import { describe, expect, test } from "bun:test";
import { SESSIONS_24X5, encodeSessions, hedgeAllowTree, HEDGE_VENUES, strToBytes32, tokenUnderlying, indexUnderlying } from "@bookrunner/shared";
import { marketCharterAbi, riskCommitteeAbi } from "@bookrunner/shared/abi";
import { TRPCError } from "@trpc/server";
import { decodeFunctionData, erc20Abi, zeroHash } from "viem";
import type { CharterServiceClient } from "../src/deps";
import {
  charterDraftSchema,
  charterFromJson,
  charterToJson,
  charterToView,
  draftToCharter,
  mergeIssues,
  validateCharterLocal,
} from "../src/domain/charter";
import { approveThreshold, tally, votesFor } from "../src/domain/committee";
import { A, fakeDeployment } from "./fakes";
import { NOW, SPONSOR, makeWorld, sampleCharter, sampleDraft, seedBook } from "./fixtures";

const stockTokens = fakeDeployment().stockTokens;
const codes = (xs: { code: string }[]) => xs.map((x) => x.code).sort();

async function trpcCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e.code;
    throw e;
  }
  throw new Error("expected a TRPCError");
}

describe("charter draft -> Charter", () => {
  test("human units are converted to protocol units", () => {
    const { charter: c, issues } = draftToCharter(charterDraftSchema.parse(sampleDraft()), { stockTokens });
    expect(issues).toEqual([]);
    expect(c.underlying).toBe(tokenUnderlying(stockTokens.NVDA!.token));
    expect(c.ifTargetUsd).toBe(30_000_000_000n);
    expect(c.mandate.maxHedgeLeverage).toBe(100);
    expect(c.sessions).toBe(encodeSessions(SESSIONS_24X5));
    expect(c.symbol).toBe(strToBytes32("PERP_NVDA_USDC"));
    expect(c.mandate.hedgeAllowRoot).toBe(hedgeAllowTree([{ asset: c.underlying, venue: HEDGE_VENUES.UNIV3 }]).root);
  });

  test("index underlying and explicit hedge allow-list", () => {
    const d = charterDraftSchema.parse(
      sampleDraft({
        underlying: { index: "RHX5" },
        venue: "pool_engine",
        mandate: { ...sampleDraft().mandate, hedgeAllow: [{ asset: "NVDA", venue: "UNIV3" }, { asset: "TSLA", venue: "UNIV3" }] },
      }),
    );
    const { charter: c, issues } = draftToCharter(d, { stockTokens });
    expect(issues).toEqual([]);
    expect(c.underlying).toBe(indexUnderlying("RHX5"));
    expect(c.venue).toBe(1);
    expect(c.mandate.hedgeAllowRoot).not.toBe(zeroHash);
  });

  test("unknown ticker is reported as BAD_UNDERLYING", () => {
    const { issues } = draftToCharter(charterDraftSchema.parse(sampleDraft({ underlying: { ticker: "ZZZZ" } })), { stockTokens });
    expect(codes(issues)).toEqual(["BAD_UNDERLYING"]);
  });

  test("struct_json round trip and human view", () => {
    const c = sampleCharter();
    const back = charterFromJson(JSON.parse(JSON.stringify(charterToJson(c))));
    expect(back).toEqual(c);
    const v = charterToView(c, { stockTokens });
    expect(v.ticker).toBe("NVDA");
    expect(v.ifTargetUsd).toBe("30000.000000");
    expect(v.mandate.maxHedgeLeverage).toBe(1);
    expect(v.sessionsPreset).toBe("24x5");
    expect(v.symbol).toBe("PERP_NVDA_USDC");
    expect(v.venue).toBe("orderly");
  });
});

