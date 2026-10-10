// Charter drafts in human units -> BRTypes.Charter, local mirror of MarketCharter.validate, and the
// human-unit view of a stored charter (charters.struct_json holds BRTypes.Charter with bigint strings).
import { type Charter, type Deployment, type Mandate, ORACLE, VENUE } from "@bookrunner/shared/types";
import { HEDGE_VENUES, bytes32ToStr, indexUnderlying, isTokenUnderlying, strToBytes32, tokenUnderlying, underlyingToToken } from "@bookrunner/shared/bytes32";
import { SESSIONS_24X5, SESSIONS_24X7, SESSIONS_NYSE_RTH, type Sessions, encodeSessions } from "@bookrunner/shared/sessions";
import { hedgeAllowTree } from "@bookrunner/shared/merkle";
import { type Address, type Hex, getAddress, isAddress, toBytes, zeroHash } from "viem";
import { z } from "zod";
import { parseUsd, usdStr } from "../format";

// ------------------------------------------------------------------ input schemas
export const addressSchema = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), "invalid address")
  .transform((s) => getAddress(s));

export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex")
  .transform((s) => s.toLowerCase() as Hex);

/** Human USD amount: "25000", "0.5", 1000 (<= 6 decimals). */
export const usdInput = z.union([
  z.string().regex(/^\d+(\.\d{1,6})?$/, "expected a non-negative USD amount with at most 6 decimals"),
  z.number().nonnegative().finite(),
]);

const uint = (max: number) => z.number().int().min(0).max(max);
const int16 = z.number().int().min(-32768).max(32767);

export const SESSION_PRESETS: Record<string, Sessions> = {
  "24x7": SESSIONS_24X7,
  "24x5": SESSIONS_24X5,
  nyse_rth: SESSIONS_NYSE_RTH,
};

const hedgeVenueSchema = z.enum(["UNIV3", "UNIV4", "ORDERLY", "ENGINE"]);

export const underlyingInput = z.union([
  z.object({ token: addressSchema }),
  z.object({ ticker: z.string().min(1).max(31) }),
  z.object({ index: z.string().min(1).max(64) }),
  z.object({ raw: bytes32Schema }),
]);

export const mandateDraftSchema = z.object({
  maxInventoryUsd: usdInput,
  maxSkewBps: int16,
  minQuoteWidthBps: uint(65_535),
  /** Max leverage of perp hedge legs as a multiple (1 = 1.00x). Stored on-chain in 0.01x units. */
  maxHedgeLeverage: z.number().min(0).max(655.35).default(1),
  hedgeRatioMinBps: uint(65_535),
  hedgeRatioMaxBps: uint(65_535),
  noNewRiskOffHours: z.boolean().default(true),
  killAtDrawdownBps: int16,
  /** (asset, venue) pairs allowed for hedges; asset = Stock Token address, ticker or bytes32. */
  hedgeAllow: z
    .array(z.object({ asset: z.string().min(1), venue: hedgeVenueSchema }))
    .max(64)
    .optional(),
  /** Pre-computed StandardMerkleTree root; overrides hedgeAllow. */
  hedgeAllowRoot: bytes32Schema.optional(),
});

export const charterDraftSchema = z.object({
  sponsor: addressSchema,
  underlying: underlyingInput,
  venue: z.union([z.enum(["orderly", "pool_engine"]), uint(255)]),
  oracle: z.union([z.enum(["chainlink", "attested"]), uint(255)]).default("attested"),
  sessions: z.union([z.enum(["24x7", "24x5", "nyse_rth"]), bytes32Schema]).default("24x5"),
  ifTargetUsd: usdInput,
  mmInventoryUsd: usdInput,
  mandate: mandateDraftSchema,
  seniorHurdleBps: uint(65_535),
  seniorCapBps: uint(65_535),
  subscriptionWindowSeconds: uint(4_294_967_295),
  juniorNoticeSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  perWalletCapUsd: usdInput.default("0"),
  symbol: z.string().max(64),
  takerFeeBps: uint(65_535).default(0),
  makerFeeBps: uint(65_535).default(0),
  meta: z
    .object({ name: z.string().max(80).optional(), description: z.string().max(2000).optional() })
    .optional(),
});

export type CharterDraftInput = z.input<typeof charterDraftSchema>;
export type CharterDraft = z.output<typeof charterDraftSchema>;

