// Venue trade-key revocation (risk kill / mandate Kill / revoke_key job): best-effort cancel-all with
// the trade key, remove the key on Orderly (authenticated with the MM ops key), mark it revoked in
// the key store and venue_accounts, write a DECISION receipt and emit `agent.revoked`. Idempotent.
//
// Redis is not trusted (audit 2026-10 lead "Redis is a shared trust domain"): the kill channel and the revoke_key job
// both arrive through Redis, so anyone with Redis write access could send them. They only trigger
// revokeIfKilledOnChain: the book's resting orders are cancelled at once (harmless when forged: a stop) and the key is
// revoked only when the book's mandate is killed ON-CHAIN (MMMandate.killed(), the authoritative kill: the risk kill
// sequence's mandate_kill step, which also revokes the desk keys). A forged message therefore never revokes a key (a
// revoked trade key only comes back with a remandate). When the on-chain kill lands after the message, the mandate
// Kill log (worker/logs.ts, source mandate_kill) revokes within one log poll.
import { RECEIPT_KIND } from "@bookrunner/shared";
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
   * A revocation trigger read from Redis (kill channel, revoke_key job): revoke only when the book's mandate is killed
   * on-chain; otherwise cancel the book's resting orders with its trade key (best effort) and keep the key. A failed
   * on-chain read defers too (never revoke on an unverified message); the mandate Kill log revokes once the kill lands.
   */
  async revokeIfKilledOnChain(bookId: number, reason: string, source: Exclude<RevokeSource, "mandate_kill">): Promise<RevokeResult> {
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
    const prefix = await this.cancelOnly(bookId);
    log.warn({ bookId, source, reason, deferred }, "venue key revocation deferred: the kill is not on-chain (a forged or early message); resting orders cancelled, key kept until the mandate Kill lands");
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

  async revoke(bookId: number, reason: string, source: RevokeSource): Promise<RevokeResult> {
    return this.ctx.locks.run(bookId, async () => {
      const { keys, builder, store, log } = this.ctx;
      const f = keys.loadBook(bookId);
      const trade = f?.trade;
      if (!trade) {
        log.info({ bookId, source }, "revoke requested but the book has no venue trade key");
        return { bookId, keyPrefix: null, revokedNow: false };
      }
      const prefix = prefixOf(trade);
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
