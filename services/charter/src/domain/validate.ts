// Pure TS mirror of MarketCharter.validate (ARCHITECTURE §2.6). Returns the FIRST failing reason in
// the documented order — the same bytes32 short string the contract returns / reverts with
// (InvalidCharter(reason)) — plus every failing reason for UI feedback.
// VERIFY: check order and boundaries against contracts/src/MarketCharter.sol once it lands
// (the charter API also cross-checks with an eth_call to validate() when the chain is reachable).
import { type Charter, ORACLE, VENUE, bytes32ToStr, isTokenUnderlying, strToBytes32, underlyingToToken } from "@bookrunner/shared";
import { type Address, type Hex, zeroHash } from "viem";

export const REASON_CODES = [
  "IF_BELOW_VENUE_MIN",
  "BAD_VENUE",
  "BAD_ORACLE",
  "BAD_BPS",
  "BAD_WINDOW",
  "BAD_NOTICE",
  "BAD_MANDATE",
  "BAD_UNDERLYING",
  "BAD_SYMBOL",
  "BAD_FEES",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const MIN_WINDOW_SECONDS = 60;
export const MAX_WINDOW_SECONDS = 30 * 86_400;
export const MAX_NOTICE_SECONDS = 30n * 86_400n;
export const MIN_KILL_DRAWDOWN_BPS = -5000;
export const MAX_INHOUSE_TAKER_FEE_BPS = 100;

/** Chain facts validate() reads (config.venueMinIfUsd, registry.isCanonical / isIndex). */
export interface ValidationContext {
  venueMinIfUsd(venue: number): bigint;
  isCanonicalToken(token: Address): boolean;
  isIndex(underlying: Hex): boolean;
}

export interface ValidationResult {
  ok: boolean;
  reason: ReasonCode | null;
  /** bytes32 short string as returned by MarketCharter.validate (zero hash when ok). */
  reasonBytes32: Hex;
  reasons: ReasonCode[];
  details: Partial<Record<ReasonCode, string>>;
}

export const reasonToBytes32 = (r: ReasonCode): Hex => strToBytes32(r);

/** bytes32 returned by the contract -> reason code (null for zero / unknown values). */
export function reasonFromBytes32(b: Hex): ReasonCode | null {
  if (/^0x0{64}$/i.test(b)) return null;
  const s = bytes32ToStr(b);
  return (REASON_CODES as readonly string[]).includes(s) ? (s as ReasonCode) : null;
}

export function validateCharter(c: Charter, ctx: ValidationContext): ValidationResult {
  const reasons: ReasonCode[] = [];
  const details: Partial<Record<ReasonCode, string>> = {};
  const fail = (r: ReasonCode, d: string) => {
    if (!reasons.includes(r)) reasons.push(r);
    details[r] = details[r] ? `${details[r]}; ${d}` : d;
  };

  const minIf = ctx.venueMinIfUsd(c.venue);
  if (c.ifTargetUsd < minIf) fail("IF_BELOW_VENUE_MIN", `insurance fund ${c.ifTargetUsd} < venue minimum ${minIf} (6dp)`);

  if (c.venue !== VENUE.ORDERLY && c.venue !== VENUE.POOL_ENGINE) fail("BAD_VENUE", `unknown venue ${c.venue}`);

  if (c.oracle !== ORACLE.CHAINLINK && c.oracle !== ORACLE.ATTESTED) fail("BAD_ORACLE", `unknown oracle kind ${c.oracle}`);

  if (c.seniorHurdleBps > 10_000) fail("BAD_BPS", `seniorHurdleBps ${c.seniorHurdleBps} > 10000`);
  if (c.seniorCapBps > 10_000) fail("BAD_BPS", `seniorCapBps ${c.seniorCapBps} > 10000`);
  if (c.seniorCapBps === 0) fail("BAD_BPS", "seniorCapBps is 0");

  if (c.subscriptionWindow < MIN_WINDOW_SECONDS) fail("BAD_WINDOW", `subscription window ${c.subscriptionWindow}s < ${MIN_WINDOW_SECONDS}s`);
  if (c.subscriptionWindow > MAX_WINDOW_SECONDS) fail("BAD_WINDOW", `subscription window ${c.subscriptionWindow}s > 30d`);

  if (c.juniorNoticeSeconds > MAX_NOTICE_SECONDS) fail("BAD_NOTICE", `junior notice ${c.juniorNoticeSeconds}s > 30d`);

  const m = c.mandate;
  if (m.maxInventoryUsd === 0n) fail("BAD_MANDATE", "maxInventoryUsd is 0");
  if (m.minQuoteWidthBps === 0) fail("BAD_MANDATE", "minQuoteWidthBps is 0");
  if (m.hedgeRatioMinBps > m.hedgeRatioMaxBps) fail("BAD_MANDATE", `hedge band min ${m.hedgeRatioMinBps} > max ${m.hedgeRatioMaxBps}`);
  if (m.killAtDrawdownBps >= 0) fail("BAD_MANDATE", `killAtDrawdownBps ${m.killAtDrawdownBps} must be negative`);
  if (m.killAtDrawdownBps < MIN_KILL_DRAWDOWN_BPS) fail("BAD_MANDATE", `killAtDrawdownBps ${m.killAtDrawdownBps} < ${MIN_KILL_DRAWDOWN_BPS}`);
  if (m.maxSkewBps <= 0) fail("BAD_MANDATE", `maxSkewBps ${m.maxSkewBps} must be positive`);

  if (!underlyingKnown(c.underlying, ctx)) fail("BAD_UNDERLYING", "underlying is neither a canonical Stock Token nor a registered index");

  if (c.symbol.toLowerCase() === zeroHash) fail("BAD_SYMBOL", "symbol is empty");

  if (c.venue === VENUE.POOL_ENGINE && c.takerFeeBps > MAX_INHOUSE_TAKER_FEE_BPS) {
    fail("BAD_FEES", `in-house taker fee ${c.takerFeeBps} bps > ${MAX_INHOUSE_TAKER_FEE_BPS}`);
  }

  // order reasons as the contract checks them
  reasons.sort((a, b) => REASON_CODES.indexOf(a) - REASON_CODES.indexOf(b));
  const reason = reasons[0] ?? null;
  return { ok: reason === null, reason, reasonBytes32: reason ? reasonToBytes32(reason) : zeroHash, reasons, details };
}

function underlyingKnown(u: Hex, ctx: ValidationContext): boolean {
  if (isTokenUnderlying(u)) {
    if (/^0x0{64}$/i.test(u)) return false;
    return ctx.isCanonicalToken(underlyingToToken(u));
  }
  return ctx.isIndex(u);
}

/** Context from plain data (prefetched chain facts or the deployment file when offline). */
export function staticValidationContext(p: {
  venueMinIfUsd: Partial<Record<number, bigint>>;
  canonicalTokens: Iterable<string>;
  indexIds: Iterable<string>;
}): ValidationContext {
  const tokens = new Set([...p.canonicalTokens].map((t) => t.toLowerCase()));
  const indexes = new Set([...p.indexIds].map((t) => t.toLowerCase()));
  return {
    venueMinIfUsd: (v) => p.venueMinIfUsd[v] ?? 0n,
    isCanonicalToken: (t) => tokens.has(t.toLowerCase()),
    isIndex: (u) => indexes.has(u.toLowerCase()),
  };
}

/** Mainnet defaults from ARCHITECTURE §2.1 (used when the chain is unreachable). */
export const DEFAULT_VENUE_MIN_IF_USD: Record<number, bigint> = {
  [VENUE.ORDERLY]: 25_001n * 10n ** 6n, // Orderly requires IF > 25,000 per symbol (strict, VERIFY O10)
  [VENUE.POOL_ENGINE]: 10_000n * 10n ** 6n,
};
