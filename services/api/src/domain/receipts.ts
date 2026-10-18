// Receipt proofs (local implementation on shared merkle.ts so the API does not depend on the receipts
// service package). Two levels, both OpenZeppelin StandardMerkleTree:
//   hourly root  = tree over RECEIPT_LEAF (kind, bookId, ts, payloadHash) of one book-hour
//   receiptsRoot = tree over PERIOD_LEAF (bookId, hourStart, hourlyRoot, leafCount) of the hours
//                  in a mark period [periodEnd - markInterval, periodEnd)   (committed in the mark)
import { type BuiltTree, PERIOD_LEAF, RECEIPT_KIND, RECEIPT_LEAF, payloadHash, periodTree, proofFor, verifyProof } from "@bookrunner/shared/merkle";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { type Hex, zeroHash } from "viem";
import type { MarkRow, ReceiptRootRow, ReceiptRow } from "../data/types";
import { unixSec } from "../format";

export const RECEIPT_KIND_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(RECEIPT_KIND).map(([k, v]) => [v, k.toLowerCase()]),
);

export type ReceiptLeaf = [number, bigint, bigint, Hex];

export const receiptLeaf = (r: ReceiptRow): ReceiptLeaf => [r.kind, BigInt(r.bookId), BigInt(unixSec(r.ts)), r.payloadHash as Hex];

/** Hourly tree over the stored leaves (payload hashes as committed by the producer). */
export function hourlyTree(rows: ReceiptRow[]): BuiltTree {
  if (rows.length === 0) return { root: zeroHash, count: 0, tree: null };
  const values = rows.map((r) => receiptLeaf(r).map((x) => (typeof x === "bigint" ? x.toString() : x)) as (string | number)[]);
  const tree = StandardMerkleTree.of(values, [...RECEIPT_LEAF]);
  return { root: tree.root as Hex, count: rows.length, tree };
}

/** An hour's tree with the lookups a proof needs (no linear scan per call; cached by receiptCache.ts). */
export interface HourTree {
  tree: BuiltTree;
  ids: Set<number>;
  /** leaf values key -> first index in the tree's values (proofFor's match rule) */
  index: Map<string, number>;
  /** built for an hour whose root is committed */
  closed: boolean;
}

const leafKey = (values: ReadonlyArray<string | number | bigint>) => JSON.stringify(values.map((x) => String(x).toLowerCase()));

export function hourTreeOf(rows: ReceiptRow[], closed: boolean): HourTree {
  const tree = hourlyTree(rows);
  const index = new Map<string, number>();
  if (tree.tree) for (const [i, v] of tree.tree.entries()) if (!index.has(leafKey(v))) index.set(leafKey(v), i);
  return { tree, ids: new Set(rows.map((r) => r.id)), index, closed };
}

/** Proof of `values` in the hour tree (the same leaf shared proofFor picks). */
export function hourProof(h: HourTree, values: ReadonlyArray<string | number | bigint>): Hex[] {
  if (!h.tree.tree) return [];
  const i = h.index.get(leafKey(values));
  if (i === undefined) throw new Error("hourProof: leaf not in tree");
  return h.tree.tree.getProof(i) as Hex[];
}

export function periodBounds(periodEnd: Date, markInterval: number): { from: Date; to: Date } {
  return { from: new Date(periodEnd.getTime() - markInterval * 1000), to: periodEnd };
}

export const periodLeaf = (r: ReceiptRootRow): [bigint, bigint, Hex, number] => [BigInt(r.bookId), BigInt(unixSec(r.hourStart)), r.root as Hex, r.leafCount];

export function receiptsRootOf(roots: ReceiptRootRow[]): BuiltTree {
  return periodTree(roots.map((r) => ({ bookId: BigInt(r.bookId), hourStart: BigInt(unixSec(r.hourStart)), root: r.root as Hex, leafCount: r.leafCount })));
}

const strs = (vals: Array<string | number | bigint>) => vals.map((v) => (typeof v === "bigint" ? v.toString() : v));

