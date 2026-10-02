// Pull oracle (docs/LOW_GAS.md §1): ORACLE_PUSH_MODE=pull never pushes on a timer; every tick publishes the
// signed bundle (Redis KEYS.oracleBundle + GET /prices/signed) that consumers carry as `priceData`.
import { describe, expect, test } from "bun:test";
import { KEYS, type OracleBundleMsg, SESSIONS_24X7, decodePriceData, encodeSessions, priceId } from "@bookrunner/shared";
import { type Address, type Hex, toFunctionSelector } from "viem";
import { ORACLE_UPDATE_SELECTOR, ViemOracleChain, codeDispatches } from "../src/adapters/chain";
import { RedisPricePublisher } from "../src/adapters/redis";
import { loadOracleConfig } from "../src/config";
import { buildUniverse } from "../src/domain/universe";
import { createApp } from "../src/http";
import { buildBundle } from "../src/service";
import type { OracleSettings } from "../src/service";
import { recoverPriceSigner } from "../src/signing";
import { FakeChain, ORACLE_ADDR, ScriptedSource, makeService, silentLog } from "./fakes";

const T0 = Date.parse("2026-10-01T15:00:00Z");
const ALWAYS = encodeSessions(SESSIONS_24X7);

function universe() {
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
    books: [],
    defaultSessions: ALWAYS,
  }).entries;
}

class Harness {
  clock = T0;
  readonly sources = ["synthetic-a", "synthetic-b", "synthetic-c"].map((n) => new ScriptedSource(n, () => this.clock));
  readonly chain = new FakeChain();
  readonly parts;
  constructor(settings: Partial<OracleSettings> = {}) {
    this.parts = makeService({ now: () => this.clock, sources: this.sources, settings: { pushMode: "pull", ...settings } });
  }
  get svc() {
    return this.parts.svc;
  }
  set(ticker: string, price: number | null) {
    for (const s of this.sources) s.set(ticker, price === null ? null : { price });
  }
  async start(oracle: Address = ORACLE_ADDR) {
    await this.svc.setDeployment({ chainId: 31337, oracle, chain: this.chain });
    await this.svc.setUniverse(universe());
    this.set("NVDA", 190);
    this.set("TSLA", 440);
  }
  async tick(atMs?: number) {
    if (atMs !== undefined) this.clock = atMs;
    this.chain.head = Math.floor(this.clock / 1000);
    const r = await this.svc.tick(this.clock);
    await this.svc.idle();
    return r;
  }
}

async function expectSignedBy(b: OracleBundleMsg, oracle: Address, signer: Address) {
  const { updates, sigs } = decodePriceData(b.priceData);
  expect(updates).toHaveLength(b.priceIds.length);
  for (let i = 0; i < updates.length; i++) {
    expect(await recoverPriceSigner(b.chainId, oracle, updates[i]!, sigs[i]!)).toBe(signer);
  }
  return updates;
}

describe("ORACLE_PUSH_MODE config", () => {
  test("defaults to pull; heartbeat selectable; anything else rejected", () => {
    expect(loadOracleConfig({}).ORACLE_PUSH_MODE).toBe("pull");
    expect(loadOracleConfig({}).ORACLE_BUNDLE_MAX_AGE_MS).toBe(300_000);
    expect(loadOracleConfig({ ORACLE_PUSH_MODE: "heartbeat" }).ORACLE_PUSH_MODE).toBe("heartbeat");
    expect(() => loadOracleConfig({ ORACLE_PUSH_MODE: "push" })).toThrow(/ORACLE_PUSH_MODE/);
  });
});

