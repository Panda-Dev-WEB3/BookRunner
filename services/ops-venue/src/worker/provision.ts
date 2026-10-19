// Venue provisioning per Orderly book (idempotent): builder account + key, per-book keys (trade-only
// key for the MM account, ops keys for IF/MM), key registration via the delegate signer, symbol
// creation under the builder account with the IF account assigned, venue_accounts rows (key PREFIX
// only). Re-run on state changes; Retiring books go REDUCE_ONLY. Trade keys are re-issued only after
// a re-mandate (rotateTradeKey). Keys and withdrawals of a contract account name its owner as
// delegateContract (v3: the adapter for MM, the OrderlyIFAccount for IF; see chain.accountOwners).
// A book without an Orderly market (TrackedBook.venueSymbolError) gets its accounts, delegates and ops keys (reports,
// withdrawals) but no trade key registration and no listing.
// IF account mode (ORDERLY_IF_MODE, domain/ifAccount.ts): contract = the OrderlyIFAccount delegate account as above;
// builder = an operator EOA's account: no delegate, and the IF ops key is registered by the operator's wallet (ops-venue
// only checks for it). A book whose IF binding does not match the mode gets no IF provisioning and no api-mode listing.
// ORDERLY_LISTING_MODE=manual (VERIFY O20): the admin lists the market in Orderly One. Provisioning then never calls
// createSymbol or setSymbolStatus: it sets up accounts and keys and leaves the listing to the ListingTracker, which
// re-checks /v1/public/info with backoff until the market is there (log + Redis status + alert venue_listing_pending),
// per symbol, so a book waiting for its listing never holds up another book.
import type { Address } from "viem";
import { OrderlyHttpError } from "../orderly/http";
import { BUILDER_SCOPE, type KeyStore, newStoredKey, prefixOf, type StoredKey } from "../keys";
import type { Ed25519Key } from "../orderly/auth";
import { errMsg } from "../util";
import { type OpsContext, type TrackedBook, tradable } from "./context";
import { ListingTracker } from "./listing";

export class Provisioner {
  private readonly done = new Map<number, string>();
  private builderReady = false;
  /** builder IF mode: IF ops keys the operator has not registered yet (bookId -> key, first / last check) */
  private readonly ifKeyPending = new Map<number, { accountId: string; orderlyKey: string; owner: string; since: number; checkedAt: number }>();
  private readonly ifIssueLogged = new Map<number, string>();
  private readonly priorCheckedAt = new Map<number, number>();
  private readonly reassign = new Map<number, { from: string; to: string; since: number }>();
  /** per-symbol listing check (both modes; the only listing step in manual mode) */
  readonly listing: ListingTracker;

  constructor(
    private readonly ctx: OpsContext,
    private readonly builderKey: { stored: StoredKey; key: Ed25519Key; persist: (s: StoredKey) => void },
  ) {
    this.listing = new ListingTracker(ctx);
  }

  get manualListing(): boolean {
    return (this.ctx.settings.listingMode ?? "api") === "manual";
  }

  /** Builder account (owner = ops EOA) + builder key registration. */
  async ensureBuilder(): Promise<void> {
    if (this.builderReady) return;
    const { settings, builder, chain } = this.ctx;
    if (settings.mode === "mock") {
      await builder.mockRegisterAccount({ accountId: settings.builderAccountId, owner: chain.opsAddress, kind: "builder", builder: true });
    }
    const s = this.builderKey.stored;
    if (!s.registeredAt) {
      await builder.addKey({ accountId: settings.builderAccountId, orderlyKey: s.orderlyKey, scope: s.scope, expirationMs: s.expiration });
      s.registeredAt = this.ctx.now();
      this.builderKey.persist(s);
    }
    this.builderReady = true;
    this.ctx.log.info({ builderAccountId: settings.builderAccountId, key: prefixOf(s) }, "builder account ready");
  }

