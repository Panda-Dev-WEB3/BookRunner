// Tech update #9 (buyback automation), off-chain side: the BuybackGuard depth cap sizes each buyback chunk (and chunks are
// spaced), the ETH reference duty pokes the guard on a cadence and survives refusals, the liquidation gas policy's ETH/USD
// no longer needs an env value once the deployment has a guard.
import { describe, expect, test } from "bun:test";
import { WAD, createLogger, usd } from "@bookrunner/shared";
import type { Hex } from "viem";
import {
  type BuybackPolicy,
  BuybackRunner,
  Cooldowns,
  type EthRefState,
  EthReferenceRunner,
  type EthReferenceChain,
  chunkHoldMs,
  loadWaterfallConfig,
  planEthPoke,
  sizeBound,
} from "../src/index";
import { liquidationEthUsd } from "../src/config";
import { FakeBuybackChain, fakeHash } from "./fakes";

const log = createLogger("buyback-guard-test", "silent");
const policy: BuybackPolicy = { thresholdUsd: usd("10"), slippageBps: 100n, poolFee: 3000, fallbackBkrnPerUsdcWad: 0n };
const GUARD = "0x00000000000000000000000000000000000000e1" as const;
const NOW = 1_790_000_000;

describe("sizeBound (min of maxBuybackPerCall and the guard depth cap)", () => {
  test("the smaller applies; 0 per-call = uncapped; no depth source = the per-call cap; an empty pool blocks", () => {
    expect(sizeBound(usd("1000"), usd("200"))).toEqual({ max: usd("200"), blocked: false, binding: "depth" });
    expect(sizeBound(usd("100"), usd("200"))).toEqual({ max: usd("100"), blocked: false, binding: "perCall" });
    expect(sizeBound(0n, usd("200"))).toEqual({ max: usd("200"), blocked: false, binding: "depth" });
    expect(sizeBound(usd("100"), null)).toEqual({ max: usd("100"), blocked: false, binding: "perCall" });
    expect(sizeBound(0n, undefined)).toEqual({ max: 0n, blocked: false, binding: "none" });
    expect(sizeBound(usd("100"), 0n)).toMatchObject({ blocked: true });
    expect(sizeBound(usd("200"), usd("200"))).toMatchObject({ max: usd("200"), binding: "perCall" });
  });

  test("chunk spacing only after a chunk that left more pending", () => {
    expect(chunkHoldMs(usd("20"), usd("50"), 300_000)).toBe(300_000);
    expect(chunkHoldMs(usd("50"), usd("50"), 300_000)).toBe(0);
    expect(chunkHoldMs(usd("20"), usd("50"), 0)).toBe(0);
  });
});