describe("validateCharterLocal mirrors MarketCharter.validate", () => {
  test("valid launch charter passes", () => {
    expect(validateCharterLocal(sampleCharter())).toEqual([]);
  });

  test("each rule reports its reason code", () => {
    const base = sampleCharter();
    const cases: Array<[string, (c: ReturnType<typeof sampleCharter>) => void]> = [
      ["IF_BELOW_VENUE_MIN", (c) => (c.ifTargetUsd = 25_000_000_000n)], // Orderly needs IF > 25,000 (VERIFY O10)
      ["BAD_VENUE", (c) => (c.venue = 7 as never)],
      ["BAD_ORACLE", (c) => (c.oracle = 3 as never)],
      ["BAD_BPS", (c) => (c.seniorCapBps = 0)],
      ["BAD_BPS", (c) => (c.seniorHurdleBps = 10_001)],
      ["BAD_WINDOW", (c) => (c.subscriptionWindow = 59)],
      ["BAD_WINDOW", (c) => (c.subscriptionWindow = 30 * 86_400 + 1)],
      ["BAD_NOTICE", (c) => (c.juniorNoticeSeconds = BigInt(30 * 86_400 + 1))],
      ["BAD_MANDATE", (c) => (c.mandate.maxInventoryUsd = 0n)],
      ["BAD_MANDATE", (c) => (c.mandate.minQuoteWidthBps = 0)],
      ["BAD_MANDATE", (c) => (c.mandate.hedgeRatioMinBps = 13_000)],
      ["BAD_MANDATE", (c) => (c.mandate.killAtDrawdownBps = 0)],
      ["BAD_MANDATE", (c) => (c.mandate.killAtDrawdownBps = -5001)],
      ["BAD_MANDATE", (c) => (c.mandate.maxSkewBps = 0)],
      ["BAD_UNDERLYING", (c) => (c.underlying = zeroHash)],
      ["BAD_SYMBOL", (c) => (c.symbol = zeroHash)],
      ["BAD_FEES", (c) => ((c.venue = 1), (c.takerFeeBps = 101))],
    ];
    for (const [code, mutate] of cases) {
      const c = structuredClone(base);
      mutate(c);
      expect(codes(validateCharterLocal(c))).toEqual([code]);
    }
  });

  test("boundaries are accepted", () => {
    const c = structuredClone(sampleCharter());
    c.subscriptionWindow = 60;
    c.juniorNoticeSeconds = BigInt(30 * 86_400);
    c.mandate.killAtDrawdownBps = -5000;
    c.seniorCapBps = 10_000;
    c.ifTargetUsd = 25_001_000_000n; // smallest Orderly IF strictly above the venue's 25,000
    expect(validateCharterLocal(c)).toEqual([]);
    const e = structuredClone(sampleCharter());
    e.venue = 1;
    e.ifTargetUsd = 10_000_000_000n;
    e.takerFeeBps = 100;
    expect(validateCharterLocal(e)).toEqual([]);
  });

  test("registry and pause context", () => {
    expect(codes(validateCharterLocal(sampleCharter(), { underlyingKnown: false }))).toEqual(["BAD_UNDERLYING"]);
    expect(codes(validateCharterLocal(sampleCharter(), { newBooksPaused: true }))).toEqual(["NEW_BOOKS_PAUSED"]);
    expect(codes(validateCharterLocal(sampleCharter(), { venueMinIfUsd: [35_000_000_000n, 0n] }))).toEqual(["IF_BELOW_VENUE_MIN"]);
  });

  test("mergeIssues drops a chain reason already reported locally", () => {
    const local = [{ code: "BAD_MANDATE", field: "mandate.maxSkewBps", message: "x", source: "local" as const }];
    const chain = [{ code: "BAD_MANDATE", field: null, message: "y", source: "chain" as const }];
    const svc = [{ code: "BAD_SYMBOL", field: "symbol", message: "z", source: "charter-service" as const }];
    expect(codes(mergeIssues(local, chain, svc))).toEqual(["BAD_MANDATE", "BAD_SYMBOL"]);
  });
});

describe("committee rules", () => {
  test("thresholds depend on the jury recommendation", () => {
    expect(approveThreshold(true)).toBe(2);
    expect(approveThreshold(false)).toBe(3);
    expect(tally(2, 0, { posted: true, recommendApprove: true }).outcome).toBe("approved");
    expect(tally(2, 0, { posted: true, recommendApprove: false }).outcome).toBe("pending");
    expect(tally(3, 0, { posted: true, recommendApprove: false }).outcome).toBe("approved");
    expect(tally(2, 0, { posted: false, recommendApprove: null }).outcome).toBe("pending");
    expect(tally(0, 2, { posted: false, recommendApprove: null }).outcome).toBe("rejected");
  });

  test("votes are read from committee.votes_json", () => {
    const rows = [
      { member: "0xAA", bond: "1", votesJson: [{ charterId: 1, approve: true, tx: "0x1", ts: 1_790_000_000 }, { charterId: 2, approve: false }], seat: 0, updatedAt: new Date() },
      { member: "0xbb", bond: "1", votesJson: [{ charterId: 1, approve: false, tx: "0x2", ts: "2026-10-01T00:00:00Z" }], seat: 1, updatedAt: new Date() },
    ];
    const v = votesFor(rows, 1);
    expect(v).toHaveLength(2);
    expect(v[0]).toEqual({ member: "0xaa", approve: true, tx: "0x1", ts: new Date(1_790_000_000_000).toISOString() });
  });
});

