// "File a charter" form model: human-unit form state -> charter.file draft input, with client-side
// hints that mirror MarketCharter.validate (the API and the chain stay authoritative).
import { DEFAULT_IF_FROM_POOL, DEFAULT_IF_POOL_FALLBACK, DEFAULT_MIN_OWN_CAPITAL_BPS, DEFAULT_PREMIUM_FLOOR_BPS, MAX_PREMIUM_BPS } from "@bookrunner/shared/insurancePool";
import { parseVenueSymbol } from "@bookrunner/shared/venueSymbol";
import type { CharterDraftInput } from "./api-types";
import { getSettlementSymbol } from "./settlementToken";

export type HedgeVenue = "UNIV3" | "UNIV4" | "ORDERLY" | "ENGINE";
export type SessionsPreset = "24x5" | "nyse_rth" | "24x7";
export type StepId = "market" | "capital" | "mandate" | "tranches" | "review";

export interface MandateForm {
  maxInventoryUsd: string;
  maxSkewBps: string;
  minQuoteWidthBps: string;
  maxHedgeLeverage: string;
  hedgeRatioMinBps: string;
  hedgeRatioMaxBps: string;
  noNewRiskOffHours: boolean;
  killAtDrawdownBps: string;
  hedgeAllow: Array<{ asset: string; venue: HedgeVenue }>;
}

export interface CharterForm {
  name: string;
  description: string;
  sponsor: string;
  underlyingKind: "ticker" | "token" | "index";
  underlying: string;
  venue: "orderly" | "pool_engine";
  oracle: "attested" | "chainlink";
  sessions: SessionsPreset;
  symbol: string;
  takerFeeBps: string;
  makerFeeBps: string;
  ifSizeUsd: string;
  mmInventoryUsd: string;
  /** 2026-10: the insurance pool funds the IF (the window raises only the MM inventory); false: the tranches do. */
  ifFromPool: boolean;
  /** Pool premium in bps of gross fee flow; "0" = the pool's floor. Must be 0 when the tranches fund the IF. */
  premiumBps: string;
  /** If the pool cannot fund the IF at window close: true raises it from the tranches, false (default) cancels the window. */
  ifPoolFallback: boolean;
  mandate: MandateForm;
  seniorCapBps: string;
  seniorShareBps: string;
  windowSeconds: string;
  juniorNoticeSeconds: string;
  perWalletCapUsd: string;
}

export const STEPS: Array<{ id: StepId; label: string }> = [
  { id: "market", label: "Market" },
  { id: "capital", label: "Capital" },
  { id: "mandate", label: "Mandate" },
  { id: "tranches", label: "Tranche terms" },
  { id: "review", label: "Review" },
];

/** Devnet example (ARCHITECTURE §7, NVDA book). */
export const DEFAULT_FORM: CharterForm = {
  name: "NVDA perp book",
  description: "",
  sponsor: "",
  underlyingKind: "ticker",
  underlying: "NVDA",
  venue: "orderly",
  oracle: "attested",
  sessions: "24x5",
  symbol: "PERP_NVDA_USDC",
  takerFeeBps: "0",
  makerFeeBps: "0",
  ifSizeUsd: "30000",
  mmInventoryUsd: "75000",
  ifFromPool: DEFAULT_IF_FROM_POOL,
  premiumBps: "0",
  ifPoolFallback: DEFAULT_IF_POOL_FALLBACK,
  mandate: {
    maxInventoryUsd: "50000",
    maxSkewBps: "4",
    minQuoteWidthBps: "8",
    maxHedgeLeverage: "1",
    hedgeRatioMinBps: "5000",
    hedgeRatioMaxBps: "12000",
    noNewRiskOffHours: true,
    killAtDrawdownBps: "-800",
    hedgeAllow: [{ asset: "NVDA", venue: "UNIV3" }],
  },
  seniorCapBps: "7000",
  seniorShareBps: "6000",
  windowSeconds: "600",
  juniorNoticeSeconds: "86400",
  perWalletCapUsd: "250000",
};

export const SESSION_PRESETS: Array<{ id: SessionsPreset; label: string; detail: string }> = [
  { id: "24x5", label: "24x5", detail: "Sunday 20:00 to Friday 20:00 New York time; held over the weekend and NYSE holidays" },
  { id: "nyse_rth", label: "NYSE RTH", detail: "09:30 to 16:00 New York time, Monday to Friday; NYSE holidays held" },
  { id: "24x7", label: "24x7", detail: "Always in session" },
];

