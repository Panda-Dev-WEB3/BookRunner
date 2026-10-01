// Deterministic rule checks run before the jury votes (pure; chain facts are prefetched into
// RuleContext by the chain adapter). Status semantics:
//   block — the charter should not be listed as filed (jurors must reject)
//   warn  — a risk the committee should weigh
//   info  — context only
import { type Charter, ORACLE, VENUE, decodeSessions, encodeSessions, formatUsd } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { ValidationResult } from "./validate";

export type CheckStatus = "pass" | "info" | "warn" | "block";

export interface RuleCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  metrics?: Record<string, string>;
}

export interface StockTokenFacts {
  token: Address;
  ticker?: string;
  priceId: Hex;
  multiplierWad: bigint;
  decimals: number;
  active: boolean;
  floatCapRaw: bigint;
  priceWad: bigint | null;
}

export type UnderlyingFacts =
  | { kind: "token"; token: StockTokenFacts }
  | { kind: "index"; components: Array<{ weightBps: number; token: StockTokenFacts }> }
  | { kind: "unknown" };

export interface PriceFacts {
  priceWad: bigint | null;
  publishedAt: number | null; // unix seconds
  held: boolean;
}

export interface RuleContext {
  venueMinIfUsd: bigint;
  validation: ValidationResult;
  underlying: UnderlyingFacts;
  /** Attested price for the charter underlying's priceId (index level for an index). */
  price: PriceFacts;
  maxPriceAgeSec: number;
  /**
   * Venue / DEX depth for the underlying in USD 6dp. "configured" = operator-supplied depth
   * (JURY_LIQUIDITY_JSON; VERIFY live sources on RHC), "devnet_mock" = MockSwapRouter fills at the
   * oracle price with no depth model, "unknown" = nothing available.
   */
  liquidity: { mode: "configured" | "devnet_mock" | "unknown"; usd: bigint | null };
  newBooksPaused: boolean;
  nowSec: number;
}

const BPS = 10_000n;
const WAD = 10n ** 18n;
const usd = (raw: bigint) => formatUsd(raw);

/** Registry valuation (ARCHITECTURE §2.7): qtyRaw * multiplier * price / (10^dec * 1e18) / 1e12 -> USD 6dp. */
export function tokenValueUsd(qtyRaw: bigint, t: Pick<StockTokenFacts, "multiplierWad" | "decimals">, priceWad: bigint): bigint {
  return (qtyRaw * t.multiplierWad * priceWad) / (10n ** BigInt(t.decimals) * WAD) / 10n ** 12n;
}

/** Max hedge notional (USD 6dp) the registry float caps allow; null when it cannot be valued. */
export function hedgeFloatCapacityUsd(u: UnderlyingFacts): bigint | null {
  if (u.kind === "token") {
    if (u.token.priceWad === null) return null;
    return tokenValueUsd(u.token.floatCapRaw, u.token, u.token.priceWad);
  }
  if (u.kind === "index") {
    let cap: bigint | null = null;
    for (const c of u.components) {
      if (c.token.priceWad === null || c.weightBps <= 0) return null;
      const v = (tokenValueUsd(c.token.floatCapRaw, c.token, c.token.priceWad) * BPS) / BigInt(c.weightBps);
      cap = cap === null || v < cap ? v : cap;
    }
    return cap;
  }
  return null;
}

