// Listing check per venue symbol (docs/VERIFY.md O20). Orderly lists a builder (Perp Anything) market through Orderly One
// (dex.orderly.network/permissionless-listing); with ORDERLY_LISTING_MODE=manual the admin does it there and ops-venue
// only reads GET /v1/public/info/{symbol} (public, read-only) — never a listing or status endpoint. In api mode the same
// check follows the listing API's result. Each symbol is checked on its own schedule (backoff while not listed, slow
// re-check once listed) and its own try/catch: one market waiting for its listing never blocks another book. The phase is
// set on every book of the symbol (TrackedBook.listing): the builder price push treats a not-listed market as preListing
// (never paged), the book registry publishes the waiting ones (VenueSymbolIssuesMsg.awaitingListing, alert
// venue_listing_pending in manual mode).
import { errMsg } from "../util";
import { type OpsContext, type TrackedBook, tradable } from "./context";

/** awaiting: absent from /v1/public/info or NEW / PENDING (not launched yet); listed: any later status. */
export type ListingPhase = "awaiting" | "listed";

export interface ListingInfo {
  phase: ListingPhase;
  /** Orderly's market status (null: not on /v1/public/info, or a row without status) */
  venueStatus: string | null;
  /** unix ms: when the current phase was first seen */
  since: number;
  /** unix ms of the last successful check */
  checkedAt: number;
  /** last check error (the phase is kept), null = the last check succeeded */
  error: string | null;
}

/** Orderly market statuses (docs: perp-anything/market-operations). NEW / PENDING: created, not launched. */
const NOT_LAUNCHED: ReadonlySet<string> = new Set(["NEW", "PENDING"]);
const KNOWN: ReadonlySet<string> = new Set(["NEW", "PENDING", "POST_ONLY", "ACTIVE", "REDUCE_ONLY", "DELISTING", "DELISTED"]);
/** Listed, but Orderly restricts trading (close-only or winding down): the book's market making cannot run normally. */
const RESTRICTED: ReadonlySet<string> = new Set(["REDUCE_ONLY", "DELISTING", "DELISTED"]);

/** A row on /v1/public/info is listed unless its status says it has not launched (an unknown status counts as listed). */
export function listingPhase(r: { listed: boolean; status: string | null }): ListingPhase {
  if (!r.listed) return "awaiting";
  return r.status !== null && NOT_LAUNCHED.has(r.status.toUpperCase()) ? "awaiting" : "listed";
}

export interface ListingSchedule {
  /** first re-check while not listed (or after a failed check), doubling */
  recheckMs: number;
  /** cap of the doubling; also the re-check period of a listed market */
  recheckMaxMs: number;
}

export const DEFAULT_LISTING_SCHEDULE: ListingSchedule = { recheckMs: 15_000, recheckMaxMs: 300_000 };

interface SymbolEntry {
  info: ListingInfo | null;
  nextAt: number;
  delayMs: number;
  warnedUnknown?: boolean;
}

/** Book states whose market must exist on Orderly (a Cancelled / Retired book is no longer listed by us). */
const CHECKED_STATES: ReadonlySet<string> = new Set(["Subscription", "Live", "Retiring"]);

export class ListingTracker {
  private readonly by = new Map<string, SymbolEntry>();
  readonly schedule: ListingSchedule;

  constructor(
    private readonly ctx: OpsContext,
    schedule?: Partial<ListingSchedule>,
  ) {
    this.schedule = { ...DEFAULT_LISTING_SCHEDULE, ...(ctx.settings.listingRecheck ?? {}), ...(schedule ?? {}) };
  }

  get mode(): "api" | "manual" {
    return this.ctx.settings.listingMode ?? "api";
  }

  info(symbol: string): ListingInfo | null {
    return this.by.get(symbol)?.info ?? null;
  }

