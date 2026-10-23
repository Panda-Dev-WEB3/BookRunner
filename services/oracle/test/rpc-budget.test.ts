// RPC budget (deploy/server/MAINNET.md "RPC budget"): on mainnet every Chainlink pass and every DEX pass is ONE
// Multicall3 aggregate3 eth_call (all tickers, one block), passes are reused for their read interval, Stock Token
// state is cached by the audit M-2 rules (split window and paused re-read at every pass, a change that became active
// after the cached read forces a new pass and fails closed), the head clock extrapolates, and the per-network cadence
// defaults and mainnet bounds hold.
import { describe, expect, test } from "bun:test";
import { MULTICALL3_ADDRESS, MULTIPLIER_VECTOR as V, WAD } from "@bookrunner/shared";
import { type Address, getAddress } from "viem";
import { DEFAULT_RPC_CADENCE, MAINNET_RPC_CADENCE, loadOracleConfig, rpcCadenceFor } from "../src/config";
import { HeadClock } from "../src/head";
import { MAINNET_RPC_BOUNDS, productionProblems, rpcCadenceProblems } from "../src/production";
import type { PriceSource } from "../src/domain/types";
import { type CachedTokenState, ChainlinkSource, type ResolvedFeed, SPLIT_WINDOW_REREAD_MS, aggregatorV3Abi, stockTokenAbi, tokenStateDue, tokenStatePredatesChange, viemAggregatorReader } from "../src/sources/chainlink";
import { DexTwapSource, uniswapV3OracleAbi, viemDexReader } from "../src/sources/dex-twap";
import { FACTORY, USDG, dexPool, liquidityForDepth, sqrtPriceX96At, tickFor } from "./dex-fakes";
import { FakeRpc } from "./rpc-fakes";

const TICKERS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"] as const;
const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const feedOf = (i: number) => addr(0xf00 + i);
const tokenOf = (i: number) => addr(0xd00 + i);
const SEQ = addr(0xe01);

interface TokenView {
  ui: bigint;
  next: bigint;
  eff: bigint;
  /** null = the view reverts (not implemented) */
  paused: boolean | null;
}

/** A mainnet node with five per-token feeds, their Stock Tokens and the sequencer feed. */
function chainlinkNode() {
  const rpc = new FakeRpc(4663);
  const updatedAt = BigInt(rpc.blockTs - 60);
  const tokens = new Map<Address, TokenView>();
  TICKERS.forEach((_, i) => {
    const t = tokenOf(i);
    tokens.set(t, { ui: V.uiMultiplierWad, next: V.uiMultiplierWad, eff: 0n, paused: i === 4 ? null : false });
    rpc.on(feedOf(i), aggregatorV3Abi, "latestRoundData", () => [1n, V.feedAnswer, updatedAt, updatedAt, 1n]);
    rpc.on(feedOf(i), aggregatorV3Abi, "decimals", () => 8);
    const view = () => tokens.get(t) as TokenView;
    rpc.on(t, stockTokenAbi, "uiMultiplier", () => view().ui);
    rpc.on(t, stockTokenAbi, "newUIMultiplier", () => view().next);
    rpc.on(t, stockTokenAbi, "effectiveAt", () => view().eff);
    rpc.on(t, stockTokenAbi, "oraclePaused", () => {
      const p = view().paused;
      if (p === null) throw new Error("not implemented");
      return p;
    });
  });
  rpc.on(SEQ, aggregatorV3Abi, "latestRoundData", () => [1n, 0n, BigInt(rpc.blockTs - 7_200), BigInt(rpc.blockTs - 7_200), 1n]);
  const feeds: Record<string, ResolvedFeed> = Object.fromEntries(
    TICKERS.map((t, i) => [t, { proxy: feedOf(i), basis: "per-token", token: tokenOf(i), decimals: 8, maxAgeMs: 86_400_000 + 600_000 } satisfies ResolvedFeed]),
  );
  return { rpc, feeds, tokens };
}

const fnsOf = (inner: Array<{ fn: string }>) => inner.map((c) => c.fn);
const tokenTargets = (rpc: FakeRpc, pass: number) =>
  new Set((rpc.aggregates[pass] ?? []).filter((c) => c.fn === "uiMultiplier").map((c) => getAddress(c.target)));

