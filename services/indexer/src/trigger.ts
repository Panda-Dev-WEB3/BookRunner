// When the indexer runs its next step (RPC budget, deploy/server/MAINNET.md "RPC budget"). With a log subscription
// (RPC_WS_URL, shared logSubscription.ts) a notification of a watched contract triggers a step after a short debounce
// (the log's block must reach INDEXER_CONFIRMATIONS first), the subscription coming up triggers a catch-up step, and
// otherwise the indexer only takes a safety step every INDEXER_WS_SAFETY_POLL_MS (keeps the cursor current, catches
// anything a dropped notification missed). The step itself is unchanged: eth_blockNumber + eth_getLogs over
// [cursor, head - confirmations], the canonical, reorg-safe read; the subscription never writes anything. Without a
// subscription (or while it is down) the indexer polls every INDEXER_POLL_MS, as before.

export interface TriggerSettings {
  pollMs: number;
  safetyMs: number;
  debounceMs: number;
}

export class StepTrigger {
  /** highest block of a notification not yet covered by an indexed range */
  private pending: bigint | null = null;
  private subscribed = false;

  constructor(private readonly s: TriggerSettings) {}

  /** The subscription went up (true) or down (false). Up: catch up now. */
  onState(up: boolean): number | null {
    this.subscribed = up;
    return up ? 0 : null;
  }

  /** Notifications at these blocks: delay before the step that should cover them (null = nothing to do). */
  onLogs(blocks: ReadonlyArray<bigint | null>): number | null {
    let any = false;
    for (const b of blocks) {
      if (b === null) continue;
      any = true;
      if (this.pending === null || b > this.pending) this.pending = b;
    }
    return any ? this.s.debounceMs : null;
  }

  /**
   * Delay after an idle step that saw `safeHead` (= head - confirmations: everything up to it is indexed). A
   * notification beyond it (not confirmed yet) is retried after the debounce; otherwise the safety step (subscribed)
   * or the normal poll.
   */
  idleDelay(safeHead: bigint): number {
    if (this.pending !== null && this.pending <= safeHead) this.pending = null;
    if (this.pending !== null) return this.s.debounceMs;
    return this.subscribed ? this.s.safetyMs : this.s.pollMs;
  }

  get isSubscribed(): boolean {
    return this.subscribed;
  }
}
