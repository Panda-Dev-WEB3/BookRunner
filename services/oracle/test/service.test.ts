import { beforeEach, describe, expect, test } from "bun:test";
import { SESSIONS_24X7, SESSIONS_NYSE_RTH, VENUE, encodeSessions, priceId } from "@bookrunner/shared";
import { LiveOrderlyPriceClient } from "../src/adapters/venue";
import { toPriceWad } from "../src/domain/price";
import { sourcesHash } from "../src/domain/sources-hash";
import { buildUniverse } from "../src/domain/universe";
import { updateFromMsg } from "../src/service";
import { recoverPriceSigner } from "../src/signing";
import type { PriceSource } from "../src/domain/types";
import { FakeChain, FakePublisher, type FakeVenue, ORACLE_ADDR, ScriptedSource, makeService } from "./fakes";

const RTH = encodeSessions(SESSIONS_NYSE_RTH);
const ALWAYS = encodeSessions(SESSIONS_24X7);
// Thu 2026-10-01 15:00 UTC = 11:00 ET (in session)
const T0 = Date.parse("2026-10-01T15:00:00Z");

function universe(nvdaSessions = ALWAYS) {
  return buildUniverse({
    equities: [
      { priceId: "NVDA", underlying: priceId("NVDA") },
      { priceId: "TSLA", underlying: priceId("TSLA") },
    ],
    indexes: [
      {
        priceId: "RHX2",
        underlying: priceId("RHX2"),
        components: [
          { priceId: "NVDA", weightBps: 5000 },
          { priceId: "TSLA", weightBps: 5000 },
        ],
      },
    ],
    books: [
      { bookId: 1, venue: VENUE.ORDERLY, symbol: "PERP_NVDA_USDC", oracleKey: "NVDA", sessions: nvdaSessions },
      { bookId: 3, venue: VENUE.POOL_ENGINE, symbol: "RHX2-PERP", oracleKey: "RHX2", sessions: ALWAYS },
    ],
    defaultSessions: ALWAYS,
  }).entries;
}

type ServiceOpts = Parameters<typeof makeService>[0];

class Harness {
  clock = T0;
  readonly sources: ScriptedSource[];
  readonly chain = new FakeChain();
  readonly parts: ReturnType<typeof makeService>;
  constructor(opts: Partial<ServiceOpts> & { extraSources?: PriceSource[] } = {}) {
    const now = () => this.clock;
    this.sources = ["synthetic-a", "synthetic-b", "synthetic-c"].map((n) => new ScriptedSource(n, now));
    const { extraSources = [], ...rest } = opts;
    this.parts = makeService({ now, ...rest, sources: [...this.sources, ...extraSources] });
  }
  get svc() {
    return this.parts.svc;
  }
  get venueCalls() {
    return (this.parts.venue as FakeVenue).calls;
  }
  set(ticker: string, price: number, overrides: Partial<Record<"a" | "b" | "c", number | null>> = {}) {
    (["a", "b", "c"] as const).forEach((n, i) => {
      const o = overrides[n];
      this.sources[i]!.set(ticker, o === null ? null : { price: o ?? price });
    });
  }
  async tick(atMs?: number) {
    if (atMs !== undefined) this.clock = atMs;
    this.chain.head = Math.floor(this.clock / 1000);
    const r = await this.svc.tick(this.clock);
    await this.svc.idle();
    return r;
  }
}

async function started(h: Harness, nvdaSessions = ALWAYS) {
  await h.svc.setDeployment({ chainId: 31337, oracle: ORACLE_ADDR, chain: h.chain });
  await h.svc.setUniverse(universe(nvdaSessions));
  h.set("NVDA", 190);
  h.set("TSLA", 440);
}