describe("Chainlink source on mainnet: one Multicall3 aggregate3 per pass", () => {
  test("every ticker of a tick shares ONE eth_call (sequencer, rounds, decimals, token views); reused for readIntervalMs", async () => {
    const { rpc, feeds } = chainlinkNode();
    let now = rpc.blockTs * 1000 + 500;
    const heads: number[] = [];
    const src = new ChainlinkSource(feeds, viemAggregatorReader(rpc.client(), MULTICALL3_ADDRESS), {
      sequencerFeed: SEQ,
      sequencerGraceMs: 3_600_000,
      readIntervalMs: 10_000,
      tokenStateIntervalMs: 10_000,
      now: () => now,
      onBlockTimestamp: (ts) => heads.push(ts),
    });
    const tick = () => Promise.all(TICKERS.map((t) => src.fetch(t)));

    const first = await tick();
    for (const o of first) expect(o?.price).toBeCloseTo(V.perSharePrice, 6);
    expect([...rpc.calls.entries()]).toEqual([["eth_call", 1]]);
    expect(rpc.aggregates).toHaveLength(1);
    // block timestamp + sequencer + 5 rounds + 5 decimals + 5 x 4 token views
    expect(rpc.aggregates[0]).toHaveLength(1 + 1 + 5 + 5 + 20);
    expect(fnsOf(rpc.aggregates[0] ?? []).slice(0, 2)).toEqual(["getCurrentBlockTimestamp", "latestRoundData"]);
    expect(heads).toEqual([rpc.blockTs]);

    // the next ticks inside the read interval: no RPC at all
    for (let s = 1; s < 10; s++) {
      now += 1_000;
      expect((await tick()).every((o) => o !== null)).toBe(true);
    }
    expect(rpc.count("eth_call")).toBe(1);

    // after it: one more aggregate3, decimals cached (never read again)
    now += 1_000;
    await tick();
    expect(rpc.count("eth_call")).toBe(2);
    expect(rpc.aggregates[1]).toHaveLength(1 + 1 + 5 + 20);
    expect(fnsOf(rpc.aggregates[1] ?? []).filter((f) => f === "decimals")).toEqual([]);
    expect(src.passes).toBe(2);
  });

  test("allowFailure: an optional token view that reverts is null, never a failed observation", async () => {
    const { rpc, feeds } = chainlinkNode();
    const src = new ChainlinkSource(feeds, viemAggregatorReader(rpc.client(), MULTICALL3_ADDRESS), { now: () => rpc.blockTs * 1000 });
    const o = await src.observe("AMZN"); // its oraclePaused() reverts
    if (!o.ok) throw new Error(o.reason);
    expect(src.tokenState(tokenOf(4))?.state.oraclePaused).toBeNull();
    // the required view reverting is a failed observation (thrown: per-source health counts it)
    rpc.on(tokenOf(4), stockTokenAbi, "uiMultiplier", () => {
      throw new Error("reverted");
    });
    await expect(src.observe("AMZN")).rejects.toThrow();
    expect(src.tokenState(tokenOf(4))).toBeNull(); // a failed read is never served from the cache
    // a revert in one feed does not fail the others of the pass
    expect((await src.observe("NVDA")).ok).toBe(true);
    expect(rpc.count("eth_call")).toBe(3);
  });

  test("without Multicall3 (devnet / testnet) the per-call reads stay as they were", async () => {
    const { feeds } = chainlinkNode();
    const rpc = chainlinkNode().rpc;
    const src = new ChainlinkSource(feeds, viemAggregatorReader(rpc.client(), null), { now: () => rpc.blockTs * 1000 });
    expect((await src.observe("NVDA")).ok).toBe(true);
    expect(rpc.aggregates).toHaveLength(0);
    expect(rpc.count("eth_call")).toBeGreaterThan(1);
  });
});