/** Inline explanations shown next to each field (copy rules apply). */
export const FIELD_HELP: Record<string, string> = {
  underlying: "Canonical Stock Token (ticker or address) or a registered index the oracle publishes",
  venue: "Orderly-listed books quote on Orderly's public contracts; in-house books run on the pool engine",
  oracle: "Attested multi-source oracle, or an equity feed reader where one is configured",
  sessions: "Session calendar: outside it the oracle is held and books with off-hours rules go reduce-only",
  symbol: "Venue symbol, at most 32 bytes (PERP_NVDA_USDC on Orderly, NVDA-PERP in-house)",
  takerFeeBps: "In-house engine taker fee, at most 100 bps; it is the book's fee flow",
  ifSizeUsd: "Insurance fund size deployed first at window close; must meet the venue minimum whoever funds it",
  ifFromPool: "The insurance pool lends the insurance fund at window close (a senior debt of the book, repaid at retirement), or the tranches fund it from the window's raise",
  premiumBps: `Share of the book's gross fee flow paid to the insurance pool before expenses and carry; 0 uses the pool's floor (${DEFAULT_PREMIUM_FLOOR_BPS / 100}% at deployment), at most ${MAX_PREMIUM_BPS} bps`,
  ifPoolFallback: "If the insurance pool cannot lend the insurance fund at window close: off (default), the window is cancelled and every commitment refunded 1:1; on, the tranches fund it from the window's raise",
  mmInventoryUsd: "Market-making inventory deployed after the insurance fund",
  "mandate.maxInventoryUsd": "Max |net venue position| notional. Desk key tiers must cover it",
  "mandate.maxSkewBps": "Max distance of the quote mid from the oracle, in bps of the oracle price; at most half the min quote width, so a quote always straddles the oracle",
  "mandate.minQuoteWidthBps": "Narrowest allowed quote: (ask - bid) / mid, in bps",
  "mandate.maxHedgeLeverage": "Leverage cap for perp hedge legs (spot hedges are 1.00x)",
  "mandate.hedgeRatio": "Share of venue exposure offset by desk hedges; enforced once exposure exceeds 5% of max inventory",
  "mandate.noNewRiskOffHours": "Outside the session calendar agents may only reduce exposure",
  "mandate.killAtDrawdownBps": "Kill when the book's performance index falls this far below its high-water mark (negative, -1 to -5000)",
  "mandate.hedgeAllow": "Assets and venues the desk may hedge on (committed as a Merkle root)",
  seniorCapBps: "Senior's maximum share of book capital at window close",
  seniorShareBps: "Senior share of net fee flow after expenses and protocol carry; Junior takes the residual",
  windowSeconds: "Subscription window length (60 seconds to 30 days)",
  juniorNoticeSeconds: "Junior redemption notice, at least one mark interval. Notice is not a gate: requests are always accepted",
  perWalletCapUsd: "Per-wallet commitment cap per window (0 = none; the sponsor is exempt)",
};

export interface FieldIssue {
  field: string;
  step: StepId;
  message: string;
  severity: "error" | "warn";
}

const USD_RE = /^\d+(\.\d{1,6})?$/;
const INT_RE = /^-?\d+$/;
const THIRTY_DAYS = 30 * 86_400;
// Orderly: IF must be strictly above 25,000 per symbol on mainnet, 100 on testnet (VERIFY O10) -> inclusive minimum 25,001 /
// 101 (the deploy scripts' venueMinIf per network; the chain value applies)
export const VENUE_MIN_IF_USD: Record<CharterForm["venue"], number> = { orderly: 25_001, pool_engine: 10_000 };
const TESTNET_CHAIN_ID = 46630;
export const TESTNET_VENUE_MIN_IF_USD: Record<CharterForm["venue"], number> = { orderly: 101, pool_engine: 10_000 };

/** Client-side venue minimum for the build's chain (Robinhood Chain testnet 101 on Orderly; else the mainnet / devnet figure). */
export const venueMinIfUsd = (venue: CharterForm["venue"], chainId?: number): number => (chainId === TESTNET_CHAIN_ID ? TESTNET_VENUE_MIN_IF_USD : VENUE_MIN_IF_USD)[venue];

export function stepOf(field: string): StepId {
  if (field.startsWith("mandate")) return "mandate";
  if (["ifSizeUsd", "ifTargetUsd", "mmInventoryUsd", "ifFromPool", "premiumBps", "ifPoolFallback"].includes(field)) return "capital";
  if (["seniorCapBps", "seniorShareBps", "seniorHurdleBps", "windowSeconds", "subscriptionWindowSeconds", "juniorNoticeSeconds", "perWalletCapUsd"].includes(field)) return "tranches";
  if (field === "" || field === "review") return "review";
  return "market";
}

