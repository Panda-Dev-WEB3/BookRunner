// Pure helpers behind the Home page (no DOM, no React): the live strip summary, the launch-book market
// descriptions and the deposit-round status of each book. Unit-tested in test/home.test.ts.
import { tickerOf, usdRaw } from "../../lib/format";
import { type TopUpRound, isTopUpOpen } from "../../lib/topup";

/** The fields of a book.list row the Home page reads (BookListItem satisfies it). */
export interface HomeBook {
  bookId: number;
  symbol: string;
  venue: string;
  state: string;
  navUsd: string | null;
  seniorNavUsd: string | null;
  juniorNavUsd: string | null;
  subscriptionEnds?: string | null;
  lastMark: { committedAt: string | null } | null;
  markSchedule?: { nextPeriodEnd: number; intervalSeconds: number; cadence: string; status: string } | null;
}

export interface BooksSummary {
  total: number;
  /** Books in the Live state. */
  live: number;
  /** Tickers of the live books, in book order. */
  liveTickers: string[];
  /** Sum of each book's latest marked NAV (USDC base units, 6 decimals). */
  navRaw: bigint;
  seniorRaw: bigint;
  juniorRaw: bigint;
  /** At least one book reports a NAV. */
  hasNav: boolean;
  /** Newest mark commit time (ISO) across all books, or null before the first mark. */
  latestMarkAt: string | null;
  /** The soonest scheduled mark among books that are marked (Live or Retiring), in lib/lowgas's shape. */
  nextMark: { nextPeriodEnd: number; cadence: string; intervalSeconds: number; status: "due" | "scheduled" } | null;
}

const MARKED_STATES = new Set(["Live", "Retiring"]);

export function summarizeBooks(books: readonly HomeBook[]): BooksSummary {
  let navRaw = 0n;
  let seniorRaw = 0n;
  let juniorRaw = 0n;
  let hasNav = false;
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestMarkAt: string | null = null;
  let nextMark: BooksSummary["nextMark"] = null;
  const sorted = [...books].sort((a, b) => a.bookId - b.bookId);
  for (const b of sorted) {
    const nav = usdRaw(b.navUsd);
    if (nav !== null) {
      navRaw += nav;
      hasNav = true;
    }
    seniorRaw += usdRaw(b.seniorNavUsd) ?? 0n;
    juniorRaw += usdRaw(b.juniorNavUsd) ?? 0n;
    const at = b.lastMark?.committedAt ?? null;
    const ms = at ? Date.parse(at) : Number.NaN;
    if (at && Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latestMarkAt = at;
    }
    const s = b.markSchedule;
    if (s && MARKED_STATES.has(b.state) && (nextMark === null || s.nextPeriodEnd < nextMark.nextPeriodEnd)) {
      nextMark = { nextPeriodEnd: s.nextPeriodEnd, cadence: s.cadence, intervalSeconds: s.intervalSeconds, status: s.status === "due" ? "due" : "scheduled" };
    }
  }
  const liveBooks = sorted.filter((b) => b.state === "Live");
  return {
    total: books.length,
    live: liveBooks.length,
    liveTickers: liveBooks.map((b) => tickerOf(b.symbol)),
    navRaw,
    seniorRaw,
    juniorRaw,
    hasNav,
    latestMarkAt,
    nextMark,
  };
}

/** Senior and Junior as fractions of their sum (null when both are zero). */
export function trancheSplit(seniorRaw: bigint, juniorRaw: bigint): { senior: number; junior: number } | null {
  const s = seniorRaw > 0n ? seniorRaw : 0n;
  const j = juniorRaw > 0n ? juniorRaw : 0n;
  const total = s + j;
  if (total === 0n) return null;
  const senior = Number((s * 10_000n) / total) / 10_000;
  return { senior, junior: 1 - senior };
}

/** Whole-number percent for a 0..1 fraction ("70%"); never rounds a non-zero share down to 0%. */
export function sharePct(frac: number): string {
  if (!Number.isFinite(frac) || frac <= 0) return "0%";
  if (frac < 0.01) return "<1%";
  if (frac > 0.99 && frac < 1) return ">99%";
  return `${Math.round(frac * 100)}%`;
}

// ------------------------------------------------------------------ markets
export interface MarketInfo {
  ticker: string;
  /** Short market name ("NVIDIA stock perp"). */
  name: string;
  kind: "stock" | "index" | "other";
  /** One or two plain sentences on what the market follows and how the book hedges it. */
  blurb: string;
  /** Index components (index books only). */
  components?: string[];
}

const RHX5_COMPONENTS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"];