describe("Chainlink source: Stock Token state caching (audit M-2)", () => {
  test("cached for ORACLE_TOKEN_STATE_READ_MS; read at every pass inside the split window and while paused", async () => {
    const { rpc, feeds, tokens } = chainlinkNode();
    const t0 = rpc.blockTs * 1000;
    let now = t0;
    const src = new ChainlinkSource(feeds, viemAggregatorReader(rpc.client(), MULTICALL3_ADDRESS), { readIntervalMs: 10_000, tokenStateIntervalMs: 60_000, now: () => now });
    const tick = () => Promise.all(TICKERS.map((t) => src.fetch(t)));
    await tick();
    expect(tokenTargets(rpc, 0).size).toBe(5);
    now += 10_000;
    await tick();
    expect(tokenTargets(rpc, 1).size).toBe(0); // cached
    // at 60 s the states are due again; this read sees a change staged 5 min ahead (token 0) and a pause (token 1)
    tokens.set(tokenOf(0), { ui: V.uiMultiplierWad, next: V.uiMultiplierWad + 1n, eff: BigInt(rpc.blockTs + 360), paused: false });
    tokens.set(tokenOf(1), { ui: V.uiMultiplierWad, next: V.uiMultiplierWad, eff: 0n, paused: true });
    now = t0 + 60_000;
    await tick();
    expect(tokenTargets(rpc, 2).size).toBe(5);
    expect((await src.observe("TSLA")).ok).toBe(false); // paused: no observation
    // next pass: only the two tokens in the window / paused are read
    now += 10_000;
    await tick();
    expect(tokenTargets(rpc, 3)).toEqual(new Set([tokenOf(0), tokenOf(1)]));
    // the issuer clears the pause: picked up at the next pass
    tokens.set(tokenOf(1), { ui: V.uiMultiplierWad, next: V.uiMultiplierWad, eff: 0n, paused: false });
    now += 10_000;
    await tick();
    expect((await src.observe("TSLA")).ok).toBe(true);
    now += 10_000;
    await tick();
    expect(tokenTargets(rpc, 5)).toEqual(new Set([tokenOf(0)])); // TSLA cached again, NVDA still in its window
  });

  test("tokenStateDue / tokenStatePredatesChange (pure rules)", () => {
    const T = 1_790_000_000_000;
    const st = (over: Partial<CachedTokenState["state"]> = {}, readAtMs = T, blockTs: number | null = T / 1000): CachedTokenState => ({
      state: { uiMultiplier: WAD, newUIMultiplier: WAD, effectiveAt: 0n, oraclePaused: false, ...over },
      readAtMs,
      blockTs,
    });
    expect(tokenStateDue(undefined, T, 60_000)).toBe(true);
    expect(tokenStateDue(st(), T + 59_999, 60_000)).toBe(false);
    expect(tokenStateDue(st(), T + 60_000, 60_000)).toBe(true);
    expect(tokenStateDue(st({ oraclePaused: true }), T + 1, 60_000)).toBe(true);
    const effSec = (ms: number) => BigInt(Math.floor(ms / 1000));
    expect(tokenStateDue(st({ effectiveAt: effSec(T + SPLIT_WINDOW_REREAD_MS + 5_000) }), T + 1_000, 60_000)).toBe(false);
    expect(tokenStateDue(st({ effectiveAt: effSec(T + SPLIT_WINDOW_REREAD_MS) }), T + 1_000, 60_000)).toBe(true);
    expect(tokenStateDue(st({ effectiveAt: effSec(T - SPLIT_WINDOW_REREAD_MS + 5_000) }), T + 1_000, 60_000)).toBe(true); // just after a change
    // a change effective after the read, and by now: predates (fail closed); before the read: the state is post-change
    expect(tokenStatePredatesChange(st({ effectiveAt: effSec(T + 5_000) }), T + 5_000)).toBe(true);
    expect(tokenStatePredatesChange(st({ effectiveAt: effSec(T + 5_000) }), T + 4_000)).toBe(false);
    expect(tokenStatePredatesChange(st({ effectiveAt: effSec(T - 5_000) }), T + 60_000)).toBe(false);
    // per-call reads (no block timestamp): the wall clock of the read stands in
    expect(tokenStatePredatesChange(st({ effectiveAt: effSec(T + 5_000) }, T, null), T + 6_000)).toBe(true);
  });

  test("a split that becomes active between passes: a new pass at once, fail closed until a post-change read, then the M-2 rule", async () => {
    const { rpc, feeds, tokens } = chainlinkNode();
    const t0 = rpc.blockTs * 1000;
    let now = t0;
    const src = new ChainlinkSource(feeds, viemAggregatorReader(rpc.client(), MULTICALL3_ADDRESS), { readIntervalMs: 10_000, tokenStateIntervalMs: 60_000, now: () => now });
    // a 10:1 split staged 5 s ahead
    const eff = BigInt(rpc.blockTs + 5);
    tokens.set(tokenOf(0), { ui: V.uiMultiplierWad, next: 10n * V.uiMultiplierWad, eff, paused: false });
    const pre = await src.observe("NVDA");
    if (!pre.ok) throw new Error(pre.reason);
    expect(pre.pendingMultiplier).toEqual({ value: 10n * V.uiMultiplierWad, effectiveAt: Number(eff) });
    expect(rpc.count("eth_call")).toBe(1);
    // 6 s later (inside the read interval) the split is active: the cached state predates it -> a new pass now. The
    // chain still serves a pre-change block: fail closed, never the old multiplier under a post-change timestamp
    now = t0 + 6_000;
    const lagging = await src.observe("NVDA");
    expect(rpc.count("eth_call")).toBe(2);
    expect(!lagging.ok && lagging.reason).toContain("after the token state was read");
    // the chain passes effectiveAt: the token reports the new multiplier; the feed's round predates the change and the
    // step is beyond the band -> no per-share price until the feed's next round (audit M-2, unchanged)
    rpc.blockTs += 6;
    tokens.set(tokenOf(0), { ui: 10n * V.uiMultiplierWad, next: 10n * V.uiMultiplierWad, eff, paused: false });
    now = t0 + 7_000;
    const post = await src.observe("NVDA");
    expect(rpc.count("eth_call")).toBe(3);
    expect(!post.ok && post.reason).toContain("share unit");
    // other tickers are unaffected meanwhile
    expect((await src.observe("TSLA")).ok).toBe(true);
  });
});

