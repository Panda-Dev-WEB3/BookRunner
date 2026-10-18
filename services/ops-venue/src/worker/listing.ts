// Listing check per venue symbol (docs/VERIFY.md O20). Orderly lists a builder (Perp Anything) market through Orderly One
// (dex.orderly.network/permissionless-listing); with ORDERLY_LISTING_MODE=manual the admin does it there and ops-venue
// only reads GET /v1/public/info/{symbol} (public, read-only) — never a listing or status endpoint. In api mode the same
// check follows the listing API's result.
//
// Phases (shared VenueMarketPhase): unknown (no successful check yet) -> awaiting (never seen listed: absent, NEW,
// PENDING) -> listed (any launched status; ACTIVE / no status = open for new risk, POST_ONLY / REDUCE_ONLY / DELISTING /
// DELISTED / undocumented = not) -> missing (was listed, now absent; never back to awaiting).
//
// Each symbol is checked on its own schedule (backoff while not listed / failing, slow re-check once listed), with a
// per-check timeout and at most `concurrency` checks at once, each in its own try/catch: one market waiting for its
// listing, failing or hanging never blocks another book. A forced check (provisioning, create_symbol job) never inflates
// the backoff. The state is set on every book of the symbol (TrackedBook.listing) and published by the book registry
// (VenueSymbolIssuesMsg.markets): builder price push preListing (awaiting only), alerts, /health and the agent gate.
import { isKnownMarketStatus, marketStatusClass, type VenueMarketPhase } from "@bookrunner/shared";
import { errMsg } from "../util";
import { type OpsContext, type TrackedBook, tradable } from "./context";

export type ListingPhase = VenueMarketPhase;

export interface ListingInfo {
  phase: ListingPhase;
  /** Orderly's market status of the last successful check (null: not on /v1/public/info, or a row without status) */
  venueStatus: string | null;
  /** listed and ACTIVE (or a row without status): new risk may be opened */
  openForRisk: boolean;
  everListed: boolean;
  /** unix ms: when the current phase / status was first seen (the first attempt while unknown) */
  since: number;
  /** unix ms of the last successful check */
  checkedAt: number | null;
  /** consecutive failed checks */
  failures: number;
  /** last check error, null = the last check succeeded */
  error: string | null;
}

/** Phase of one successful check. A market seen listed before and now absent is "missing", never "awaiting" again. */
export function listingPhase(r: { listed: boolean; status: string | null }, everListed = false): Exclude<ListingPhase, "unknown"> {
  if (!r.listed) return everListed ? "missing" : "awaiting";
  if (marketStatusClass(r.status) === "not_launched" && !everListed) return "awaiting";
  return "listed";
}

export interface ListingSchedule {
  /** first re-check while not listed (or after a failed check), doubling */
  recheckMs: number;
  /** cap of the doubling; also the re-check period of a listed market */
  recheckMaxMs: number;
  /** a check (GET /v1/public/info/{symbol}) still running after this counts as failed */
  timeoutMs: number;
  /** at most this many checks in flight */
  concurrency: number;
}

export const DEFAULT_LISTING_SCHEDULE: ListingSchedule = { recheckMs: 15_000, recheckMaxMs: 300_000, timeoutMs: 5_000, concurrency: 4 };

interface SymbolEntry {
  info: ListingInfo | null;
  nextAt: number;
  delayMs: number;
  inFlight: Promise<void> | null;
  warnedUnknown: boolean;
}

