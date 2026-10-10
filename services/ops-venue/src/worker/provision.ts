// Venue provisioning per Orderly book (idempotent): builder account + key, per-book keys (trade-only
// key for the MM account, ops keys for IF/MM), key registration via the delegate signer, symbol
// creation under the builder account with the IF account assigned, venue_accounts rows (key PREFIX
// only). Re-run on state changes; Retiring books go REDUCE_ONLY. Trade keys are re-issued only after
// a re-mandate (rotateTradeKey). Keys and withdrawals of a contract account name its owner as
// delegateContract (v3: the adapter for MM, the OrderlyIFAccount for IF; see chain.accountOwners).
import type { Address } from "viem";
import { OrderlyHttpError } from "../orderly/http";
import { BUILDER_SCOPE, type KeyStore, newStoredKey, prefixOf, type StoredKey } from "../keys";
import type { Ed25519Key } from "../orderly/auth";
import { errMsg } from "../util";
import type { OpsContext, TrackedBook } from "./context";

export class Provisioner {
  private readonly done = new Map<number, string>();
  private builderReady = false;

  constructor(
    private readonly ctx: OpsContext,
    private readonly builderKey: { stored: StoredKey; key: Ed25519Key; persist: (s: StoredKey) => void },
  ) {}

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
      if (!this.done.has(book.bookId)) {
        await store.upsertVenueAccount({ bookId: book.bookId, kind: "mm", accountId: book.accounts.mm, keyPrefix: f.trade ? prefixOf(f.trade) : null, status: tradeRevoked ? "revoked" : "pending" });
      }
      if (settings.mode === "mock") {
        await builder.mockRegisterAccount({ accountId: book.accounts.if, owner: book.owners.if, kind: "if", delegateSigner: chain.opsAddress });
        await builder.mockRegisterAccount({ accountId: book.accounts.mm, owner: book.owners.mm, kind: "mm", delegateSigner: chain.opsAddress });
      } else {
        await this.ensureDelegates(book);
      }
      for (const which of ["if", "mm"] as const) {
        const k = f.ops[which];
        if (k && !k.registeredAt) {
          await builder.addKey({ accountId: k.accountId, orderlyKey: k.orderlyKey, scope: k.scope, expirationMs: k.expiration, delegateContract: book.owners[which] });
          keys.markRegistered(book.bookId, which, this.ctx.now());
        }
      }
      if (f.trade && !tradeRevoked && !f.trade.registeredAt) {
        await builder.addKey({ accountId: f.trade.accountId, orderlyKey: f.trade.orderlyKey, scope: f.trade.scope, expirationMs: f.trade.expiration, delegateContract: book.owners.mm });
        keys.markRegistered(book.bookId, "trade", this.ctx.now());
      }
      let sym: { symbol: string; status?: string };
      try {
        sym = await builder.createSymbol({ symbol: book.symbol, baseAsset: book.baseAsset, priceSource: settings.priceSource, sessions: book.sessions, ifAccountId: book.accounts.if });
      } catch (err) {
        // live listing APIs may reject a re-submission of an existing symbol (VERIFY wording)
        if (!(err instanceof OrderlyHttpError && /exist|already|duplicate/i.test(err.message))) throw err;
        sym = { symbol: book.symbol, status: "EXISTS" };
      }
      await store.upsertVenueAccount({ bookId: book.bookId, kind: "if", accountId: book.accounts.if, keyPrefix: null, status: "active" });
      await store.upsertVenueAccount({ bookId: book.bookId, kind: "mm", accountId: book.accounts.mm, keyPrefix: f.trade ? prefixOf(f.trade) : null, status: tradeRevoked ? "revoked" : "active" });
      await store.upsertVenueAccount({ bookId: book.bookId, kind: "builder", accountId: settings.builderAccountId, keyPrefix: null, status: "active" });
      if (book.state === "Retiring") {
        try {
          await builder.setSymbolStatus(book.symbol, "REDUCE_ONLY");
        } catch (err) {
          if (!(err instanceof OrderlyHttpError && /terminal/i.test(err.message))) log.warn({ bookId: book.bookId, err: errMsg(err) }, "could not set REDUCE_ONLY on retiring book");
        }
      }
      this.done.set(book.bookId, book.state);
      log.info({ bookId: book.bookId, symbol: sym.symbol, symbolStatus: sym.status, state: book.state, tradeKey: f.trade ? prefixOf(f.trade) : null, tradeRevoked }, "book venue provisioned");
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
    const owners = [...new Set([book.owners.mm, book.owners.if].map((a) => a.toLowerCase()))] as Address[];
    for (const owner of owners) {
      if (keys.delegateRegistered(book.bookId, owner)) continue;
      const txHash = await chain.delegateTx(owner, chain.opsAddress);
      if (!txHash) throw new Error(`book ${book.bookId}: no on-chain Orderly delegate for ${owner} naming ${chain.opsAddress} — the timelock must call adapter.setDelegateSigner(${chain.opsAddress})`);
      const r = await builder.registerDelegateSigner({ delegateContract: owner, txHash });
      keys.markDelegateRegistered(book.bookId, owner, this.ctx.now());
      log.info({ bookId: book.bookId, delegateContract: owner, accountId: r.accountId, tx: txHash }, "Orderly delegate signer confirmed");
    }
  }

  /** After a re-mandate: replace a revoked trade key (only while the mandate is not killed). */
  async rotateTradeKey(book: TrackedBook): Promise<string | null> {
    return this.ctx.locks.run(book.bookId, async () => {
      const { keys, chain, builder, store, settings, log } = this.ctx;
      const f = keys.loadBook(book.bookId);
      if (!f?.trade?.revokedAt) return null;
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
