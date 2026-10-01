// Per-book risk state machine. Pure: (previous MonitorState, this tick's snapshot, chain killed flag)
// -> next MonitorState + effects for the monitor to execute.
//
//   not killed, no breach      -> streak 0, episode cleared
//   breach (streak < confirm)  -> episode opened (unconfirmed)
//   breach (streak >= confirm) -> episode confirmed: emit limit.breached (once per episode) and, in
//                                 enforce mode, open a kill journal + run the kill sequence
//   kill journal incomplete    -> resume the kill sequence (a started kill is always completed)
//   killed on-chain            -> finish our journal, or verify that the follow-up of an external
//                                 kill (book at mark, earlier run) is recorded
//   killed -> not killed       -> (re-mandated) journal + handled marker cleared
import type { LimitsSnapshot } from "@bookrunner/shared";
import type { BreachEpisode, KillJournal, KillStep, MonitorState } from "../types";

export const KILL_STEPS: readonly KillStep[] = [
  "broadcast",
  "cancel_all",
  "reduce_only",
  "flatten",
  "revoke_venue_key",
  "mandate_kill",
  "record_kill_event",
  "record_receipt",
  "record_event",
] as const;

/** Breach names in kill-reason priority order (mandate.kill takes one bytes32 reason). */
const REASON_PRIORITY = ["DRAWDOWN", "INVENTORY", "SKEW", "WIDTH", "HEDGE_BAND"];

export function primaryReason(breaches: string[]): string {
  for (const r of REASON_PRIORITY) if (breaches.includes(r)) return r;
  return breaches[0] ?? "RISK";
}

export function isJournalComplete(j: KillJournal): boolean {
  return j.done.includes("record_event");
}

export type Effect = { kind: "emit_breach"; episode: BreachEpisode } | { kind: "run_kill" } | { kind: "check_kill_followup" };

export interface DecideInput {
  bookId: number;
  state: MonitorState;
  snapshot: LimitsSnapshot;
  killedOnChain: boolean;
  nowSec: number;
  confirmTicks: number;
  killMode: "enforce" | "alert";
}

export function newKillJournal(
  episode: Pick<BreachEpisode, "id" | "breaches">,
  snapshot: Record<string, unknown>,
  nowSec: number,
  mode: KillJournal["mode"] = "breach",
): KillJournal {
  return {
    episodeId: episode.id,
    mode,
    startedAt: nowSec,
    reason: primaryReason(episode.breaches),
    breaches: [...episode.breaches],
    snapshot,
    done: [],
    failed: {},
    actions: [],
    txHashes: [],
    killTx: null,
    runs: 0,
  };
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

export function decide(i: DecideInput): { next: MonitorState; effects: Effect[] } {
  const s: MonitorState = {
    ...i.state,
    band: { ...i.state.band },
    episode: i.state.episode ? { ...i.state.episode, breaches: [...i.state.episode.breaches] } : null,
    lastState: i.snapshot.state,
    lastBreaches: [...i.snapshot.breaches],
  };
  const effects: Effect[] = [];
  const enforce = i.killMode === "enforce";

  if (i.killedOnChain) {
    s.breachStreak = 0;
    if (s.kill && !isJournalComplete(s.kill)) {
      if (enforce) effects.push({ kind: "run_kill" });
    } else if (s.handledKill === null && enforce) {
      effects.push({ kind: "check_kill_followup" });
    }
  } else {
    if (s.kill && isJournalComplete(s.kill)) s.kill = null; // re-mandated after a recorded kill
    s.handledKill = null;

    if (s.kill) {
      // a started kill is always completed, whatever the current classification says
      if (enforce) effects.push({ kind: "run_kill" });
    } else if (i.snapshot.state === "breach") {
      s.breachStreak = i.state.breachStreak + 1;
      const ep: BreachEpisode = s.episode ?? {
        id: `${i.bookId}-${i.nowSec}`,
        since: i.nowSec,
        breaches: [],
        confirmed: false,
        notified: false,
      };
      ep.breaches = union(ep.breaches, i.snapshot.breaches);
      if (!ep.confirmed && s.breachStreak >= Math.max(1, i.confirmTicks)) {
        ep.confirmed = true;
        if (enforce) {
          s.kill = newKillJournal(ep, { ...i.snapshot, episodeId: ep.id }, i.nowSec);
          effects.push({ kind: "run_kill" });
        }
      }
      s.episode = ep;
    } else {
      s.breachStreak = 0;
      s.episode = null;
    }
  }

  // limit.breached goes out first (and is retried every tick until written), then the kill
  if (s.episode?.confirmed && !s.episode.notified) {
    effects.unshift({ kind: "emit_breach", episode: { ...s.episode, breaches: [...s.episode.breaches] } });
  }
  return { next: s, effects };
}
