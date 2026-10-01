// Charter draft (human units) -> BRTypes.Charter. The zod schema enforces only the Solidity TYPE
// ranges (uint16, int16, ...); protocol rules are reported by validateCharter as on-chain reason
// codes so the intake API gives the same answer MarketCharter.validate would.
import {
  type Charter,
  HEDGE_VENUES,
  ORACLE,
  SESSIONS_24X5,
  SESSIONS_24X7,
  SESSIONS_NYSE_RTH,
  type Sessions,
  VENUE,
  encodeSessions,
  hedgeAllowTree,
  indexUnderlying,
  parseFixed,
  strToBytes32,
  tokenUnderlying,
} from "@bookrunner/shared";
import { type Hex, getAddress, isAddress, toBytes, zeroHash } from "viem";
import { z } from "zod";

const U16 = 0xffff;
const U32 = 0xffff_ffff;
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed bytes32").transform((s) => s.toLowerCase() as Hex);
const address = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), "expected an address")
  .transform((s) => getAddress(s));

/** Human USD ("25000", "25000.50", 25000) -> raw 6dp bigint; at most 6 decimals, non-negative, <= uint128. */
export const usdAmount = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim().replaceAll("_", "").replaceAll(",", "");
    if (!/^\d+(\.\d{1,6})?$/.test(s)) {
      ctx.addIssue({ code: "custom", message: `invalid USD amount "${v}" (non-negative, at most 6 decimals)` });
      return z.NEVER;
    }
    const raw = parseFixed(s, 6);
    if (raw > U128) {
      ctx.addIssue({ code: "custom", message: "USD amount exceeds uint128" });
      return z.NEVER;
    }
    return raw;
  });

const uint = (max: number) => z.number().int().min(0).max(max);
const int16 = z.number().int().min(-32768).max(32767);

const DURATION_UNITS: Record<string, bigint> = { s: 1n, m: 60n, h: 3600n, d: 86_400n, w: 604_800n };

/** 600 | "600" | "10m" | "7d" -> seconds */
export function parseDuration(v: string | number): bigint | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? BigInt(v) : null;
  const m = /^(\d+)\s*([smhdw]?)$/i.exec(v.trim());
  if (!m) return null;
  const unit = DURATION_UNITS[(m[2] || "s").toLowerCase()];
  return unit === undefined ? null : BigInt(m[1] ?? "0") * unit;
}

const duration = (max: bigint) =>
  z.union([z.string(), z.number()]).transform((v, ctx) => {
    const d = parseDuration(v);
    if (d === null || d > max) {
      ctx.addIssue({ code: "custom", message: `invalid duration "${v}" (seconds or e.g. "10m", "7d")` });
      return z.NEVER;
    }
    return d;
  });

const venueField = z.union([z.enum(["orderly", "pool_engine", "engine", "in_house"]), uint(255)]).transform((v) => {
  if (typeof v === "number") return v;
  return v === "orderly" ? VENUE.ORDERLY : VENUE.POOL_ENGINE;
});

const oracleField = z.union([z.enum(["chainlink", "attested"]), uint(255)]).transform((v) => {
  if (typeof v === "number") return v;
  return v === "chainlink" ? ORACLE.CHAINLINK : ORACLE.ATTESTED;
});

const daySession = z.object({ open: uint(1439), close: uint(1439) });
const sessionsObject = z.object({
  kind: z.union([z.literal(0), z.literal(1)]),
  tz: z.union([z.literal(0), z.literal(1)]),
  days: z.array(daySession).length(7),
  holidays: z.union([z.literal(0), z.literal(1)]),
});
const SESSION_PRESETS: Record<string, Sessions> = { "24x7": SESSIONS_24X7, "24x5": SESSIONS_24X5, nyse_rth: SESSIONS_NYSE_RTH };

const sessionsField = z.union([z.enum(["24x7", "24x5", "nyse_rth"]), hex32, sessionsObject]).transform((v): Hex => {
  if (typeof v === "object") return encodeSessions(v as Sessions);
  if (v.startsWith("0x")) return v as Hex;
  return encodeSessions(SESSION_PRESETS[v] ?? SESSIONS_24X7);
});

const underlyingField = z.union([
  z.object({ token: address }),
  z.object({ ticker: z.string().min(1).max(32) }),
  z.object({ index: z.string().min(1).max(64) }),
  hex32,
]);

const symbolField = z.union([hex32, z.string().max(32)]).transform((v, ctx): Hex => {
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase() as Hex;
  if (v.length === 0) return zeroHash;
  if (!/^[\x20-\x7e]+$/.test(v) || toBytes(v).length > 32) {
    ctx.addIssue({ code: "custom", message: "symbol must be printable ASCII, at most 32 bytes" });
    return z.NEVER;
  }
  return strToBytes32(v);
});

const hedgeVenue = z.union([z.enum(["UNIV3", "UNIV4", "ORDERLY", "ENGINE"]), hex32]);
const hedgeAllowEntry = z.object({
  asset: z.union([address, hex32, z.object({ ticker: z.string() })]),
  venue: hedgeVenue,
});

const mandateDraft = z.object({
  maxInventoryUsd: usdAmount,
  maxSkewBps: int16,
  minQuoteWidthBps: uint(U16),
  maxHedgeLeverage: uint(U16).default(100),
  hedgeRatioMinBps: uint(U16),
  hedgeRatioMaxBps: uint(U16),
  noNewRiskOffHours: z.boolean().default(true),
  killAtDrawdownBps: int16,
  hedgeAllowRoot: hex32.optional(),
  hedgeAllow: z.array(hedgeAllowEntry).max(64).optional(),
});

