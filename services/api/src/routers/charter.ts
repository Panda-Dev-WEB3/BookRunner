import { CHARTER_STATUS } from "@bookrunner/shared/types";
import { bytes32ToStr } from "@bookrunner/shared/bytes32";
import { getAddress, zeroHash } from "viem";
import { z } from "zod";
import type { CommitteeRow, JuryVerdictRow } from "../data/types";
import {
  type CharterDraftInput,
  type CharterIssue,
  charterDraftSchema,
  charterFromJson,
  charterLabel,
  charterToJson,
  draftToCharter,
  mergeIssues,
  validateCharterLocal,
} from "../domain/charter";
import { type CommitteeVote, type Tally, tally, votesFor } from "../domain/committee";
import { type PreparedTx, approveBkrnTx, approveUsdcTx, committeeVoteTx, fileCharterTx, stakeTx } from "../domain/txs";
import { bkrnStr, dbUsdStr, iso, usdStr } from "../format";
import { fail, hardChain, notFound, publicProcedure, router, softChain } from "../trpc";
import { charterViewOf, cursorInput, intLike, limitInput, paged, stockTokens, walletInput } from "./common";

/** Human text for MarketCharter.validate reason codes (bytes32 short strings). */
export const REASON_TEXT: Record<string, string> = {
  IF_BELOW_VENUE_MIN: "Insurance fund size is below the venue minimum",
  BAD_VENUE: "Unknown venue",
  BAD_ORACLE: "Unknown oracle kind",
  BAD_BPS: "Senior share of fee flow or Senior cap is out of range",
  BAD_WINDOW: "Subscription window must be between 60 seconds and 30 days",
  BAD_NOTICE: "Junior notice must be at most 30 days",
  BAD_MANDATE: "Mandate terms are out of range",
  BAD_UNDERLYING: "Underlying is neither a canonical Stock Token nor a registered index",
  BAD_SYMBOL: "Venue symbol is required",
  BAD_FEES: "In-house taker fee must be at most 100 bps",
};

