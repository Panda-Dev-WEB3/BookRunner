// Agent / trader-sim behaviour under the low-gas design (docs/LOW_GAS.md §1, §4): off-hours from the
// carried price, off-chain desk valuation, off-chain engine quotes, liquidation pre-filter, defaults.
import { describe, expect, test } from "bun:test";
import { type OraclePriceMsg, SESSIONS_24X7, type QuotingVenue, hedgeAllowTree, usd, wad } from "@bookrunner/shared";
import { type Address, type Hex, zeroHash } from "viem";
import { type AgentChain, BookAgent, type BookAgentConfig } from "../src/agent/book-agent";
import { type HedgeChain, Hedger } from "../src/agent/hedger";
import { PriceFeed } from "../src/agent/price-feed";
import type { OraclePoint, StockTokenInfo } from "../src/chain/book-chain";
import type { DeskRunner } from "../src/chain/desk-client";
import { loadAgentEnv, loadSimEnv } from "../src/config";
import { valueUsdOf } from "../src/domain/hedge-planner";
import { buildHedgeUniverse, defaultAllowPairs } from "../src/domain/hedge-universe";
import { DEFAULT_QUOTING_CONFIG } from "../src/domain/quoting";
import { RuleBasedSizing } from "../src/domain/sizing";
import { DEFAULT_VOL_CONFIG, EwmaVolatility } from "../src/domain/volatility";
import { classifyTradeError, engineFillPriceWad, nearLiquidation } from "../src/sim/trader-logic";
import { FakeBus, FakeStore, nvdaMandate, silentLog } from "./helpers";

const SIG = `0x${"11".repeat(65)}` as Hex;

describe("BookAgent off-hours with carried prices", () => {
  const cfg: BookAgentConfig = {
    quoting: DEFAULT_QUOTING_CONFIG,
    quoteIntervalMs: 5,
    stateRefreshMs: 5,
    fillPollMs: 5,
    hedgeIntervalMs: 5,
    priceStaleSec: 30,
    chainPriceFallbackSec: 10,
    maxPriceAgeSec: 300,
    requoteBps: 1,
    requoteSizeFrac: 0.2,
    requoteMaxMs: 10_000,
    quoteSampleMs: 1_000,
    quoteReceiptMs: 5_000,
    receiptsIntervalSec: 60,
    heartbeatTtlMs: 60_000,
    quoteTtlMs: 10_000,
    fillLookbackMs: 60_000,
  };
  const now = 1_760_000_000_000;
  const msg = (signature: Hex, held = false): OraclePriceMsg => ({
    priceId: "NVDA",
    underlying: zeroHash,
    priceWad: "0",
    price: 190,
    publishedAt: now / 1000,
    held,
    sourceCount: 3,
    sources: [],
    sourcesHash: zeroHash,
    signature,
  });

  async function agent(pullPrices: boolean | undefined) {
    const chain: AgentChain = {
      readMandate: async () => nvdaMandate(),
      mandateKilled: async () => false,
      mandateOffHours: async () => true, // stored price stale: nothing landed on-chain recently
      bookState: async () => "Live",
    };
    const vol = new EwmaVolatility(DEFAULT_VOL_CONFIG);
    const a = new BookAgent(
      {
        bookId: 1,
        venue: {} as QuotingVenue,
        chain,
        price: new PriceFeed("NVDA", vol),
        vol,
        sizing: new RuleBasedSizing(),
        store: new FakeStore(),
        bus: new FakeBus(),
        hedger: null,
        sessions: SESSIONS_24X7,
        initialMandate: nvdaMandate(),
        log: silentLog,
        now: () => now,
      },
      { ...cfg, ...(pullPrices === undefined ? {} : { pullPrices }) },
    );
    await a.refreshState();
    return a;
  }

  test("pull: the stored-price off-hours view is ignored while the feed price is signed (it rides in the tx)", async () => {
    const a = await agent(true);
    expect(a.isOffHours(msg(SIG), now)).toBe(false);
    expect(a.isOffHours(msg("0x"), now)).toBe(true); // chain-fallback print: nothing to carry
    expect(a.isOffHours(msg(SIG, true), now)).toBe(true); // held still means off-hours
    expect(a.isOffHours({ ...msg(SIG), publishedAt: now / 1000 - 301 }, now)).toBe(true); // stale feed
  });

  test("legacy (no pull / unset): the on-chain view still forces off-hours", async () => {
    expect((await agent(false)).isOffHours(msg(SIG), now)).toBe(true);
    expect((await agent(undefined)).isOffHours(msg(SIG), now)).toBe(true);
  });
});

