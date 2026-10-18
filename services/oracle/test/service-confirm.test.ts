// OracleService under ORACLE_POLICY=primary-confirm (mainnet): Chainlink alone sets and signs (sourceCount 1), the
// DEX TWAP confirms; divergence still publishes Chainlink + warns + /health; Chainlink stale = no price even with a
// fresh DEX; on-chain minSources must be 1.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SESSIONS_24X7, SESSIONS_NYSE_RTH, VENUE, encodeSessions, priceId } from "@bookrunner/shared";
import { sourcesHash } from "../src/domain/sources-hash";
import { buildUniverse } from "../src/domain/universe";
import { updateFromMsg } from "../src/service";
import { recoverPriceSigner } from "../src/signing";
import { FakeChain, ORACLE_ADDR, ScriptedSource, makeService, silentLog } from "./fakes";

const RTH = encodeSessions(SESSIONS_NYSE_RTH);
const ALWAYS = encodeSessions(SESSIONS_24X7);
// Thu 2026-10-01 15:00 UTC = 11:00 ET (in session)
const T0 = Date.parse("2026-10-01T15:00:00Z");
// Sat 2026-10-03 15:00 UTC (closed)
const SAT = Date.parse("2026-10-03T15:00:00Z");

function universe(sessions = RTH) {
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
      { bookId: 1, venue: VENUE.ORDERLY, symbol: "PERP_NVDA_USDC", oracleKey: "NVDA", sessions },
      { bookId: 2, venue: VENUE.ORDERLY, symbol: "PERP_TSLA_USDC", oracleKey: "TSLA", sessions },
      { bookId: 3, venue: VENUE.POOL_ENGINE, symbol: "RHX2-PERP", oracleKey: "RHX2", sessions },
    ],
    defaultSessions: ALWAYS,
  }).entries;
}

class Harness {
  clock = T0;
  readonly chainlink = new ScriptedSource("chainlink", () => this.clock);
  readonly dex = new ScriptedSource("dex-twap", () => this.clock);
  readonly chain = new FakeChain();
  readonly parts;
  constructor(settings: Parameters<typeof makeService>[0]["settings"] = {}) {
    this.chain.min = 1;
    this.parts = makeService({
      now: () => this.clock,
      sources: [this.chainlink, this.dex],
      settings: { policy: "primary-confirm", minSources: 1, confirmBps: 200, sessionsMode: "charter", production: true, ...settings },
    });
  }
  get svc() {
    return this.parts.svc;
  }
  async start() {
    await this.svc.setDeployment({ chainId: 31337, oracle: ORACLE_ADDR, chain: this.chain });
    await this.svc.setUniverse(universe());
  }
  async tick(atMs?: number) {
    if (atMs !== undefined) this.clock = atMs;
    this.chain.head = Math.floor(this.clock / 1000);
    const r = await this.svc.tick(this.clock);
    await this.svc.idle();
    return r;
  }
  confirm(id: string) {
    return this.svc.health().confirm.find((c) => c.priceId === id);
  }
}