// ------------------------------------------------------------------ reasons
export type CharterReasonCode =
  | "IF_BELOW_VENUE_MIN"
  | "BAD_VENUE"
  | "BAD_ORACLE"
  | "BAD_BPS"
  | "BAD_WINDOW"
  | "BAD_NOTICE"
  | "BAD_MANDATE"
  | "BAD_UNDERLYING"
  | "BAD_SYMBOL"
  | "BAD_FEES"
  | "NEW_BOOKS_PAUSED";

export interface CharterIssue {
  code: CharterReasonCode | string;
  field: string | null;
  message: string;
  source: "local" | "chain" | "charter-service";
}

export const THIRTY_DAYS = 30 * 86_400;
const MIN_WINDOW = 60;
const MAX_IN_HOUSE_TAKER_FEE_BPS = 100;

/** Devnet/mainnet defaults (ARCHITECTURE §2.1) used when the chain is not reachable. */
// Orderly: strictly above the venue's 25,000 per-symbol IF requirement (VERIFY O10), so the inclusive minimum is 25,001.
export const DEFAULT_VENUE_MIN_IF_USD: [bigint, bigint] = [25_001_000_000n, 10_000_000_000n];

const venueId = (v: CharterDraft["venue"]): number => (v === "orderly" ? VENUE.ORDERLY : v === "pool_engine" ? VENUE.POOL_ENGINE : v);
const oracleId = (v: CharterDraft["oracle"]): number => (v === "chainlink" ? ORACLE.CHAINLINK : v === "attested" ? ORACLE.ATTESTED : v);

// ------------------------------------------------------------------ draft -> Charter
export interface DraftContext {
  stockTokens?: Deployment["stockTokens"];
}

export interface DraftConversion {
  charter: Charter;
  issues: CharterIssue[];
  warnings: string[];
}

function resolveTicker(ticker: string, ctx: DraftContext): Address | null {
  const entry = ctx.stockTokens?.[ticker] ?? ctx.stockTokens?.[ticker.toUpperCase()];
  return entry ? getAddress(entry.token) : null;
}

function resolveAsset(asset: string, ctx: DraftContext): Hex | null {
  if (isAddress(asset, { strict: false })) return tokenUnderlying(getAddress(asset));
  if (/^0x[0-9a-fA-F]{64}$/.test(asset)) return asset.toLowerCase() as Hex;
  const t = resolveTicker(asset, ctx);
  return t ? tokenUnderlying(t) : null;
}

function symbolBytes(symbol: string, issues: CharterIssue[]): Hex {
  const s = symbol.trim();
  if (toBytes(s).length > 32) {
    issues.push({ code: "BAD_SYMBOL", field: "symbol", message: "Venue symbol must fit in 32 bytes", source: "local" });
    return zeroHash;
  }
  return s ? strToBytes32(s) : zeroHash;
}