describe("Hedger desk valuation", () => {
  const DESK = "0x00000000000000000000000000000000000000d1" as Address;
  const NVDA = "0x00000000000000000000000000000000000000a1" as Address;
  const PRICE_ID = ("0x" + "4e564441".padEnd(64, "0")) as Hex;
  const balance = 200n * 10n ** 18n; // 200 NVDA tokens @ 190 = 38,000 USD

  function hedger(opts: { offchain?: boolean; views: "throw" | "zero" }) {
    const chain: HedgeChain = {
      deskHedgeUsd: async () => {
        if (opts.views === "throw") throw new Error("execution reverted: StalePrice");
        return 0n;
      },
      deskValueUsd: async () => {
        if (opts.views === "throw") throw new Error("execution reverted: StalePrice");
        return usd(1_000);
      },
      deskUsdc: async () => usd(1_000),
      tokenBalance: async () => balance,
      getToken: async (token): Promise<StockTokenInfo> => ({ token, priceId: PRICE_ID, multiplierWad: wad(1), decimals: 18, active: true, floatCapRaw: 10n ** 30n }),
      oracleLatest: async (): Promise<OraclePoint> => ({ priceWad: wad(190), publishedAt: 1, held: false, sourceCount: 3 }),
      vaultDeployable: async () => usd(1_000_000),
    };
    const comps = [{ token: NVDA, weightBps: 10_000 }];
    const mandate = nvdaMandate({ hedgeAllowRoot: hedgeAllowTree(defaultAllowPairs(comps)).root });
    const runner: DeskRunner = {
      key: DESK,
      execute: async () => zeroHash,
      run: async () => {
        throw new Error("no legs expected");
      },
    };
    const h = new Hedger({
      bookId: 1,
      desk: DESK,
      chain,
      runner,
      store: new FakeStore(),
      universe: buildHedgeUniverse(comps, mandate.hedgeAllowRoot),
      cfg: { minTradeUsd: usd(250), slippageBps: 100, perpEnabled: false, returnDustUsd: usd(1) },
      poolFee: 3000,
      receiptsIntervalSec: 60,
      log: silentLog,
      ...(opts.offchain ? { offchainValuation: true } : {}),
    });
    return { h, mandate };
  }

  const expectedRatio = (valueUsdOf(balance, wad(190), wad(1), 18) * 10_000n) / usd(40_000);

  test("pull: inventory valued from the snapshot (fresh signed prices), not the stored-price views", async () => {
    const { h, mandate } = hedger({ offchain: true, views: "zero" });
    const plan = await h.cycle({ mandate, mode: "normal", offHours: false, netExposureUsd: -usd(40_000), allowAddHedge: true });
    expect(plan.ratioBefore).toBe(expectedRatio); // 38k / 40k = 9500 bps: in band, no action
    expect(plan.action).toBe("none");
  });

  test("chain mode: a reverting view (StalePrice) falls back to the off-chain valuation", async () => {
    const { h, mandate } = hedger({ views: "throw" });
    const plan = await h.cycle({ mandate, mode: "normal", offHours: false, netExposureUsd: -usd(40_000), allowAddHedge: true });
    expect(plan.ratioBefore).toBe(expectedRatio);
  });
});

