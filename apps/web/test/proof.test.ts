// In-browser receipt verification against trees built exactly like the receipts / mark services do.
import { describe, expect, test } from "bun:test";
import { RECEIPT_KIND, payloadHash, periodTree, proofFor, receiptsTree } from "@bookrunner/shared/merkle";
import { type Hex, encodeAbiParameters, encodeEventTopics } from "viem";
import { MARK_COMMITTED_ABI, type ProofIn, allPass, markCommittedFromLogs, recomputeReceiptsRoot, verifyReceiptProof } from "../src/lib/proof";

const BOOK = 1;
const HOUR_A = 1_790_920_800;
const HOUR_B = 1_790_920_860;
const payloads = [
  { type: "fill", bookId: BOOK, side: "sell", qty: 1.25, px: 190.12 },
  { type: "quote", bookId: BOOK, bid: 189.9, ask: 190.1 },
  { type: "hedge", bookId: BOOK, asset: "0x2bdcc0de6be1f7d2ee689a0342d76f52e8efaba3", qtyRaw: "1000000000000000000" },
];
const leaves = [
  { kind: RECEIPT_KIND.FILL, bookId: BigInt(BOOK), ts: BigInt(HOUR_A + 5), payload: payloads[0] },
  { kind: RECEIPT_KIND.QUOTE, bookId: BigInt(BOOK), ts: BigInt(HOUR_A + 9), payload: payloads[1] },
  { kind: RECEIPT_KIND.HEDGE, bookId: BigInt(BOOK), ts: BigInt(HOUR_A + 30), payload: payloads[2] },
];
const hourly = receiptsTree(leaves);
const hours = [
  { hourStart: HOUR_A, root: hourly.root, leafCount: hourly.count },
  { hourStart: HOUR_B, root: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex, leafCount: 0 },
];
const period = periodTree(hours.map((h) => ({ bookId: BigInt(BOOK), hourStart: BigInt(h.hourStart), root: h.root, leafCount: h.leafCount })));

function proofOf(i: number): ProofIn {
  const l = leaves[i];
  if (!l) throw new Error("no leaf");
  const values: Array<string | number> = [l.kind, l.bookId.toString(), l.ts.toString(), payloadHash(l.payload)];
  const pValues: Array<string | number> = [String(BOOK), String(HOUR_A), hourly.root, hourly.count];
  return {
    receiptId: 100 + i,
    bookId: BOOK,
    kindName: "fill",
    payload: l.payload,
    payloadHash: payloadHash(l.payload),
    leaf: { values },
    hourly: { root: hourly.root, storedRoot: hourly.root, proof: proofFor(hourly, values) },
    period: { markId: 220, receiptsRoot: period.root, leaf: { values: pValues }, proof: proofFor(period, pValues) },
  };
}

describe("verifyReceiptProof", () => {
  test("a valid receipt passes every check, including the committed root", () => {
    for (let i = 0; i < leaves.length; i++) {
      const checks = verifyReceiptProof(proofOf(i), period.root);
      expect(checks.map((c) => c.id)).toEqual(["payload", "leaf", "hourly", "link", "period", "committed"]);
      expect(checks.every((c) => c.state === "pass")).toBe(true);
      expect(allPass(checks)).toBe(true);
    }
  });

  test("a tampered payload fails the payload and leaf checks", () => {
    const p = proofOf(0);
    const tampered = { ...p, payload: { ...(p.payload as object), qty: 99 } };
    const checks = verifyReceiptProof(tampered, period.root);
    expect(checks.find((c) => c.id === "payload")?.state).toBe("fail");
    expect(allPass(checks)).toBe(false);
  });

  test("a forged hourly proof fails inclusion", () => {
    const p = proofOf(1);
    const forged = { ...p, hourly: { ...p.hourly, proof: [...p.hourly.proof].reverse().map((h, i) => (i === 0 ? (`0x${"11".repeat(32)}` as Hex) : h)) } };
    expect(verifyReceiptProof(forged).find((c) => c.id === "hourly")?.state).toBe("fail");
  });

  test("a root that differs from the committed mark fails", () => {
    const checks = verifyReceiptProof(proofOf(2), `0x${"ab".repeat(32)}`);
    expect(checks.find((c) => c.id === "committed")?.state).toBe("fail");
  });

  test("an hour not yet covered by a mark is skipped, not failed", () => {
    const checks = verifyReceiptProof({ ...proofOf(0), period: null });
    expect(checks.find((c) => c.id === "link")?.state).toBe("skip");
    expect(allPass(checks)).toBe(true);
  });
});

describe("markCommittedFromLogs", () => {
  const registry = "0x0000000000000000000000000000000000000Bb1" as const;
  const signer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
  const log = (markId: bigint) => ({
    address: registry,
    topics: encodeEventTopics({ abi: MARK_COMMITTED_ABI, eventName: "MarkCommitted", args: { markId, bookId: 1n } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint64" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
      [1790921100n, 111_741_438_239n, 111_658_758_092n, `0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, period.root, signer],
    ),
  });
  const foreign = { address: "0x0000000000000000000000000000000000000Cc2" as const, topics: [`0x${"ff".repeat(32)}`] as Hex[], data: "0x" as Hex };

  test("decodes the committed roots of the requested mark, skipping other logs", () => {
    const m = markCommittedFromLogs([foreign, log(219n), log(220n)], 220);
    expect(m).toMatchObject({ markId: 220n, bookId: 1n, periodEnd: 1790921100n, receiptsRoot: period.root, signer, registry });
    expect(markCommittedFromLogs([foreign, log(219n)], 220)).toBeNull();
    expect(markCommittedFromLogs([], 1)).toBeNull();
  });
});

describe("recomputeReceiptsRoot", () => {
  test("matches the period tree the mark signs", () => {
    expect(recomputeReceiptsRoot(BOOK, hours)).toBe(period.root);
  });
  test("an empty period commits the zero root", () => {
    expect(recomputeReceiptsRoot(BOOK, [])).toBe("0x0000000000000000000000000000000000000000000000000000000000000000");
  });
});
