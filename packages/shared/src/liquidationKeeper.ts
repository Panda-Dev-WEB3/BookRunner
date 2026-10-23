// Status of the waterfall liquidation keeper (2026-10, in-house engine markets), written to KEYS.liquidationKeeper every
// pass: what it watched, what is liquidatable and not liquidated yet (the backlog, with why), and its failure run. Read
// by the alerts service (liquidation_backlog, keeper_liquidation_failing) and the API's /health. Tolerant parser.

/** Why a liquidatable position is still open after a pass. */
export type BacklogReason =
  /** found this pass, the transaction is next */
  | "pending"
  /** the transaction would cost more than the gas policy allows (per-tx cap, the bad debt at stake, the hourly loss budget) */
  | "gas_guard"
  /** reward + margin below the gas cost and not under water (no bad debt yet): skipped until it is (review I-3) */
  | "dust"
  /** the price it needs is not usable now (stale / off-hours for a close-out, a bad signature): retried next pass */
  | "price"
  /** the transaction failed (not a race): retried next pass */
  | "failed";

export interface LiquidationBacklogItem {
  marketId: number;
  trader: string;
  /** "liquidate" or "forceClose" (wind-down close-out / settled market) */
  action: "liquidate" | "forceClose";
  /** unix ms: first pass that found it actionable */
  since: number;
  reason: BacklogReason;
  detail: string | null;
}

export interface LiquidationMarketStatus {
  marketId: number;
  bookId: number | null;
  /** open: live price; held: session closed (off-hours requirement); settled: governance settle price; closeout: wind-down open */
  regime: "open" | "held" | "settled" | "closeout" | "no_price";
  openPositions: number;
  /** age (s) of the price the pass used */
  priceAgeSec: number | null;
}

export interface LiquidationKeeperStatus {
  /** unix ms of the write */
  ts: number;
  enabled: boolean;
  keeper: string;
  /** seconds to the next pass */
  nextPassSec: number;
  markets: LiquidationMarketStatus[];
  backlog: LiquidationBacklogItem[];
  lastPass: { at: number; durationMs: number; checked: number; liquidated: number; forceClosed: number; raced: number };
  /** consecutive failed attempts (transactions or passes, races excluded) */
  failures: { consecutive: number; since: number | null; lastError: string | null; lastErrorAt: number | null };
  totals: { liquidations: number; forceCloses: number; raced: number; rewardsUsd: string; gasWei: string };
  /** gas guard: whether the cost is compared with the reward (an ETH/USD price is configured) or only capped */
  gasGuard: "reward" | "cap_only";
  /**
   * Review I-6: open positions known (total) and read this pass (checked). truncated = a pass cannot cover them all: they
   * are paged across passes, one full rotation every rotationSec.
   */
  coverage: { total: number; checked: number; truncated: boolean; rotationSec: number };
  /** Review I-5: the last on-chain reconciliation of every known (market, trader): rows read, sizes repaired */
  reconcile: { at: number | null; checked: number; repaired: number; error: string | null };
}

/** The keeper rewrites the status every pass; the TTL outlives a few slow passes so a stalled keeper leaves an old status. */
export const LIQUIDATION_STATUS_TTL_SEC = 900;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const REASONS = new Set<BacklogReason>(["pending", "gas_guard", "dust", "price", "failed"]);
const REGIMES = new Set(["open", "held", "settled", "closeout", "no_price"]);

/** KEYS.liquidationKeeper JSON -> status; null when absent or malformed (malformed entries are dropped). */
export function parseLiquidationStatus(raw: string | null | undefined): LiquidationKeeperStatus | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const ts = num(o.ts);
    if (ts === null) return null;
    const arr = (v: unknown) => (Array.isArray(v) ? (v.filter((x) => !!x && typeof x === "object") as Array<Record<string, unknown>>) : []);
    const lp = (o.lastPass ?? {}) as Record<string, unknown>;
    const f = (o.failures ?? {}) as Record<string, unknown>;
    const t = (o.totals ?? {}) as Record<string, unknown>;
    return {
      ts,
      enabled: o.enabled !== false,
      keeper: str(o.keeper) ?? "",
      nextPassSec: num(o.nextPassSec) ?? 0,
      markets: arr(o.markets)
        .filter((m) => num(m.marketId) !== null)
        .map((m) => ({
          marketId: num(m.marketId) as number,
          bookId: num(m.bookId),
          regime: (REGIMES.has(String(m.regime)) ? m.regime : "no_price") as LiquidationMarketStatus["regime"],
          openPositions: num(m.openPositions) ?? 0,
          priceAgeSec: num(m.priceAgeSec),
        })),
      backlog: arr(o.backlog)
        .filter((b) => num(b.marketId) !== null && typeof b.trader === "string" && num(b.since) !== null)
        .map((b) => ({
          marketId: num(b.marketId) as number,
          trader: b.trader as string,
          action: b.action === "forceClose" ? ("forceClose" as const) : ("liquidate" as const),
          since: num(b.since) as number,
          reason: (REASONS.has(b.reason as BacklogReason) ? b.reason : "pending") as BacklogReason,
          detail: str(b.detail),
        })),
      lastPass: { at: num(lp.at) ?? ts, durationMs: num(lp.durationMs) ?? 0, checked: num(lp.checked) ?? 0, liquidated: num(lp.liquidated) ?? 0, forceClosed: num(lp.forceClosed) ?? 0, raced: num(lp.raced) ?? 0 },
      failures: { consecutive: num(f.consecutive) ?? 0, since: num(f.since), lastError: str(f.lastError), lastErrorAt: num(f.lastErrorAt) },
      totals: { liquidations: num(t.liquidations) ?? 0, forceCloses: num(t.forceCloses) ?? 0, raced: num(t.raced) ?? 0, rewardsUsd: str(t.rewardsUsd) ?? "0", gasWei: str(t.gasWei) ?? "0" },
      gasGuard: o.gasGuard === "cap_only" ? "cap_only" : "reward",
      coverage: (() => {
        const c = (o.coverage ?? {}) as Record<string, unknown>;
        return { total: num(c.total) ?? 0, checked: num(c.checked) ?? 0, truncated: c.truncated === true, rotationSec: num(c.rotationSec) ?? 0 };
      })(),
      reconcile: (() => {
        const r = (o.reconcile ?? {}) as Record<string, unknown>;
        return { at: num(r.at), checked: num(r.checked) ?? 0, repaired: num(r.repaired) ?? 0, error: str(r.error) };
      })(),
    };
  } catch {
    return null;
  }
}