/** Book states whose market must exist on Orderly (a Cancelled / Retired book is no longer listed by us). */
export const CHECKED_STATES: ReadonlySet<string> = new Set(["Subscription", "Live", "Retiring"]);

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
   * Checks every due symbol of `books` (tradable, Subscription / Live / Retiring); `force` checks now without touching the
   * backoff (provisioning a book, the create_symbol job). Never throws; bounded by the per-check timeout.
   */
  async check(books: TrackedBook[], force = false): Promise<void> {
    const groups = new Map<string, TrackedBook[]>();
    for (const b of books) {
      if (!tradable(b) || !CHECKED_STATES.has(b.state)) continue;
      groups.set(b.symbol, [...(groups.get(b.symbol) ?? []), b]);
    }
    const due: Array<[string, SymbolEntry, TrackedBook[]]> = [];
    for (const [symbol, group] of groups) {
      let e = this.by.get(symbol);
      if (!e) {
        e = { info: null, nextAt: 0, delayMs: this.schedule.recheckMs, inFlight: null, warnedUnknown: false };
        this.by.set(symbol, e);
      }
      if (force || this.ctx.now() >= e.nextAt) due.push([symbol, e, group]);
    }
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const [symbol, e, group] = due[next++] as [string, SymbolEntry, TrackedBook[]];
        // a check of this symbol still in flight (forced + scheduled at once): wait for it instead of a second GET
        e.inFlight ??= this.checkOne(symbol, e, group, force).finally(() => {
          e.inFlight = null;
        });
        await e.inFlight;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.schedule.concurrency, due.length)) }, worker));
    for (const [symbol, group] of groups) for (const b of group) b.listing = this.by.get(symbol)?.info ?? null;
  }

  private async status(symbol: string): Promise<{ listed: boolean; status: string | null }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`listing check timed out after ${this.schedule.timeoutMs} ms`)), this.schedule.timeoutMs);
    });
    try {
      return await Promise.race([this.ctx.builder.listingStatus(symbol), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Scheduled checks double the delay while not listed / failing; forced checks keep the schedule as it is. */
  private reschedule(e: SymbolEntry, now: number, settled: boolean, force: boolean): void {
    if (settled) {
      e.delayMs = this.schedule.recheckMs;
      e.nextAt = now + this.schedule.recheckMaxMs;
      return;
    }
    if (force) {
      e.nextAt = now + e.delayMs; // re-check after the current delay, which a forced check does not double
      return;
    }
    e.nextAt = now + e.delayMs;
    e.delayMs = Math.min(e.delayMs * 2, this.schedule.recheckMaxMs);
  }

  private async checkOne(symbol: string, e: SymbolEntry, group: TrackedBook[], force: boolean): Promise<void> {
    const { log } = this.ctx;
    const now = this.ctx.now();
    const bookIds = group.map((b) => b.bookId);
    const prev = e.info;
    try {
      const r = await this.status(symbol);
      const everListed = prev?.everListed ?? false;
      const phase = listingPhase(r, everListed);
      if (r.status !== null && !isKnownMarketStatus(r.status) && !e.warnedUnknown) {
        e.warnedUnknown = true;
        log.warn({ symbol, venueStatus: r.status, bookIds }, "Orderly market status not in the documented set: listed, but restricted (no new risk) (VERIFY O20)");
      }
      const status = r.listed ? r.status : null;
      const same = prev !== null && prev.phase === phase && prev.venueStatus === status;
      e.info = {
        phase,
        venueStatus: status,
        openForRisk: phase === "listed" && marketStatusClass(status) === "open",
        everListed: everListed || phase === "listed",
        since: same ? prev.since : now,
        checkedAt: now,
        failures: 0,
        error: null,
      };
      // listed and open: slow re-check; anything else (awaiting, missing, restricted) re-checks with backoff
      this.reschedule(e, now, e.info.openForRisk, force);
      if (!same) this.logChange(symbol, prev, e.info, group);
    } catch (err) {
      const msg = errMsg(err);
      e.info = prev
        ? { ...prev, failures: prev.failures + 1, error: msg }
        : { phase: "unknown", venueStatus: null, openForRisk: false, everListed: false, since: now, checkedAt: null, failures: 1, error: msg };
      this.reschedule(e, now, false, force);
      const lvl = e.info.failures === 1 || e.info.failures % 10 === 0 ? "warn" : "debug";
      log[lvl]({ symbol, bookIds, err: msg, failures: e.info.failures, retryInMs: e.nextAt - now }, "Orderly listing check failed (will retry)");
    }
  }

  private logChange(symbol: string, prev: ListingInfo | null, next: ListingInfo, group: TrackedBook[]): void {
    const { log, settings } = this.ctx;
    const bookIds = group.map((b) => b.bookId);
    const from = prev ? `${prev.phase}${prev.venueStatus ? `:${prev.venueStatus}` : ""}` : "unchecked";
    const base = { symbol, venueStatus: next.venueStatus, bookIds, from };
    if (next.phase === "awaiting") {
      const what = { ...base, mode: this.mode, ifAccounts: group.map((b) => b.accounts.if), oracleFeed: `ORACLE_${settings.brokerId}` };
      if (this.mode === "manual") {
        log.warn(what, "awaiting listing in Orderly One: the admin lists this market (dex.orderly.network/permissionless-listing) with price source ORACLE_<broker> and the book's IF account; ops-venue re-checks /v1/public/info");
      } else {
        log.warn(what, "Orderly market not listed / not launched yet (listing API); ops-venue re-checks /v1/public/info");
      }
      return;
    }
    if (next.phase === "missing") {
      const live = group.some((b) => b.state === "Live");
      log[live ? "error" : "warn"](base, live ? "Orderly market was listed and is now MISSING from /v1/public/info while a book is Live" : "Orderly market was listed and is now missing from /v1/public/info (delisted?)");
      return;
    }
    if (!next.openForRisk) {
      log.warn(base, "Orderly market is listed but not open for new risk (POST_ONLY / REDUCE_ONLY / DELISTING / DELISTED): the agent stays reduce-only");
    } else {
      log.info(base, "Orderly market listed and open");
    }
  }
}