export const charterDraftSchema = z.object({
  sponsor: address,
  underlying: underlyingField,
  venue: venueField,
  oracle: oracleField.default(ORACLE.ATTESTED),
  sessions: sessionsField.prefault("24x5"), // zod 4: prefault = parsed (input-type) default
  ifTargetUsd: usdAmount,
  mmInventoryUsd: usdAmount,
  mandate: mandateDraft,
  seniorHurdleBps: uint(U16),
  seniorCapBps: uint(U16),
  subscriptionWindow: duration(BigInt(U32)),
  juniorNoticeSeconds: duration(U64).default(7n * 86_400n),
  perWalletCapUsd: usdAmount.default(0n),
  symbol: symbolField,
  takerFeeBps: uint(U16).default(0),
  makerFeeBps: uint(U16).default(0),
  meta: z
    .object({ name: z.string().max(120).optional(), description: z.string().max(4000).optional() })
    .optional(),
});

export type CharterDraftInput = z.input<typeof charterDraftSchema>;
type ParsedDraft = z.output<typeof charterDraftSchema>;

/** Known Stock Tokens (deployment.stockTokens) for ticker resolution. */
export type TickerBook = Record<string, { token: `0x${string}` }>;

export interface DraftResult {
  charter: Charter;
  meta: ParsedDraft["meta"];
  hedgeAllow: Array<{ asset: Hex; venue: Hex }> | null;
  warnings: string[];
}

export class DraftError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export function parseCharterDraft(body: unknown, tickers: TickerBook = {}): DraftResult {
  const parsed = charterDraftSchema.safeParse(body);
  if (!parsed.success) {
    throw new DraftError(
      "invalid charter draft",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const d = parsed.data;
  const warnings: string[] = [];
  const resolveTicker = (ticker: string): Hex => {
    const t = tickers[ticker] ?? tickers[ticker.toUpperCase()];
    if (!t) throw new DraftError("unknown ticker", [{ path: "underlying.ticker", message: `no Stock Token known for ticker ${ticker}` }]);
    return tokenUnderlying(t.token);
  };

  let underlying: Hex;
  const u = d.underlying;
  if (typeof u === "string") underlying = u;
  else if ("token" in u) underlying = tokenUnderlying(u.token);
  else if ("ticker" in u) underlying = resolveTicker(u.ticker);
  else underlying = indexUnderlying(u.index);

  let hedgeAllow: DraftResult["hedgeAllow"] = null;
  let hedgeAllowRoot: Hex = d.mandate.hedgeAllowRoot ?? zeroHash;
  if (d.mandate.hedgeAllow && d.mandate.hedgeAllow.length > 0) {
    hedgeAllow = d.mandate.hedgeAllow.map((e) => {
      const asset =
        typeof e.asset === "object"
          ? resolveTicker(e.asset.ticker)
          : /^0x[0-9a-fA-F]{40}$/.test(e.asset)
            ? tokenUnderlying(e.asset as `0x${string}`)
            : (e.asset.toLowerCase() as Hex);
      const venue = e.venue.startsWith("0x") ? (e.venue.toLowerCase() as Hex) : HEDGE_VENUES[e.venue as keyof typeof HEDGE_VENUES];
      return { asset, venue };
    });
    const root = hedgeAllowTree(hedgeAllow).root.toLowerCase() as Hex;
    if (d.mandate.hedgeAllowRoot && d.mandate.hedgeAllowRoot !== root) {
      warnings.push("mandate.hedgeAllowRoot differs from the root of mandate.hedgeAllow; using the computed root");
    }
    hedgeAllowRoot = root;
  }
  if (hedgeAllowRoot === zeroHash) warnings.push("hedge allow-list is empty: the desk cannot place hedge legs");

  const charter: Charter = {
    underlying,
    venue: d.venue as Charter["venue"],
    oracle: d.oracle as Charter["oracle"],
    sessions: d.sessions,
    ifTargetUsd: d.ifTargetUsd,
    mmInventoryUsd: d.mmInventoryUsd,
    mandate: {
      maxInventoryUsd: d.mandate.maxInventoryUsd,
      maxSkewBps: d.mandate.maxSkewBps,
      minQuoteWidthBps: d.mandate.minQuoteWidthBps,
      maxHedgeLeverage: d.mandate.maxHedgeLeverage,
      hedgeRatioMinBps: d.mandate.hedgeRatioMinBps,
      hedgeRatioMaxBps: d.mandate.hedgeRatioMaxBps,
      noNewRiskOffHours: d.mandate.noNewRiskOffHours,
      killAtDrawdownBps: d.mandate.killAtDrawdownBps,
      hedgeAllowRoot,
    },
    seniorHurdleBps: d.seniorHurdleBps,
    seniorCapBps: d.seniorCapBps,
    subscriptionWindow: Number(d.subscriptionWindow),
    juniorNoticeSeconds: d.juniorNoticeSeconds,
    sponsor: d.sponsor,
    perWalletCapUsd: d.perWalletCapUsd,
    symbol: d.symbol,
    takerFeeBps: d.takerFeeBps,
    makerFeeBps: d.makerFeeBps,
  };
  return { charter, meta: d.meta, hedgeAllow, warnings };
}
