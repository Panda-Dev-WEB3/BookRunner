// Venue trade-key revocation (risk kill / mandate Kill / revoke_key job): best-effort cancel-all with
// the trade key, remove the key on Orderly (authenticated with the MM ops key), mark it revoked in
// the key store and venue_accounts, write a DECISION receipt and emit `agent.revoked`. Idempotent.
//
// Redis is not trusted (audit 2026-10 lead "Redis is a shared trust domain"): the kill channel and the revoke_key job
// both arrive through Redis, so anyone with Redis write access could send them. Both carry the risk service's
// EIP-712 KillOrder signed with the RISK key (packages/shared/src/busAuth.ts); onRedisKill decides:
//   - signed by a RISK_ROLE holder, fresh, not replayed: revoke at once (as before the Redis-trust change), unless the
//     book's current trade key was created after the kill was issued (a replay after a remandate);
//   - the RISK role check could not run (RPC): cancel the book's orders and revoke only once the mandate is killed
//     on-chain (revokeIfKilledOnChain);
//   - unsigned / forged: ignored (warning + bus_forged_message alert); for the job, the on-chain kill still revokes.
// The mandate Kill log (worker/logs.ts, source mandate_kill) stays a second trigger: it revokes within one log poll of
// the on-chain kill. A forged message therefore never revokes a key (only a remandate brings one back).
import { type KillVerdict, RECEIPT_KIND } from "@bookrunner/shared";
import { prefixOf, toKey } from "../keys";
import { errMsg, nowSec } from "../util";
import type { BookRegistry } from "./books";
import { type OpsContext, tradable } from "./context";

export type RevokeSource = "job" | "kill_channel" | "mandate_kill";

export interface RevokeResult {
  bookId: number;
  keyPrefix: string | null;
  revokedNow: boolean;
  /** a Redis-borne trigger whose kill is not (yet) on-chain: orders cancelled, key kept; why */
  deferred?: string;
}

export class Revoker {
  constructor(
    private readonly ctx: OpsContext,
    private readonly registry: BookRegistry,
  ) {}

  /**
   * A kill read from Redis: the kill channel's message, or the revoke_key job's signed order (`bookIdHint` = the job's
   * book). See the header for the decision. null = nothing to do (not an Orderly book, or an ignored forged message).
   */
  async onRedisKill(raw: unknown, input: "channel" | "job", bookIdHint: number | null = null): Promise<RevokeResult | null> {
    const { log } = this.ctx;
    const auth = this.ctx.killAuth;
    const source = input === "channel" ? "kill_channel" : "job";
    let v: KillVerdict = auth ? await (input === "channel" ? auth.channel : auth.job).verify(raw) : { ok: false, reason: "kill authentication not configured", forged: false, unavailable: true };
    if (v.ok && bookIdHint !== null && v.msg.bookId !== bookIdHint) v = { ok: false, reason: `signed kill for book ${v.msg.bookId} in a job for book ${bookIdHint}`, forged: true };
    if (v.ok) {
      if (!this.isOrderlyBook(v.msg.bookId)) return null;
      log.warn({ bookId: v.msg.bookId, source, reason: v.msg.reason, signer: v.signer }, "RISK-signed kill: revoking the venue trade key");
      return this.revoke(v.msg.bookId, v.msg.reason || "RISK_KILL", source, v.msg.issuedAt !== undefined ? { issuedAtSec: v.msg.issuedAt } : {});
    }
    const bookId = bookIdHint ?? bookIdOf(raw);
    if (v.forged) {
      log.warn({ bookId, source, reason: v.reason }, "FORGED kill ignored (no valid RISK signature)");
      auth?.forged.note("kill", `${input}: ${v.reason}`);
    } else if (!v.unavailable) {
      log.info({ bookId, source, reason: v.reason }, "kill ignored (stale or replayed)");
    }
    if (bookId === null || !this.isOrderlyBook(bookId)) return null;
    if (v.unavailable) {
      log.warn({ bookId, source, err: v.reason }, "kill signature could not be checked: falling back to the on-chain kill");
      return this.revokeIfKilledOnChain(bookId, "RISK_KILL", source);
    }
    // the channel's on-chain trigger is the mandate Kill log; a job also checks the chain now (no cancel: unauthenticated)
    return input === "job" ? this.revokeIfKilledOnChain(bookId, "RISK_KILL", source, { cancel: false }) : null;
  }

  private isOrderlyBook(bookId: number): boolean {
    return !!this.registry.get(bookId) || !!this.ctx.keys.loadBook(bookId);
  }