  async ensure(book: TrackedBook, force = false): Promise<void> {
    if (book.state === "Cancelled") return;
    if (!force && this.done.get(book.bookId) === book.state) return;
    await this.ensureBuilder();
    await this.ctx.locks.run(book.bookId, async () => {
      const { settings, builder, keys, store, chain, log } = this.ctx;
      const f = await keys.ensureBook(book.bookId, book.accounts, { tradeMs: settings.tradeKeyTtlMs, opsMs: settings.opsKeyTtlMs });
      const tradeRevoked = !!f.trade?.revokedAt;
      const trades = tradable(book);
      const tradePrefix = f.trade && trades ? prefixOf(f.trade) : null;
      if (!this.done.has(book.bookId)) {
        await store.upsertVenueAccount({ bookId: book.bookId, kind: "mm", accountId: book.accounts.mm, keyPrefix: tradePrefix, status: tradeRevoked ? "revoked" : "pending" });
      }
      const ifIssue = book.ifAccountError ?? null;
      const builderIf = book.ifBinding === "builder";
      if (ifIssue && this.ifIssueLogged.get(book.bookId) !== ifIssue) {
        this.ifIssueLogged.set(book.bookId, ifIssue);
        log.error({ bookId: book.bookId, ifAccount: book.accounts.if, ifBinding: book.ifBinding, err: ifIssue }, "IF account not provisioned (ORDERLY_IF_MODE mismatch): no IF delegate / key registration and no api-mode listing for this book; MM provisioning continues");
      }
      if (settings.mode === "mock") {
        // mock-orderly stands in for the operator's own registration of a builder IF account
        if (!ifIssue) await builder.mockRegisterAccount({ accountId: book.accounts.if, owner: book.owners.if, kind: "if", ...(builderIf ? {} : { delegateSigner: chain.opsAddress }) });
        await builder.mockRegisterAccount({ accountId: book.accounts.mm, owner: book.owners.mm, kind: "mm", delegateSigner: chain.opsAddress });
      } else {
        await this.ensureDelegates(book);
      }
      for (const which of ["if", "mm"] as const) {
        const k = f.ops[which];
        if (which === "if" && ifIssue) continue;
        if (which === "if" && builderIf) {
          // an EOA account: only its own wallet can add keys (ops-venue never holds it), so the operator registers it
          if (k && !k.registeredAt) await this.checkBuilderIfKey(book, true);
          continue;
        }
        if (k && !k.registeredAt) {
          await builder.addKey({ accountId: k.accountId, orderlyKey: k.orderlyKey, scope: k.scope, expirationMs: k.expiration, delegateContract: book.owners[which] });
          keys.markRegistered(book.bookId, which, this.ctx.now());
        }
      }
      if (trades && f.trade && !tradeRevoked && !f.trade.registeredAt) {
        await builder.addKey({ accountId: f.trade.accountId, orderlyKey: f.trade.orderlyKey, scope: f.trade.scope, expirationMs: f.trade.expiration, delegateContract: book.owners.mm });
        keys.markRegistered(book.bookId, "trade", this.ctx.now());
      }
      const manual = this.manualListing;
      let sym: { symbol: string; status?: string } = { symbol: book.symbol, status: "NOT_LISTED" };
      if (trades && !manual && ifIssue) {
        log.warn({ bookId: book.bookId, symbol: book.symbol }, "api listing skipped: the book's IF account does not match ORDERLY_IF_MODE (the market would be assigned the wrong IF account)");
      } else if (trades && !manual) {
        try {
          sym = await builder.createSymbol({ symbol: book.symbol, baseAsset: book.baseAsset, priceSource: settings.priceSource, sessions: book.sessions, ifAccountId: book.accounts.if });
        } catch (err) {
          // live listing APIs may reject a re-submission of an existing symbol (VERIFY wording)
          if (!(err instanceof OrderlyHttpError && /exist|already|duplicate/i.test(err.message))) throw err;
          sym = { symbol: book.symbol, status: "EXISTS" };
        }
      }
      await store.upsertVenueAccount({ bookId: book.bookId, kind: "if", accountId: book.accounts.if, keyPrefix: null, status: "active" });
      await store.upsertVenueAccount({ bookId: book.bookId, kind: "mm", accountId: book.accounts.mm, keyPrefix: tradePrefix, status: tradeRevoked ? "revoked" : "active" });
      await store.upsertVenueAccount({ bookId: book.bookId, kind: "builder", accountId: settings.builderAccountId, keyPrefix: null, status: "active" });
      if (trades && book.state === "Retiring" && manual) {
        // no confirmed builder endpoint (VERIFY O20): the mandate's reduce-only (agent / risk) is our enforcement
        log.warn({ bookId: book.bookId, symbol: book.symbol }, "retiring book: set the market REDUCE_ONLY in Orderly One if needed (manual listing mode); on our side the agent is reduce-only (book Retiring)");
      } else if (trades && book.state === "Retiring") {
        try {
          await builder.setSymbolStatus(book.symbol, "REDUCE_ONLY");
        } catch (err) {
          if (!(err instanceof OrderlyHttpError && /terminal/i.test(err.message))) log.warn({ bookId: book.bookId, err: errMsg(err) }, "could not set REDUCE_ONLY on retiring book");
        }
      }
      this.done.set(book.bookId, book.state);
      if (trades) {
        await this.listing.check([book], true);
        if (manual) sym = { symbol: book.symbol, status: book.listing ? (book.listing.venueStatus ?? (book.listing.phase === "listed" ? "LISTED" : "NOT_LISTED")) : "UNCHECKED" };
      }
      if (trades && manual && book.listing?.phase !== "listed") {
        log.warn({ bookId: book.bookId, symbol: book.symbol, phase: book.listing?.phase ?? "unknown", symbolStatus: sym.status, state: book.state, ifAccount: book.accounts.if, tradeKey: tradePrefix }, "book venue accounts provisioned; market not listed on Orderly (manual mode: listed in Orderly One; re-checked with backoff; the agent stays reduce-only)");
      } else if (trades) log.info({ bookId: book.bookId, symbol: sym.symbol, symbolStatus: sym.status, state: book.state, tradeKey: tradePrefix, tradeRevoked }, "book venue provisioned");
      else log.warn({ bookId: book.bookId, charterSymbol: book.charterSymbol, state: book.state, err: book.venueSymbolError }, "book venue accounts provisioned WITHOUT listing or trade key (no Orderly market for the charter symbol)");
    });
  }