/** API field names (charter.file issues) -> form field names. */
export const apiFieldToForm = (f: string | null): string => {
  if (!f) return "review";
  const map: Record<string, string> = {
    ifTargetUsd: "ifSizeUsd",
    seniorHurdleBps: "seniorShareBps",
    subscriptionWindowSeconds: "windowSeconds",
    "underlying.ticker": "underlying",
  };
  return map[f] ?? f;
};

const int = (s: string) => (INT_RE.test(s.trim()) ? Number(s.trim()) : Number.NaN);
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

export function suggestSymbol(ticker: string, venue: CharterForm["venue"]): string {
  const t = ticker.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!t) return "";
  return venue === "orderly" ? `PERP_${t}_USDC` : `${t}-PERP`;
}

/**
 * Client-side hints for every field (errors block "Review"; warnings do not). `markIntervalSeconds`: the
 * network's mark interval (the books' markSchedule) — MarketCharter.validate rejects a Junior notice below it
 * (audit M-1); unknown: at least 1 second (the interval is never 0). `chainId`: picks the network's Orderly IF
 * minimum (VERIFY O10).
 */
export function formIssues(f: CharterForm, ctx: { markIntervalSeconds?: number | null; chainId?: number; poolConfigured?: boolean | null } = {}): FieldIssue[] {
  const out: FieldIssue[] = [];
  const add = (field: string, message: string, severity: FieldIssue["severity"] = "error") => out.push({ field, step: stepOf(field), message, severity });
  const usdField = (field: string, v: string, label: string, positive = false) => {
    if (!USD_RE.test(v.trim())) add(field, `${label}: enter a USD amount (up to 6 decimals)`);
    else if (positive && Number(v) <= 0) add(field, `${label} must be above 0`);
  };

  if (!isAddr(f.sponsor)) add("sponsor", "Sponsor must be a 0x address (connect a wallet to fill it)");
  if (!f.underlying.trim()) add("underlying", "Underlying is required");
  else if (f.underlyingKind === "token" && !isAddr(f.underlying)) add("underlying", "Stock Token must be a 0x address");
  const sym = f.symbol.trim();
  if (!sym) add("symbol", "Venue symbol is required");
  else if (new TextEncoder().encode(sym).length > 32) add("symbol", "Venue symbol must fit in 32 bytes");
  else if (f.venue === "orderly" && parseVenueSymbol(sym) === null) add("symbol", "Orderly venue symbol must look like PERP_NVDA_USDC");
  if (f.venue === "pool_engine") {
    const t = int(f.takerFeeBps);
    if (!Number.isInteger(t) || t < 0) add("takerFeeBps", "Taker fee: whole bps");
    else if (t > 100) add("takerFeeBps", "In-house taker fee must be at most 100 bps");
    const m = int(f.makerFeeBps);
    if (!Number.isInteger(m) || m < 0) add("makerFeeBps", "Maker fee: whole bps");
  }

  usdField("ifSizeUsd", f.ifSizeUsd, "Insurance fund size", true);
  usdField("mmInventoryUsd", f.mmInventoryUsd, "MM inventory");
  const minIf = venueMinIfUsd(f.venue, ctx.chainId);
  if (USD_RE.test(f.ifSizeUsd.trim()) && Number(f.ifSizeUsd) < minIf) {
    add("ifSizeUsd", `Below the venue minimum of ${minIf.toLocaleString("en-US")} ${getSettlementSymbol()} (network default; the chain value applies)`);
  }

  // 2026-10 insurance pool (CharterRules.poolReason: BAD_PREMIUM / NO_POOL)
  const premium = int(f.premiumBps);
  if (f.ifFromPool) {
    if (!Number.isInteger(premium) || premium < 0) add("premiumBps", "Pool premium: whole bps (0 = the pool's floor)");
    else if (premium > MAX_PREMIUM_BPS) add("premiumBps", `Pool premium must be at most ${MAX_PREMIUM_BPS} bps of gross fee flow`);
    if (ctx.poolConfigured === false) add("ifFromPool", "No insurance pool is configured on this deployment: fund the insurance fund from the tranches");
    // pool audit 2026-10-23 B-M2 (MarketCharter UNDERCAPITALISED; closeWindow checks the actual raise the same way)
    if (USD_RE.test(f.ifSizeUsd.trim()) && USD_RE.test(f.mmInventoryUsd.trim())) {
      const minRaise = (Number(f.ifSizeUsd) * DEFAULT_MIN_OWN_CAPITAL_BPS) / 10_000;
      if (Number(f.mmInventoryUsd) < minRaise) {
        add("mmInventoryUsd", `A pool-funded book must raise at least ${DEFAULT_MIN_OWN_CAPITAL_BPS / 100}% of its insurance fund: MM inventory of at least ${minRaise.toLocaleString("en-US")} ${getSettlementSymbol()} (the pool's parameter applies)`);
      }
    }
  } else if (f.premiumBps.trim() !== "" && premium !== 0) {
    add("premiumBps", "A book-funded insurance fund pays no pool premium: set it to 0");
  }

  const m = f.mandate;
  usdField("mandate.maxInventoryUsd", m.maxInventoryUsd, "Max inventory", true);
  const skew = int(m.maxSkewBps);
  if (!Number.isInteger(skew) || skew <= 0 || skew > 32_767) add("mandate.maxSkewBps", "Max skew must be a whole number of bps above 0");
  const width = int(m.minQuoteWidthBps);
  if (!Number.isInteger(width) || width <= 0 || width > 65_535) add("mandate.minQuoteWidthBps", "Min quote width must be a whole number of bps above 0");
  // audit M-3: a quote at the min width and the max skew must still straddle the oracle
  if (Number.isInteger(skew) && Number.isInteger(width) && skew > 0 && width > 0 && skew * 2 > width) {
    add("mandate.maxSkewBps", `Max skew must be at most half the min quote width (${Math.floor(width / 2)} bps)`);
  }
  const lev = Number(m.maxHedgeLeverage);
  if (!Number.isFinite(lev) || lev < 0 || lev > 655.35) add("mandate.maxHedgeLeverage", "Hedge leverage: a multiple between 0 and 655.35");
  const lo = int(m.hedgeRatioMinBps);
  const hi = int(m.hedgeRatioMaxBps);
  if (!Number.isInteger(lo) || lo < 0 || lo > 65_535) add("mandate.hedgeRatioMinBps", "Band lower bound: whole bps");
  if (!Number.isInteger(hi) || hi < 0 || hi > 65_535) add("mandate.hedgeRatioMaxBps", "Band upper bound: whole bps");
  if (Number.isInteger(lo) && Number.isInteger(hi) && lo > hi) add("mandate.hedgeRatioMinBps", "Band lower bound must not exceed the upper bound");
  const kill = int(m.killAtDrawdownBps);
  if (!Number.isInteger(kill) || kill >= 0 || kill < -5000) add("mandate.killAtDrawdownBps", "Kill drawdown must be negative and no lower than -5000 bps");
  m.hedgeAllow.forEach((h, i) => {
    if (!h.asset.trim()) add(`mandate.hedgeAllow.${i}`, "Hedge asset is required (ticker, token address or bytes32)");
  });
  if (m.hedgeAllow.length === 0) add("mandate.hedgeAllow", "No hedge venues: desk hedges are rejected until re-mandated", "warn");

  const cap = int(f.seniorCapBps);
  if (!Number.isInteger(cap) || cap <= 0 || cap > 10_000) add("seniorCapBps", "Senior cap must be between 1 and 10000 bps");
  const share = int(f.seniorShareBps);
  if (!Number.isInteger(share) || share < 0 || share > 10_000) add("seniorShareBps", "Senior share of fee flow must be between 0 and 10000 bps");
  const win = int(f.windowSeconds);
  if (!Number.isInteger(win) || win < 60 || win > THIRTY_DAYS) add("windowSeconds", "Subscription window must be between 60 seconds and 30 days");
  const notice = int(f.juniorNoticeSeconds);
  const minNotice = ctx.markIntervalSeconds && ctx.markIntervalSeconds > 0 ? ctx.markIntervalSeconds : 1;
  if (!Number.isInteger(notice) || notice < minNotice || notice > THIRTY_DAYS) {
    add("juniorNoticeSeconds", `Junior notice must be between one mark interval (${fmtNoticeMin(minNotice)}) and 30 days`);
  }
  if (!USD_RE.test(f.perWalletCapUsd.trim())) add("perWalletCapUsd", "Per-wallet cap: a USD amount (0 = none)");
  return out;
}