export function draftToCharter(d: CharterDraft, ctx: DraftContext = {}): DraftConversion {
  const issues: CharterIssue[] = [];
  const warnings: string[] = [];

  let underlying: Hex = zeroHash;
  const u = d.underlying;
  if ("token" in u) underlying = tokenUnderlying(u.token);
  else if ("raw" in u) underlying = u.raw;
  else if ("index" in u) underlying = indexUnderlying(u.index);
  else {
    const t = resolveTicker(u.ticker, ctx);
    if (t) underlying = tokenUnderlying(t);
    else issues.push({ code: "BAD_UNDERLYING", field: "underlying.ticker", message: `Unknown Stock Token ticker ${u.ticker}`, source: "local" });
  }

  const sessions: Hex = typeof d.sessions === "string" && d.sessions in SESSION_PRESETS ? encodeSessions(SESSION_PRESETS[d.sessions] as Sessions) : (d.sessions as Hex);

  let hedgeAllowRoot: Hex = zeroHash;
  if (d.mandate.hedgeAllowRoot) hedgeAllowRoot = d.mandate.hedgeAllowRoot;
  else {
    const pairs: Array<{ asset: Hex; venue: Hex }> = [];
    if (d.mandate.hedgeAllow?.length) {
      for (const p of d.mandate.hedgeAllow) {
        const asset = resolveAsset(p.asset, ctx);
        if (!asset) {
          issues.push({ code: "BAD_MANDATE", field: "mandate.hedgeAllow", message: `Unknown hedge asset ${p.asset}`, source: "local" });
          continue;
        }
        pairs.push({ asset, venue: HEDGE_VENUES[p.venue] });
      }
    } else if (underlying !== zeroHash && isTokenUnderlying(underlying)) {
      pairs.push({ asset: underlying, venue: HEDGE_VENUES.UNIV3 });
      warnings.push("Hedge allow-list defaulted to the underlying Stock Token on UNIV3");
    } else {
      warnings.push("No hedge venues allow-listed: desk hedges will be rejected by the mandate until re-mandated");
    }
    if (pairs.length) hedgeAllowRoot = hedgeAllowTree(pairs).root;
  }

  const mandate: Mandate = {
    maxInventoryUsd: parseUsd(d.mandate.maxInventoryUsd),
    maxSkewBps: d.mandate.maxSkewBps,
    minQuoteWidthBps: d.mandate.minQuoteWidthBps,
    maxHedgeLeverage: Math.round(d.mandate.maxHedgeLeverage * 100),
    hedgeRatioMinBps: d.mandate.hedgeRatioMinBps,
    hedgeRatioMaxBps: d.mandate.hedgeRatioMaxBps,
    noNewRiskOffHours: d.mandate.noNewRiskOffHours,
    killAtDrawdownBps: d.mandate.killAtDrawdownBps,
    hedgeAllowRoot,
  };

  const charter: Charter = {
    underlying,
    venue: venueId(d.venue) as Charter["venue"],
    oracle: oracleId(d.oracle) as Charter["oracle"],
    sessions,
    ifTargetUsd: parseUsd(d.ifTargetUsd),
    mmInventoryUsd: parseUsd(d.mmInventoryUsd),
    mandate,
    seniorHurdleBps: d.seniorHurdleBps,
    seniorCapBps: d.seniorCapBps,
    subscriptionWindow: d.subscriptionWindowSeconds,
    juniorNoticeSeconds: BigInt(d.juniorNoticeSeconds),
    sponsor: d.sponsor,
    perWalletCapUsd: parseUsd(d.perWalletCapUsd),
    symbol: symbolBytes(d.symbol, issues),
    takerFeeBps: d.takerFeeBps,
    makerFeeBps: d.makerFeeBps,
  };
  return { charter, issues, warnings };
}

// ------------------------------------------------------------------ local validation
export interface ValidationContext {
  venueMinIfUsd?: [bigint, bigint];
  /** true/false when checked against the registry; null/undefined when unknown. */
  underlyingKnown?: boolean | null;
  newBooksPaused?: boolean;
}

/** Mirrors MarketCharter.validate (ARCHITECTURE §2.6); reports every failing rule, not only the first. */
export function validateCharterLocal(c: Charter, ctx: ValidationContext = {}): CharterIssue[] {
  const out: CharterIssue[] = [];
  const add = (code: CharterReasonCode, field: string | null, message: string) => out.push({ code, field, message, source: "local" });

  const venueOk = c.venue === VENUE.ORDERLY || c.venue === VENUE.POOL_ENGINE;
  if (!venueOk) add("BAD_VENUE", "venue", "Venue must be Orderly (0) or the in-house engine (1)");
  if (c.oracle !== ORACLE.CHAINLINK && c.oracle !== ORACLE.ATTESTED) add("BAD_ORACLE", "oracle", "Oracle must be Chainlink (0) or attested (1)");

  if (venueOk) {
    const min = (ctx.venueMinIfUsd ?? DEFAULT_VENUE_MIN_IF_USD)[c.venue];
    if (min !== undefined && c.ifTargetUsd < min) {
      add("IF_BELOW_VENUE_MIN", "ifTargetUsd", `Insurance fund size ${usdStr(c.ifTargetUsd)} USDC is below the venue minimum of ${usdStr(min)} USDC`);
    }
  }

  if (c.seniorHurdleBps > 10_000) add("BAD_BPS", "seniorHurdleBps", "Senior share of net fee flow must be at most 10000 bps");
  if (c.seniorCapBps > 10_000 || c.seniorCapBps === 0) add("BAD_BPS", "seniorCapBps", "Senior cap must be between 1 and 10000 bps of book capital");

  if (c.subscriptionWindow < MIN_WINDOW || c.subscriptionWindow > THIRTY_DAYS) {
    add("BAD_WINDOW", "subscriptionWindowSeconds", "Subscription window must be between 60 seconds and 30 days");
  }
  if (c.juniorNoticeSeconds > BigInt(THIRTY_DAYS)) add("BAD_NOTICE", "juniorNoticeSeconds", "Junior notice must be at most 30 days");

  const m = c.mandate;
  if (m.maxInventoryUsd === 0n) add("BAD_MANDATE", "mandate.maxInventoryUsd", "Mandate max inventory must be above 0");
  if (m.minQuoteWidthBps === 0) add("BAD_MANDATE", "mandate.minQuoteWidthBps", "Mandate min quote width must be above 0 bps");
  if (m.hedgeRatioMinBps > m.hedgeRatioMaxBps) add("BAD_MANDATE", "mandate.hedgeRatioMinBps", "Hedge band lower bound must not exceed its upper bound");
  if (m.killAtDrawdownBps >= 0 || m.killAtDrawdownBps < -5000) {
    add("BAD_MANDATE", "mandate.killAtDrawdownBps", "Kill drawdown must be negative and no lower than -5000 bps");
  }
  if (m.maxSkewBps <= 0) add("BAD_MANDATE", "mandate.maxSkewBps", "Mandate max skew must be above 0 bps");

  if (c.underlying === zeroHash || ctx.underlyingKnown === false) {
    add("BAD_UNDERLYING", "underlying", "Underlying is neither a canonical Stock Token nor a registered index");
  }
  if (c.symbol === zeroHash) add("BAD_SYMBOL", "symbol", "Venue symbol is required");
  if (c.venue === VENUE.POOL_ENGINE && c.takerFeeBps > MAX_IN_HOUSE_TAKER_FEE_BPS) {
    add("BAD_FEES", "takerFeeBps", "In-house taker fee must be at most 100 bps");
  }
  if (ctx.newBooksPaused) add("NEW_BOOKS_PAUSED", null, "New charters are paused by the guardian; filing would revert");
  return out;
}