describe("BuybackRunner with the guard depth cap", () => {
  function setup(spacingMs = 300_000) {
    const now = { t: 1_000_000 };
    const chain = new FakeBuybackChain();
    const runner = new BuybackRunner({ chain, policy, cooldowns: new Cooldowns(() => now.t), cooldownMs: 30_000, chunkSpacingMs: spacingMs, log });
    return { chain, runner, now };
  }

  test("a pending amount above the depth cap goes out in chunks of at most the cap, spaced apart", async () => {
    const { chain, runner, now } = setup();
    chain.pending = usd("500");
    chain.depthCap = usd("200");
    chain.maxPerCall = usd("10000"); // the per-call cap is far above the depth cap
    expect((await runner.tick()).status).toBe("bought");
    expect(chain.executed.map((e) => e.amountIn)).toEqual([usd("200")]);
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "cooldown" }); // the chunk spacing: arbitrage restores the price
    now.t += 299_000;
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "cooldown" });
    now.t += 1_000;
    expect((await runner.tick()).status).toBe("bought");
    now.t += 300_000;
    expect((await runner.tick()).status).toBe("bought"); // the last 100
    expect(chain.executed.map((e) => e.amountIn)).toEqual([usd("200"), usd("200"), usd("100")]);
    expect(chain.pending).toBe(0n);
    // the final chunk emptied the pending amount: no spacing needed after it
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "below threshold" });
  });

  test("the guard cap tightens as the pool gets shallower: every call re-reads it", async () => {
    const { chain, runner, now } = setup(0);
    chain.pending = usd("500");
    chain.depthCap = usd("200");
    await runner.tick();
    chain.depthCap = usd("50"); // an LP pulled liquidity
    now.t += 1;
    await runner.tick();
    expect(chain.executed.map((e) => e.amountIn)).toEqual([usd("200"), usd("50")]);
  });

  test("an empty BKRN pool (cap 0): nothing is sent, the keeper cools down and says why", async () => {
    const { chain, runner } = setup();
    chain.pending = usd("500");
    chain.depthCap = 0n;
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "BKRN pool has no depth" });
    expect(chain.executed).toEqual([]);
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "cooldown" });
  });

  test("no guard / no depth source: the per-call cap alone bounds the chunk (chunks are spaced the same way); spacing 0 = the old behaviour", async () => {
    const spaced = setup();
    spaced.chain.pending = usd("50");
    spaced.chain.maxPerCall = usd("20");
    await spaced.runner.tick();
    expect(await spaced.runner.tick()).toEqual({ status: "skipped", reason: "cooldown" });
    spaced.now.t += 300_000;
    await spaced.runner.tick();
    expect(spaced.chain.executed.map((e) => e.amountIn)).toEqual([usd("20"), usd("20")]);
    const plain = setup(0);
    plain.chain.pending = usd("50");
    plain.chain.maxPerCall = usd("20");
    await plain.runner.tick();
    await plain.runner.tick();
    expect(plain.chain.executed.map((e) => e.amountIn)).toEqual([usd("20"), usd("20")]);
  });

  test("v4 venue: the depth cap bounds the previewed and sent size", async () => {
    const { chain, runner } = setup();
    chain.venue = 1;
    chain.v4Ready = true;
    chain.pending = usd("500");
    chain.depthCap = usd("120");
    const out = await runner.tick();
    expect(out.status).toBe("bought");
    expect(chain.previews).toEqual([usd("120")]);
    expect(chain.executed.map((e) => e.amountIn)).toEqual([usd("120")]);
    expect(chain.pending).toBe(usd("380"));
  });
});

describe("planEthPoke", () => {
  const st = (o: Partial<EthRefState> = {}): EthRefState => ({ guard: GUARD, configured: true, valueWad: 2000n * WAD, source: 1, storedAt: NOW - 400, nowSec: NOW, fallbackExpiry: NOW + 86_400, ...o });
  test("pokes when never stored, or when the stored value is at least the interval old; waits otherwise", () => {
    expect(planEthPoke(st({ storedAt: 0, source: 2 }), 300)).toEqual({ kind: "poke" });
    expect(planEthPoke(st({ storedAt: NOW - 300 }), 300)).toEqual({ kind: "poke" });
    expect(planEthPoke(st({ storedAt: NOW - 299 }), 300)).toEqual({ kind: "wait", reason: "recent", untilSec: NOW + 1 });
    // never faster than the contract's minimum (300 s), whatever the configured interval
    expect(planEthPoke(st({ storedAt: NOW - 100 }), 60)).toEqual({ kind: "wait", reason: "recent", untilSec: NOW + 200 });
  });
  test("a guard without a configured pool has nothing to poke", () => {
    expect(planEthPoke(st({ configured: false, storedAt: 0, source: 0 }), 300)).toEqual({ kind: "wait", reason: "not_configured", untilSec: null });
  });
});

class FakeEthRef implements EthReferenceChain {
  state: EthRefState | null = { guard: GUARD, configured: true, valueWad: 2000n * WAD, source: 1, storedAt: NOW - 600, nowSec: NOW, fallbackExpiry: 0 };
  pokes = 0;
  failPoke: string | null = null;
  failRead = false;
  async ethReferenceState() {
    if (this.failRead) throw new Error("rpc down");
    return this.state;
  }
  async pokeEthReference(): Promise<Hex> {
    if (this.failPoke) throw new Error(`execution reverted: ${this.failPoke}`);
    this.pokes++;
    if (this.state) this.state = { ...this.state, storedAt: this.state.nowSec, source: 1 };
    return fakeHash();
  }
}

