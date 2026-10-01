// Agent operating mode from kill signals, risk state and book state (pure).
//
//   halt        kill message / mandate.killed() / risk "killed" / book Retired|Cancelled:
//               cancel-all, stop quoting, exit the loop (risk flattens on kill)
//   idle        book not Live yet (Subscription): no quotes, keep watching
//   reduce_only risk "breach" or "reduce_only" (stop new risk immediately), book Retiring
//   quote       normal operation (the mandate's own off-hours / utilisation gating still applies)

import type { BookState, LimitState } from "@bookrunner/shared";
import type { HedgeMode } from "./hedge-planner";

export type AgentMode = "quote" | "reduce_only" | "idle" | "halt";

export interface ModeInputs {
  killMessage: { reason: string } | null;
  mandateKilled: boolean;
  riskState: LimitState | null;
  bookState: BookState | null;
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
  return { mode: "quote", hedgeMode: "normal", reason: "OK" };
}