describe("DEX TWAP source on mainnet: block + one aggregate3 per pass", () => {
  function dexNode() {
    const rpc = new FakeRpc(4663);
    const pools = [
      { ticker: "NVDA", pool: addr(0xa01), token: tokenOf(0), price: 213.2 },
      { ticker: "TSLA", pool: addr(0xa02), token: tokenOf(1), price: 349.8 },
    ];
    const index = new Map<Address, number>();
    for (const p of pools) {
      // token1 = Stock Token, token0 = USDG (so the token is not token0)
      const tick = tickFor(p.price, false);
      const sq = sqrtPriceX96At(tick);
      index.set(p.pool, 10);
      rpc.on(p.pool, uniswapV3OracleAbi, "token0", () => USDG);
      rpc.on(p.pool, uniswapV3OracleAbi, "token1", () => p.token);
      rpc.on(p.pool, uniswapV3OracleAbi, "slot0", () => [sq, tick, index.get(p.pool) as number, 7200, 7200, 0, true]);
      rpc.on(p.pool, uniswapV3OracleAbi, "liquidity", () => liquidityForDepth(500_000, sq, true));
      rpc.on(p.pool, uniswapV3OracleAbi, "observations", (args) => {
        const i = Number(args[0]);
        const ts = i === index.get(p.pool) ? rpc.blockTs - 30 : rpc.blockTs - 86_400;
        return [ts, 0n, 0n, true];
      });
      rpc.on(p.pool, uniswapV3OracleAbi, "observe", (args) => [(args[0] as readonly number[]).map((ago) => 123_456_789n - BigInt(tick) * BigInt(ago)), [0n, 0n]]);
      rpc.on(p.token, stockTokenAbi, "uiMultiplier", () => WAD);
      rpc.on(p.token, stockTokenAbi, "newUIMultiplier", () => WAD);
      rpc.on(p.token, stockTokenAbi, "effectiveAt", () => 0n);
      rpc.on(p.token, stockTokenAbi, "oraclePaused", () => false);
    }
    rpc.on(USDG, aggregatorV3Abi, "decimals", () => 6);
    // the factory answers per (token, quote) pair: one handler dispatching on the token argument
    rpc.on(FACTORY, uniswapV3OracleAbi, "getPool", (args) => pools.find((p) => p.token === args[0] || p.token === args[1])?.pool ?? addr(0));
    const config = Object.fromEntries(pools.map((p) => [p.ticker, dexPool(p.pool, p.token)]));
    return { rpc, pools, index, config };
  }

  test("first pass: one-time pool checks, then block + one aggregate3 (pools) + one (rings); later passes: block + one aggregate3", async () => {
    const { rpc, config, index, pools } = dexNode();
    let now = rpc.blockTs * 1000 + 800;
    const heads: number[] = [];
    const src = new DexTwapSource(config, viemDexReader(rpc.client(), MULTICALL3_ADDRESS), { maxAgeMs: 120_000, factory: FACTORY, readIntervalMs: 60_000, now: () => now, onBlockTimestamp: (ts) => heads.push(ts) });
    const tick = () => Promise.all(["NVDA", "TSLA"].map((t) => src.observe(t)));

    const first = await tick();
    for (const o of first) if (!o.ok) throw new Error(o.reason);
    expect(first[0]?.ok && first[0].price).toBeCloseTo(213.2, 0);
    expect(rpc.count("eth_getBlockByNumber")).toBe(1);
    // getPool + token0 + token1 per pool, the quote decimals once (cached for good), then the two aggregate3
    expect(rpc.count("eth_call")).toBe(2 * 3 + 1 + 2);
    expect(rpc.aggregates).toHaveLength(2);
    expect(rpc.aggregates[0]).toHaveLength(2 * (3 + 4)); // slot0, liquidity, observe, 4 token views per pool
    expect(rpc.aggregates[1]).toHaveLength(2 * 3); // next, newest and slot-0 observations per pool
    const pinned = rpc.callBlocks.slice(-2);
    expect(pinned).toEqual([`0x${rpc.blockNumber.toString(16)}`, `0x${rpc.blockNumber.toString(16)}`]);
    expect(heads).toEqual([rpc.blockTs]);

    // inside the read interval: nothing
    now += 59_000;
    await tick();
    expect(rpc.count("eth_call")).toBe(9);
    // after it, rings unchanged: the block + ONE aggregate3
    rpc.reset();
    now += 1_000;
    await tick();
    expect([...rpc.calls.entries()].sort()).toEqual([["eth_call", 1], ["eth_getBlockByNumber", 1]]);
    // a swap moved one pool's observation index: one more aggregate3, for that pool only
    rpc.reset();
    index.set(pools[0]!.pool, 11);
    now += 60_000;
    const moved = await tick();
    expect(moved.every((o) => o.ok)).toBe(true);
    expect(rpc.count("eth_call")).toBe(2);
    expect(rpc.aggregates[1]).toHaveLength(3);
  });
});

