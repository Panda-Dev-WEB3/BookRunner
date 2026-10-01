// Verdict assembly: majority of jury seats -> recommendApprove. The verdict JSON is content-addressed
// (canonicalJson -> CIDv1 raw sha2-256), so it only holds strings / integers / booleans (exact jsonb
// round-trip) and its text passes the copy rules.
import { type Charter, payloadHash } from "@bookrunner/shared";
import type { Hex } from "viem";
import { charterToJson } from "./charterJson";
import { sanitizeCopy, sanitizeList } from "./copyFilter";
import type { JurorVote } from "./jurors";
import { type RuleCheck, countByStatus } from "./ruleChecks";

export interface Verdict {
  version: 1;
  charterId: number;
  /** payloadHash(charterToJson(charter)) — binds the verdict to the exact filed struct. */
  charterHash: Hex;
  models: JurorVote[];
  ruleChecks: RuleCheck[];
  tally: { seats: number; approve: number; reject: number; abstain: number };
  recommendApprove: boolean;
  /** RiskCommittee threshold implied by the recommendation (2-of-3, or 3-of-3 against the jury). */
  approvalsRequired: number;
  summary: string;
  createdAt: string; // ISO-8601
}

export function tallyVotes(votes: JurorVote[]) {
  const t = { seats: votes.length, approve: 0, reject: 0, abstain: 0 };
  for (const v of votes) t[v.vote]++;
  return t;
}

/** Strict majority of seats (abstentions count against approval); any blocking rule check vetoes. */
export function recommendation(votes: JurorVote[], checks: RuleCheck[]): boolean {
  const t = tallyVotes(votes);
  const blocked = checks.some((c) => c.status === "block");
  return !blocked && t.seats > 0 && t.approve * 2 > t.seats;
}

export function buildVerdict(p: { charterId: number; charter: Charter; votes: JurorVote[]; ruleChecks: RuleCheck[]; createdAt: Date }): Verdict {
  const models = p.votes.map((v) => {
    const r = sanitizeCopy(v.rationale);
    const risks = sanitizeList(v.risks);
    const out: JurorVote = { model: v.model, source: v.source, vote: v.vote, rationale: r.text, risks: risks.items };
    if (v.error) out.error = sanitizeCopy(v.error).text;
    return out;
  });
  const ruleChecks = p.ruleChecks.map((c) => ({ ...c, detail: sanitizeCopy(c.detail).text }));
  const tally = tallyVotes(models);
  const recommendApprove = recommendation(models, ruleChecks);
  const counts = countByStatus(ruleChecks);
  const blocked = counts.block > 0;
  const lead = recommendApprove
    ? `The jury recommends approval (${tally.approve} of ${tally.seats} seats approve).`
    : blocked
      ? `The jury recommends rejection: ${counts.block} blocking rule check(s) (${tally.approve} of ${tally.seats} seats approve).`
      : `The jury recommends rejection (${tally.approve} of ${tally.seats} seats approve${tally.abstain ? `, ${tally.abstain} abstained` : ""}).`;
  const summary = sanitizeCopy(
    `${lead} Rule checks: ${counts.pass} pass, ${counts.info} info, ${counts.warn} warn, ${counts.block} block. ` +
      `Committee approval needs ${recommendApprove ? 2 : 3} of 3 bonded members.`,
  ).text;
  return {
    version: 1,
    charterId: p.charterId,
    charterHash: payloadHash(charterToJson(p.charter)),
    models,
    ruleChecks,
    tally,
    recommendApprove,
    approvalsRequired: recommendApprove ? 2 : 3,
    summary,
    createdAt: p.createdAt.toISOString(),
  };
}