export interface ReceiptProof {
  receiptId: number;
  bookId: number;
  kind: number;
  kindName: string;
  ts: string;
  hourStart: number;
  payload: unknown;
  payloadHash: Hex;
  payloadHashMatches: boolean;
  leaf: { encoding: string[]; values: Array<string | number>; hash: Hex };
  hourly: { root: Hex; storedRoot: Hex | null; matchesStored: boolean | null; leafCount: number; proof: Hex[]; verified: boolean };
  period: {
    markId: number;
    periodStart: number;
    periodEnd: number;
    receiptsRoot: Hex;
    computedRoot: Hex;
    matchesMark: boolean;
    leaf: { encoding: string[]; values: Array<string | number> };
    proof: Hex[];
    verified: boolean;
    hours: number;
  } | null;
  roots: { hourly: Hex; receiptsRoot: Hex | null; inventoryRoot: Hex | null };
}

export interface ProofInputs {
  receipt: ReceiptRow;
  /** tree of the receipt's hour; must contain the receipt */
  hour: HourTree;
  storedHourRoot: ReceiptRootRow | null;
  mark: MarkRow | null;
  periodRoots: ReceiptRootRow[];
  /** receiptsRootOf(periodRoots) when already built (cached per mark) */
  periodTree?: BuiltTree;
}

export function buildReceiptProof(i: ProofInputs): ReceiptProof {
  const r = i.receipt;
  const leafValues = receiptLeaf(r);
  if (!i.hour.ids.has(r.id)) throw new Error("buildReceiptProof: the hour tree does not contain the receipt");
  const tree = i.hour.tree;
  const proof = hourProof(i.hour, leafValues);
  const verified = verifyProof(tree.root, RECEIPT_LEAF, leafValues, proof);
  const leafHash = (tree.tree?.leafHash(strs(leafValues)) ?? zeroHash) as Hex;
  const storedRoot = (i.storedHourRoot?.root as Hex | undefined) ?? null;

  let period: ReceiptProof["period"] = null;
  if (i.mark) {
    // The period tree commits to the stored hourly roots; use the recomputed root for this hour when
    // the receipts service has not written it yet.
    const hasHour = i.periodRoots.some((x) => x.hourStart.getTime() === r.hourStart.getTime());
    const roots = hasHour
      ? i.periodRoots
      : [...i.periodRoots, { id: 0, bookId: r.bookId, hourStart: r.hourStart, root: tree.root, leafCount: tree.count, createdAt: new Date(0) }];
    const pTree = hasHour && i.periodTree ? i.periodTree : receiptsRootOf(roots);
    const hourRow = roots.find((x) => x.hourStart.getTime() === r.hourStart.getTime());
    const pLeaf = hourRow ? periodLeaf(hourRow) : null;
    const pProof = pLeaf ? proofFor(pTree, pLeaf) : [];
    const markEnd = unixSec(i.mark.periodEnd);
    const start = roots.length ? Math.min(...roots.map((x) => unixSec(x.hourStart))) : markEnd;
    period = {
      markId: i.mark.id,
      periodStart: start,
      periodEnd: markEnd,
      receiptsRoot: i.mark.receiptsRoot as Hex,
      computedRoot: pTree.root,
      matchesMark: pTree.root.toLowerCase() === i.mark.receiptsRoot.toLowerCase(),
      leaf: { encoding: [...PERIOD_LEAF], values: pLeaf ? strs(pLeaf) : [] },
      proof: pProof,
      verified: pLeaf ? verifyProof(i.mark.receiptsRoot as Hex, PERIOD_LEAF, pLeaf, pProof) : false,
      hours: roots.length,
    };
  }

  return {
    receiptId: r.id,
    bookId: r.bookId,
    kind: r.kind,
    kindName: RECEIPT_KIND_NAMES[r.kind] ?? "unknown",
    ts: r.ts.toISOString(),
    hourStart: unixSec(r.hourStart),
    payload: r.payload,
    payloadHash: r.payloadHash as Hex,
    payloadHashMatches: payloadHash(r.payload).toLowerCase() === r.payloadHash.toLowerCase(),
    leaf: { encoding: [...RECEIPT_LEAF], values: strs(leafValues), hash: leafHash },
    hourly: {
      root: tree.root,
      storedRoot,
      matchesStored: storedRoot ? storedRoot.toLowerCase() === tree.root.toLowerCase() : null,
      leafCount: tree.count,
      proof,
      verified,
    },
    period,
    roots: { hourly: tree.root, receiptsRoot: (i.mark?.receiptsRoot as Hex | undefined) ?? null, inventoryRoot: (i.mark?.inventoryRoot as Hex | undefined) ?? null },
  };
}
