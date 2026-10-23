// Chain head clock of the oracle process: the head timestamp the service clamps publishedAt to
// (domain/push-policy.ts publishTimestamp). With `maxAgeMs` 0 (devnet, testnet) every call reads the head, as
// before. Above 0 (mainnet, ORACLE_HEAD_READ_MS) a head seen less than `maxAgeMs` ago is reused, advanced by the
// wall time elapsed since (Robinhood Chain stamps blocks with the sequencer's clock), and every batched source read
// reports the block timestamp it was served at (Multicall3 getCurrentBlockTimestamp, the DEX block): the service then
// almost never needs a head read of its own.

export interface HeadClockOptions {
  /** reads the latest block timestamp (unix s) */
  read: () => Promise<number>;
  /** a head observed this recently is reused (extrapolated); 0 = read every time */
  maxAgeMs: number;
  now?: () => number;
}

export class HeadClock {
  private seen: { tsSec: number; atMs: number } | null = null;
  private inFlight: Promise<number> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: HeadClockOptions) {
    this.now = o.now ?? Date.now;
  }

  /** A block timestamp (unix s) seen at wall time `atMs` (default now); an older observation never replaces a newer one. */
  observe(tsSec: number, atMs = this.now()): void {
    if (!Number.isFinite(tsSec) || tsSec <= 0) return;
    if (this.seen && this.seen.atMs > atMs) return;
    this.seen = { tsSec, atMs };
  }

  /** Head timestamp (unix s): extrapolated from a recent observation, else read (concurrent callers share one read). */
  async headTimestamp(): Promise<number> {
    const nowMs = this.now();
    const s = this.seen;
    if (this.o.maxAgeMs > 0 && s && nowMs - s.atMs < this.o.maxAgeMs) return s.tsSec + Math.floor(Math.max(0, nowMs - s.atMs) / 1000);
    if (this.inFlight) return this.inFlight;
    const p = this.o.read().then((ts) => {
      this.observe(ts);
      return ts;
    });
    this.inFlight = p;
    try {
      return await p;
    } finally {
      this.inFlight = null;
    }
  }
}