describe("cadence: per-network defaults, mainnet bounds", () => {
  test("mainnet defaults; devnet / testnet read every tick (unchanged); env overrides; token state follows the Chainlink pass", () => {
    expect(rpcCadenceFor(4663, {})).toEqual(MAINNET_RPC_CADENCE);
    expect(MAINNET_RPC_CADENCE).toEqual({ chainlinkReadMs: 10_000, tokenStateReadMs: 10_000, dexReadMs: 60_000, dexMaxAgeMs: 120_000, headReadMs: 30_000 });
    expect(rpcCadenceFor(46630, {})).toEqual(DEFAULT_RPC_CADENCE);
    expect(rpcCadenceFor(31337, {})).toEqual({ chainlinkReadMs: 0, tokenStateReadMs: 0, dexReadMs: 0, dexMaxAgeMs: 60_000, headReadMs: 0 });
    expect(rpcCadenceFor(4663, { ORACLE_CHAINLINK_READ_MS: 5_000 }).tokenStateReadMs).toBe(5_000);
    expect(rpcCadenceFor(4663, { ORACLE_CHAINLINK_READ_MS: 5_000, ORACLE_TOKEN_STATE_READ_MS: 60_000 }).tokenStateReadMs).toBe(60_000);
    const main = loadOracleConfig({ CHAIN_ID: "4663" });
    expect(main.cadence).toEqual(MAINNET_RPC_CADENCE);
    expect(main.ORACLE_DEX_MAX_AGE_MS).toBe(120_000);
    expect(main.ORACLE_TICK_MS).toBe(1_000); // the signing tick is not slowed down (no RPC of its own)
    const testnet = loadOracleConfig({ CHAIN_ID: "46630" });
    expect(testnet.cadence).toEqual(DEFAULT_RPC_CADENCE);
    expect(testnet.ORACLE_DEX_MAX_AGE_MS).toBe(60_000);
    expect(loadOracleConfig({ CHAIN_ID: "4663", ORACLE_DEX_READ_MS: "30000", ORACLE_HEAD_READ_MS: "5000" }).cadence).toMatchObject({ dexReadMs: 30_000, headReadMs: 5_000 });
    expect(() => loadOracleConfig({ ORACLE_CHAINLINK_READ_MS: "-1" })).toThrow("invalid environment");
  });

  test("mainnet bounds refuse a misconfiguration (a 100 ms tick, a hot read loop, a stale reused pass)", () => {
    const base = { tickMs: 1_000, ...MAINNET_RPC_CADENCE };
    expect(rpcCadenceProblems(base)).toEqual([]);
    expect(rpcCadenceProblems({ ...base, tickMs: 100 })).toEqual(["ORACLE_TICK_MS=100 outside 1000-5000 ms on mainnet (signing cadence: RPC-free, but each tick re-signs every price)"]);
    expect(rpcCadenceProblems({ ...base, chainlinkReadMs: 100, tokenStateReadMs: 100 })[0]).toContain("ORACLE_CHAINLINK_READ_MS=100 outside 2000-30000");
    expect(rpcCadenceProblems({ ...base, chainlinkReadMs: 60_000, tokenStateReadMs: 60_000 })[0]).toContain("ORACLE_CHAINLINK_READ_MS=60000");
    expect(rpcCadenceProblems({ ...base, tokenStateReadMs: 5_000 })[0]).toContain("ORACLE_TOKEN_STATE_READ_MS=5000 outside 10000-60000");
    expect(rpcCadenceProblems({ ...base, tokenStateReadMs: 120_000 })[0]).toContain("ORACLE_TOKEN_STATE_READ_MS=120000");
    expect(rpcCadenceProblems({ ...base, dexReadMs: 90_000 })[0]).toContain("ORACLE_DEX_READ_MS=90000 outside 10000-60000");
    expect(rpcCadenceProblems({ ...base, dexReadMs: 1_000 })[0]).toContain("ORACLE_DEX_READ_MS=1000");
    expect(rpcCadenceProblems({ ...base, headReadMs: 0 })[0]).toContain("ORACLE_HEAD_READ_MS=0 outside 1000-60000");
    expect(MAINNET_RPC_BOUNDS.tickMs.min).toBe(1_000);
    // wired into the startup refusal (productionProblems), mainnet only
    const src = (name: string, kind: PriceSource["kind"]): PriceSource => ({ name, kind, fetch: async () => null });
    const sources = [src("chainlink", "chainlink"), src("dex-twap", "dex")];
    const mainnet = (env: Record<string, string> = {}) => loadOracleConfig({ CHAIN_ID: "4663", ORACLE_SYNTHETIC: "0", SESSIONS_MODE: "charter", ...env });
    expect(productionProblems(mainnet(), sources)).toEqual([]);
    expect(productionProblems(mainnet({ ORACLE_TICK_MS: "100" }), sources)).toEqual([expect.stringContaining("ORACLE_TICK_MS=100")]);
    expect(productionProblems(mainnet({ ORACLE_CHAINLINK_READ_MS: "0" }), sources)).toEqual([expect.stringContaining("ORACLE_CHAINLINK_READ_MS=0")]);
    expect(productionProblems(loadOracleConfig({ CHAIN_ID: "46630", ORACLE_TICK_MS: "100" }), [])).toEqual([]);
  });
});