export function runRuleChecks(c: Charter, ctx: RuleContext): RuleCheck[] {
  const m = c.mandate;
  const out: RuleCheck[] = [];
  const add = (id: string, status: CheckStatus, detail: string, metrics?: Record<string, string>) =>
    out.push(metrics ? { id, status, detail, metrics } : { id, status, detail });

  // 1. on-chain validation parity
  if (ctx.validation.ok) add("charter_validate", "pass", "charter passes the MarketCharter validation rules");
  else add("charter_validate", "block", `charter fails validation: ${ctx.validation.reasons.join(", ")}`, { reasons: ctx.validation.reasons.join(",") });

  // 2. venue minimum insurance fund
  const ifMetrics = { insuranceFundUsd: usd(c.ifTargetUsd), venueMinimumUsd: usd(ctx.venueMinIfUsd) };
  if (c.ifTargetUsd < ctx.venueMinIfUsd) add("venue_min_if", "block", "insurance fund is below the venue minimum", ifMetrics);
  else if (c.ifTargetUsd * 10n < ctx.venueMinIfUsd * 11n) add("venue_min_if", "info", "insurance fund is within 10% of the venue minimum", ifMetrics);
  else add("venue_min_if", "pass", "insurance fund meets the venue minimum", ifMetrics);

  // 3. oracle plan
  if (c.venue === VENUE.POOL_ENGINE && c.oracle !== ORACLE.ATTESTED) {
    add("oracle_plan", "block", "the in-house engine prices only from the attested oracle; charter names another oracle kind");
  } else if (c.oracle === ORACLE.CHAINLINK) {
    add("oracle_plan", "warn", "Chainlink equity feed availability on Robinhood Chain is unverified (VERIFY feed address)");
  } else {
    add("oracle_plan", "pass", "attested multi-source oracle with session-aware hold flags");
  }

  // 4. live price for the underlying
  const p = ctx.price;
  if (p.priceWad === null || p.publishedAt === null) {
    add("oracle_price", "warn", "no attested price published yet for the underlying");
  } else {
    const age = ctx.nowSec - p.publishedAt;
    const metrics = { priceWad: p.priceWad.toString(), ageSeconds: String(Math.max(age, 0)) };
    if (p.held) add("oracle_price", "info", "feed is currently held (off-hours)", metrics);
    else if (age > ctx.maxPriceAgeSec) add("oracle_price", "warn", "latest attested price is stale", metrics);
    else add("oracle_price", "pass", "fresh attested price", metrics);
  }

  // 5. sessions sanity
  out.push(...sessionChecks(c, ctx.underlying));

  // 6. mandate vs Stock Token float caps
  const needMax = (m.maxInventoryUsd * BigInt(m.hedgeRatioMaxBps)) / BPS;
  const needMin = (m.maxInventoryUsd * BigInt(m.hedgeRatioMinBps)) / BPS;
  const inactive = activeIssue(ctx.underlying);
  const capacity = hedgeFloatCapacityUsd(ctx.underlying);
  if (ctx.underlying.kind === "unknown") {
    add("mandate_float_cap", "warn", "underlying is not registered: float caps cannot be checked");
  } else if (inactive) {
    add("mandate_float_cap", "block", inactive);
  } else if (capacity === null) {
    add("mandate_float_cap", "warn", "float cap cannot be valued without a component price");
  } else if (capacity === 0n) {
    add("mandate_float_cap", "warn", "no float cap configured for the Stock Token(s); spot hedges may be impossible", { capacityUsd: "0" });
  } else {
    const metrics = { capacityUsd: usd(capacity), hedgeAtBandMinUsd: usd(needMin), hedgeAtBandMaxUsd: usd(needMax) };
    if (capacity < needMin) add("mandate_float_cap", "block", "float caps cannot hold even the minimum hedge band at full inventory", metrics);
    else if (capacity < needMax) add("mandate_float_cap", "warn", "float caps cap spot hedges below the top of the hedge band at full inventory", metrics);
    else add("mandate_float_cap", "pass", "float caps cover the full hedge band at max inventory", metrics);
  }

  // 7. mandate sanity
  if (m.maxInventoryUsd > c.mmInventoryUsd * 10n) {
    add("mandate_margin", "warn", "max inventory exceeds 10x the MM capital (initial margin 10%)", {
      maxInventoryUsd: usd(m.maxInventoryUsd),
      mmInventoryUsd: usd(c.mmInventoryUsd),
    });
  } else {
    add("mandate_margin", "pass", "MM capital supports max inventory at 10% initial margin");
  }
  if (m.minQuoteWidthBps > 0 && m.maxSkewBps > m.minQuoteWidthBps * 10) {
    add("mandate_quote", "warn", "allowed quote skew is more than 10x the minimum width", { maxSkewBps: String(m.maxSkewBps), minQuoteWidthBps: String(m.minQuoteWidthBps) });
  } else if (m.minQuoteWidthBps > 500) {
    add("mandate_quote", "info", "minimum quote width above 500 bps limits taker flow", { minQuoteWidthBps: String(m.minQuoteWidthBps) });
  } else {
    add("mandate_quote", "pass", "quote width and skew bounds are consistent");
  }
  if (m.killAtDrawdownBps < -2000) add("mandate_kill", "warn", "kill drawdown deeper than 20%", { killAtDrawdownBps: String(m.killAtDrawdownBps) });
  else add("mandate_kill", "pass", "kill drawdown within 20%", { killAtDrawdownBps: String(m.killAtDrawdownBps) });
  const bandIssues: string[] = [];
  if (m.hedgeRatioMinBps < 2000) bandIssues.push("hedge band floor below 20%");
  if (m.hedgeRatioMaxBps > 15_000) bandIssues.push("hedge band ceiling above 150%");
  if (m.maxHedgeLeverage > 300) bandIssues.push("perp hedge leverage above 3x");
  if (bandIssues.length) add("mandate_hedge", "warn", bandIssues.join("; "), { band: `${m.hedgeRatioMinBps}-${m.hedgeRatioMaxBps}`, leverage: String(m.maxHedgeLeverage) });
  else add("mandate_hedge", "pass", "hedge band and leverage within house ranges", { band: `${m.hedgeRatioMinBps}-${m.hedgeRatioMaxBps}` });

  // 8. liquidity of the underlying
  const liq = ctx.liquidity;
  if (liq.mode === "devnet_mock") {
    add("underlying_liquidity", "info", "devnet mock swap router fills at the oracle price; depth is not modelled");
  } else if (liq.usd === null) {
    add("underlying_liquidity", "warn", "venue/DEX depth for the underlying is unverified");
  } else if (needMax === 0n) {
    add("underlying_liquidity", "pass", "no hedge band requested");
  } else {
    const coverageBps = (liq.usd * BPS) / needMax;
    const metrics = { liquidityUsd: usd(liq.usd), hedgeAtBandMaxUsd: usd(needMax), coverageBps: coverageBps.toString() };
    if (coverageBps < BPS) add("underlying_liquidity", "block", "observed depth is below the hedge size at the top of the band", metrics);
    else if (coverageBps < 5n * BPS) add("underlying_liquidity", "warn", "observed depth is under 5x the hedge size at the top of the band", metrics);
    else add("underlying_liquidity", "pass", "observed depth covers the hedge band", metrics);
  }

  // 9. capital structure
  const capIssues: string[] = [];
  if (c.seniorCapBps > 8000) capIssues.push("Senior may exceed 80% of book capital (thin Junior layer)");
  if (c.ifTargetUsd * 5n < m.maxInventoryUsd) capIssues.push("insurance fund below 20% of max inventory");
  if (capIssues.length) add("capital_structure", "warn", capIssues.join("; "), { seniorCapBps: String(c.seniorCapBps) });
  else add("capital_structure", "pass", "loss layers and insurance fund are proportionate", { seniorCapBps: String(c.seniorCapBps) });

  if (ctx.newBooksPaused) add("new_books_paused", "warn", "the guardian has paused new books; no book can be created until unpaused");

  return out;
}