export const issuesFor = (issues: FieldIssue[], field: string) => issues.filter((i) => i.field === field || i.field.startsWith(`${field}.`));

/** Form -> charter.file input (human units; the API converts and validates). */
export function formToDraft(f: CharterForm): CharterDraftInput {
  const u = f.underlying.trim();
  const underlying: CharterDraftInput["underlying"] =
    f.underlyingKind === "token" ? { token: u } : f.underlyingKind === "index" ? { index: u } : { ticker: u.toUpperCase() };
  const m = f.mandate;
  return {
    sponsor: f.sponsor.trim(),
    underlying,
    venue: f.venue,
    oracle: f.oracle,
    sessions: f.sessions,
    ifTargetUsd: f.ifSizeUsd.trim(),
    mmInventoryUsd: f.mmInventoryUsd.trim(),
    mandate: {
      maxInventoryUsd: m.maxInventoryUsd.trim(),
      maxSkewBps: int(m.maxSkewBps),
      minQuoteWidthBps: int(m.minQuoteWidthBps),
      maxHedgeLeverage: Number(m.maxHedgeLeverage),
      hedgeRatioMinBps: int(m.hedgeRatioMinBps),
      hedgeRatioMaxBps: int(m.hedgeRatioMaxBps),
      noNewRiskOffHours: m.noNewRiskOffHours,
      killAtDrawdownBps: int(m.killAtDrawdownBps),
      hedgeAllow: m.hedgeAllow.filter((h) => h.asset.trim()).map((h) => ({ asset: h.asset.trim(), venue: h.venue })),
    },
    seniorHurdleBps: int(f.seniorShareBps),
    seniorCapBps: int(f.seniorCapBps),
    subscriptionWindowSeconds: int(f.windowSeconds),
    juniorNoticeSeconds: int(f.juniorNoticeSeconds),
    perWalletCapUsd: f.perWalletCapUsd.trim() || "0",
    symbol: f.symbol.trim(),
    takerFeeBps: f.venue === "pool_engine" ? int(f.takerFeeBps) || 0 : 0,
    makerFeeBps: f.venue === "pool_engine" ? int(f.makerFeeBps) || 0 : 0,
    ifFromPool: f.ifFromPool,
    premiumBps: f.ifFromPool ? int(f.premiumBps) || 0 : 0,
    ifPoolFallback: f.ifFromPool && f.ifPoolFallback,
    meta: { name: f.name.trim() || undefined, description: f.description.trim() || undefined },
  };
}

