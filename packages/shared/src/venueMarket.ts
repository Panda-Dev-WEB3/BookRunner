// Orderly market state of a book's venue symbol, as ops-venue's listing check sees it (GET /v1/public/info/{symbol},
// docs/VERIFY.md O20), published in KEYS.venueSymbolIssues (VenueSymbolIssuesMsg.markets). Read by services/alerts,
// the API's /health and the agent (venueMarketGate: no new risk on a market that is not open). The gate can only
// RESTRICT the agent (reduce-only), never widen what it may do, so it adds no trust beyond the risk-state key the agent
// already reads from the same Redis; an absent / unreadable status leaves the agent as it was.

/**
 * unknown: no successful check yet; awaiting: never seen listed (absent, NEW or PENDING); listed: on
 * /v1/public/info with a launched status; missing: was listed, now absent from /v1/public/info (delisted / removed, or
 * a transient empty answer) — never "awaiting" again.
 */
export type VenueMarketPhase = "unknown" | "awaiting" | "listed" | "missing";

export interface VenueMarketMsg {
  symbol: string;
  /** tracked books on the symbol in Subscription / Live / Retiring */
  bookIds: number[];
  phase: VenueMarketPhase;
  /** Orderly's market status of the last successful check (null: absent, or a row without status) */
  venueStatus: string | null;
  /** new risk may be opened: listed and ACTIVE (or a row without status, the documented schema) */
  openForRisk: boolean;
  /** seen listed at least once by this ops-venue */
  everListed: boolean;
  /** unix ms: when the current phase / status was first seen */
  since: number;
  /** unix ms of the last successful check (null: none yet) */
  checkedAt: number | null;
  /** consecutive failed checks (0 = the last check succeeded) */
  failures: number;
  /** last check error (null when failures = 0) */
  error: string | null;
}

/** Orderly market statuses (docs: perp-anything/market-operations). */
export const ORDERLY_MARKET_STATUSES = ["NEW", "PENDING", "POST_ONLY", "ACTIVE", "REDUCE_ONLY", "DELISTING", "DELISTED"] as const;

/**
 * not_launched: NEW / PENDING; open: ACTIVE (or no status); post_only: limit orders only (launch, until both sides hold
 * the depth warning for 10 min); restricted: REDUCE_ONLY / DELISTING / DELISTED or any undocumented status.
 */
export type MarketStatusClass = "not_launched" | "open" | "post_only" | "restricted";

export function marketStatusClass(status: string | null): MarketStatusClass {
  if (status === null || status === "") return "open";
  const s = status.toUpperCase();
  if (s === "NEW" || s === "PENDING") return "not_launched";
  if (s === "ACTIVE") return "open";
  if (s === "POST_ONLY") return "post_only";
  return "restricted";
}

export const isKnownMarketStatus = (status: string) => (ORDERLY_MARKET_STATUSES as readonly string[]).includes(status.toUpperCase());

/** Markets of a VenueSymbolIssuesMsg JSON (malformed entries dropped; malformed / absent -> []). */
export function parseVenueMarkets(raw: unknown): VenueMarketMsg[] {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const list = (o as { markets?: unknown } | null)?.markets;
  if (!Array.isArray(list)) return [];
  const out: VenueMarketMsg[] = [];
  const PHASES = new Set(["unknown", "awaiting", "listed", "missing"]);
  for (const x of list as Array<Record<string, unknown> | null>) {
    if (!x || typeof x.symbol !== "string" || !PHASES.has(x.phase as string) || !Array.isArray(x.bookIds)) continue;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out.push({
      symbol: x.symbol,
      bookIds: x.bookIds.map(Number).filter(Number.isFinite),
      phase: x.phase as VenueMarketPhase,
      venueStatus: typeof x.venueStatus === "string" ? x.venueStatus : null,
      openForRisk: x.openForRisk === true,
      everListed: x.everListed === true,
      since: n(x.since) ?? 0,
      checkedAt: n(x.checkedAt),
      failures: n(x.failures) ?? 0,
      error: typeof x.error === "string" ? x.error : null,
    });
  }
  return out;
}

/** The book's market is listed and in Orderly's POST_ONLY launch phase (limit orders only, maker-only quoting). */
export function venueMarketPostOnly(markets: VenueMarketMsg[], bookId: number): boolean {
  const m = markets.find((x) => x.bookIds.includes(bookId));
  return !!m && m.phase === "listed" && marketStatusClass(m.venueStatus) === "post_only";
}

/**
 * Agent gate: a reason to stop new risk (reduce-only quoting / hedging) on the book's Orderly market, null = no gate.
 * not listed (awaiting) or gone (missing) -> gate; listed POST_ONLY -> gate unless `allowPostOnly`; listed and
 * restricted -> gate. unknown (no successful check) or no entry for the book -> no gate (today's behaviour).
 */
export function venueMarketGate(markets: VenueMarketMsg[], bookId: number, opts: { allowPostOnly?: boolean } = {}): { reason: string; symbol: string } | null {
  const m = markets.find((x) => x.bookIds.includes(bookId));
  if (!m || m.phase === "unknown") return null;
  if (m.phase === "awaiting") return { reason: "VENUE_NOT_LISTED", symbol: m.symbol };
  if (m.phase === "missing") return { reason: "VENUE_MARKET_MISSING", symbol: m.symbol };
  const c = marketStatusClass(m.venueStatus);
  if (c === "open") return null;
  if (c === "post_only" && opts.allowPostOnly) return null;
  return { reason: `VENUE_${(m.venueStatus ?? "RESTRICTED").toUpperCase()}`, symbol: m.symbol };
}
