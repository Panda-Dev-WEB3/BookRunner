// Book discovery (poll): Orderly-venue books from deployment.books + BookFactory.bookIds(), their
// adapter account ids and lifecycle state. Non-Orderly books are remembered and skipped. Each book's charter symbol is
// mapped once here to its venue symbol (@bookrunner/shared resolveVenueSymbol: ORDERLY_MODE + ORDERLY_BROKER_ID). A
// live book without an Orderly market stays tracked for its non-trading duties (TrackedBook.venueSymbolError); the
// set of such books is published every pass (KEYS.venueSymbolIssues) for alerts, with the books whose market is not
// listed / open on Orderly (TrackedBook.listing, worker/listing.ts) and IF withdrawals waiting for a delisting.
// Each book's IF account binding (contract OrderlyIFAccount / builder EOA, domain/ifAccount.ts) is checked against
// ORDERLY_IF_MODE; a mismatch, or a book still in Subscription, is re-read every poll (the timelock may switch the IF
// account owner while the IF is empty), and a changed IF account re-provisions the book (RegistryDelta.rebound).
import { type BookState, resolveVenueSymbol, type VenueMarketMsg, type VenueSymbolIssuesMsg } from "@bookrunner/shared";
import type { OrderlyBook } from "../chain";
import { ifAccountIssue, ifBindingOf } from "../domain/ifAccount";
import { errMsg } from "../util";
import { lc, type OpsContext, type TrackedBook } from "./context";

/** Book states whose market must be listed (published in VenueSymbolIssuesMsg.markets). */
const LISTING_STATES: ReadonlySet<string> = new Set(["Subscription", "Live", "Retiring"]);

export interface RegistryDelta {
  added: TrackedBook[];
  changed: Array<{ book: TrackedBook; from: BookState }>;
  /** the IF account binding changed (adapter.setIfAccountOwner): re-provision (force); `from` = the previous IF account */
  rebound: Array<{ book: TrackedBook; from: string }>;
}

type IfFacts = Pick<TrackedBook, "accounts" | "owners" | "ifBinding" | "ifAccountError">;

export class BookRegistry {
  readonly books = new Map<number, TrackedBook>();
  private readonly skipped = new Set<number>();

  constructor(private readonly ctx: OpsContext) {}

  /** `publish: false`: the caller publishes the status itself (OpsService.syncBooks, after the listing checks). */
  async refresh(opts: { publish?: boolean } = {}): Promise<RegistryDelta> {
    const delta: RegistryDelta = { added: [], changed: [], rebound: [] };
    const ids = await this.ctx.chain.listBookIds();
    for (const id of ids) {
      if (this.skipped.has(id)) continue;
      const known = this.books.get(id);
      if (known) {
        try {
          const state = await this.ctx.chain.bookState(known.book);
          if (state !== known.state) {
            const from = known.state;
            known.state = state;
            delta.changed.push({ book: known, from });
            this.ctx.log.info({ bookId: id, from, to: state }, "book state changed");
          }
        } catch (err) {
          this.ctx.log.warn({ bookId: id, err: errMsg(err) }, "book state read failed");
        }
        const due = this.ctx.now() - (this.ifReadAt.get(id) ?? 0) >= (this.ctx.settings.ifBindingRecheckMs ?? 300_000);
        if (known.ifAccountError || known.state === "Subscription" || due) await this.rereadIf(known, delta);
        continue;
      }
      try {
        const b = await this.ctx.chain.loadOrderlyBook(id);
        if (!b) {
          this.skipped.add(id);
          continue;
        }
        const r = resolveVenueSymbol({ charterSymbol: b.charterSymbol, mode: this.ctx.settings.mode, brokerId: this.ctx.settings.brokerId });
        const [state, facts] = await Promise.all([this.ctx.chain.bookState(b.book), this.readIf(b)]);
        const tb: TrackedBook = { ...b, symbol: r.symbol ?? b.charterSymbol, venueSymbolError: r.error, state, ...facts };
        this.ifReadAt.set(id, this.ctx.now());
        if (tb.ifAccountError) this.ctx.log.error({ bookId: id, ifMode: this.ifMode, ifBinding: tb.ifBinding, ifAccount: tb.accounts.if, err: tb.ifAccountError }, "Orderly book IF account does not match ORDERLY_IF_MODE: no IF provisioning for it (re-checked every poll)");
        this.books.set(id, tb);
        delta.added.push(tb);
        if (r.error !== null) {
          // the charter symbol is immutable: never listed / traded; its capital is still reported and withdrawable
          this.ctx.log.error({ bookId: id, charterSymbol: b.charterSymbol, state, err: r.error }, "Orderly book tracked WITHOUT listing or trading: no venue symbol for its charter symbol");
        } else {
          if (r.warning) this.ctx.log.warn({ bookId: id, charterSymbol: b.charterSymbol, warning: r.warning }, "Orderly book charter symbol breaks the charter rule");
          this.ctx.log.info({ bookId: id, symbol: r.symbol, charterSymbol: b.charterSymbol, state, adapter: b.adapter }, "tracking Orderly book");
        }
      } catch (err) {
        this.ctx.log.warn({ bookId: id, err: errMsg(err) }, "book load failed (will retry)");
      }
    }
    if (opts.publish !== false) await this.publishStatus();
    return delta;
  }

