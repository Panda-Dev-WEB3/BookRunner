// Receipts, inventory and hedge-allow Merkle trees. OpenZeppelin StandardMerkleTree format
// (double-hashed, sorted leaves) so proofs verify on-chain with OZ MerkleProof:
//   leaf = keccak256(bytes.concat(keccak256(abi.encode(...values))))
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { type Hex, keccak256, stringToHex, zeroHash } from "viem";

export const RECEIPT_KIND = { QUOTE: 0, FILL: 1, HEDGE: 2, DECISION: 3 } as const;
export type ReceiptKind = (typeof RECEIPT_KIND)[keyof typeof RECEIPT_KIND];

/** (kind, bookId, ts, payloadHash) */
export const RECEIPT_LEAF = ["uint8", "uint256", "uint64", "bytes32"] as const;
/** (bookId, hourStart, hourlyRoot, leafCount) — leaves of a mark's receiptsRoot */
export const PERIOD_LEAF = ["uint256", "uint64", "bytes32", "uint32"] as const;
/** (location, asset, amount, valueUsd) — leaves of a mark's inventoryRoot */
export const INVENTORY_LEAF = ["bytes32", "bytes32", "int256", "uint256"] as const;
/** (asset, venue) — leaves of Mandate.hedgeAllowRoot */
export const HEDGE_ALLOW_LEAF = ["bytes32", "bytes32"] as const;

/** Canonical JSON: sorted keys, bigint as decimal string, no whitespace. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortValue(v));
}

function sortValue(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortValue((v as Record<string, unknown>)[k])]),
    );
  }
  if (v instanceof Date) return v.toISOString();
  return v;
}

export const payloadHash = (payload: unknown): Hex => keccak256(stringToHex(canonicalJson(payload)));

type LeafValue = string | bigint | number;

export interface BuiltTree {
  root: Hex;
  count: number;
  tree: StandardMerkleTree<(string | number)[]> | null;
}

function build(values: LeafValue[][], encoding: readonly string[]): BuiltTree {
  if (values.length === 0) return { root: zeroHash, count: 0, tree: null };
  const norm = values.map((row) => row.map((x) => (typeof x === "bigint" ? x.toString() : x)));
  const tree = StandardMerkleTree.of(norm, [...encoding]);
  return { root: tree.root as Hex, count: values.length, tree };
}

export interface ReceiptLeafInput {
  kind: ReceiptKind;
  bookId: bigint;
  ts: bigint; // unix seconds
  payload: unknown;
}

export function receiptsTree(leaves: ReceiptLeafInput[]): BuiltTree {
  return build(
    leaves.map((l) => [l.kind, l.bookId, l.ts, payloadHash(l.payload)]),
    RECEIPT_LEAF,
  );
}

export function periodTree(hourly: Array<{ bookId: bigint; hourStart: bigint; root: Hex; leafCount: number }>): BuiltTree {
  return build(
    hourly.map((h) => [h.bookId, h.hourStart, h.root, h.leafCount]),
    PERIOD_LEAF,
  );
}

export function inventoryTree(items: Array<{ location: Hex; asset: Hex; amount: bigint; valueUsd: bigint }>): BuiltTree {
  return build(
    items.map((i) => [i.location, i.asset, i.amount, i.valueUsd]),
    INVENTORY_LEAF,
  );
}

export function hedgeAllowTree(pairs: Array<{ asset: Hex; venue: Hex }>): BuiltTree {
  return build(
    pairs.map((p) => [p.asset, p.venue]),
    HEDGE_ALLOW_LEAF,
  );
}

/** Proof for the row equal to `values` (after bigint normalisation). */
export function proofFor(t: BuiltTree, values: LeafValue[]): Hex[] {
  if (!t.tree) return [];
  const want = JSON.stringify(values.map((x) => (typeof x === "bigint" ? x.toString() : String(x))).map((x) => x.toLowerCase()));
  for (const [i, v] of t.tree.entries()) {
    if (JSON.stringify(v.map((x) => String(x).toLowerCase())) === want) return t.tree.getProof(i) as Hex[];
  }
  throw new Error("proofFor: leaf not in tree");
}

export function verifyProof(root: Hex, encoding: readonly string[], values: LeafValue[], proof: Hex[]): boolean {
  const norm = values.map((x) => (typeof x === "bigint" ? x.toString() : x));
  return StandardMerkleTree.verify(root, [...encoding], norm, proof);
}