describe("trader-sim pull helpers", () => {
  test("engineFillPriceWad mirrors PoolEngine._fillPrice (ceil buys, floor sells, skew on both sides)", () => {
    const p = 100n * 10n ** 18n;
    // spread 12, skew +8: buy 100 * (2e4 + 12 + 16) / 2e4 = 100.14, sell 100 * (2e4 - 12 + 16) / 2e4 = 100.02
    expect(engineFillPriceWad(p, 12, 8, 1n)).toBe(100_140000000000000000n);
    expect(engineFillPriceWad(p, 12, 8, -1n)).toBe(100_020000000000000000n);
    expect(engineFillPriceWad(p, 10, -5, 5n)).toBe(100_000000000000000000n);
    // rounding: 1 wei * 20011/20000 -> ceil 2 for buys, floor 0 for sells
    expect(engineFillPriceWad(1n, 11, 0, 1n)).toBe(2n);
    expect(engineFillPriceWad(1n, 11, 0, -1n)).toBe(0n);
  });

  test("nearLiquidation: equity vs maintenance (+20% buffer)", () => {
    const px = 100n * 10n ** 18n;
    const size = 100n * 10n ** 18n; // 10k notional, 5% maintenance = 500 USD
    expect(nearLiquidation({ size, entryPriceWad: px, marginUsd: usd(5_000) }, px, 500)).toBe(false);
    expect(nearLiquidation({ size, entryPriceWad: px, marginUsd: usd(590) }, px, 500)).toBe(true); // < 600 (500 * 1.2)
    // a 10% drop wipes 1,000 USD of a 1,500 margin long: equity 500 < 450 * 1.2
    expect(nearLiquidation({ size, entryPriceWad: px, marginUsd: usd(1_500) }, 90n * 10n ** 18n, 500)).toBe(true);
    // the same drop helps a short
    expect(nearLiquidation({ size: -size, entryPriceWad: px, marginUsd: usd(1_500) }, 90n * 10n ** 18n, 500)).toBe(false);
    expect(nearLiquidation({ size: 0n, entryPriceWad: 0n, marginUsd: 0n }, px, 500)).toBe(false);
  });

  test("a carried price past maxTradePriceAge is a stale-price rejection, not off-hours", () => {
    // PoolEngine reverts StalePrice for a new-risk trade whose (carried) price is past maxTradePriceAge
    expect(classifyTradeError("StalePrice", "", { carriedPrice: true })).toBe("stale_price");
    // without a carried price, a stale stored price is the off-hours / oracle-down signal (close-only)
    expect(classifyTradeError("StalePrice", "")).toBe("off_hours");
    expect(classifyTradeError("StalePrice", "", { carriedPrice: false })).toBe("off_hours");
    // the in-tx oracle update rejected the bundle itself
    expect(classifyTradeError("BadSigner", "")).toBe("stale_price");
    expect(classifyTradeError("FuturePrice", "", { carriedPrice: true })).toBe("stale_price");
    // unrelated rejections keep their class whether or not a price was carried
    expect(classifyTradeError("MaxNetExposure", "", { carriedPrice: true })).toBe("exposure_cap");
    expect(classifyTradeError("ReduceOnly", "", { carriedPrice: true })).toBe("reduce_only");
  });
});

describe("low-gas defaults (docs/LOW_GAS.md §4)", () => {
  test("agent: re-quote on >= 5 bps / 5% cap steps, at most once a minute; pull prices auto", () => {
    const env = loadAgentEnv({ BOOK_ID: "1" });
    expect(env.ENGINE_MIN_RESEND_MS).toBe(60_000);
    expect(env.ENGINE_SPREAD_THRESHOLD_BPS).toBe(5);
    expect(env.ENGINE_SKEW_THRESHOLD_BPS).toBe(5);
    expect(env.ENGINE_EXPOSURE_STEP_BPS).toBe(500);
    expect(env.ENGINE_REFRESH_MS).toBe(900_000);
    expect(env.AGENT_PULL_PRICES).toBe("auto");
    expect(env.AGENT_PRICE_DATA_MAX_AGE_SECONDS).toBe(60);
    expect(env.AGENT_PRICE_DATA_SKIP_IF_STORED_SECONDS).toBe(120);
    expect(loadAgentEnv({ AGENT_PRICE_DATA_SKIP_IF_STORED_SECONDS: "0" }).AGENT_PRICE_DATA_SKIP_IF_STORED_SECONDS).toBe(0);
    expect(env.ORACLE_URL).toBeUndefined();
    expect(() => loadAgentEnv({ AGENT_PULL_PRICES: "maybe" })).toThrow(/AGENT_PULL_PRICES/);
  });

  test("trader-sim: 1 trade/min/book off the local devnet, 6 on it, explicit value wins", () => {
    expect(loadSimEnv({}).TRADER_SIM_TRADES_PER_MIN).toBe(6);
    expect(loadSimEnv({ CHAIN_ID: "46630" }).TRADER_SIM_TRADES_PER_MIN).toBe(1);
    expect(loadSimEnv({ CHAIN_ID: "46630", TRADER_SIM_TRADES_PER_MIN: "3" }).TRADER_SIM_TRADES_PER_MIN).toBe(3);
    expect(loadSimEnv({}).TRADER_SIM_PULL_PRICES).toBe("auto");
  });
});