/**
 * What the subscription window raises at most: the MM inventory alone when the insurance pool funds the IF, the
 * IF plus the MM inventory when the tranches do (malformed amounts count as 0).
 */
export function windowRaiseUsd(f: Pick<CharterForm, "ifFromPool" | "ifSizeUsd" | "mmInventoryUsd">): number {
  const n = (v: string) => (USD_RE.test(v.trim()) ? Number(v) : 0);
  return (f.ifFromPool ? 0 : n(f.ifSizeUsd)) + n(f.mmInventoryUsd);
}

/** "12% (the pool's floor)" / "15%": the premium as filed, for summaries. */
export function premiumText(premiumBps: number, floorBps: number = DEFAULT_PREMIUM_FLOOR_BPS): string {
  const pct = (b: number) => `${Number.isInteger(b / 100) ? b / 100 : (b / 100).toFixed(2)}%`;
  return premiumBps === 0 ? `${pct(floorBps)} (the pool's floor)` : premiumBps < floorBps ? `${pct(floorBps)} (the pool's floor applies)` : pct(premiumBps);
}

/** Duration units for window / notice inputs. */
export const DURATION_UNITS: Array<{ id: "s" | "min" | "h" | "d"; seconds: number; label: string }> = [
  { id: "s", seconds: 1, label: "seconds" },
  { id: "min", seconds: 60, label: "minutes" },
  { id: "h", seconds: 3_600, label: "hours" },
  { id: "d", seconds: 86_400, label: "days" },
];

/** Largest unit that divides the value exactly (for display in a value + unit input). */
export function splitDuration(seconds: number): { value: number; unit: "s" | "min" | "h" | "d" } {
  for (const u of [...DURATION_UNITS].reverse()) {
    if (seconds >= u.seconds && seconds % u.seconds === 0) return { value: seconds / u.seconds, unit: u.id };
  }
  return { value: seconds, unit: "s" };
}

/** "1 h", "15 min", "1 d", "45 s": the minimum notice in the form's own units. */
function fmtNoticeMin(seconds: number): string {
  const d = splitDuration(seconds);
  return `${d.value} ${d.unit}`;
}
