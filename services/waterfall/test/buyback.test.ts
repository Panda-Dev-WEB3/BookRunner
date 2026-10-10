import { describe, expect, test } from "bun:test";
import { WAD, createLogger, usd } from "@bookrunner/shared";
import { type BuybackPolicy, BuybackRunner, Cooldowns, buybackAmount, buybackDue, loadWaterfallConfig, minOutAfterSlippage, planBuyback, quoteAtPrice, referenceSourceName } from "../src/index";
import { FakeBuybackChain } from "./fakes";

const log = createLogger("waterfall-test", "silent");
const policy: BuybackPolicy = { thresholdUsd: usd("10"), slippageBps: 100n, poolFee: 3000, fallbackBkrnPerUsdcWad: 0n };
const bkrn = (whole: bigint) => whole * WAD;

describe("buyback decision (pure)", () => {
  test("threshold", () => {
    expect(buybackDue(usd("9.999999"), usd("10"))).toBe(false);
    expect(buybackDue(usd("10"), usd("10"))).toBe(true);
    expect(buybackDue(0n, 0n)).toBe(false); // never a zero-amount buyback
    expect(planBuyback(usd("9.99"), bkrn(200n), policy)).toEqual({ kind: "skip", reason: "below threshold" });
  });

  test("minOut = router quote minus slippage (devnet: 20 BKRN per USDC)", () => {
    // 23.47 USDC at 20 BKRN/USDC = 469.4 BKRN quoted; 1% slippage -> 464.706 BKRN minimum
    const pending = usd("23.47");
    const quote = quoteAtPrice(pending, 20n * WAD);
    expect(quote).toBe(4694n * 10n ** 17n);
    const plan = planBuyback(pending, quote, policy);
    expect(plan).toEqual({ kind: "buy", amountIn: pending, quote, minOut: 464_706n * 10n ** 15n, floor: 0n, priceSource: "router" });
  });

  test("the on-chain floor only tightens: minOut = max(quote - slippage, floor)", () => {
    const pending = usd("100");
    const quote = bkrn(2000n);
    // 1% keeper slippage (1980) above a 5% floor (1900): keeper minimum wins
    expect(planBuyback(pending, quote, policy, { maxPerCall: 0n, floor: bkrn(1900n) })).toMatchObject({ kind: "buy", minOut: bkrn(1980n), floor: bkrn(1900n) });
    // 10% keeper slippage (1800) below the floor: the floor wins (the contract would raise it anyway)
    expect(planBuyback(pending, quote, { ...policy, slippageBps: 1000n }, { maxPerCall: 0n, floor: bkrn(1900n) })).toMatchObject({ kind: "buy", minOut: bkrn(1900n) });
  });

  test("router quote below the on-chain floor: skipped (pool off-market or stale reference), never sent", () => {
    expect(planBuyback(usd("100"), bkrn(1800n), policy, { maxPerCall: 0n, floor: bkrn(1900n) })).toMatchObject({ kind: "skip", reason: expect.stringContaining("below the on-chain reference floor") });
  });

  test("per-call cap: swaps maxBuybackPerCall now, the rest on later passes", () => {
    expect(buybackAmount(usd("500"), usd("200"))).toBe(usd("200"));
    expect(buybackAmount(usd("150"), usd("200"))).toBe(usd("150"));
    expect(buybackAmount(usd("500"), 0n)).toBe(usd("500")); // 0 = uncapped (legacy router)
    expect(planBuyback(usd("500"), bkrn(4000n), policy, { maxPerCall: usd("200"), floor: bkrn(3800n) })).toMatchObject({ kind: "buy", amountIn: usd("200"), minOut: bkrn(3960n) });
  });

  test("slippage math floors and is bounded", () => {
    expect(minOutAfterSlippage(1_000n, 0n)).toBe(1_000n);
    expect(minOutAfterSlippage(1_000n, 100n)).toBe(990n);
    expect(minOutAfterSlippage(999n, 100n)).toBe(989n); // 989.01 floored
    expect(() => minOutAfterSlippage(1_000n, 10_000n)).toThrow("slippageBps");
  });

  test("no router quote: configured fallback price, else the on-chain floor, else skip", () => {
    expect(planBuyback(usd("10"), null, policy)).toMatchObject({ kind: "skip", reason: expect.stringContaining("no BKRN price") });
    const p = planBuyback(usd("10"), null, { ...policy, fallbackBkrnPerUsdcWad: 5n * WAD });
    expect(p).toEqual({ kind: "buy", amountIn: usd("10"), quote: bkrn(50n), minOut: bkrn(50n) * 99n / 100n, floor: 0n, priceSource: "config" });
    expect(planBuyback(usd("10"), 0n, policy).kind).toBe("skip"); // zero quote treated as none
    // a real SwapRouter02 has no quote: the router's own reference floor is the minimum
    expect(planBuyback(usd("10"), null, policy, { maxPerCall: 0n, floor: bkrn(190n) })).toEqual({ kind: "buy", amountIn: usd("10"), quote: bkrn(190n), minOut: bkrn(190n), floor: bkrn(190n), priceSource: "reference" });
  });

  test("reference source names follow BkrnFeeRouter REF_FIXED / REF_TWAP / REF_ATTESTED", () => {
    expect([0, 1, 2, 3].map(referenceSourceName)).toEqual(["fixed", "twap", "attested", "unknown"]);
  });

  test("a quote that rounds minOut to zero is skipped (the contract rejects minBkrnOut == 0)", () => {
    expect(planBuyback(usd("10"), 1n, policy)).toEqual({ kind: "skip", reason: "quote rounds to zero BKRN" });
  });
});