  /**
   * Live: confirm the delegate signer of each contract account with Orderly (POST /v1/delegate_signer), which also
   * creates the account. Needs the on-chain `Vault.delegateSigner` tx of that contract naming the ops EOA, i.e. the
   * timelock's `adapter.setDelegateSigner(ops)` (v3 registers the adapter and its OrderlyIFAccount in one call).
   * Recorded per contract in the book's key file, so it runs once.
   */
  private async ensureDelegates(book: TrackedBook): Promise<void> {
    const { builder, keys, chain, log } = this.ctx;
    // builder IF mode: the IF account belongs to an EOA (no delegate); a mismatched IF binding is not touched
    const ifOwners = book.ifAccountError || book.ifBinding === "builder" ? [] : [book.owners.if];
    const owners = [...new Set([book.owners.mm, ...ifOwners].map((a) => a.toLowerCase()))] as Address[];
    for (const owner of owners) {
      if (keys.delegateRegistered(book.bookId, owner)) continue;
      const txHash = await chain.delegateTx(owner, chain.opsAddress);
      if (!txHash) throw new Error(`book ${book.bookId}: no on-chain Orderly delegate for ${owner} naming ${chain.opsAddress} — the timelock must call adapter.setDelegateSigner(${chain.opsAddress})`);
      const r = await builder.registerDelegateSigner({ delegateContract: owner, txHash });
      keys.markDelegateRegistered(book.bookId, owner, this.ctx.now());
      log.info({ bookId: book.bookId, delegateContract: owner, accountId: r.accountId, tx: txHash }, "Orderly delegate signer confirmed");
    }
  }