describe("OracleService primary-confirm", () => {
  let h: Harness;
  let warn: ReturnType<typeof spyOn>;
  beforeEach(async () => {
    h = new Harness();
    await h.start();
    warn = spyOn(silentLog, "warn");
  });
  afterEach(() => warn.mockRestore());

  test("signs the Chainlink price with sourceCount 1; sourcesHash commits to the DEX confirm value too", async () => {
    h.chainlink.set("NVDA", { price: 190 });
    h.chainlink.set("TSLA", { price: 440 });
    h.dex.set("NVDA", { price: 190.4 });
    h.dex.set("TSLA", { price: 439.1 });
    const r = await h.tick();
    expect(r.published).toEqual(["NVDA", "TSLA", "RHX2"]);
    const msgs = h.parts.publisher!.published;
    expect(msgs.map((m) => [m.priceId, m.price, m.sourceCount])).toEqual([
      ["NVDA", 190, 1],
      ["TSLA", 440, 1],
      ["RHX2", 315, 1],
    ]);
    const nvda = msgs[0]!;
    expect(nvda.sources.map((s) => [s.name, s.price])).toEqual([
      ["chainlink", 190],
      ["dex-twap", 190.4],
    ]);
    expect(nvda.sourcesHash).toBe(sourcesHash(nvda.sources));
    expect(await recoverPriceSigner(31337, ORACLE_ADDR, updateFromMsg(nvda), nvda.signature)).toBe(h.parts.signerAccount.address);
    expect(h.chain.pushes[0]!.updates.every((u) => u.sourceCount === 1)).toBe(true);

    const health = h.svc.health();
    expect(health.policy).toBe("primary-confirm");
    expect(health.confirmBps).toBe(200);
    expect(health.sources.map((s) => `${s.name}:${s.role}`)).toEqual(["chainlink:primary", "dex-twap:confirm"]);
    expect(h.confirm("NVDA")).toEqual({
      priceId: "NVDA",
      status: "ok",
      diffBps: 21.1,
      since: T0,
      checkedAt: T0,
      primaryPrice: 190,
      confirmers: [{ name: "dex-twap", price: 190.4, diffBps: 21.1 }],
    });
    expect(health.onchain.minSourcesProblem).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("divergence beyond ORACLE_CONFIRM_BPS: Chainlink still published, /health diverged, warning rate-limited", async () => {
    h.chainlink.set("NVDA", { price: 190 });
    h.chainlink.set("TSLA", { price: 440 });
    h.dex.set("NVDA", { price: 171 }); // a manipulated / depegged pool: -10%
    h.dex.set("TSLA", { price: 440 });
    await h.tick();
    expect(h.parts.publisher!.last.get("NVDA")!.price).toBe(190);
    expect(h.confirm("NVDA")).toMatchObject({ status: "diverged", diffBps: 1000, since: T0 });
    const divergenceWarns = () => warn.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith("confirm divergence")).length;
    expect(divergenceWarns()).toBe(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ priceId: "NVDA", chainlink: 190, confirmBps: 200 });
    await h.tick(T0 + 30_000);
    expect(divergenceWarns()).toBe(1); // rate-limited (60 s)
    expect(h.confirm("NVDA")).toMatchObject({ status: "diverged", since: T0, checkedAt: T0 + 30_000 });
    await h.tick(T0 + 61_000);
    expect(divergenceWarns()).toBe(2);
    expect(h.parts.publisher!.last.get("NVDA")!.price).toBe(190);
    // back within the band: ok, a new run starts
    h.dex.set("NVDA", { price: 190.2 });
    await h.tick(T0 + 62_000);
    expect(h.confirm("NVDA")).toMatchObject({ status: "ok", since: T0 + 62_000 });
  });

  test("Chainlink stale in session: no price even though the DEX is fresh; /health no-primary + unpublished", async () => {
    h.chainlink.set("NVDA", { price: 190, ts: T0 - 60_000 }); // older than maxSourceAgeMs (15 s here)
    h.chainlink.set("TSLA", { price: 440 });
    h.dex.set("NVDA", { price: 190 });
    h.dex.set("TSLA", { price: 440 });
    const r = await h.tick();
    expect(r.published).toEqual(["TSLA"]);
    expect(r.skipped.find((s) => s.priceId === "NVDA")!.reason).toBe("primary source chainlink has no fresh observation (confirm sources never substitute for it)");
    expect(h.confirm("NVDA")).toMatchObject({ status: "no-primary", primaryPrice: null, diffBps: null });
    expect(h.svc.health().unpublished.map((u) => u.priceId)).toEqual(["NVDA", "RHX2"]);
    // Chainlink unavailable entirely: same
    h.chainlink.set("NVDA", null);
    expect((await h.tick(T0 + 1_000)).published).toEqual(["TSLA"]);
  });

  test("no confirm source: Chainlink published unconfirmed; logged only after 10 min in session", async () => {
    h.chainlink.set("NVDA", { price: 190 });
    h.chainlink.set("TSLA", { price: 440 });
    h.dex.set("NVDA", new Error("insufficient liquidity: $1,000 quote tokens in the pool < floor $50,000"));
    h.dex.set("TSLA", { price: 440 });
    expect((await h.tick()).published).toContain("NVDA");
    expect(h.confirm("NVDA")).toMatchObject({ status: "unavailable", diffBps: null, confirmers: [] });
    const unconfirmed = () => warn.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith("no confirm source")).length;
    await h.tick(T0 + 599_000);
    expect(unconfirmed()).toBe(0);
    await h.tick(T0 + 600_000);
    expect(unconfirmed()).toBe(1);
    const dexHealth = h.svc.health().sources.find((s) => s.name === "dex-twap")!;
    expect(dexHealth).toMatchObject({ role: "confirm", failingTickers: ["NVDA"] });
    expect(dexHealth.lastError).toContain("insufficient liquidity");
  });

  test("off-hours: confirm not evaluated (closed); the hold stays at the last Chainlink price", async () => {
    h.chainlink.set("NVDA", { price: 190 });
    h.chainlink.set("TSLA", { price: 440 });
    h.dex.set("NVDA", { price: 190 });
    h.dex.set("TSLA", { price: 440 });
    await h.tick();
    h.dex.set("NVDA", { price: 150 }); // the DEX trades over the weekend; Chainlink holds
    h.chainlink.set("NVDA", { price: 190 });
    const r = await h.tick(SAT);
    expect(r.published).toContain("NVDA");
    const m = h.parts.publisher!.last.get("NVDA")!;
    expect([m.price, m.held, m.sourceCount]).toEqual([190, true, 1]);
    expect(h.confirm("NVDA")!.status).toBe("closed");
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith("confirm divergence"))).toHaveLength(0);
  });

  test("on-chain minSources other than 1 is a /health problem (every primary-confirm price would be refused)", async () => {
    h.chain.min = 2;
    await h.svc.refreshChainState();
    expect(h.svc.health().onchain.minSourcesProblem).toContain("AttestedOracle.minSources()=2 but primary-confirm signs every price with sourceCount 1");
    h.chainlink.set("NVDA", { price: 190 });
    h.chainlink.set("TSLA", { price: 440 });
    // the service applies max(ORACLE_MIN_SOURCES, minSources()): nothing below 2 is signed
    expect((await h.tick()).published).toEqual([]);
    h.chain.min = 1;
    await h.svc.refreshChainState();
    expect(h.svc.health().onchain.minSourcesProblem).toBeNull();
    expect((await h.tick(T0 + 1_000)).published).toEqual(["NVDA", "TSLA", "RHX2"]);
  });

  test("median policy keeps the old /health shape (no confirm entries, role median)", async () => {
    const m = new Harness({ policy: "median", minSources: 2, production: false });
    await m.start();
    m.chainlink.set("NVDA", { price: 190 });
    m.dex.set("NVDA", { price: 190.2 });
    await m.tick();
    const health = m.svc.health();
    expect(health.policy).toBe("median");
    expect(health.confirmBps).toBeNull();
    expect(health.confirm).toEqual([]);
    expect(health.sources.map((s) => s.role)).toEqual(["median", "median"]);
    expect(m.parts.publisher!.last.get("NVDA")!.sourceCount).toBe(2);
  });
});