/**
 * Merges issues from several sources. `primary` is kept verbatim; an issue from a later source is
 * dropped when an earlier one already reports the same code for the same field (or either has no
 * field, e.g. the single bytes32 reason MarketCharter.validate gives).
 */
export function mergeIssues(primary: CharterIssue[], ...others: CharterIssue[][]): CharterIssue[] {
  const out = [...primary];
  for (const list of others) {
    for (const i of list) {
      const dup = out.some((o) => o.code === i.code && (o.field === i.field || o.field === null || i.field === null));
      if (!dup) out.push(i);
    }
  }
  return out;
}

// ------------------------------------------------------------------ stored charter -> view
const big = (v: unknown, d = 0n): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return d;
};
const num = (v: unknown, d = 0): number => {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : d;
};
const hex = (v: unknown): Hex => (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? (v.toLowerCase() as Hex) : zeroHash);

/** charters.struct_json (BRTypes.Charter, bigint as strings) -> Charter. Tolerates numbers/strings. */
export function charterFromJson(json: unknown): Charter {
  const o = (json ?? {}) as Record<string, unknown>;
  const m = (o.mandate ?? {}) as Record<string, unknown>;
  return {
    underlying: hex(o.underlying),
    venue: num(o.venue) as Charter["venue"],
    oracle: num(o.oracle) as Charter["oracle"],
    sessions: hex(o.sessions),
    ifTargetUsd: big(o.ifTargetUsd),
    mmInventoryUsd: big(o.mmInventoryUsd),
    mandate: {
      maxInventoryUsd: big(m.maxInventoryUsd),
      maxSkewBps: num(m.maxSkewBps),
      minQuoteWidthBps: num(m.minQuoteWidthBps),
      maxHedgeLeverage: num(m.maxHedgeLeverage),
      hedgeRatioMinBps: num(m.hedgeRatioMinBps),
      hedgeRatioMaxBps: num(m.hedgeRatioMaxBps),
      noNewRiskOffHours: Boolean(m.noNewRiskOffHours),
      killAtDrawdownBps: num(m.killAtDrawdownBps),
      hedgeAllowRoot: hex(m.hedgeAllowRoot),
    },
    seniorHurdleBps: num(o.seniorHurdleBps),
    seniorCapBps: num(o.seniorCapBps),
    subscriptionWindow: num(o.subscriptionWindow),
    juniorNoticeSeconds: big(o.juniorNoticeSeconds),
    sponsor: (typeof o.sponsor === "string" && isAddress(o.sponsor, { strict: false }) ? getAddress(o.sponsor) : "0x0000000000000000000000000000000000000000") as Address,
    perWalletCapUsd: big(o.perWalletCapUsd),
    symbol: hex(o.symbol),
    takerFeeBps: num(o.takerFeeBps),
    makerFeeBps: num(o.makerFeeBps),
  };
}