  /**
   * Builder IF mode: is ops-venue's IF ops key registered for the builder IF account (public GET /v1/get_orderly_key)?
   * Only the account's own wallet (the operator EOA) can add it, so until then the book is listed in `pendingIfKeys` (alert
   * venue_if_account key_pending) and its venue reports, which read the IF account with that key, fail. Re-checked at most
   * every OPS_IF_OPERATOR_RECHECK_MS (`force`: now).
   */
  async checkBuilderIfKey(book: TrackedBook, force = false): Promise<boolean> {
    const { keys, builder, log, settings } = this.ctx;
    if (book.ifBinding !== "builder" || book.ifAccountError) {
      this.ifKeyPending.delete(book.bookId);
      return false;
    }
    const k = keys.loadBook(book.bookId)?.ops.if;
    if (!k) return false;
    if (k.registeredAt) {
      this.ifKeyPending.delete(book.bookId);
      return true;
    }
    const now = this.ctx.now();
    const pending = this.ifKeyPending.get(book.bookId);
    if (pending && pending.orderlyKey === k.orderlyKey && !force && now - pending.checkedAt < (settings.ifOperatorRecheckMs ?? 60_000)) return false;
    let found: Awaited<ReturnType<typeof builder.getOrderlyKey>> = null;
    try {
      found = await builder.getOrderlyKey(k.accountId, k.orderlyKey);
    } catch (err) {
      log.debug({ bookId: book.bookId, err: errMsg(err) }, "builder IF key check failed");
    }
    if (found) {
      keys.markRegistered(book.bookId, "if", now);
      this.ifKeyPending.delete(book.bookId);
      log.info({ bookId: book.bookId, accountId: k.accountId, key: prefixOf(k), scope: found.scope }, "builder IF account: ops-venue's IF key is registered (reports can read the IF account)");
      return true;
    }
    const first = !pending || pending.orderlyKey !== k.orderlyKey;
    this.ifKeyPending.set(book.bookId, { accountId: k.accountId, orderlyKey: k.orderlyKey, owner: book.owners.if, since: first ? now : (pending?.since ?? now), checkedAt: now });
    if (first) {
      log.warn(
        { bookId: book.bookId, accountId: k.accountId, owner: book.owners.if, orderlyKey: k.orderlyKey, scope: "read" },
        "builder IF account: the operator must register this Orderly key for the IF account from its wallet (Orderly One or POST /v1/orderly_key signed by that wallet, scope read); ops-venue re-checks every minute",
      );
    }
    return false;
  }

  /**
   * Builder IF mode, while the book is in Subscription (before its IF deposit) and the IF key is registered: equity
   * already on the EOA's Orderly account would be reported as book insurance, so it is recorded (saga store
   * ifPriorEquity, survives restarts) and the book's reports are refused until the timelock binds a fresh account.
   */
  async checkPriorEquity(book: TrackedBook): Promise<void> {
    const { keys, sagas, log, settings } = this.ctx;
    if (book.ifBinding !== "builder" || book.ifAccountError || book.state !== "Subscription") return;
    const k = keys.loadBook(book.bookId)?.ops.if;
    if (!k?.registeredAt) return;
    const now = this.ctx.now();
    if (now - (this.priorCheckedAt.get(book.bookId) ?? 0) < (settings.ifOperatorRecheckMs ?? 60_000)) return;
    this.priorCheckedAt.set(book.bookId, now);
    let equity: bigint;
    try {
      equity = (await this.ctx.readAccount(book.accounts.if, book.symbol, await keys.opsKey(book.bookId, "if"))).equityUsd;
    } catch (err) {
      log.debug({ bookId: book.bookId, err: errMsg(err) }, "builder IF prior-equity check failed");
      return;
    }
    const f = await this.ctx.chain.adapterFlowState(book.adapter);
    if (equity <= 0n || f.insuranceUsd !== 0n) return;
    const st = sagas.get();
    const a = book.adapter.toLowerCase();
    if (st.ifPriorEquity?.[a]) return;
    st.ifPriorEquity = { ...(st.ifPriorEquity ?? {}), [a]: { usd: equity.toString(), at: now } };
    sagas.save();
    log.error({ bookId: book.bookId, accountId: book.accounts.if, owner: book.owners.if, equityUsd: equity.toString() }, "builder IF account already holds equity before the book's IF deposit: it would be reported as book insurance — the book's reports are refused; bind a fresh EOA account (timelock adapter.setIfAccountOwner)");
  }