describe("pull mode", () => {
  test("never pushes on a timer (interval, deviation, held flip) — history rows keep flowing without a tx", async () => {
    const h = new Harness();
    await h.start();
    await h.tick();
    h.set("NVDA", 199); // +470 bps: a heartbeat push in the old mode
    for (let s = 1; s <= 20; s++) await h.tick(T0 + s * 1000);
    expect(h.chain.pushes).toHaveLength(0);
    const rows = h.parts.store!.rows;
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.pushedTx === null)).toBe(true);
    expect(h.svc.lastPush?.txHash).toBeNull();
    const health = h.svc.health();
    expect(health.pushMode).toBe("pull");
    expect(health.onchain.pushes).toBe(false);
    expect(health.onchain.signerRegistered).toBe(true); // still checked: consumers' updates must verify
  });

  test("every tick publishes the bundle: all live ids, signed for (chainId, oracle), expiring with the oracle", async () => {
    const h = new Harness({ bundleMaxAgeMs: 120_000 });
    await h.start();
    expect(h.svc.signedBundle()).toBeNull();
    await h.tick();
    await h.tick(T0 + 1000);
    const pubs = h.parts.publisher!.bundles;
    expect(pubs).toHaveLength(2);
    expect(pubs[1]!.ttlMs).toBe(120_000);
    const b = pubs[1]!.msg;
    expect(b).toEqual(h.svc.signedBundle()!);
    expect(b).toMatchObject({ chainId: 31337, oracle: ORACLE_ADDR, priceIds: ["NVDA", "TSLA", "RHX2"], publishedAt: Math.floor(T0 / 1000) + 1 });
    const updates = await expectSignedBy(b, ORACLE_ADDR, h.parts.signerAccount.address);
    expect(updates.map((u) => u.underlying)).toEqual([priceId("NVDA"), priceId("TSLA"), priceId("RHX2")]);
    expect(updates.every((u) => u.publishedAt === BigInt(Math.floor(T0 / 1000) + 1))).toBe(true);
    // the bundle carries exactly the per-price messages published on the same tick
    const last = h.parts.publisher!.last.get("NVDA")!;
    expect(updates[0]!.priceWad).toBe(BigInt(last.priceWad));
  });

  test("a key whose sources fail stays in the bundle with its last update until it ages out", async () => {
    const h = new Harness({ bundleMaxAgeMs: 20_000 });
    await h.start();
    await h.tick();
    h.set("TSLA", null); // TSLA stops publishing; the index keeps using its last print for maxSourceAge (15s)
    await h.tick(T0 + 10_000);
    let b = h.svc.signedBundle()!;
    expect(b.priceIds).toEqual(["NVDA", "TSLA", "RHX2"]);
    const tsla = decodePriceData(b.priceData).updates[1]!;
    expect(tsla.publishedAt).toBe(BigInt(Math.floor(T0 / 1000))); // its own (older) publishedAt
    expect(b.publishedAt).toBe(Math.floor(T0 / 1000) + 10);
    await h.tick(T0 + 25_000); // TSLA 25s old: out; RHX2 last signed at +10s: still in
    b = h.svc.signedBundle()!;
    expect(b.priceIds).toEqual(["NVDA", "RHX2"]);
    await h.tick(T0 + 31_000);
    b = h.svc.signedBundle()!;
    expect(b.priceIds).toEqual(["NVDA"]);
    await expectSignedBy(b, ORACLE_ADDR, h.parts.signerAccount.address);
  });

  test("no live price: no bundle is published (the Redis key then expires)", async () => {
    const h = new Harness({ bundleMaxAgeMs: 5_000 });
    await h.start();
    h.set("NVDA", null);
    h.set("TSLA", null);
    await h.tick();
    expect(h.svc.signedBundle()).toBeNull();
    expect(h.parts.publisher!.bundles).toHaveLength(0);
  });

  test("a new AttestedOracle re-signs: no signature bound to the old domain survives in the bundle", async () => {
    const h = new Harness();
    await h.start();
    await h.tick();
    const other = "0x00000000000000000000000000000000000000bb" as Address;
    h.set("TSLA", null); // TSLA cannot be re-signed for the new oracle this tick
    await h.svc.setDeployment({ chainId: 31337, oracle: other, chain: h.chain });
    expect(h.svc.signedBundle()).toBeNull();
    await h.tick(T0 + 1000);
    const b = h.svc.signedBundle()!;
    expect(b.oracle).toBe(other);
    expect(b.priceIds).toEqual(["NVDA"]);
    await expectSignedBy(b, other, h.parts.signerAccount.address);
  });

  test("pull against a pre-low-gas AttestedOracle (no update(bytes)) keeps the heartbeat pushes", async () => {
    const h = new Harness();
    h.chain.pullContract = false;
    await h.start();
    await h.tick();
    expect(h.chain.pushes).toHaveLength(1); // nobody could carry the bundle: the stored price must stay fresh
    const health = h.svc.health();
    expect(health.pushMode).toBe("pull");
    expect(health.effectivePushMode).toBe("heartbeat");
    expect(health.onchain.pushes).toBe(true);
    expect(health.onchain.pullSupported).toBe(false);
    expect(h.svc.signedBundle()?.priceIds).toEqual(["NVDA", "TSLA", "RHX2"]); // still published
    // detected once per contract, not on every discovery refresh
    await h.svc.setDeployment({ chainId: 31337, oracle: ORACLE_ADDR, chain: h.chain });
    expect(h.chain.updateChecks).toBe(1);
    // a redeploy with the pull contract switches to pull
    h.chain.pullContract = true;
    await h.svc.setDeployment({ chainId: 31337, oracle: "0x00000000000000000000000000000000000000cc", chain: h.chain });
    expect(h.svc.effectivePushMode()).toBe("pull");
    expect(h.chain.updateChecks).toBe(2);
  });

  test("pull with the pull contract never asks again and never pushes; heartbeat config never checks", async () => {
    const h = new Harness();
    await h.start();
    await h.tick();
    expect(h.svc.effectivePushMode()).toBe("pull");
    expect(h.svc.health().onchain.pullSupported).toBe(true);
    expect(h.chain.pushes).toHaveLength(0);
    const hb = new Harness({ pushMode: "heartbeat" });
    await hb.start();
    expect(hb.chain.updateChecks).toBe(0);
    expect(hb.svc.effectivePushMode()).toBe("heartbeat");
  });

  test("heartbeat mode keeps today's pushes and publishes the bundle as well", async () => {
    const h = new Harness({ pushMode: "heartbeat" });
    await h.start();
    await h.tick();
    expect(h.chain.pushes).toHaveLength(1);
    expect(h.svc.signedBundle()?.priceIds).toEqual(["NVDA", "TSLA", "RHX2"]);
    expect(h.svc.health().onchain.pushes).toBe(true);
  });
});

