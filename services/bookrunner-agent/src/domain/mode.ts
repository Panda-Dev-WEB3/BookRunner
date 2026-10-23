// Agent operating mode from kill signals, risk state and book state (pure).
//
//   halt        kill message / mandate.killed() / risk "killed" / book Retired|Cancelled:
//               cancel-all, stop quoting, exit the loop (risk flattens on kill)
//   idle        book not Live yet (Subscription): no quotes, keep watching
//   reduce_only risk "breach" or "reduce_only" (stop new risk immediately), book Retiring, no verified risk state for
//               the agent's timeout (RISK_STATE_UNVERIFIED), no active desk session key on the mandate (NO_DESK_KEY:
//               an agent quotes new risk only with a key, so risk can verify every quote it judges), or the book's Orderly
//               market not open for new risk (ops-venue listing check: not listed / missing / POST_ONLY /
//               REDUCE_ONLY / DELISTING / DELISTED, shared venueMarketGate; docs/VERIFY.md O20), or a pool-funded book's
//               own capital below the pool's minimum (Book.capitalShort(), pool audit 2026-10-23 fix round 2 Info 4:
//               redemptions are never blocked, the book stops adding risk until its capital is back above the minimum)
//   quote       normal operation (the mandate's own off-hours / utilisation gating still applies)

import type { BookState, LimitState } from "@bookrunner/shared";
import type { HedgeMode } from "./hedge-planner";

export type AgentMode = "quote" | "reduce_only" | "idle" | "halt";

export interface ModeInputs {
  killMessage: { reason: string } | null;
  mandateKilled: boolean;
  riskState: LimitState | null;
  bookState: BookState | null;
  /** the venue market gate (Orderly books): a reason to stop new risk, null = open / unknown */
  venueGate?: { reason: string } | null;
  /** no RISK-signed state verified for the agent's timeout (Redis not trusted): reduce-only, never a halt */
  riskUnverified?: boolean;
  /** the desk session key is not active on the mandate (false) / unknown (undefined): false = reduce-only */
  deskKeyActive?: boolean;
  /** Book.capitalShort(): a pool-funded book's own capital is below the pool's minimum (reduce-only until restored) */
  capitalShort?: boolean;
}

export interface ModeDecision {
  mode: AgentMode;
  hedgeMode: HedgeMode;
  reason: string;
}

export function resolveMode(i: ModeInputs): ModeDecision {
  if (i.killMessage) return { mode: "halt", hedgeMode: "off", reason: `KILL_MSG:${i.killMessage.reason}` };
  if (i.mandateKilled) return { mode: "halt", hedgeMode: "off", reason: "MANDATE_KILLED" };
  if (i.riskState === "killed") return { mode: "halt", hedgeMode: "off", reason: "RISK_KILLED" };
  if (i.bookState === "Retired") return { mode: "halt", hedgeMode: "off", reason: "BOOK_RETIRED" };
  if (i.bookState === "Cancelled") return { mode: "halt", hedgeMode: "off", reason: "BOOK_CANCELLED" };
  if (i.bookState === "Subscription" || i.bookState === null) return { mode: "idle", hedgeMode: "off", reason: i.bookState ? "BOOK_NOT_LIVE" : "BOOK_STATE_UNKNOWN" };
  if (i.bookState === "Retiring") return { mode: "reduce_only", hedgeMode: "flatten", reason: "BOOK_RETIRING" };
  if (i.riskState === "breach") return { mode: "reduce_only", hedgeMode: "reduce_only", reason: "RISK_BREACH" };
  if (i.riskState === "reduce_only") return { mode: "reduce_only", hedgeMode: "reduce_only", reason: "RISK_REDUCE_ONLY" };
  if (i.capitalShort) return { mode: "reduce_only", hedgeMode: "reduce_only", reason: "POOL_CAPITAL_SHORT" };
  if (i.riskUnverified) return { mode: "reduce_only", hedgeMode: "reduce_only", reason: "RISK_STATE_UNVERIFIED" };
  if (i.deskKeyActive === false) return { mode: "reduce_only", hedgeMode: "reduce_only", reason: "NO_DESK_KEY" };
  if (i.venueGate) return { mode: "reduce_only", hedgeMode: "reduce_only", reason: i.venueGate.reason };
  return { mode: "quote", hedgeMode: "normal", reason: "OK" };
}
