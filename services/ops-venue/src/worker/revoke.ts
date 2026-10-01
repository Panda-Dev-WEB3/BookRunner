// Venue trade-key revocation (risk kill / mandate Kill / revoke_key job): best-effort cancel-all with
// the trade key, remove the key on Orderly (authenticated with the MM ops key), mark it revoked in
// the key store and venue_accounts, write a DECISION receipt and emit `agent.revoked`. Idempotent.
import { RECEIPT_KIND } from "@bookrunner/shared";
import { prefixOf, toKey } from "../keys";
import { errMsg, nowSec } from "../util";
import type { BookRegistry } from "./books";
import type { OpsContext } from "./context";

export type RevokeSource = "job" | "kill_channel" | "mandate_kill";

export interface RevokeResult {
  bookId: number;
  keyPrefix: string | null;
  revokedNow: boolean;
}

export class Revoker {
  constructor(
    private readonly ctx: OpsContext,
    private readonly registry: BookRegistry,
  ) {}

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
        const symbol = this.registry.get(bookId)?.symbol;
        if (symbol) {
          try {
            await this.ctx.cancelAll(trade.accountId, symbol, await toKey(trade));
          } catch (err) {
            log.warn({ bookId, err: errMsg(err) }, "pre-revoke cancel-all failed (continuing with revocation)");
          }
        }
        await builder.revokeTradeKey({ accountId: trade.accountId, keyPrefix: prefix, orderlyKey: trade.orderlyKey });
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
