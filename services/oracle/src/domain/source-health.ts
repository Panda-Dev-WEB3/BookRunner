// Per-source health for /health (and services/alerts' oracle_source_failing rule). Mainnet (primary-confirm): the
// Chainlink primary failing stops the price of its tickers (critical); a confirm source failing leaves the price
// unconfirmed (warning). Median policy: each failing source removes one vote. An operator must see WHICH source fails
// and why. Only in-session tickers count: a closed market (Pyth `closed`, weekends) is not a
// failure. Error texts come from the sources, which never include access tokens (pyth.ts redacts).

export type SourceOutcome = { ok: true } | { ok: false; error: string };

export interface SourceHealthView {
  name: string;
  kind: string;
  /** primary (signs) | confirm (compared only) | median (one vote): domain/types.ts sourceRole */
  role: string;
  /** last time (unix ms) the source gave a fresh observation for any ticker */
  lastOkAt: number | null;
  /** start (unix ms) of the current run of ticks in which it failed an in-session ticker; null = healthy */
  failingSince: number | null;
  /** in-session tickers it failed on the last tick */
  failingTickers: string[];
  /** class of the last failure, e.g. "HTTP 401", "timeout", "no observation" */
  lastError: string | null;
  /**
   * latest failed tick (unix ms). failingSince lingers for the hysteresis after recovery, so consumers measure the
   * observed failing span lastErrorAt - failingSince (services/alerts), never now - failingSince.
   */
  lastErrorAt: number | null;
}

/** Short, key-free failure class of an error message. */
export function errorClass(msg: string): string {
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) return `HTTP ${http[1]}`;
  if (/timeout|timed out|aborted/i.test(msg)) return "timeout";
  return (msg.split("\n")[0] ?? "").replace(/^[a-z0-9_-]+: /i, "").slice(0, 80) || "error";
}

export class SourceHealth {
  private readonly state = new Map<string, SourceHealthView>();
  private readonly lastWarnAt = new Map<string, number>();
  /** start of the current healthy stretch inside a failure run (hysteresis) */
  private readonly healthySince = new Map<string, number>();

  constructor(
    sources: ReadonlyArray<{ name: string; kind?: string; role?: string }>,
    private readonly warn: (fields: Record<string, unknown>, msg: string) => void = () => {},
    private readonly warnEveryMs = 60_000,
    /** a failure run must last this long before it is logged (single-tick dropouts stay quiet) */
    private readonly warnAfterMs = 10_000,
    /**
     * a failure run ends only after this long without a failure (a one-tick success does not reset `failingSince`, so
     * the alert timers keep running through a flapping source); 0 = end at the first clean tick
     */
    private readonly clearAfterMs = 0,
  ) {
    for (const s of sources) {
      this.state.set(s.name, { name: s.name, kind: s.kind ?? "http", role: s.role ?? "median", lastOkAt: null, failingSince: null, failingTickers: [], lastError: null, lastErrorAt: null });
    }
  }

  /**
   * One tick: outcomes per ticker per source name, and which tickers were in session. Failures on closed tickers are
   * ignored; a tick without any in-session ticker resets `failingSince` (nothing to fail); otherwise a run ends only after
 * `clearAfterMs` without a failure (its last failing tickers stay listed meanwhile).
   */
  update(nowMs: number, outcomes: ReadonlyMap<string, ReadonlyMap<string, SourceOutcome>>, openTickers: ReadonlySet<string>): void {
    for (const h of this.state.values()) {
      const failing: string[] = [];
      let error: string | null = null;
      for (const [ticker, bySource] of outcomes) {
        const o = bySource.get(h.name);
        if (!o) continue;
        if (o.ok) h.lastOkAt = nowMs;
        else if (openTickers.has(ticker)) {
          failing.push(ticker);
          error ??= o.error;
        }
      }
      if (failing.length === 0) {
        if (h.failingSince !== null && openTickers.size > 0) {
          const healthy = this.healthySince.get(h.name) ?? nowMs;
          this.healthySince.set(h.name, healthy);
          if (nowMs - healthy < this.clearAfterMs) continue;
        }
        h.failingTickers = [];
        h.failingSince = null;
        this.healthySince.delete(h.name);
        continue;
      }
      this.healthySince.delete(h.name);
      h.failingTickers = failing.sort();
      h.failingSince ??= nowMs;
      h.lastError = error;
      h.lastErrorAt = nowMs;
      const last = this.lastWarnAt.get(h.name);
      if (nowMs - h.failingSince >= this.warnAfterMs && (last === undefined || nowMs - last >= this.warnEveryMs)) {
        this.lastWarnAt.set(h.name, nowMs);
        this.warn(
          { source: h.name, role: h.role, error, tickers: h.failingTickers, failingForMs: nowMs - h.failingSince, lastOkAt: h.lastOkAt },
          "price source failing for in-session tickers",
        );
      }
    }
  }

  view(): SourceHealthView[] {
    return [...this.state.values()].map((h) => ({ ...h, failingTickers: [...h.failingTickers] }));
  }
}
