// Pure tree construction + proof verification for receipts.
//   hourly (window) root: StandardMerkleTree over RECEIPT_LEAF (kind, bookId, ts, payloadHash)
//   period root:          StandardMerkleTree over PERIOD_LEAF (bookId, hourStart, hourlyRoot, leafCount)
// Same format as packages/shared/src/merkle.ts (receiptsTree / periodTree), but hourly leaves are built
// from the payload hashes STORED by producers (receipts.payload_hash) instead of re-hashing the jsonb
// payload, so a jsonb round-trip can never change what was committed.
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { type BuiltTree, PERIOD_LEAF, RECEIPT_LEAF, periodTree, proofFor, verifyProof } from "@bookrunner/shared";
import { type Hex, zeroHash } from "viem";

export interface ReceiptLeaf {
  kind: number;
  bookId: bigint;
  ts: bigint; // unix seconds
  payloadHash: Hex;
}

export interface HourlyRoot {
  bookId: bigint;
  hourStart: bigint; // window start, unix seconds
  root: Hex;
  leafCount: number;
}

export function receiptLeafValues(l: ReceiptLeaf): [number, string, string, string] {
  return [l.kind, l.bookId.toString(), l.ts.toString(), l.payloadHash.toLowerCase()];
}

/** Hourly (window) tree. Empty window -> root = zeroHash, count 0. Leaf order does not matter (sorted). */
export function hourlyTree(leaves: ReceiptLeaf[]): BuiltTree {
  if (leaves.length === 0) return { root: zeroHash, count: 0, tree: null };
  const tree = StandardMerkleTree.of<(string | number)[]>(leaves.map(receiptLeafValues), [...RECEIPT_LEAF]);
  return { root: tree.root as Hex, count: leaves.length, tree };
}

/** Period tree over the hourly roots of one mark period (shared periodTree). */
export function periodRootTree(hourly: HourlyRoot[]): BuiltTree {
  return periodTree(hourly);
}

export function hourlyLeafProof(t: BuiltTree, leaf: ReceiptLeaf): Hex[] {
  return proofFor(t, receiptLeafValues(leaf));
}

export function periodLeafValues(h: HourlyRoot): [string, string, string, number] {
  return [h.bookId.toString(), h.hourStart.toString(), h.root.toLowerCase(), h.leafCount];
}

export function periodLeafProof(t: BuiltTree, h: HourlyRoot): Hex[] {
  return proofFor(t, periodLeafValues(h));
}

/** Proof bundle: receipt leaf -> hourly root -> period root (the mark's receiptsRoot). */
export interface ReceiptProof {
  receiptId: number;
  leaf: { kind: number; bookId: string; ts: string; payloadHash: Hex };
  payload: unknown;
  hourly: { hourStart: number; root: Hex; leafCount: number; proof: Hex[] };
  period: { periodStart: number; periodEnd: number; root: Hex; proof: Hex[]; complete: boolean };
}

export function verifyHourly(p: Pick<ReceiptProof, "leaf" | "hourly">): boolean {
  const values = [p.leaf.kind, p.leaf.bookId, p.leaf.ts, p.leaf.payloadHash];
  if (p.hourly.leafCount === 0 || p.hourly.root === zeroHash) return false;
  return verifyProof(p.hourly.root, RECEIPT_LEAF, values, p.hourly.proof);
}

export function verifyPeriod(p: Pick<ReceiptProof, "leaf" | "hourly" | "period">): boolean {
  const values = [p.leaf.bookId, String(p.hourly.hourStart), p.hourly.root, p.hourly.leafCount];
  return verifyProof(p.period.root, PERIOD_LEAF, values, p.period.proof);
}

/**
 * Full verification: leaf -> hourly root -> period root. Pass `expectedReceiptsRoot` (from the mark on
 * MarkRegistry) to also pin the period root to the committed one.
 */
export function verifyReceiptProof(p: ReceiptProof, expectedReceiptsRoot?: Hex): boolean {
  if (expectedReceiptsRoot && expectedReceiptsRoot.toLowerCase() !== p.period.root.toLowerCase()) return false;
  return verifyHourly(p) && verifyPeriod(p);
}
