import {
  type Charter,
  HEDGE_VENUES,
  ORACLE,
  SESSIONS_24X5,
  VENUE,
  encodeSessions,
  hedgeAllowTree,
  strToBytes32,
  tokenUnderlying,
  usd,
} from "@bookrunner/shared";
import type { Address } from "viem";
import type { RuleContext, StockTokenFacts } from "../src/domain/ruleChecks";
import { staticValidationContext, validateCharter } from "../src/domain/validate";

export const NVDA_TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
export const SPONSOR = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955" as Address; // anvil #7

/** ARCHITECTURE §7 NVDA launch book. */
export function nvdaCharter(overrides: Partial<Charter> = {}): Charter {
  const u = tokenUnderlying(NVDA_TOKEN);
  return {
    underlying: u,
    venue: VENUE.ORDERLY,
    oracle: ORACLE.ATTESTED,
    sessions: encodeSessions(SESSIONS_24X5),
    ifTargetUsd: usd("25000"),
    mmInventoryUsd: usd("75000"),
    mandate: {
      maxInventoryUsd: usd("50000"),
      maxSkewBps: 25,
      minQuoteWidthBps: 8,
      maxHedgeLeverage: 100,
      hedgeRatioMinBps: 5000,
      hedgeRatioMaxBps: 12000,
      noNewRiskOffHours: true,
      killAtDrawdownBps: -800,
      hedgeAllowRoot: hedgeAllowTree([{ asset: u, venue: HEDGE_VENUES.UNIV3 }]).root,
    },
    seniorHurdleBps: 6000,
    seniorCapBps: 7000,
    subscriptionWindow: 600,
    juniorNoticeSeconds: 900n,
    sponsor: SPONSOR,
    perWalletCapUsd: usd("250000"),
    symbol: strToBytes32("PERP_NVDA_USDC"),
    takerFeeBps: 0,
    makerFeeBps: 0,
    ...overrides,
  };
}

export const devValidationContext = staticValidationContext({
  venueMinIfUsd: { [VENUE.ORDERLY]: usd("25000"), [VENUE.POOL_ENGINE]: usd("10000") },
  canonicalTokens: [NVDA_TOKEN],
  indexIds: [],
});

export const nvdaToken = (over: Partial<StockTokenFacts> = {}): StockTokenFacts => ({
  token: NVDA_TOKEN,
  ticker: "NVDA",
  priceId: strToBytes32("NVDA"),
  multiplierWad: 10n ** 18n,
  decimals: 18,
  active: true,
  floatCapRaw: 10_000n * 10n ** 18n, // 10k tokens @ 190 = 1.9M USD
  priceWad: 190n * 10n ** 18n,
  ...over,
});

export function ruleContextFor(c: Charter, over: Partial<RuleContext> = {}): RuleContext {
  return {
    venueMinIfUsd: usd("25000"),
    validation: validateCharter(c, devValidationContext),
    underlying: { kind: "token", token: nvdaToken() },
    price: { priceWad: 190n * 10n ** 18n, publishedAt: 1_790_000_000, held: false },
    maxPriceAgeSec: 300,
    liquidity: { mode: "configured", usd: usd("5000000") },
    newBooksPaused: false,
    nowSec: 1_790_000_060,
    ...over,
  };
}