describe("BuybackRunner", () => {
  function setup(now = { t: 1_000_000 }) {
    const chain = new FakeBuybackChain();
    const runner = new BuybackRunner({ chain, policy, cooldowns: new Cooldowns(() => now.t), cooldownMs: 30_000, log });
    return { chain, runner, now };
  }

  test("below threshold: no tx", async () => {
    const { chain, runner } = setup();
    chain.pending = usd("9");
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "below threshold" });
    expect(chain.executed).toEqual([]);
  });

  test("at threshold: swaps all pending with minOut from the router quote; idempotent next pass", async () => {
    const { chain, runner } = setup();
    chain.pending = usd("23.47");
    const out = await runner.tick();
    expect(out.status).toBe("bought");
    expect(chain.executed).toEqual([{ amountIn: usd("23.47"), minOut: 464_706n * 10n ** 15n }]); // pool fee pinned on-chain
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "below threshold" });
    expect(chain.executed).toHaveLength(1);
  });

  test("failed tx: warn, cool down, retry after the cooldown", async () => {
    const { chain, runner, now } = setup();
    chain.pending = usd("15");
    chain.failExecute = true;
    expect((await runner.tick()).status).toBe("failed");
    chain.failExecute = false;
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "cooldown" });
    now.t += 30_000;
    expect((await runner.tick()).status).toBe("bought");
    expect(chain.executed).toHaveLength(1);
  });

  test("quote read fails and no fallback price: buys at the on-chain floor", async () => {
    const { chain, runner } = setup();
    chain.pending = usd("15");
    chain.failQuote = true;
    const out = await runner.tick();
    expect(out).toMatchObject({ status: "bought", plan: { priceSource: "reference", minOut: bkrn(285n) } });
    expect(chain.executed).toEqual([{ amountIn: usd("15"), minOut: bkrn(285n) }]);
  });

  test("per-call cap: one capped buyback per pass", async () => {
    const { chain, runner } = setup();
    chain.pending = usd("50");
    chain.maxPerCall = usd("20");
    expect((await runner.tick()).status).toBe("bought");
    expect((await runner.tick()).status).toBe("bought");
    expect(chain.executed.map((e) => e.amountIn)).toEqual([usd("20"), usd("20")]);
    expect(chain.pending).toBe(usd("10"));
  });

  test("router quote below the on-chain floor: warn + cooldown, no tx", async () => {
    const { chain, runner } = setup();
    chain.pending = usd("15");
    chain.quoteWad = 18n * WAD; // pool 10% below the 20 BKRN/USDC reference (floor 19)
    expect(await runner.tick()).toMatchObject({ status: "skipped", reason: expect.stringContaining("below the on-chain reference floor") });
    expect(chain.executed).toEqual([]);
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "cooldown" });
  });

  test("floor read reverts (reference unset / oracle stale): failed with a cooldown, no tx", async () => {
    const { chain, runner } = setup();
    chain.pending = usd("15");
    chain.failFloor = true;
    expect((await runner.tick()).status).toBe("failed");
    expect(chain.executed).toEqual([]);
  });

  test("legacy (pre-bound) fee router: passes the configured pool fee, no floor; no quote + no fallback -> skip", async () => {
    const { chain, runner, now } = setup();
    chain.legacy = true;
    chain.failFloor = true; // never read for a legacy router
    chain.pending = usd("23.47");
    expect((await runner.tick()).status).toBe("bought");
    expect(chain.executed).toEqual([{ amountIn: usd("23.47"), minOut: 464_706n * 10n ** 15n, poolFee: 3000 }]);
    chain.pending = usd("15");
    chain.failQuote = true;
    now.t += 1;
    expect((await runner.tick()).status).toBe("skipped");
    expect(chain.executed).toHaveLength(1);
  });

  test("reports the router's reference source (fixed / twap / attested); a failed read is 'unknown', not fatal", async () => {
    const { chain, runner, now } = setup();
    chain.pending = usd("15");
    chain.reference = "twap";
    expect(await runner.tick()).toMatchObject({ status: "bought", reference: "twap" });
    chain.pending = usd("15");
    chain.reference = "throw";
    now.t += 1;
    expect(await runner.tick()).toMatchObject({ status: "bought", reference: "unknown" });
    // legacy router: no reference read
    chain.pending = usd("15");
    chain.legacy = true;
    chain.reference = "attested";
    expect(await runner.tick()).toMatchObject({ status: "bought", reference: "legacy" });
  });

  test("TWAP floor refused on-chain (spot deviates / short history): failed + cooldown, no tx", async () => {
    const { chain, runner } = setup();
    chain.pending = usd("15");
    chain.reference = "twap";
    chain.buybackFloor = async () => Promise.reject(new Error("execution reverted: TwapDeviation(-305282, -306282)"));
    expect((await runner.tick()).status).toBe("failed");
    expect(chain.executed).toEqual([]);
    expect(await runner.tick()).toEqual({ status: "skipped", reason: "cooldown" });
  });

  test("pending read fails: failed, cooled down (never throws into the loop)", async () => {
    const { chain, runner } = setup();
    chain.buybackPending = async () => Promise.reject(new Error("rpc down"));
    expect((await runner.tick()).status).toBe("failed");
  });
});