describe("OracleService tick", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  test("idles before a deployment is set", async () => {
    const r = await h.svc.tick(T0);
    expect(r.published).toEqual([]);
    expect(h.svc.status()).toBe("waiting-deployment");
    expect(h.parts.publisher!.published).toHaveLength(0);
  });

  test("first tick publishes signed equities + index, pushes once, records rows and venue prices", async () => {
    await started(h);
    const r = await h.tick();
    expect(r.published).toEqual(["NVDA", "TSLA", "RHX2"]);
    const msgs = h.parts.publisher!.published;
    expect(msgs.map((m) => [m.priceId, m.price, m.held, m.sourceCount])).toEqual([
      ["NVDA", 190, false, 3],
      ["TSLA", 440, false, 3],
      ["RHX2", 315, false, 3],
    ]);
    for (const m of msgs) {
      expect(m.sourcesHash).toBe(sourcesHash(m.sources));
      expect(m.priceWad).toBe(toPriceWad(m.price).toString());
      expect(m.publishedAt).toBe(Math.floor(T0 / 1000));
      expect(await recoverPriceSigner(31337, ORACLE_ADDR, updateFromMsg(m), m.signature)).toBe(h.parts.signerAccount.address);
    }
    expect(msgs[0]!.underlying).toBe(priceId("NVDA"));
    expect(msgs[2]!.sources.map((s) => s.name)).toEqual(["NVDA", "TSLA"]);

    expect(h.chain.pushes).toHaveLength(1);
    expect(h.chain.pushes[0]!.updates.map((u) => u.underlying)).toEqual([priceId("NVDA"), priceId("TSLA"), priceId("RHX2")]);
    const rows = h.parts.store!.rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.pushedTx === "0x0000000000000000000000000000000000000000000000000000000000000001")).toBe(true);

    await Bun.sleep(0);
    expect(h.venueCalls).toEqual([
      { symbol: "PERP_NVDA_USDC", price: 190, held: false, ts: Math.floor(T0 / 1000) },
    ]);
    expect(h.svc.prices().map((m) => m.priceId)).toEqual(["NVDA", "TSLA", "RHX2"]);
  });

  test("pushes on the interval and immediately on a deviation > 25 bps (only the moved key)", async () => {
    await started(h);
    await h.tick();
    h.set("NVDA", 190.1); // 5 bps
    let r = await h.tick(T0 + 1000);
    expect(r.due).toEqual([]);
    expect(h.chain.pushes).toHaveLength(1);

    h.set("NVDA", 191); // +52 bps vs last pushed 190; index moves ~16 bps
    r = await h.tick(T0 + 2000);
    expect(r.due).toEqual(["NVDA"]);
    expect(h.chain.pushes).toHaveLength(2);
    expect(h.chain.pushes[1]!.updates.map((u) => u.underlying)).toEqual([priceId("NVDA")]);

    r = await h.tick(T0 + 5000); // TSLA + RHX2 interval elapsed, NVDA pushed at +2s
    expect(r.due).toEqual(["TSLA", "RHX2"]);
    r = await h.tick(T0 + 7000);
    expect(r.due).toEqual(["NVDA"]);
    expect(h.parts.store!.rows).toHaveLength(3 + 1 + 2 + 1);
  });

  test("outlier / dropout leaves < 3 sources: equity skipped, index uses the component's fresh publication", async () => {
    await started(h);
    await h.tick();
    h.set("NVDA", 190, { c: 199 }); // ~470 bps outlier
    h.set("TSLA", 440, { b: null }); // dropout
    const r = await h.tick(T0 + 1000);
    expect(r.skipped.map((s) => s.priceId)).toEqual(["NVDA", "TSLA"]);
    expect(r.published).toEqual(["RHX2"]);
    const last = h.parts.publisher!.published.at(-1)!;
    expect(last.priceId).toBe("RHX2");
    expect(last.price).toBe(315);

    // components older than maxSourceAgeMs no longer feed the index
    const r2 = await h.tick(T0 + 16_000);
    expect(r2.skipped.map((s) => s.priceId)).toEqual(["NVDA", "TSLA", "RHX2"]);
  });

  test("off-hours: held at the last open-session price, held-change pushed, re-stamped while held", async () => {
    const hh = new Harness({ settings: { sessionsMode: "charter" } });
    await started(hh, RTH);
    const fri1559 = Date.parse("2026-10-02T19:59:59Z");
    hh.set("NVDA", 192);
    await hh.tick(fri1559);
    hh.set("NVDA", 193);
    const r = await hh.tick(fri1559 + 1000); // 16:00 ET
    expect(r.due).toContain("NVDA");
    const nv = hh.parts.publisher!.published.filter((m) => m.priceId === "NVDA");
    expect(nv.map((m) => [m.price, m.held])).toEqual([
      [192, false],
      [192, true],
    ]);
    const pushed = hh.chain.pushes.at(-1)!.updates.find((u) => u.underlying === priceId("NVDA"))!;
    expect(pushed.held).toBe(true);
    expect(pushed.priceWad).toBe(toPriceWad(192));

    hh.set("NVDA", 150);
    await hh.tick(Date.parse("2026-10-03T15:00:00Z")); // Saturday
    const sat = hh.parts.publisher!.published.filter((m) => m.priceId === "NVDA").at(-1)!;
    expect([sat.price, sat.held, sat.publishedAt]).toEqual([192, true, Math.floor(Date.parse("2026-10-03T15:00:00Z") / 1000)]);
    // TSLA has no book of its own and is not an RTH-governed component here -> unaffected
    expect(hh.parts.publisher!.published.filter((m) => m.priceId === "TSLA").every((m) => !m.held)).toBe(true);
  });

  test("restart off-hours restores the held price from Redis", async () => {
    const publisher = new FakePublisher();
    const a = new Harness({ publisher, settings: { sessionsMode: "charter" } });
    await started(a, RTH);
    a.set("NVDA", 188.5);
    await a.tick(Date.parse("2026-10-02T19:00:00Z")); // Fri 15:00 ET
    const b = new Harness({ publisher, settings: { sessionsMode: "charter" } });
    await started(b, RTH);
    b.set("NVDA", 170);
    await b.tick(Date.parse("2026-10-03T12:00:00Z")); // Saturday
    const m = publisher.published.filter((x) => x.priceId === "NVDA").at(-1)!;
    expect([m.price, m.held]).toEqual([188.5, true]);
  });

  test("signer not registered: no chain push, rows recorded without pushed_tx", async () => {
    h.chain.signer = false;
    await started(h);
    await h.tick();
    expect(h.chain.pushes).toHaveLength(0);
    expect(h.parts.store!.rows).toHaveLength(3);
    expect(h.parts.store!.rows.every((r) => r.pushedTx === null)).toBe(true);
    expect(h.svc.health().onchain.status).toContain("not registered");
  });

  test("on-chain minSources above config raises the requirement", async () => {
    h.chain.min = 4;
    await started(h);
    const r = await h.tick();
    expect(r.skipped.map((s) => s.priceId)).toEqual(["NVDA", "TSLA", "RHX2"]);
  });

  test("pushMany failure backs off; rows keep flowing; recovers after the backoff", async () => {
    await started(h);
    h.chain.failNext = new Error("rpc down");
    await h.tick();
    expect(h.chain.pushes).toHaveLength(0);
    expect(h.parts.store!.rows.map((r) => r.pushedTx)).toEqual([null, null, null]);
    expect(h.svc.lastPush?.error).toContain("rpc down");

    await h.tick(T0 + 5000); // interval due, still within the 5s backoff? backoff ends at T0+5000 -> usable
    expect(h.chain.pushes).toHaveLength(1);
    expect(h.svc.lastPush?.error).toBeUndefined();
  });

  test("updates not newer than the stored on-chain publishedAt are held back, then pushed", async () => {
    for (const id of ["NVDA", "TSLA", "RHX2"]) h.chain.stored.set(priceId(id).toLowerCase(), Math.floor(T0 / 1000));
    await started(h); // restore() reads the stored publishedAt
    let r = await h.tick();
    expect(r.due).toHaveLength(3);
    expect(h.chain.pushes).toHaveLength(0);
    expect(h.parts.store!.rows).toHaveLength(0);
    r = await h.tick(T0 + 1000);
    expect(r.due).toHaveLength(3);
    expect(h.chain.pushes).toHaveLength(1);
  });

  test("redis and db failures never break the tick", async () => {
    h.parts.publisher!.fail = true;
    h.parts.store!.fail = true;
    await started(h);
    const r = await h.tick();
    expect(r.published).toHaveLength(3);
    expect(h.chain.pushes).toHaveLength(1);
  });

  test("a throwing source is ignored (and costs that key its quorum)", async () => {
    await started(h);
    h.sources[0]!.set("NVDA", new Error("boom"));
    const r = await h.tick();
    expect(r.skipped.map((s) => s.priceId)).toEqual(["NVDA", "RHX2"]);
    expect(r.published).toEqual(["TSLA"]);
  });

  test("a hanging source times out without stalling the tick", async () => {
    const hang: PriceSource = { name: "hang", fetch: () => new Promise(() => {}) };
    const hh = new Harness({ extraSources: [hang], settings: { sourceTimeoutMs: 20 } });
    await started(hh);
    const r = await hh.tick();
    expect(r.published).toEqual(["NVDA", "TSLA", "RHX2"]);
  });

  test("live venue client (NotConfigured) disables builder prices without failing ticks", async () => {
    const hh = new Harness({ venue: new LiveOrderlyPriceClient() });
    await started(hh);
    await hh.tick();
    await Bun.sleep(0);
    expect(hh.svc.health().venue.enabled).toBe(false);
    expect(hh.svc.health().venue.disabledReason).toContain("VERIFY");
    const r = await hh.tick(T0 + 1000);
    expect(r.published).toHaveLength(3);
  });

  test("ORACLE_PUSH_ONCHAIN=0 (chain null): wall-clock timestamps, rows without tx", async () => {
    await h.svc.setDeployment({ chainId: 31337, oracle: ORACLE_ADDR, chain: null });
    await h.svc.setUniverse(universe());
    h.set("NVDA", 190);
    h.set("TSLA", 440);
    await h.tick(T0 + 999);
    expect(h.parts.store!.rows.map((r) => r.pushedTx)).toEqual([null, null, null]);
    expect(h.parts.publisher!.published[0]!.publishedAt).toBe(Math.floor((T0 + 999) / 1000));
  });
});