const statusInput = z
  .string()
  .transform((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
  .pipe(z.enum(CHARTER_STATUS));

export interface JuryView {
  cid: string;
  digest: string;
  recommendApprove: boolean;
  postedTx: string | null;
  createdAt: string;
  verdict: unknown;
  onChain: { posted: boolean; cid: string; recommendApprove: boolean } | null;
}

const juryView = (v: JuryVerdictRow | null, onChain: JuryView["onChain"]): JuryView | null =>
  v
    ? {
        cid: v.cid,
        digest: v.digest,
        recommendApprove: v.recommendApprove,
        postedTx: v.postedTx,
        createdAt: v.createdAt.toISOString(),
        verdict: v.verdict,
        onChain,
      }
    : onChain?.posted
      ? { cid: onChain.cid, digest: onChain.cid, recommendApprove: onChain.recommendApprove, postedTx: null, createdAt: new Date(0).toISOString(), verdict: null, onChain }
      : null;

function dbTally(votes: CommitteeVote[], verdict: JuryVerdictRow | null): Tally {
  return tally(
    votes.filter((v) => v.approve).length,
    votes.filter((v) => !v.approve).length,
    { posted: verdict !== null, recommendApprove: verdict?.recommendApprove ?? null },
  );
}

const committeeView = (rows: CommitteeRow[], votes: CommitteeVote[]) =>
  rows.map((r) => ({
    member: getAddress(r.member),
    seat: r.seat,
    bonded: BigInt(r.bond || "0") > 0n,
    voted: votes.some((v) => v.member === r.member.toLowerCase()),
  }));

export const charterRouter = router({
  /** Validates a draft (human units) like MarketCharter.validate and prepares the filing txs. */
  file: publicProcedure.input(charterDraftSchema).mutation(async ({ ctx: { deps }, input }) => {
    const conv = draftToCharter(input, { stockTokens: stockTokens(deps) });
    const c = conv.charter;
    const chain = deps.chain();
    const warnings = [...conv.warnings];

    const params = await softChain(deps, "config.params", (g) => g.params(), null);
    const underlyingKnown =
      c.underlying === zeroHash ? null : await softChain(deps, "registry.underlying", (g) => g.underlyingKnown(c.underlying), null);
    const local = validateCharterLocal(c, {
      venueMinIfUsd: params?.venueMinIfUsd,
      underlyingKnown,
      newBooksPaused: params?.newBooksPaused,
    });

    const chainReason = await softChain(deps, "charter.validate", (g) => g.validateCharter(c), null);
    const chainIssues: CharterIssue[] =
      chainReason && chainReason !== zeroHash
        ? [{ code: bytes32ToStr(chainReason), field: null, message: REASON_TEXT[bytes32ToStr(chainReason)] ?? "Rejected by MarketCharter.validate", source: "chain" }]
        : [];
    const serviceReply = deps.charterService ? await deps.charterService.validate(input as CharterDraftInput, c) : null;
    const serviceIssues = serviceReply ?? [];

    const issues = mergeIssues([...conv.issues, ...local], chainIssues, serviceIssues);
    const ok = issues.length === 0;
    const txs: PreparedTx[] = [];

    if (ok && chain && params) {
      const { contracts } = chain.deployment;
      const usdc = await softChain(deps, "usdc.state", (g) => g.usdcState(c.sponsor, contracts.charter), null);
      if (!usdc || usdc.allowance < params.charterFeeUsd) {
        txs.push(approveUsdcTx(chain.chainId, contracts.usdc, contracts.charter, params.charterFeeUsd, "the flat charter fee (refundable on rejection)"));
      }
      if (usdc && usdc.balance < params.charterFeeUsd) {
        warnings.push(`Sponsor USDC balance ${usdStr(usdc.balance)} is below the charter fee of ${usdStr(params.charterFeeUsd)}`);
      }
      const available = await softChain(deps, "staking.availableOf", (g) => g.stakeAvailable(c.sponsor), null);
      if (available !== null && available < params.sponsorBondBkrn) {
        const missing = params.sponsorBondBkrn - available;
        txs.push(approveBkrnTx(chain.chainId, contracts.bkrn, contracts.staking, missing, "staking (sponsor bond)"));
        txs.push(stakeTx(chain.chainId, contracts.staking, missing));
      }
      txs.push(fileCharterTx(chain.chainId, contracts.charter, c, charterLabel(c)));
    } else if (ok) {
      warnings.push("Contracts are not reachable yet; the draft is valid locally and filing transactions will be prepared once the deployment is available");
    }

    return {
      ok,
      issues,
      warnings,
      charter: charterViewOf(deps, c),
      charterStruct: charterToJson(c),
      fee: params ? { charterFeeUsd: usdStr(params.charterFeeUsd), sponsorBondBkrn: bkrnStr(params.sponsorBondBkrn) } : null,
      signer: c.sponsor,
      txs,
      validatedBy: {
        local: true,
        chain: chainReason !== null,
        charterService: serviceReply !== null,
      },
    };
  }),

  get: publicProcedure.input(z.object({ charterId: intLike(1) })).query(async ({ ctx: { deps }, input }) => {
    const row = await deps.data.getCharter(input.charterId);
    if (!row) return notFound(`charter ${input.charterId}`);
    const [verdict, members, book] = await Promise.all([
      deps.data.latestJuryVerdict(row.id),
      deps.data.committeeMembers(),
      deps.data.getBook(row.id),
    ]);
    const votes = votesFor(members, row.id);
    const chainState = await softChain(deps, "committee.state", (g) => g.committeeState(row.id), null);
    const chainRecord = await softChain(deps, "charter.get", (g) => g.charterRecord(row.id), null);
    const onChainJury = chainState
      ? { posted: chainState.juryVerdict.posted, cid: chainState.juryVerdict.cid, recommendApprove: chainState.juryVerdict.recommendApprove }
      : null;
    const t = chainState
      ? tally(chainState.approvals, chainState.rejections, {
          posted: chainState.juryVerdict.posted,
          recommendApprove: chainState.juryVerdict.posted ? chainState.juryVerdict.recommendApprove : null,
        })
      : dbTally(votes, verdict);
    const charter = charterFromJson(row.structJson);
    return {
      charterId: row.id,
      status: chainRecord ? (CHARTER_STATUS[chainRecord.status] ?? row.status) : row.status,
      sponsor: getAddress(row.sponsor),
      filedAt: row.filedAt.toISOString(),
      decidedAt: iso(row.decidedAt),
      bondTx: row.bondTx,
      feeUsd: dbUsdStr(row.feeUsd),
      bondBkrn: row.bondBkrn,
      juryCid: row.juryCid,
      meta: row.meta,
      charter: charterViewOf(deps, charter),
      jury: juryView(verdict, onChainJury),
      votes,
      tally: { ...t, source: chainState ? ("chain" as const) : ("db" as const) },
      committee: chainState
        ? chainState.memberStatus.map((m) => ({
            member: m.member,
            seat: members.find((r) => r.member.toLowerCase() === m.member.toLowerCase())?.seat ?? null,
            bonded: m.bonded,
            voted: m.voted,
          }))
        : committeeView(members, votes),
      book: book ? { bookId: book.id, address: getAddress(book.bookAddr), state: book.state } : row.bookAddr ? { bookId: row.id, address: getAddress(row.bookAddr), state: null } : null,
    };
  }),

  list: publicProcedure
    .input(
      z
        .object({ status: statusInput.optional(), sponsor: walletInput.optional(), limit: limitInput(50, 200), cursor: cursorInput })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx: { deps }, input }) => {
      const rows = await deps.data.listCharters({ status: input.status, sponsor: input.sponsor, limit: input.limit, beforeId: input.cursor });
      const verdicts = await deps.data.juryVerdictsFor(rows.map((r) => r.id));
      const latest = new Map<number, JuryVerdictRow>();
      for (const v of verdicts) latest.set(v.charterId, v); // ascending id: last wins
      const items = rows.map((r) => {
        const v = latest.get(r.id) ?? null;
        const meta = (r.meta ?? {}) as Record<string, unknown>;
        return {
          charterId: r.id,
          sponsor: getAddress(r.sponsor),
          symbol: r.symbol,
          name: typeof meta.name === "string" ? meta.name : null,
          venue: r.venue === 1 ? ("pool_engine" as const) : ("orderly" as const),
          underlying: r.underlying,
          status: r.status,
          filedAt: r.filedAt.toISOString(),
          decidedAt: iso(r.decidedAt),
          juryCid: r.juryCid ?? v?.cid ?? null,
          juryRecommendApprove: v ? v.recommendApprove : null,
          bookAddr: r.bookAddr ? getAddress(r.bookAddr) : null,
        };
      });
      return paged(items, input.limit, (i) => i.charterId);
    }),

  /** Committee member vote -> prepared RiskCommittee.vote tx (signed by the member). */
  decide: publicProcedure
    .input(z.object({ charterId: intLike(1), member: walletInput, approve: z.boolean() }))
    .mutation(async ({ ctx: { deps }, input }) => {
      const row = await deps.data.getCharter(input.charterId);
      const chain = deps.chain();
      const record = await hardChain(deps, "charter.get", (g) => g.charterRecord(input.charterId));
      if (!record && !row) return notFound(`charter ${input.charterId}`);
      const status = record ? CHARTER_STATUS[record.status] : row?.status;
      if (status !== "Filed") fail("PRECONDITION_FAILED", `Charter #${input.charterId} is ${status ?? "unknown"}; only filed charters can be voted on`);
      const cs = await hardChain(deps, "committee.state", (g) => g.committeeState(input.charterId));
      const me = cs.memberStatus.find((m) => m.member.toLowerCase() === input.member.toLowerCase());
      if (!me) fail("FORBIDDEN", `${input.member} is not a seated committee member`);
      if (me.voted) fail("CONFLICT", `${input.member} has already voted on charter #${input.charterId}`);
      if (!me.bonded) fail("PRECONDITION_FAILED", "Committee member must lock the committee bond (RiskCommittee.bond) before voting");
      if (!chain) return fail("PRECONDITION_FAILED", "Contracts are not deployed yet");

      const jury = { posted: cs.juryVerdict.posted, recommendApprove: cs.juryVerdict.posted ? cs.juryVerdict.recommendApprove : null };
      const current = tally(cs.approvals, cs.rejections, jury);
      const projected = tally(cs.approvals + (input.approve ? 1 : 0), cs.rejections + (input.approve ? 0 : 1), jury);
      const warnings: string[] = [];
      if (!jury.posted && input.approve) warnings.push("The jury verdict is not posted yet; approval cannot finalise until it is");
      const tx = committeeVoteTx(chain.chainId, chain.deployment.contracts.committee, input.charterId, input.approve);
      return { tx, txs: [tx], signer: getAddress(input.member), tally: current, projected, jury: { ...jury, cid: cs.juryVerdict.cid }, warnings };
    }),
});