describe("charter router", () => {
  test("file: valid draft with chain -> fee approve, bond stake, file", async () => {
    const w = makeWorld();
    w.chain.stake.set(SPONSOR.toLowerCase(), 40_000n * 10n ** 18n);
    const res = await w.caller.charter.file(sampleDraft());
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.txs.map((t) => t.description.split(" ")[0])).toEqual(["Approve", "Approve", "Stake", "File"]);
    const [fee, bkrn, , file] = res.txs;
    expect(fee!.to).toBe(w.chain.deployment.contracts.usdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: fee!.data }).args).toEqual([w.chain.deployment.contracts.charter, 5_000_000_000n]);
    expect(decodeFunctionData({ abi: erc20Abi, data: bkrn!.data }).args?.[1]).toBe(60_000n * 10n ** 18n);
    expect(file!.to).toBe(w.chain.deployment.contracts.charter);
    expect(decodeFunctionData({ abi: marketCharterAbi, data: file!.data }).functionName).toBe("file");
    expect(res.fee).toEqual({ charterFeeUsd: "5000.000000", sponsorBondBkrn: "100000.0" });
    expect(res.validatedBy).toEqual({ local: true, chain: true, charterService: false });
    expect(w.chain.validated).toHaveLength(1);
  });

  test("file: skips approvals already in place", async () => {
    const w = makeWorld();
    w.chain.usdc = { balance: 10_000_000_000n, allowance: 5_000_000_000n };
    w.chain.stake.set(SPONSOR.toLowerCase(), 100_000n * 10n ** 18n);
    const res = await w.caller.charter.file(sampleDraft());
    expect(res.txs).toHaveLength(1);
  });

  test("file: invalid draft returns reasons and no txs", async () => {
    const w = makeWorld();
    const res = await w.caller.charter.file(sampleDraft({ ifTargetUsd: "1000", symbol: "" }));
    expect(res.ok).toBe(false);
    expect(codes(res.issues)).toEqual(["BAD_SYMBOL", "IF_BELOW_VENUE_MIN"]);
    expect(res.txs).toEqual([]);
  });

  test("file: on-chain validate reason is surfaced", async () => {
    const w = makeWorld();
    w.chain.validateReason = strToBytes32("BAD_UNDERLYING");
    const res = await w.caller.charter.file(sampleDraft());
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual([{ code: "BAD_UNDERLYING", field: null, message: expect.any(String), source: "chain" }]);
  });

  test("file: without deployment validates locally and prepares nothing", async () => {
    const w = makeWorld({ chain: false });
    const res = await w.caller.charter.file(sampleDraft({ underlying: { token: A(0x1001) } }));
    expect(res.ok).toBe(true);
    expect(res.txs).toEqual([]);
    expect(res.warnings.join(" ")).toContain("deployment");
    expect(res.validatedBy.chain).toBe(false);
  });

  test("file: charter service reasons are merged", async () => {
    const svc: CharterServiceClient = { validate: async () => [{ code: "SPONSOR_UNKNOWN", field: "sponsor", message: "unknown sponsor", source: "charter-service" }] };
    const w = makeWorld({ charterService: svc });
    const res = await w.caller.charter.file(sampleDraft());
    expect(res.ok).toBe(false);
    expect(codes(res.issues)).toEqual(["SPONSOR_UNKNOWN"]);
    expect(res.validatedBy.charterService).toBe(true);
  });

  test("file: malformed input is a BAD_REQUEST", async () => {
    const w = makeWorld();
    expect(await trpcCode(w.caller.charter.file({ ...sampleDraft(), sponsor: "0xnope" }))).toBe("BAD_REQUEST");
    expect(await trpcCode(w.caller.charter.file({ ...sampleDraft(), ifTargetUsd: "-5" }))).toBe("BAD_REQUEST");
  });

  test("get: charter view + jury verdict + votes (db) and chain tally", async () => {
    const w = makeWorld({ chain: false });
    seedBook(w);
    w.data.charters[0]!.status = "Filed";
    w.data.juryVerdicts.push({ id: 1, charterId: 1, cid: "bafkrei1", digest: "0xd1", recommendApprove: true, verdict: { summary: "ok" }, postedTx: "0xp", createdAt: new Date(NOW) });
    w.data.committee.push({ member: A(0xa8).toLowerCase(), bond: "250000", votesJson: [{ charterId: 1, approve: true, tx: "0xv" }], seat: 0, updatedAt: new Date(NOW) });
    const g = await w.caller.charter.get({ charterId: 1 });
    expect(g.charter.ticker).toBe(null); // chain off: no deployment token map
    expect(g.jury?.cid).toBe("bafkrei1");
    expect(g.votes).toHaveLength(1);
    expect(g.tally).toMatchObject({ approvals: 1, rejections: 0, approveThreshold: 2, outcome: "pending", source: "db" });
    expect(g.committee[0]).toMatchObject({ bonded: true, voted: true });
    expect(g.book?.bookId).toBe(1);

    w.setChain(true);
    w.chain.committee = { ...w.chain.committee, approvals: 2, juryVerdict: { cid: "0xd1", recommendApprove: true, posted: true } };
    const g2 = await w.caller.charter.get({ charterId: 1 });
    expect(g2.tally).toMatchObject({ approvals: 2, outcome: "approved", source: "chain" });
    expect(g2.charter.ticker).toBe("NVDA");
    expect(await trpcCode(w.caller.charter.get({ charterId: 99 }))).toBe("NOT_FOUND");
  });

  test("list: status filter (case-insensitive) and pagination", async () => {
    const w = makeWorld();
    seedBook(w);
    for (let id = 2; id <= 4; id++) w.data.charters.push({ ...w.data.charters[0]!, id, status: id % 2 ? "Filed" : "Rejected" });
    const filed = await w.caller.charter.list({ status: "filed" });
    expect(filed.items.map((i) => i.charterId)).toEqual([3]);
    const p1 = await w.caller.charter.list({ limit: 2 });
    expect(p1.items.map((i) => i.charterId)).toEqual([4, 3]);
    expect(p1.nextCursor).toBe(3);
    const p2 = await w.caller.charter.list({ limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.charterId)).toEqual([2, 1]);
    expect(await trpcCode(w.caller.charter.list({ status: "bogus" }))).toBe("BAD_REQUEST");
  });

  test("decide: prepared RiskCommittee.vote for a bonded member", async () => {
    const w = makeWorld();
    seedBook(w);
    w.chain.records.set(1, { status: 1, filedAt: 0, decidedAt: 0, juryCid: zeroHash, book: A(0) });
    w.chain.committee = { ...w.chain.committee, juryVerdict: { cid: "0xd1", recommendApprove: false, posted: true }, approvals: 2 };
    const res = await w.caller.charter.decide({ charterId: 1, member: A(0xa9), approve: true });
    expect(res.tx.to).toBe(w.chain.deployment.contracts.committee);
    expect(decodeFunctionData({ abi: riskCommitteeAbi, data: res.tx.data }).args).toEqual([1n, true]);
    expect(res.tally).toMatchObject({ approvals: 2, approveThreshold: 3, outcome: "pending" });
    expect(res.projected).toMatchObject({ approvals: 3, outcome: "approved" });
  });

  test("decide: rejects non-members, double votes, unbonded members, decided charters", async () => {
    const w = makeWorld();
    seedBook(w);
    w.chain.records.set(1, { status: 1, filedAt: 0, decidedAt: 0, juryCid: zeroHash, book: A(0) });
    expect(await trpcCode(w.caller.charter.decide({ charterId: 1, member: A(0x1234), approve: true }))).toBe("FORBIDDEN");
    w.chain.committee.memberStatus[0]!.voted = true;
    expect(await trpcCode(w.caller.charter.decide({ charterId: 1, member: A(0xa8), approve: true }))).toBe("CONFLICT");
    w.chain.committee.memberStatus[1]!.bonded = false;
    expect(await trpcCode(w.caller.charter.decide({ charterId: 1, member: A(0xa9), approve: true }))).toBe("PRECONDITION_FAILED");
    w.chain.records.set(1, { status: 2, filedAt: 0, decidedAt: 0, juryCid: zeroHash, book: A(0) });
    expect(await trpcCode(w.caller.charter.decide({ charterId: 1, member: A(0xaa), approve: true }))).toBe("PRECONDITION_FAILED");
    w.setChain(false);
    expect(await trpcCode(w.caller.charter.decide({ charterId: 1, member: A(0xaa), approve: true }))).toBe("PRECONDITION_FAILED");
  });
});