  private get ifMode() {
    return this.ctx.settings.ifMode ?? "contract";
  }

  /** The adapter's IF account binding and its consistency with ORDERLY_IF_MODE (domain/ifAccount.ts). */
  private async readIf(b: Pick<OrderlyBook, "bookId" | "adapter">): Promise<IfFacts> {
    const { chain, settings } = this.ctx;
    const [accounts, owners, builderOwner] = await Promise.all([chain.accountIds(b.adapter), chain.accountOwners(b.adapter), chain.ifAccountOwner(b.adapter)]);
    const ifBinding = ifBindingOf({ adapter: b.adapter, ifOwner: owners.if, builderOwner });
    const ifAccountError = ifAccountIssue({ mode: this.ifMode, binding: ifBinding, bookId: b.bookId, accountId: accounts.if, ifOwner: owners.if, ...(settings.ifBuilderAccounts ? { expected: settings.ifBuilderAccounts } : {}) });
    return { accounts, owners, ifBinding, ifAccountError };
  }

  private readonly ifReadAt = new Map<number, number>();

  private async rereadIf(known: TrackedBook, delta: RegistryDelta): Promise<void> {
    this.ifReadAt.set(known.bookId, this.ctx.now());
    let f: IfFacts;
    try {
      f = await this.readIf(known);
    } catch (err) {
      this.ctx.log.debug({ bookId: known.bookId, err: errMsg(err) }, "IF account re-read failed");
      return;
    }
    const moved = f.accounts.if.toLowerCase() !== known.accounts.if.toLowerCase() || f.owners.if.toLowerCase() !== known.owners.if.toLowerCase();
    const errChanged = (f.ifAccountError ?? null) !== (known.ifAccountError ?? null);
    if (!moved && !errChanged) return;
    const before = { ifAccount: known.accounts.if, err: known.ifAccountError ?? null };
    Object.assign(known, f);
    if (moved) {
      delta.rebound.push({ book: known, from: before.ifAccount });
      this.ctx.log.warn({ bookId: known.bookId, from: before.ifAccount, to: f.accounts.if, ifBinding: f.ifBinding, owner: f.owners.if }, "book IF account changed on-chain (adapter.setIfAccountOwner): re-provisioning");
    }
    if (f.ifAccountError) this.ctx.log.error({ bookId: known.bookId, ifMode: this.ifMode, ifBinding: f.ifBinding, err: f.ifAccountError }, "Orderly book IF account does not match ORDERLY_IF_MODE");
    else if (before.err) this.ctx.log.info({ bookId: known.bookId, ifBinding: f.ifBinding, ifAccount: f.accounts.if }, "Orderly book IF account now matches ORDERLY_IF_MODE");
  }

  /** Books tracked without listing / trading (live mode, no Orderly market for the charter symbol). */
  untradable(): TrackedBook[] {
    return this.list().filter((b) => b.venueSymbolError !== null);
  }

  /** Manual listing mode: IF withdrawals waiting for the admin's delisting (set by OpsService from the withdrawals worker). */
  delistWaits: () => NonNullable<VenueSymbolIssuesMsg["delistWaits"]> = () => [];
  /** Builder IF mode: IF ops keys waiting for the operator's registration (set by OpsService from the provisioner). */
  ifKeysPending: () => Array<{ bookId: number; accountId: string; owner: string; since: number }> = () => [];
  /** After an IF account switch: markets that may still have the previous IF account (set by OpsService). */
  ifReassign: () => Array<{ bookId: number; from: string; to: string; since: number }> = () => [];
  /** Builder IF mode: equity found on the IF account before the book's deposit (set by OpsService). */
  ifPriorEquity: () => Array<{ bookId: number; accountId: string; usd: string; since: number }> = () => [];
  /** Builder IF mode: IF withdrawals no saga adopted (set by OpsService from the withdrawals worker). */
  ifUnadopted: () => NonNullable<VenueSymbolIssuesMsg["ifUnadopted"]> = () => [];
  /** Builder IF mode: unexplained IF equity drops (set by OpsService from the reporter). */
  ifEquityDrops: () => NonNullable<VenueSymbolIssuesMsg["ifEquityDrops"]> = () => [];
  /** Builder IF mode: IF withdrawals waiting for the operator (set by OpsService from the withdrawals worker). */
  ifOperatorWaits: () => NonNullable<VenueSymbolIssuesMsg["ifOperatorWaits"]> = () => [];

