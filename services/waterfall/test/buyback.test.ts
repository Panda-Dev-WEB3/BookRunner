import { describe, expect, test } from "bun:test";
import { WAD, createLogger, usd } from "@bookrunner/shared";
import { type BuybackPolicy, BuybackRunner, Cooldowns, buybackDue, loadWaterfallConfig, minOutAfterSlippage, planBuyback, quoteAtPrice } from "../src/index";
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
    expect(plan).toEqual({ kind: "buy", amountIn: pending, quote, minOut: 464_706n * 10n ** 15n, priceSource: "router" });
  });

  test("slippage math floors and is bounded", () => {
    expect(minOutAfterSlippage(1_000n, 0n)).toBe(1_000n);
    expect(minOutAfterSlippage(1_000n, 100n)).toBe(990n);
    expect(minOutAfterSlippage(999n, 100n)).toBe(989n); // 989.01 floored
    expect(() => minOutAfterSlippage(1_000n, 10_000n)).toThrow("slippageBps");
  });

  test("no router quote: configured fallback price, else skip", () => {
    expect(planBuyback(usd("10"), null, policy)).toMatchObject({ kind: "skip", reason: expect.stringContaining("no BKRN price") });
    const p = planBuyback(usd("10"), null, { ...policy, fallbackBkrnPerUsdcWad: 5n * WAD });
    expect(p).toEqual({ kind: "buy", amountIn: usd("10"), quote: bkrn(50n), minOut: bkrn(50n) * 99n / 100n, priceSource: "config" });
    expect(planBuyback(usd("10"), 0n, policy).kind).toBe("skip"); // zero quote treated as none
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
    expect(chain.executed).toEqual([{ amountIn: usd("23.47"), minOut: 464_706n * 10n ** 15n, poolFee: 3000 }]);
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

  test("quote read fails and no fallback price: skipped with a cooldown, never sent with minOut 0", async () => {
    const { chain, runner } = setup();
    chain.pending = usd("15");
    chain.failQuote = true;
    expect((await runner.tick()).status).toBe("skipped");
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
    const d = loadWaterfallConfig({ WATERFALL_BUYBACK_THRESHOLD_USD: "25.5", WATERFALL_BUYBACK_SLIPPAGE_BPS: "50", WATERFALL_BUYBACK_BKRN_PER_USDC: "20" });
    expect(d.WATERFALL_BUYBACK_THRESHOLD_USD).toBe(usd("25.5"));
    expect(d.WATERFALL_BUYBACK_SLIPPAGE_BPS).toBe(50);
    expect(d.WATERFALL_BUYBACK_BKRN_PER_USDC).toBe(20n * WAD);
    expect(() => loadWaterfallConfig({ WATERFALL_BUYBACK_SLIPPAGE_BPS: "10000" })).toThrow("invalid environment");
  });
});