/** Charter -> JSON with bigint strings (the struct_json convention). */
export function charterToJson(c: Charter): Record<string, unknown> {
  return JSON.parse(JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export interface MandateView {
  maxInventoryUsd: string;
  maxSkewBps: number;
  minQuoteWidthBps: number;
  maxHedgeLeverage: number; // multiple (1 = 1.00x)
  hedgeRatioMinBps: number;
  hedgeRatioMaxBps: number;
  noNewRiskOffHours: boolean;
  killAtDrawdownBps: number;
  hedgeAllowRoot: Hex;
}

export interface CharterView {
  underlying: Hex;
  underlyingKind: "token" | "index";
  underlyingToken: Address | null;
  ticker: string | null;
  venue: "orderly" | "pool_engine" | "unknown";
  venueId: number;
  oracle: "chainlink" | "attested" | "unknown";
  sessions: Hex;
  sessionsPreset: string | null;
  ifTargetUsd: string;
  mmInventoryUsd: string;
  mandate: MandateView;
  seniorHurdleBps: number;
  seniorCapBps: number;
  subscriptionWindowSeconds: number;
  juniorNoticeSeconds: number;
  sponsor: Address;
  perWalletCapUsd: string;
  symbol: string;
  symbolHex: Hex;
  takerFeeBps: number;
  makerFeeBps: number;
}

export function mandateToView(m: Mandate): MandateView {
  return {
    maxInventoryUsd: usdStr(m.maxInventoryUsd),
    maxSkewBps: m.maxSkewBps,
    minQuoteWidthBps: m.minQuoteWidthBps,
    maxHedgeLeverage: m.maxHedgeLeverage / 100,
    hedgeRatioMinBps: m.hedgeRatioMinBps,
    hedgeRatioMaxBps: m.hedgeRatioMaxBps,
    noNewRiskOffHours: m.noNewRiskOffHours,
    killAtDrawdownBps: m.killAtDrawdownBps,
    hedgeAllowRoot: m.hedgeAllowRoot,
  };
}

function safeSymbol(h: Hex): string {
  try {
    return h === zeroHash ? "" : bytes32ToStr(h);
  } catch {
    return "";
  }
}

export function charterToView(c: Charter, ctx: DraftContext = {}): CharterView {
  const isToken = isTokenUnderlying(c.underlying) && c.underlying !== zeroHash;
  const token = isToken ? underlyingToToken(c.underlying) : null;
  const ticker = token
    ? (Object.entries(ctx.stockTokens ?? {}).find(([, v]) => v.token.toLowerCase() === token.toLowerCase())?.[0] ?? null)
    : null;
  const preset = Object.entries(SESSION_PRESETS).find(([, s]) => encodeSessions(s) === c.sessions)?.[0] ?? null;
  return {
    underlying: c.underlying,
    underlyingKind: isToken ? "token" : "index",
    underlyingToken: token,
    ticker,
    venue: c.venue === VENUE.ORDERLY ? "orderly" : c.venue === VENUE.POOL_ENGINE ? "pool_engine" : "unknown",
    venueId: c.venue,
    oracle: c.oracle === ORACLE.CHAINLINK ? "chainlink" : c.oracle === ORACLE.ATTESTED ? "attested" : "unknown",
    sessions: c.sessions,
    sessionsPreset: preset,
    ifTargetUsd: usdStr(c.ifTargetUsd),
    mmInventoryUsd: usdStr(c.mmInventoryUsd),
    mandate: mandateToView(c.mandate),
    seniorHurdleBps: c.seniorHurdleBps,
    seniorCapBps: c.seniorCapBps,
    subscriptionWindowSeconds: c.subscriptionWindow,
    juniorNoticeSeconds: Number(c.juniorNoticeSeconds),
    sponsor: c.sponsor,
    perWalletCapUsd: usdStr(c.perWalletCapUsd),
    symbol: safeSymbol(c.symbol),
    symbolHex: c.symbol,
    takerFeeBps: c.takerFeeBps,
    makerFeeBps: c.makerFeeBps,
  };
}

/** Human label for messages, e.g. "PERP_NVDA_USDC". */
export const charterLabel = (c: Charter) => safeSymbol(c.symbol) || "(no symbol)";
