// In-browser verification of receipts. Nothing here trusts the API's own "verified" flags: every
// check is recomputed locally with the OpenZeppelin StandardMerkleTree format used on-chain.
//   receipt leaf  (kind, bookId, ts, payloadHash)            -> hourly root
//   period leaf   (bookId, hourStart, hourlyRoot, leafCount)  -> mark.receiptsRoot (signed + committed)
import { PERIOD_LEAF, RECEIPT_LEAF, payloadHash, periodTree } from "@bookrunner/shared/merkle";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { type Address, type Hex, decodeEventLog } from "viem";

export interface ProofIn {
  receiptId: number;
  bookId: number;
  kindName: string;
  payload: unknown;
  payloadHash: string;
  leaf: { values: Array<string | number> };
  hourly: { root: string; storedRoot: string | null; proof: string[] };
  period: {
    markId: number;
    receiptsRoot: string;
    leaf: { values: Array<string | number> };
    proof: string[];
  } | null;
}

export type CheckState = "pass" | "fail" | "skip";

export interface ProofCheck {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** OpenZeppelin StandardMerkleTree.verify (double-hashed sorted-pair leaves, as verified on-chain). */
function safeVerify(root: string, encoding: readonly string[], values: Array<string | number>, proof: string[]): boolean {
  try {
    return StandardMerkleTree.verify(root, [...encoding], values, proof);
  } catch {
    return false;
  }
}

/**
 * Checks, in order: payload hash, leaf binding, hourly inclusion, period link, period inclusion and
 * (when the marks table is loaded) that the root is the one committed by that mark.
 */
export function verifyReceiptProof(p: ProofIn, committedRoot?: string | null): ProofCheck[] {
  const checks: ProofCheck[] = [];
  let recomputed: string | null = null;
  try {
    recomputed = payloadHash(p.payload);
  } catch {
    recomputed = null;
  }
  checks.push({
    id: "payload",
    label: "Payload hash",
    state: recomputed && eq(recomputed, p.payloadHash) ? "pass" : "fail",
    detail: recomputed ? `keccak256(canonical JSON) = ${recomputed}` : "payload could not be hashed",
  });

  const [kind, bookId, , leafHash] = p.leaf.values;
  const bound = eq(leafHash, p.payloadHash) && eq(bookId, p.bookId) && kind !== undefined;
  checks.push({
    id: "leaf",
    label: "Leaf binds payload",
    state: bound ? "pass" : "fail",
    detail: `leaf = (kind ${kind ?? "?"}, book ${bookId ?? "?"}, ts ${p.leaf.values[2] ?? "?"}, payloadHash)`,
  });

  const hourRoot = p.hourly.storedRoot ?? p.hourly.root;
  const inHour = safeVerify(hourRoot, RECEIPT_LEAF, p.leaf.values, p.hourly.proof);
  checks.push({
    id: "hourly",
    label: "Included in hourly root",
    state: inHour ? "pass" : "fail",
    detail: `${p.hourly.proof.length} sibling hash(es) against ${p.hourly.storedRoot ? "the stored" : "the recomputed"} root ${hourRoot}`,
  });

  if (!p.period) {
    checks.push({ id: "link", label: "Hour linked to a mark", state: "skip", detail: "No mark covers this hour yet; it is committed by the next mark" });
    return checks;
  }
  const [pBook, , pRoot] = p.period.leaf.values;
  const linked = eq(pRoot, hourRoot) && eq(pBook, p.bookId);
  checks.push({
    id: "link",
    label: "Hour linked to the mark period",
    state: linked ? "pass" : "fail",
    detail: `period leaf carries hourly root ${String(pRoot ?? "?")}`,
  });
  const inPeriod = safeVerify(p.period.receiptsRoot, PERIOD_LEAF, p.period.leaf.values, p.period.proof);
  checks.push({
    id: "period",
    label: `Included in mark #${p.period.markId} receipts root`,
    state: inPeriod ? "pass" : "fail",
    detail: `${p.period.proof.length} sibling hash(es) against ${p.period.receiptsRoot}`,
  });
  if (committedRoot !== undefined) {
    checks.push({
      id: "committed",
      label: "Root matches the committed mark",
      state: committedRoot == null ? "skip" : eq(committedRoot, p.period.receiptsRoot) ? "pass" : "fail",
      detail: committedRoot == null ? "Mark not in the loaded marks table" : `marks table: ${committedRoot}`,
    });
  }
  return checks;
}

export const allPass = (checks: ProofCheck[]) => checks.length > 0 && checks.every((c) => c.state !== "fail") && checks.some((c) => c.state === "pass");

/** MarkRegistry.MarkCommitted (IMarkRegistry), for reading the committed roots straight from the chain. */
export const MARK_COMMITTED_ABI = [
  {
    type: "event",
    name: "MarkCommitted",
    inputs: [
      { name: "markId", type: "uint256", indexed: true },
      { name: "bookId", type: "uint256", indexed: true },
      { name: "periodEnd", type: "uint64", indexed: false },
      { name: "navUsd", type: "uint256", indexed: false },
      { name: "deployedValueUsd", type: "uint256", indexed: false },
      { name: "inventoryRoot", type: "bytes32", indexed: false },
      { name: "pnlJsonHash", type: "bytes32", indexed: false },
      { name: "receiptsRoot", type: "bytes32", indexed: false },
      { name: "signer", type: "address", indexed: false },
    ],
    anonymous: false,
  },
] as const;

export interface OnChainMark {
  markId: bigint;
  bookId: bigint;
  periodEnd: bigint;
  navUsd: bigint;
  receiptsRoot: Hex;
  inventoryRoot: Hex;
  pnlJsonHash: Hex;
  signer: Address;
  registry: Address;
}

/** The MarkCommitted event for `markId` among a transaction receipt's logs (null when absent). */
export function markCommittedFromLogs(logs: ReadonlyArray<{ address: Address; topics: readonly Hex[]; data: Hex }>, markId: number | bigint): OnChainMark | null {
  for (const l of logs) {
    const [sig, ...rest] = l.topics;
    if (!sig) continue;
    try {
      const ev = decodeEventLog({ abi: MARK_COMMITTED_ABI, data: l.data, topics: [sig, ...rest] });
      if (ev.args.markId !== BigInt(markId)) continue;
      const a = ev.args;
      return {
        markId: a.markId,
        bookId: a.bookId,
        periodEnd: a.periodEnd,
        navUsd: a.navUsd,
        receiptsRoot: a.receiptsRoot,
        inventoryRoot: a.inventoryRoot,
        pnlJsonHash: a.pnlJsonHash,
        signer: a.signer,
        registry: l.address,
      };
    } catch {
      // another contract's event in the same transaction
    }
  }
  return null;
}

export interface HourIn {
  hourStart: number;
  root: string;
  leafCount: number;
}

/** Rebuilds a mark's receipts root from its hourly roots. Empty period -> zero hash. */
export function recomputeReceiptsRoot(bookId: number, hours: HourIn[]): Hex {
  return periodTree(hours.map((h) => ({ bookId: BigInt(bookId), hourStart: BigInt(h.hourStart), root: h.root as Hex, leafCount: h.leafCount }))).root;
}
