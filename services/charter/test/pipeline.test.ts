// Jury pipeline with fake ports: store-before-post idempotency, skips, receipts, events.
import { describe, expect, test } from "bun:test";
import { RECEIPT_KIND } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { cidFromDigest, cidOfJson } from "../src/domain/cid";
import { type JuryPorts, type PendingEvent, type ReceiptInput, type StoredVerdict, runJury } from "../src/jury/pipeline";
import { nvdaCharter, ruleContextFor } from "./fixtures";

function fakePorts(over: Partial<{ status: string; posted: boolean; failPostOnce: boolean }> = {}) {
  const state = {
    verdicts: [] as StoredVerdict[],
    posts: [] as Array<{ id: number; digest: Hex; rec: boolean }>,
    receipts: [] as ReceiptInput[],
    events: [] as PendingEvent[],
    ruleContextCalls: 0,
    failPost: over.failPostOnce ?? false,
  };
  const c = nvdaCharter();
  const ports: JuryPorts = {
    loadCharter: async (id) => (id === 404 ? null : { charterId: id, charter: c, status: (over.status ?? "Filed") as "Filed", filedAt: 1_790_000_000 }),
    onChainVerdict: async () => ({ posted: over.posted ?? false, digest: `0x${"0".repeat(64)}`, recommendApprove: false }),
    ruleContext: async (ch) => {
      state.ruleContextCalls++;
      return ruleContextFor(ch);
    },
    findVerdict: async (id) => [...state.verdicts].reverse().find((v) => v.charterId === id) ?? null,
    saveVerdict: async (v) => {
      state.verdicts.push({ ...v });
    },
    postVerdict: async (id, digest, rec) => {
      if (state.failPost) {
        state.failPost = false;
        throw new Error("rpc down");
      }
      state.posts.push({ id, digest, rec });
      return `0x${"ab".repeat(32)}` as Hex;
    },
    markPosted: async (id, digest, tx) => {
      const v = state.verdicts.find((x) => x.charterId === id && x.digest === digest);
      if (v) v.postedTx = tx;
    },
    writeReceipt: async (r) => {
      state.receipts.push(r);
    },
    emit: async (e) => {
      state.events.push(e);
    },
    committee: async () => ({ members: ["0x00000000000000000000000000000000000000c1" as Address], committeeWindowSec: 172_800 }),
  };
  return { ports, state };
}

const opts = { jurors: { kind: "rules" as const }, now: () => new Date("2026-10-02T12:00:00.000Z"), finalAttempt: false };

describe("runJury", () => {
  test("rule jury -> verdict CID -> postJuryVerdict(digest) -> receipt + events", async () => {
    const { ports, state } = fakePorts();
    const out = await runJury(7, ports, opts);
    expect(out.status).toBe("posted");
    if (out.status !== "posted") return;
    const stored = state.verdicts[0]!;
    expect((await cidOfJson(stored.verdict)).cid).toBe(out.cid);
    expect(cidFromDigest(out.digest)).toBe(out.cid);
    expect(state.posts).toEqual([{ id: 7, digest: out.digest, rec: true }]);
    expect(stored.postedTx).toBe(out.txHash);
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]!.kind).toBe(RECEIPT_KIND.DECISION);
    expect(state.receipts[0]!.bookId).toBe(7);
    expect(state.receipts[0]!.payload).toMatchObject({ type: "jury_verdict", charterId: 7, cid: out.cid, recommendApprove: true });
    expect(state.events.map((e) => e.type)).toEqual(["jury.verdict_posted", "committee.review_requested"]);
    expect(state.events[1]!.payload).toMatchObject({ approvalsRequired: 2, juryCid: out.cid, deadline: new Date((1_790_000_000 + 172_800) * 1000).toISOString() });
  });

  test("crash between store and post: the retry re-posts the SAME digest without re-running the jury", async () => {
    const { ports, state } = fakePorts({ failPostOnce: true });
    await expect(runJury(7, ports, opts)).rejects.toThrow("rpc down");
    expect(state.verdicts).toHaveLength(1);
    const out = await runJury(7, ports, { ...opts, now: () => new Date("2027-01-01T00:00:00.000Z") });
    expect(out.status === "posted" && out.reused).toBe(true);
    expect(state.verdicts).toHaveLength(1);
    expect(state.ruleContextCalls).toBe(1);
    expect(state.posts[0]!.digest).toBe(state.verdicts[0]!.digest);
  });

  test("skips charters that are not Filed, already have a verdict on-chain, or do not exist", async () => {
    expect((await runJury(7, fakePorts({ status: "Approved" }).ports, opts)).status).toBe("not_filed");
    const posted = fakePorts({ posted: true });
    expect((await runJury(7, posted.ports, opts)).status).toBe("already_posted");
    expect(posted.state.posts).toHaveLength(0);
    expect((await runJury(404, fakePorts().ports, opts)).status).toBe("missing");
  });

  test("approvals cast before the verdict: tryFinalize runs right after postJuryVerdict and decides the charter", async () => {
    const { ports, state } = fakePorts();
    // RiskCommittee: two bonded members approved while the jury was still running
    const committee = { approvals: 2, posted: false, decided: false, finalizeCalls: 0 };
    const post = ports.postVerdict;
    ports.postVerdict = async (id, digest, rec) => {
      const tx = await post(id, digest, rec);
      committee.posted = true; // postJuryVerdict never finalizes by itself
      return tx;
    };
    ports.tryFinalize = async () => {
      committee.finalizeCalls++;
      if (committee.decided || !committee.posted || committee.approvals < 2) return { finalized: false, tx: null };
      committee.decided = true;
      return { finalized: true, tx: `0x${"cd".repeat(32)}` as Hex };
    };
    const out = await runJury(4, ports, opts);
    expect(out.status).toBe("posted");
    expect(state.posts).toHaveLength(1);
    expect(committee.finalizeCalls).toBe(1);
    expect(committee.decided).toBe(true);
    expect(out.status === "posted" && out.finalized).toBe(true);
  });

  test("a failing tryFinalize never fails the verdict (the committee upkeep sweep retries)", async () => {
    const { ports } = fakePorts();
    ports.tryFinalize = async () => {
      throw new Error("rpc down");
    };
    const out = await runJury(4, ports, opts);
    expect(out.status).toBe("posted");
    expect(out.status === "posted" && out.finalized).toBeNull();
  });
});