const KNOWN_MARKETS: Record<string, Omit<MarketInfo, "ticker">> = {
  NVDA: {
    name: "NVIDIA stock perp",
    kind: "stock",
    blurb: "Follows the NVIDIA share price with no expiry date. The book hedges with the NVDA Stock Token.",
  },
  TSLA: {
    name: "Tesla stock perp",
    kind: "stock",
    blurb: "Follows the Tesla share price with no expiry date. The book hedges with the TSLA Stock Token.",
  },
  RHX5: {
    name: "Five-stock index perp",
    kind: "index",
    blurb: "Follows an equal-weight index of NVDA, TSLA, AAPL, MSFT and AMZN (20% each). The book can hedge with all five Stock Tokens.",
    components: RHX5_COMPONENTS,
  },
};

/**
 * What a book's market is, for a newcomer. Unknown symbols get a neutral description. On a test
 * network the Stock Tokens are protocol-owned mocks priced from the signed oracle (Deploy.s.sol).
 */
export function marketInfo(symbol: string, testnet = false): MarketInfo {
  const ticker = tickerOf(symbol);
  const known = KNOWN_MARKETS[ticker];
  if (known) return { ticker, ...known, blurb: testnet && known.kind !== "other" ? `${known.blurb} On this test network, Stock Tokens are protocol-owned mocks priced from the signed oracle.` : known.blurb };
  return { ticker, name: `${ticker} perp`, kind: "other", blurb: "A perp market chartered through Bookrunner and approved by the Risk Committee." };
}

// ------------------------------------------------------------------ deposits
export type DepositStatus =
  /** A new book's subscription window is open. */
  | { kind: "window"; endsAt: number }
  /** A live book has an open top-up round with capacity left in at least one tranche. */
  | { kind: "topup"; endsAt: number; seniorCapacity: bigint; juniorCapacity: bigint }
  /** Still reading the round from the chain. */
  | { kind: "checking" }
  | { kind: "closed"; reason: "full" | "no-round" | "window-ended" | "not-live" | "unknown" };

/**
 * Can this book take a deposit now? `round` is the book's top-up round: undefined while it loads,
 * null when it could not be read.
 */
export function depositStatus(book: Pick<HomeBook, "state" | "subscriptionEnds">, round: TopUpRound | null | undefined, nowSec: number): DepositStatus {
  if (book.state === "Subscription") {
    const ends = book.subscriptionEnds ? Math.floor(Date.parse(book.subscriptionEnds) / 1000) : Number.NaN;
    if (Number.isFinite(ends) && ends > nowSec) return { kind: "window", endsAt: ends };
    return { kind: "closed", reason: "window-ended" };
  }
  if (book.state !== "Live") return { kind: "closed", reason: "not-live" };
  if (round === undefined) return { kind: "checking" };
  if (round === null) return { kind: "closed", reason: "unknown" };
  if (!isTopUpOpen(round, nowSec)) return { kind: "closed", reason: "no-round" };
  if (round.seniorCapacityUsd === 0n && round.juniorCapacityUsd === 0n) return { kind: "closed", reason: "full" };
  return { kind: "topup", endsAt: round.endsAt, seniorCapacity: round.seniorCapacityUsd, juniorCapacity: round.juniorCapacityUsd };
}

export const depositOpen = (s: DepositStatus): boolean => s.kind === "window" || s.kind === "topup";

/**
 * How much of a top-up round's capacity is already committed (0..1, capped). `over` flags an
 * oversubscribed round: every deposit is then filled pro-rata at settlement and the rest refunded.
 */
export function roundFill(committed: bigint, capacity: bigint): { frac: number; over: boolean } | null {
  if (capacity <= 0n) return null;
  const c = committed > 0n ? committed : 0n;
  if (c >= capacity) return { frac: 1, over: c > capacity };
  return { frac: Number((c * 10_000n) / capacity) / 10_000, over: false };
}

const DAY_UTC = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** Unix seconds -> "1 Nov 2026" (UTC, so every reader sees the same day). */
export function fmtDayUtc(sec: number): string {
  const d = new Date(sec * 1000);
  if (!Number.isFinite(sec) || Number.isNaN(d.getTime())) return "—";
  const parts = Object.fromEntries(DAY_UTC.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month} ${parts.year}`;
}

/** One-line headline for a deposit status. */
export function depositHeadline(s: DepositStatus): string {
  switch (s.kind) {
    case "window":
      return `Subscription window open until ${fmtDayUtc(s.endsAt)}`;
    case "topup":
      return `Deposits open until ${fmtDayUtc(s.endsAt)}`;
    case "checking":
      return "Checking the deposit round";
    case "closed":
      return {
        full: "Deposit round full",
        "no-round": "No deposit round open",
        "window-ended": "Subscription window closed",
        "not-live": "Not taking deposits",
        unknown: "Deposit round unavailable",
      }[s.reason];
  }
}