function activeIssue(u: UnderlyingFacts): string | null {
  if (u.kind === "token") return u.token.active ? null : "Stock Token is registered but inactive";
  if (u.kind === "index") {
    const off = u.components.filter((c) => !c.token.active).map((c) => c.token.ticker ?? c.token.token);
    return off.length ? `index components inactive: ${off.join(", ")}` : null;
  }
  return null;
}

function sessionChecks(c: Charter, u: UnderlyingFacts): RuleCheck[] {
  const s = decodeSessions(c.sessions);
  const problems: string[] = [];
  if (s.kind !== 0 && s.kind !== 1) problems.push(`unknown session kind ${s.kind}`);
  if (s.tz !== 0 && s.tz !== 1) problems.push(`unknown timezone id ${s.tz}`);
  if (s.holidays !== 0 && s.holidays !== 1) problems.push(`unknown holiday calendar ${s.holidays}`);
  if (s.days.some((d) => d.open > 1439 || d.close > 1439)) problems.push("session minute out of range");
  if (problems.length === 0) {
    try {
      if (encodeSessions(s).toLowerCase() !== c.sessions.toLowerCase()) problems.push("reserved session bits are set");
    } catch {
      problems.push("sessions cannot be re-encoded");
    }
  }
  if (problems.length) return [{ id: "sessions_sanity", status: "block", detail: problems.join("; ") }];

  if (s.kind === 0) {
    const equity = u.kind !== "unknown";
    return [
      equity
        ? { id: "sessions_sanity", status: "warn", detail: "24x7 session on an equity underlying: the reference market closes off-hours" }
        : { id: "sessions_sanity", status: "pass", detail: "24x7 session" },
    ];
  }
  const weeklyMinutes = s.days.reduce((acc, d) => {
    if (d.open === d.close) return acc;
    if (d.open === 0 && d.close === 1439) return acc + 1440;
    return acc + (d.close > d.open ? d.close - d.open : 1440 - d.open + d.close);
  }, 0);
  const metrics = { weeklyOpenHours: (weeklyMinutes / 60).toFixed(1), timezone: s.tz === 1 ? "America/New_York" : "UTC" };
  if (weeklyMinutes === 0) return [{ id: "sessions_sanity", status: "block", detail: "weekly schedule has no open minutes", metrics }];
  const out: RuleCheck[] = [];
  if (weeklyMinutes < 20 * 60) out.push({ id: "sessions_sanity", status: "warn", detail: "fewer than 20 open hours per week", metrics });
  else out.push({ id: "sessions_sanity", status: "pass", detail: "weekly session schedule decodes cleanly", metrics });
  if (!c.mandate.noNewRiskOffHours) {
    out.push({ id: "sessions_off_hours", status: "warn", detail: "mandate allows new risk while the feed is held off-hours" });
  }
  return out;
}

export function countByStatus(checks: RuleCheck[]): Record<CheckStatus, number> {
  const r: Record<CheckStatus, number> = { pass: 0, info: 0, warn: 0, block: 0 };
  for (const ch of checks) r[ch.status]++;
  return r;
}
