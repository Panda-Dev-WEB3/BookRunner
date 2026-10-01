// Jury pipeline for one charter (ports injected; unit-tested with fakes):
//   chain status Filed? -> verdict already posted? -> reuse stored unposted verdict or run
//   rule checks + jurors -> verdict JSON -> CID -> store -> RiskCommittee.postJuryVerdict(digest)
//   -> mark posted -> receipts DECISION leaf -> domain events (jury.verdict_posted,
//   committee.review_requested).
// Idempotent: the verdict is stored before posting, so a crash between store and post re-posts the
// same digest instead of re-running the jury.
import { type Charter, type CharterStatus, RECEIPT_KIND, payloadHash } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { charterToJson } from "../domain/charterJson";
import { cidOfJson } from "../domain/cid";
import { type JurorVote, PERSONAS, ruleJury } from "../domain/jurors";
import { type RuleContext, runRuleChecks } from "../domain/ruleChecks";
import { type Verdict, buildVerdict } from "../domain/verdict";
import { type JuryModelCall, modelJurorVote } from "./modelJuror";

export interface JuryCharter {
  charterId: number;
  charter: Charter;
  status: CharterStatus;
  filedAt: number; // unix seconds
}

export interface StoredVerdict {
  charterId: number;
  cid: string;
  digest: Hex;
  recommendApprove: boolean;
  verdict: Verdict;
  postedTx: string | null;
}

export interface PendingEvent {
  type: string;
  bookId: number | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

export interface ReceiptInput {
  bookId: number;
  kind: number;
  ts: Date;
  payload: Record<string, unknown>;
}

export interface JuryPorts {
  loadCharter(charterId: number): Promise<JuryCharter | null>;
  onChainVerdict(charterId: number): Promise<{ posted: boolean; digest: Hex; recommendApprove: boolean }>;
  ruleContext(charter: Charter): Promise<RuleContext>;
  findVerdict(charterId: number): Promise<StoredVerdict | null>;
  saveVerdict(v: StoredVerdict): Promise<void>;
  postVerdict(charterId: number, digest: Hex, recommendApprove: boolean): Promise<Hex>;
  markPosted(charterId: number, digest: Hex, txHash: Hex): Promise<void>;
  writeReceipt(r: ReceiptInput): Promise<void>;
  emit(e: PendingEvent): Promise<void>;
  committee(): Promise<{ members: Address[]; committeeWindowSec: number }>;
}

export type JurorSetup = { kind: "rules" } | { kind: "models"; call: JuryModelCall; models: string[] };

export interface JuryRunOptions {
  jurors: JurorSetup;
  now: () => Date;
  /** final queue attempt: transient model errors hand the seat to the rule juror instead of throwing */
  finalAttempt: boolean;
}

export type JuryOutcome =
  | { status: "missing" | "not_filed" | "already_posted"; charterId: number; detail?: string }
  | { status: "posted"; charterId: number; cid: string; digest: Hex; recommendApprove: boolean; txHash: Hex; reused: boolean };

export async function castVotes(charterId: number, charter: Charter, checks: ReturnType<typeof runRuleChecks>, o: JuryRunOptions): Promise<JurorVote[]> {
  if (o.jurors.kind === "rules") return ruleJury(charter, checks);
  const { call, models } = o.jurors;
  return Promise.all(
    models.map((model, i) =>
      modelJurorVote(call, model, {
        charterId,
        charter,
        ruleChecks: checks,
        substitute: PERSONAS[i % PERSONAS.length]!,
        finalAttempt: o.finalAttempt,
      }),
    ),
  );
}

export async function runJury(charterId: number, ports: JuryPorts, o: JuryRunOptions): Promise<JuryOutcome> {
  const rec = await ports.loadCharter(charterId);
  if (!rec) return { status: "missing", charterId };
  if (rec.status !== "Filed") return { status: "not_filed", charterId, detail: rec.status };

  const onChain = await ports.onChainVerdict(charterId);
  if (onChain.posted) return { status: "already_posted", charterId, detail: onChain.digest };

  const charterHash = payloadHash(charterToJson(rec.charter));
  let stored = await ports.findVerdict(charterId);
  let reused = true;
  if (!stored || stored.verdict.charterHash !== charterHash) {
    reused = false;
    const ctx = await ports.ruleContext(rec.charter);
    const checks = runRuleChecks(rec.charter, ctx);
    const votes = await castVotes(charterId, rec.charter, checks, o);
    const verdict = buildVerdict({ charterId, charter: rec.charter, votes, ruleChecks: checks, createdAt: o.now() });
    const id = await cidOfJson(verdict);
    stored = { charterId, cid: id.cid, digest: id.digest, recommendApprove: verdict.recommendApprove, verdict, postedTx: null };
    await ports.saveVerdict(stored);
  }

  const txHash = await ports.postVerdict(charterId, stored.digest, stored.recommendApprove);
  await ports.markPosted(charterId, stored.digest, txHash);

  const now = o.now();
  await ports.writeReceipt({
    bookId: charterId,
    kind: RECEIPT_KIND.DECISION,
    ts: now,
    payload: {
      type: "jury_verdict",
      charterId,
      cid: stored.cid,
      digest: stored.digest,
      recommendApprove: stored.recommendApprove,
      tally: stored.verdict.tally,
      txHash,
    },
  });

  const committee = await ports.committee().catch(() => ({ members: [] as Address[], committeeWindowSec: 0 }));
  const deadline = committee.committeeWindowSec ? rec.filedAt + committee.committeeWindowSec : null;
  await ports.emit({
    type: "jury.verdict_posted",
    bookId: charterId,
    dedupeKey: `jury.verdict_posted:${charterId}:${stored.digest}`,
    payload: { charterId, cid: stored.cid, digest: stored.digest, recommendApprove: stored.recommendApprove, summary: stored.verdict.summary, txHash },
  });
  await ports.emit({
    type: "committee.review_requested",
    bookId: charterId,
    dedupeKey: `committee.review_requested:${charterId}`,
    payload: {
      charterId,
      members: committee.members.map((m) => m.toLowerCase()),
      approvalsRequired: stored.verdict.approvalsRequired,
      juryCid: stored.cid,
      deadline: deadline ? new Date(deadline * 1000).toISOString() : null,
    },
  });
  return { status: "posted", charterId, cid: stored.cid, digest: stored.digest, recommendApprove: stored.recommendApprove, txHash, reused };
}