describe("EthReferenceRunner", () => {
  const mk = (chain: EthReferenceChain, now: { t: number }, everySec = 300) => new EthReferenceRunner({ chain, cooldowns: new Cooldowns(() => now.t), cooldownMs: 30_000, everySec, log });

  test("pokes a stale reference once, then waits; exposes the value in force for the gas policy", async () => {
    const chain = new FakeEthRef();
    const now = { t: 0 };
    const runner = mk(chain, now);
    expect(runner.valueWad).toBeNull(); // nothing read yet
    const first = await runner.tick();
    expect(first.poked).toBeDefined();
    expect(chain.pokes).toBe(1);
    expect(runner.valueWad).toBe(2000n * WAD);
    await runner.tick(); // the stored value is fresh now
    expect(chain.pokes).toBe(1);
  });

  test("a refused poke (thin pool, spot deviation, history) cools down and never throws; the fallback value still serves", async () => {
    const chain = new FakeEthRef();
    chain.state = { ...chain.state!, source: 2, valueWad: 1900n * WAD, storedAt: NOW - 7200 };
    chain.failPoke = "TwapDeviation(10, 300)";
    const now = { t: 0 };
    const runner = mk(chain, now);
    const r = await runner.tick();
    expect(r.error).toContain("TwapDeviation");
    expect(r.poked).toBeUndefined();
    expect(runner.valueWad).toBe(1900n * WAD); // the governance fallback in force
    const again = await runner.tick(); // cooling down: no read, no tx
    expect(again.error).toBeUndefined();
    expect(chain.pokes).toBe(0);
    chain.failPoke = null;
    now.t += 30_000;
    expect((await runner.tick()).poked).toBeDefined();
  });

  test("no reference in force (source 0): value null so callers keep their own fallback; no guard: nothing at all", async () => {
    const chain = new FakeEthRef();
    chain.state = { ...chain.state!, source: 0, valueWad: 0n, storedAt: 0 };
    const runner = mk(chain, { t: 0 });
    await runner.tick();
    expect(runner.valueWad).toBeNull();
    chain.state = null;
    const none = mk(chain, { t: 0 });
    expect((await none.tick()).state).toBeNull();
    expect(none.valueWad).toBeNull();
  });

  test("a failed read cools the duty down", async () => {
    const chain = new FakeEthRef();
    chain.failRead = true;
    const now = { t: 0 };
    const runner = mk(chain, now);
    expect((await runner.tick()).error).toBe("rpc down");
    chain.failRead = false;
    expect((await runner.tick()).poked).toBeUndefined(); // cooling down
    now.t += 30_000;
    expect((await runner.tick()).poked).toBeDefined();
  });
});

describe("ETH/USD of the liquidation gas policy with a BuybackGuard", () => {
  test("mainnet without an env value starts only when the deployment has a guard (its on-chain reference supplies it)", () => {
    const base = loadWaterfallConfig({});
    expect(() => liquidationEthUsd({ ...base, CHAIN_ID: 4663 })).toThrow(/without a BuybackGuard/);
    expect(liquidationEthUsd({ ...base, CHAIN_ID: 4663 }, true)).toBe(0n); // starts at 0 until the first on-chain read
    expect(liquidationEthUsd({ ...base, CHAIN_ID: 4663, WATERFALL_LIQ_ETH_USD: 2_000n * WAD }, true)).toBe(2_000n * WAD); // env = the starting value
    expect(() => liquidationEthUsd({ ...base, CHAIN_ID: 4663, WATERFALL_LIQ_ETH_USD: 3n * WAD }, true)).toThrow(/out of range/);
  });
});