describe("buyback config", () => {
  test("defaults and parsing", () => {
    const c = loadWaterfallConfig({});
    expect(c.WATERFALL_BUYBACK_ENABLED).toBe(true);
    expect(c.WATERFALL_BUYBACK_THRESHOLD_USD).toBe(usd("10"));
    expect(c.WATERFALL_BUYBACK_SLIPPAGE_BPS).toBe(100);
    expect(c.WATERFALL_BUYBACK_POOL_FEE).toBe(3000);
    expect(c.WATERFALL_BUYBACK_BKRN_PER_USDC).toBe(0n);
    expect(c.WATERFALL_FEE_FORWARD_WAIT_SECONDS).toBe(45);
    expect(c.WATERFALL_UNIV3_QUOTER).toBe("");
    expect(loadWaterfallConfig({ WATERFALL_UNIV3_QUOTER: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" }).WATERFALL_UNIV3_QUOTER).toBe("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
    expect(() => loadWaterfallConfig({ WATERFALL_UNIV3_QUOTER: "quoter" })).toThrow("invalid environment");
    const d = loadWaterfallConfig({ WATERFALL_BUYBACK_THRESHOLD_USD: "25.5", WATERFALL_BUYBACK_SLIPPAGE_BPS: "50", WATERFALL_BUYBACK_BKRN_PER_USDC: "20" });
    expect(d.WATERFALL_BUYBACK_THRESHOLD_USD).toBe(usd("25.5"));
    expect(d.WATERFALL_BUYBACK_SLIPPAGE_BPS).toBe(50);
    expect(d.WATERFALL_BUYBACK_BKRN_PER_USDC).toBe(20n * WAD);
    expect(() => loadWaterfallConfig({ WATERFALL_BUYBACK_SLIPPAGE_BPS: "10000" })).toThrow("invalid environment");
  });
});
