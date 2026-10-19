// The desk's StaleTradePrice rejections of this book's key swaps (audit 2026-10 "old prints": the desk refuses a key
// Hedge / Flatten whose traded token's price is older than min(maxPriceAge, maxTradePriceAge)). The agent never
// carries such a print on purpose (pull-prices swapMaxAgeSec), so a run of rejections means the signed prices stopped
// reaching it (oracle down, Redis / HTTP source gone) or the stored prices are old: hedging is stuck. Kept for the
// last DESK_REJECTS_WINDOW_SEC in Redis (KEYS.agentDeskRejects, reloaded at start so a restart keeps the count);
// services/alerts raises desk_stale_trade_price when too many land within its window.
import { DESK_REJECTS_WINDOW_SEC, type DeskRejectsMsg, KEYS, type Logger } from "@bookrunner/shared";
import type { AgentBus } from "../adapters/bus";
import { errMsg } from "../util";

export const STALE_TRADE_PRICE = "StaleTradePrice";

export class DeskRejects {
  private times: number[] = [];

  constructor(
    private readonly bookId: number,
    private readonly bus: Pick<AgentBus, "getJson" | "setJson">,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seeds the window from Redis (a restart keeps the recent rejections). */
  async load(): Promise<void> {
    const m = await this.bus.getJson<Partial<DeskRejectsMsg>>(KEYS.agentDeskRejects(this.bookId)).catch(() => null);
    const prev = Array.isArray(m?.staleTradePrice) ? m.staleTradePrice.filter((t): t is number => typeof t === "number" && Number.isFinite(t)) : [];
    this.times = this.prune([...prev, ...this.times].sort((a, b) => a - b));
  }

  /** DeskClient.onRejected: counts StaleTradePrice, ignores every other refusal. */
  note(revert: string, action: string): void {
    if (revert !== STALE_TRADE_PRICE) return;
    const now = this.now();
    this.times = this.prune([...this.times, now]);
    this.log.warn({ action, revert, lastHour: this.times.length }, "desk refused a key swap: traded token price too old (StaleTradePrice)");
    const msg: DeskRejectsMsg = { v: 1, bookId: this.bookId, ts: now, staleTradePrice: this.times };
    void this.bus.setJson(KEYS.agentDeskRejects(this.bookId), msg, DESK_REJECTS_WINDOW_SEC * 1000).catch((err) => this.log.debug({ err: errMsg(err) }, "desk rejects publish failed"));
  }

  /** Rejections within the window (oldest first). */
  recent(): number[] {
    return this.prune(this.times);
  }

  private prune(times: number[]): number[] {
    const from = this.now() - DESK_REJECTS_WINDOW_SEC * 1000;
    return times.filter((t) => t > from).slice(-1_000);
  }
}