  /**
   * Revoke only when the book's mandate is killed on-chain; otherwise cancel the book's resting orders with its trade
   * key (best effort, unless `cancel` is false) and keep the key. A failed on-chain read defers too; the mandate Kill log
   * revokes once the kill lands.
   */
  async revokeIfKilledOnChain(bookId: number, reason: string, source: Exclude<RevokeSource, "mandate_kill">, opts: { cancel?: boolean } = {}): Promise<RevokeResult> {
    const { log } = this.ctx;
    let book = this.registry.get(bookId);
    if (!book) {
      await this.registry.refresh().catch((err) => log.warn({ bookId, err: errMsg(err) }, "book refresh failed"));
      book = this.registry.get(bookId);
    }
    let deferred = "book not tracked by ops-venue: its mandate cannot be checked";
    if (book) {
      let killed = false;
      try {
        killed = await this.ctx.chain.mandateKilled(book.mandate);
        deferred = "mandate not killed on-chain";
      } catch (err) {
        deferred = `on-chain kill check failed: ${errMsg(err)}`;
      }
      if (killed) return this.revoke(bookId, reason, source);
    }
    const trade = this.ctx.keys.loadBook(bookId)?.trade;
    const prefix = opts.cancel === false ? (trade ? prefixOf(trade) : null) : await this.cancelOnly(bookId);
    log.warn({ bookId, source, reason, deferred, cancelled: opts.cancel !== false }, "venue key revocation deferred: the kill is not on-chain; key kept until the mandate Kill lands");
    return { bookId, keyPrefix: prefix, revokedNow: false, deferred };
  }

  /** Best-effort cancel-all with the book's (unrevoked) trade key; the key prefix, or null without a trade key. */
  private async cancelOnly(bookId: number): Promise<string | null> {
    return this.ctx.locks.run(bookId, async () => {
      const trade = this.ctx.keys.loadBook(bookId)?.trade;
      if (!trade) return null;
      const book = this.registry.get(bookId);
      if (!trade.revokedAt && book && tradable(book)) {
        try {
          await this.ctx.cancelAll(trade.accountId, book.symbol, await toKey(trade));
        } catch (err) {
          this.ctx.log.warn({ bookId, err: errMsg(err) }, "cancel-all on an unconfirmed kill failed");
        }
      }
      return prefixOf(trade);
    });
  }

  async revoke(bookId: number, reason: string, source: RevokeSource, opts: { issuedAtSec?: number } = {}): Promise<RevokeResult> {
    return this.ctx.locks.run(bookId, async () => {
      const { keys, builder, store, log } = this.ctx;
      const f = keys.loadBook(bookId);
      const trade = f?.trade;
      if (!trade) {
        log.info({ bookId, source }, "revoke requested but the book has no venue trade key");
        return { bookId, keyPrefix: null, revokedNow: false };
      }
      const prefix = prefixOf(trade);
      if (opts.issuedAtSec !== undefined && !trade.revokedAt && trade.createdAt > (opts.issuedAtSec + 1) * 1000) { // issuedAt has 1 s resolution
        log.warn({ bookId, key: prefix, issuedAt: opts.issuedAtSec, keyCreatedAt: trade.createdAt }, "signed kill predates the current trade key (replay after a remandate?): key kept");
        return { bookId, keyPrefix: prefix, revokedNow: false, deferred: "kill predates the current trade key" };
      }
      const already = !!trade.revokedAt;
      if (!already) {
        const book = this.registry.get(bookId);
        // a book without an Orderly market never quoted, and its trade key was never registered (provision.ts)
        const neverTraded = !!book && !tradable(book);
        if (book && !neverTraded) {
          try {
            await this.ctx.cancelAll(trade.accountId, book.symbol, await toKey(trade));
          } catch (err) {
            log.warn({ bookId, err: errMsg(err) }, "pre-revoke cancel-all failed (continuing with revocation)");
          }
        }
        if (!(neverTraded && !trade.registeredAt)) await builder.revokeTradeKey({ accountId: trade.accountId, keyPrefix: prefix, orderlyKey: trade.orderlyKey });
        keys.markTradeRevoked(bookId, reason, this.ctx.now());
        log.warn({ bookId, key: prefix, reason, source }, "venue trade key revoked");
      }
      await store.setVenueAccountStatus(bookId, "mm", "revoked");
      if (!already) {
        await store.insertReceipt({ bookId, kind: RECEIPT_KIND.DECISION, tsSec: nowSec(this.ctx.now()), payload: { action: "revoke_venue_key", bookId, keyPrefix: prefix, reason, source } });
      }
      await store.emitEvent("agent.revoked", bookId, { bookId, key: `orderly:${prefix}`, reason }, `venue-key-revoked:${bookId}:${prefix}`);
      return { bookId, keyPrefix: prefix, revokedNow: !already };
    });
  }
}

/** The book id of a raw kill message (for the fallback paths), or null. */
function bookIdOf(raw: unknown): number | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const id = Number((o as { bookId?: unknown } | null)?.bookId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