  /** After an IF account switch: the market keeps its old IF account on Orderly until the admin re-assigns it. */
  noteReassign(book: TrackedBook, from: string): void {
    this.reassign.set(book.bookId, { from, to: book.accounts.if, since: this.ctx.now() });
    this.ctx.log.warn({ bookId: book.bookId, symbol: book.symbol, from, to: book.accounts.if }, "IF account switched: if the market was already listed, the admin must re-assign the market's IF account in Orderly One to the new account (api mode: createSymbol does not change it)");
  }

  /** Books whose market may still be assigned the previous IF account (published for OPS_IF_REASSIGN_NOTICE_MS). */
  pendingReassign(): Array<{ bookId: number; from: string; to: string; since: number }> {
    const now = this.ctx.now();
    const keep = this.ctx.settings.ifReassignNoticeMs ?? 86_400_000;
    for (const [id, r] of this.reassign) if (now - r.since >= keep) this.reassign.delete(id);
    return [...this.reassign.entries()].map(([bookId, r]) => ({ bookId, ...r }));
  }

  /** Builder IF mode: books whose IF ops key the operator has not registered yet (published for alerts). */
  pendingIfKeys(): Array<{ bookId: number; accountId: string; owner: string; since: number }> {
    return [...this.ifKeyPending.entries()].map(([bookId, p]) => ({ bookId, accountId: p.accountId, owner: p.owner, since: p.since }));
  }

  /** After a re-mandate: replace a revoked trade key (only while the mandate is not killed). */
  async rotateTradeKey(book: TrackedBook): Promise<string | null> {
    return this.ctx.locks.run(book.bookId, async () => {
      const { keys, chain, builder, store, settings, log } = this.ctx;
      const f = keys.loadBook(book.bookId);
      if (!f?.trade?.revokedAt) return null;
      if (!tradable(book)) return null; // no Orderly market: no trade key to restore
      if (await chain.mandateKilled(book.mandate)) return null;
      const next = await keys.rotateTrade(book.bookId, settings.tradeKeyTtlMs);
      const t = next.trade;
      if (!t) return null;
      await builder.addKey({ accountId: t.accountId, orderlyKey: t.orderlyKey, scope: t.scope, expirationMs: t.expiration, delegateContract: book.owners.mm });
      keys.markRegistered(book.bookId, "trade", this.ctx.now());
      const prefix = prefixOf(t);
      await store.upsertVenueAccount({ bookId: book.bookId, kind: "mm", accountId: t.accountId, keyPrefix: prefix, status: "active" });
      await store.emitEvent("agent.registered", book.bookId, { bookId: book.bookId, key: `orderly:${prefix}`, operator: chain.opsAddress }, `venue-key-registered:${book.bookId}:${prefix}`);
      log.info({ bookId: book.bookId, key: prefix }, "trade key rotated after re-mandate");
      return prefix;
    });
  }
}

/** Builder key: env secret, else the key store (generated on first run). */
export async function loadOrCreateBuilderKey(keys: KeyStore, accountId: string, envSecret: string | undefined, ttlMs: number, keyFromSecret: (s: string) => Promise<Ed25519Key>) {
  if (envSecret) {
    const key = await keyFromSecret(envSecret);
    const stored: StoredKey = { accountId, orderlyKey: key.orderlyKey, secret: "<env>", scope: BUILDER_SCOPE, createdAt: Date.now(), expiration: Date.now() + ttlMs, registeredAt: Date.now(), revokedAt: null };
    return { stored, key, persist: () => {} };
  }
  const existing = keys.loadBuilder();
  if (existing && existing.builder.accountId === accountId) {
    return { stored: existing.builder, key: await keyFromSecret(existing.builder.secret), persist: (s: StoredKey) => keys.saveBuilder({ builder: s }) };
  }
  const { stored, key } = await newStoredKey(accountId, BUILDER_SCOPE, ttlMs);
  keys.saveBuilder({ builder: stored });
  return { stored, key, persist: (s: StoredKey) => keys.saveBuilder({ builder: s }) };
}