  /**
   * Checks every due symbol of `books` (tradable, Subscription / Live / Retiring); `force` checks now (provisioning a
   * book, the create_symbol job). Never throws: a failed check is recorded on that symbol and retried with backoff.
   */
  async check(books: TrackedBook[], force = false): Promise<void> {
    const groups = new Map<string, TrackedBook[]>();
    for (const b of books) {
      if (!tradable(b) || !CHECKED_STATES.has(b.state)) continue;
      groups.set(b.symbol, [...(groups.get(b.symbol) ?? []), b]);
    }
    for (const [symbol, group] of groups) {
      const e = this.by.get(symbol) ?? { info: null, nextAt: 0, delayMs: this.schedule.recheckMs };
      this.by.set(symbol, e);
      if (force || this.ctx.now() >= e.nextAt) await this.checkOne(symbol, e, group);
      for (const b of group) b.listing = e.info;
    }
  }

  private async checkOne(symbol: string, e: SymbolEntry, group: TrackedBook[]): Promise<void> {
    const { builder, log } = this.ctx;
    const now = this.ctx.now();
    const bookIds = group.map((b) => b.bookId);
    try {
      const r = await builder.listingStatus(symbol);
      const phase = listingPhase(r);
      const prev = e.info;
      if (r.status !== null && !KNOWN.has(r.status.toUpperCase()) && !e.warnedUnknown) {
        e.warnedUnknown = true;
        log.warn({ symbol, venueStatus: r.status, bookIds }, "Orderly market status not in the documented set: treated as listed (VERIFY O20)");
      }
      e.info = { phase, venueStatus: r.status, since: prev && prev.phase === phase ? prev.since : now, checkedAt: now, error: null };
      if (phase === "listed") {
        e.delayMs = this.schedule.recheckMs;
        e.nextAt = now + this.schedule.recheckMaxMs;
      } else {
        e.nextAt = now + e.delayMs;
        e.delayMs = Math.min(e.delayMs * 2, this.schedule.recheckMaxMs);
      }
      this.logChange(symbol, prev, e.info, group);
    } catch (err) {
      const msg = errMsg(err);
      e.info = e.info ? { ...e.info, error: msg } : null;
      e.nextAt = now + e.delayMs;
      e.delayMs = Math.min(e.delayMs * 2, this.schedule.recheckMaxMs);
      log.warn({ symbol, bookIds, err: msg, retryInMs: e.nextAt - now }, "Orderly listing check failed (will retry)");
    }
  }

  private logChange(symbol: string, prev: ListingInfo | null, next: ListingInfo, group: TrackedBook[]): void {
    const { log, settings } = this.ctx;
    if (prev && prev.phase === next.phase && prev.venueStatus === next.venueStatus) return; // unchanged (or a check error recovered)
    const bookIds = group.map((b) => b.bookId);
    if (next.phase === "awaiting") {
      const what = { symbol, venueStatus: next.venueStatus, bookIds, mode: this.mode, ifAccounts: group.map((b) => b.accounts.if), oracleFeed: `ORACLE_${settings.brokerId}` };
      if (this.mode === "manual") {
        log.warn(what, "awaiting listing in Orderly One: the admin lists this market (dex.orderly.network/permissionless-listing) with price source ORACLE_<broker> and the book's IF account; ops-venue re-checks /v1/public/info");
      } else {
        log.warn(what, "Orderly market not listed / not launched yet (listing API); ops-venue re-checks /v1/public/info");
      }
      return;
    }
    const restricted = next.venueStatus !== null && RESTRICTED.has(next.venueStatus.toUpperCase());
    const tradingBook = group.some((b) => b.state === "Live");
    if (restricted && tradingBook) {
      log.warn({ symbol, venueStatus: next.venueStatus, bookIds }, "Orderly market is restricted (close-only / winding down) while a book is Live");
    } else {
      log.info({ symbol, venueStatus: next.venueStatus, bookIds, from: prev?.venueStatus ?? (prev ? "not listed" : "unchecked") }, "Orderly market listed");
    }
  }
}
