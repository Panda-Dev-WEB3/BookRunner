// Committee decision rules (IRiskCommittee): approve needs the jury verdict posted and 2-of-3
// approvals (3-of-3 when the jury recommended reject); reject needs 2 rejections.
import type { CommitteeRow } from "../data/types";

export interface CommitteeVote {
  member: string;
  approve: boolean;
  tx: string | null;
  ts: string | null;
}

export interface Tally {
  approvals: number;
  rejections: number;
  approveThreshold: number;
  rejectThreshold: number;
  juryPosted: boolean;
  outcome: "approved" | "rejected" | "pending";
}

export const REJECT_THRESHOLD = 2;

export function approveThreshold(juryRecommendApprove: boolean | null): number {
  return juryRecommendApprove === false ? 3 : 2;
}

export function tally(approvals: number, rejections: number, jury: { posted: boolean; recommendApprove: boolean | null }): Tally {
  const at = approveThreshold(jury.posted ? jury.recommendApprove : null);
  let outcome: Tally["outcome"] = "pending";
  if (rejections >= REJECT_THRESHOLD) outcome = "rejected";
  else if (jury.posted && approvals >= at) outcome = "approved";
  return { approvals, rejections, approveThreshold: at, rejectThreshold: REJECT_THRESHOLD, juryPosted: jury.posted, outcome };
}

/** Votes on `charterId` from committee.votes_json ([{charterId, approve, tx, ts}] per member). */
export function votesFor(rows: CommitteeRow[], charterId: number): CommitteeVote[] {
  const out: CommitteeVote[] = [];
  for (const r of rows) {
    const list = Array.isArray(r.votesJson) ? (r.votesJson as unknown[]) : [];
    for (const v of list) {
      if (!v || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      if (Number(o.charterId) !== charterId) continue;
      const ts = o.ts == null ? null : typeof o.ts === "number" ? new Date(o.ts > 1e12 ? o.ts : o.ts * 1000).toISOString() : String(o.ts);
      out.push({ member: r.member.toLowerCase(), approve: Boolean(o.approve), tx: o.tx == null ? null : String(o.tx), ts });
    }
  }
  return out;
}