  /** IF account problems per book (mismatch with ORDERLY_IF_MODE, builder IF key not registered yet), for alerts. */
  ifAccountIssues(): NonNullable<VenueSymbolIssuesMsg["ifAccounts"]> {
    const out: NonNullable<VenueSymbolIssuesMsg["ifAccounts"]> = [];
    const pending = new Map(this.ifKeysPending().map((p) => [p.bookId, p]));
    const prior = new Map(this.ifPriorEquity().map((p) => [p.bookId, p]));
    const reassign = new Map(this.ifReassign().map((p) => [p.bookId, p]));
    for (const b of this.list()) {
      if (b.state === "Cancelled" || b.state === "Retired") continue;
      const p = pending.get(b.bookId);
      if (b.ifAccountError) out.push({ bookId: b.bookId, accountId: b.accounts.if, binding: b.ifBinding ?? "contract", issue: "mismatch", detail: b.ifAccountError });
      else if (p) out.push({ bookId: b.bookId, accountId: p.accountId, binding: "builder", issue: "key_pending", detail: `the operator (wallet ${p.owner}) must register ops-venue's IF key for ${p.accountId}`, since: p.since });
      const pe = prior.get(b.bookId);
      if (pe) out.push({ bookId: b.bookId, accountId: pe.accountId, binding: "builder", issue: "prior_equity", detail: `the builder IF account held ${pe.usd} (USD 6dp) before the book's IF deposit: reports refused; bind a fresh EOA account`, since: pe.since });
      const ra = reassign.get(b.bookId);
      if (ra) out.push({ bookId: b.bookId, accountId: ra.to, binding: b.ifBinding ?? "contract", issue: "reassign", detail: `the book's IF account changed from ${ra.from}: the admin re-assigns the market ${b.symbol}'s IF account in Orderly One (fund_if checks the market's IF balance)`, since: ra.since });
    }
    return out;
  }

  /** Orderly market state per venue symbol of the tradable books in Subscription / Live / Retiring (listing checks). */
  markets(): VenueMarketMsg[] {
    const by = new Map<string, { bookIds: number[]; info: NonNullable<TrackedBook["listing"]> | null }>();
    for (const b of this.list()) {
      if (b.venueSymbolError !== null || !LISTING_STATES.has(b.state)) continue;
      const cur = by.get(b.symbol) ?? { bookIds: [], info: null };
      cur.bookIds = [...cur.bookIds, b.bookId].sort((x, y) => x - y);
      cur.info ??= b.listing ?? null;
      by.set(b.symbol, cur);
    }
    const out: VenueMarketMsg[] = [];
    for (const [symbol, { bookIds, info }] of by) {
      if (!info) continue; // not checked yet
      out.push({ symbol, bookIds, phase: info.phase, venueStatus: info.venueStatus, openForRisk: info.openForRisk, everListed: info.everListed, since: info.since, checkedAt: info.checkedAt, failures: info.failures, error: info.error });
    }
    return out;
  }

  async publishStatus(): Promise<void> {
    if (!this.ctx.status) return;
    const msg: VenueSymbolIssuesMsg = {
      v: 1,
      ts: this.ctx.now(),
      mode: this.ctx.settings.mode,
      builderPush: this.ctx.settings.builderPush === true,
      books: this.untradable().map((b) => ({ bookId: b.bookId, charterSymbol: b.charterSymbol, error: b.venueSymbolError as string })),
      listingMode: this.ctx.settings.listingMode ?? "api",
      markets: this.markets(),
      delistWaits: this.delistWaits(),
      ifMode: this.ifMode,
      ifAccounts: this.ifAccountIssues(),
      ifOperatorWaits: this.ifOperatorWaits(),
      ifUnadopted: this.ifUnadopted(),
      ifEquityDrops: this.ifEquityDrops(),
    };
    try {
      await this.ctx.status.venueSymbolIssues(msg);
    } catch (err) {
      this.ctx.log.debug({ err: errMsg(err) }, "venue symbol status publish failed");
    }
  }

  get(bookId: number): TrackedBook | undefined {
    return this.books.get(bookId);
  }

  byAdapter(adapter: string): TrackedBook | undefined {
    for (const b of this.books.values()) if (lc(b.adapter) === lc(adapter)) return b;
    return undefined;
  }

  byMandate(mandate: string): TrackedBook | undefined {
    for (const b of this.books.values()) if (lc(b.mandate) === lc(mandate)) return b;
    return undefined;
  }

  list(): TrackedBook[] {
    return [...this.books.values()];
  }
}
