// Alert rules for the liquidation keeper of the in-house engine markets (2026-10; services/waterfall liquidationKeeper.ts,
// status in KEYS.liquidationKeeper). Pure Snapshot -> Conditions, registered in rules.ts RULES. Snapshot.liquidationKeeper
// undefined (the Redis read failed: the infra rule reports it) -> both rules are quiet.
//
// - liquidation_backlog:<marketId>:<trader> — a position the keeper found liquidatable (or due for a wind-down /
//   settled close-out) is still open ALERT_LIQ_BACKLOG_SECONDS (60) later: WARNING, CRITICAL at 5x that. The reason says
//   why (gas guard, price not usable, a failing transaction, still pending). A liquidatable position left open turns
//   its loss beyond the margin into insurance-fund bad debt.
// - keeper_liquidation_failing — CRITICAL when the keeper's last ALERT_LIQ_FAILURES (3) attempts (transactions or
//   passes, races excluded) failed, or when an engine book is Live / Retiring and the keeper's status is missing or
//   older than ALERT_LIQ_STATUS_STALE_SECONDS (300): nobody liquidates its traders.
import type { RuleConfig } from "./config";
import type { Condition, Snapshot } from "./types";

const dur = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const REASON: Record<string, string> = {
  pending: "not sent yet",
  gas_guard: "held back by the gas guard (cost above reward + margin, or a gas cap)",
  price: "the price it needs is not usable now",
  failed: "its transaction fails",
};

export function liquidationBacklog(s: Snapshot, c: RuleConfig): Condition[] {
  const st = s.liquidationKeeper;
  if (!st) return [];
  const out: Condition[] = [];
  for (const b of st.backlog) {
    const age = (s.now - b.since) / 1000;
    if (age <= c.liqBacklogSec) continue;
    out.push({
      key: `liquidation_backlog:${b.marketId}:${b.trader.toLowerCase()}`,
      rule: "liquidation_backlog",
      severity: age > 5 * c.liqBacklogSec ? "critical" : "warning",
      summary: `engine market ${b.marketId}: ${b.action === "liquidate" ? "liquidatable position" : "position due for close-out"} of ${short(b.trader)} still open after ${dur(age)}: ${REASON[b.reason] ?? b.reason}${b.detail ? ` (${b.detail})` : ""}`,
    });
  }
  return out;
}

export function keeperLiquidationFailing(s: Snapshot, c: RuleConfig): Condition[] {
  const st = s.liquidationKeeper;
  if (st === undefined) return [];
  const engineLive = (s.books ?? []).filter((b) => b.venue === "pool_engine" && (b.state === "Live" || b.state === "Retiring"));
  if (st === null || (s.now - st.ts) / 1000 > c.liqStatusStaleSec) {
    if (engineLive.length === 0) return [];
    return [
      {
        key: "keeper_liquidation_failing",
        rule: "keeper_liquidation_failing",
        severity: "critical",
        summary:
          st === null
            ? `no liquidation keeper status while ${engineLive.length} engine book(s) are live (waterfall down, WATERFALL_LIQ_ENABLED off or no Redis write): nobody liquidates their traders`
            : `liquidation keeper status is ${dur((s.now - st.ts) / 1000)} old (limit ${dur(c.liqStatusStaleSec)}) while ${engineLive.length} engine book(s) are live: the keeper is stalled`,
      },
    ];
  }
  if (st.failures.consecutive < c.liqFailures) return [];
  const since = st.failures.since ? ` since ${dur((s.now - st.failures.since) / 1000)}` : "";
  return [
    {
      key: "keeper_liquidation_failing",
      rule: "keeper_liquidation_failing",
      severity: "critical",
      summary: `liquidation keeper: ${st.failures.consecutive} consecutive failed attempts${since}; last error: ${st.failures.lastError ?? "unknown"}`,
    },
  ];
}

export const LIQUIDATION_RULES = {
  liquidation_backlog: liquidationBacklog,
  keeper_liquidation_failing: keeperLiquidationFailing,
} as const;