describe("pull-contract detection", () => {
  test("codeDispatches finds the update(bytes) PUSH4 selector; ViemOracleChain reads the oracle's code", async () => {
    expect(ORACLE_UPDATE_SELECTOR).toBe(toFunctionSelector("update(bytes)"));
    expect(ORACLE_UPDATE_SELECTOR.startsWith("0x00")).toBe(false); // a full PUSH4 in the dispatcher
    const pull = `0x608060405263${ORACLE_UPDATE_SELECTOR.slice(2)}14610010` as Hex;
    expect(codeDispatches(pull, ORACLE_UPDATE_SELECTOR)).toBe(true);
    expect(codeDispatches(pull.toUpperCase().replace("0X", "0x") as Hex, ORACLE_UPDATE_SELECTOR)).toBe(true);
    expect(codeDispatches("0x6080604052631234567814", ORACLE_UPDATE_SELECTOR)).toBe(false);
    expect(codeDispatches("0x", ORACLE_UPDATE_SELECTOR)).toBe(false);
    expect(codeDispatches(undefined, ORACLE_UPDATE_SELECTOR)).toBe(false);
    const pub = { getCode: async () => pull };
    const chain = new ViemOracleChain(pub as never, {} as never, ORACLE_ADDR, 31337, silentLog);
    expect(await chain.supportsUpdate()).toBe(true);
    const legacy = new ViemOracleChain({ getCode: async () => "0x6080604052" } as never, {} as never, ORACLE_ADDR, 31337, silentLog);
    expect(await legacy.supportsUpdate()).toBe(false);
  });
});

describe("buildBundle (pure)", () => {
  test("skips unsigned messages and keeps universe order", () => {
    const m = (id: string, at: number, signature: `0x${string}`) => ({
      priceId: id,
      underlying: priceId(id),
      priceWad: "1000000000000000000",
      price: 1,
      publishedAt: at,
      held: false,
      sourceCount: 3,
      sources: [],
      sourcesHash: `0x${"00".repeat(32)}` as const,
      signature,
    });
    const sig = `0x${"11".repeat(65)}` as const;
    const b = buildBundle([m("B", 100, sig), undefined, m("A", 99, "0x"), m("C", 50, sig)], { chainId: 1, oracle: ORACLE_ADDR }, 100, 30)!;
    expect(b.priceIds).toEqual(["B"]);
    expect(b.publishedAt).toBe(100);
    expect(buildBundle([], { chainId: 1, oracle: ORACLE_ADDR }, 100, 30)).toBeNull();
  });
});

describe("HTTP in pull mode", () => {
  test("GET /prices/signed serves the bundle (503 before the first tick); /prices serves the latest unsigned", async () => {
    const h = new Harness();
    await h.start();
    const app = createApp(h.svc);
    const before = await app.request("/prices/signed");
    expect(before.status).toBe(503);
    await h.tick();
    h.set("NVDA", 190.1); // below any push policy: in heartbeat mode /prices would keep serving 190
    await h.tick(T0 + 1000);
    const res = await app.request("/prices/signed");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as OracleBundleMsg;
    expect(body).toEqual(h.svc.signedBundle()!);
    await expectSignedBy(body, ORACLE_ADDR, h.parts.signerAccount.address);
    const nv = (await (await app.request("/prices/NVDA")).json()) as Record<string, unknown>;
    expect(nv.price).toBe(190.1);
    expect(nv).not.toHaveProperty("signature");
    const all = (await (await app.request("/prices")).json()) as { prices: Array<Record<string, unknown>> };
    expect(all.prices.every((p) => !("signature" in p))).toBe(true);
  });
});

describe("RedisPricePublisher bundle key", () => {
  test("per-price keys + channels and the bundle (PX ttl) go out in one pipeline", async () => {
    const calls: unknown[][] = [];
    const pipeline = {
      set: (...a: unknown[]) => (calls.push(["set", ...a]), pipeline),
      publish: (...a: unknown[]) => (calls.push(["publish", ...a]), pipeline),
      exec: async () => calls.map(() => [null, "OK"]),
    };
    const pub = new RedisPricePublisher({ pipeline: () => pipeline } as never);
    const bundle: OracleBundleMsg = { priceData: "0x1234", publishedAt: 7, chainId: 31337, oracle: ORACLE_ADDR, priceIds: ["NVDA"] };
    await pub.publish([], { msg: bundle, ttlMs: 60_000 });
    expect(calls).toEqual([["set", KEYS.oracleBundle, JSON.stringify(bundle), "PX", 60_000]]);
    calls.length = 0;
    await pub.publish([], null);
    expect(calls).toEqual([]); // nothing to send
  });
});