describe("HeadClock", () => {
  test("maxAgeMs 0 reads every time; above 0 a recent observation is extrapolated, an old one re-read", async () => {
    let now = 1_000_000;
    let reads = 0;
    const read = async () => {
      reads++;
      return 1_790_000_000 + reads;
    };
    const every = new HeadClock({ read, maxAgeMs: 0, now: () => now });
    await every.headTimestamp();
    every.observe(1_800_000_000);
    await every.headTimestamp();
    expect(reads).toBe(2);

    reads = 0;
    const clock = new HeadClock({ read, maxAgeMs: 30_000, now: () => now });
    clock.observe(1_790_000_100, now);
    now += 12_500;
    expect(await clock.headTimestamp()).toBe(1_790_000_112);
    expect(reads).toBe(0);
    now += 17_500; // 30 s after the observation: read
    expect(await clock.headTimestamp()).toBe(1_790_000_001);
    expect(reads).toBe(1);
    // concurrent callers share one read
    now += 60_000;
    await Promise.all([clock.headTimestamp(), clock.headTimestamp(), clock.headTimestamp()]);
    expect(reads).toBe(2);
    // an older observation never replaces a newer one
    clock.observe(1, now - 1);
    expect(await clock.headTimestamp()).toBe(1_790_000_002);
  });
});
