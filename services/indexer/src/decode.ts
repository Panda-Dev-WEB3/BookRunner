// Tolerant log decoding with the shared (frozen-interface) ABIs. Implementations may emit extra
// events (ERC-20 Transfer, OZ Initialized/Upgraded, implementation-specific events): those fail to
// decode and are reported as skips — the cursor still advances.
import {
  bookAbi,
  bookFactoryAbi,
  mMMandateAbi,
  markRegistryAbi,
  marketCharterAbi,
  revenueRouterAbi,
  riskCommitteeAbi,
  trancheAbi,
} from "@bookrunner/shared/abi";
import { type Abi, type Address, type Hex, decodeEventLog, toEventSelector } from "viem";

export type ContractKind = "charter" | "committee" | "factory" | "markRegistry" | "book" | "senior" | "junior" | "router" | "mandate";
export type ContractGroup = "protocol" | "books";

export const KIND_ABI: Record<ContractKind, Abi> = {
  charter: marketCharterAbi,
  committee: riskCommitteeAbi,
  factory: bookFactoryAbi,
  markRegistry: markRegistryAbi,
  book: bookAbi,
  senior: trancheAbi,
  junior: trancheAbi,
  router: revenueRouterAbi,
  mandate: mMMandateAbi,
};

export const groupOf = (k: ContractKind): ContractGroup =>
  k === "charter" || k === "committee" || k === "factory" || k === "markRegistry" ? "protocol" : "books";

/** Raw log as returned by eth_getLogs (subset of viem's Log). */
export interface RawLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
  blockHash: Hex | null;
  removed?: boolean;
}

export interface DecodedLog {
  kind: ContractKind;
  group: ContractGroup;
  address: Address; // lowercase
  bookId: number | null;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
}

export interface DecodeSkip {
  kind: ContractKind;
  address: Address;
  topic0: Hex | null;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex | null;
  reason: "unknown_event" | "known_extra" | "bad_data" | "pending";
  error?: string;
}

/** Events implementations commonly add on top of the frozen interfaces (logged at debug only). */
export const KNOWN_EXTRA_TOPICS = new Set<Hex>(
  [
    "Transfer(address,address,uint256)",
    "Approval(address,address,uint256)",
    "Initialized(uint64)",
    "Initialized(uint8)",
    "Upgraded(address)",
    "AdminChanged(address,address)",
    "BeaconUpgraded(address)",
    "Paused(address)",
    "Unpaused(address)",
    "OwnershipTransferred(address,address)",
    "RoleGranted(bytes32,address,address)",
    "RoleRevoked(bytes32,address,address)",
  ].map((s) => toEventSelector(s)),
);

export type DecodeResult = { ok: true; log: DecodedLog } | { ok: false; skip: DecodeSkip };

export function decodeLog(raw: RawLog, kind: ContractKind, bookId: number | null): DecodeResult {
  const topic0 = raw.topics[0] ?? null;
  const base = {
    kind,
    address: raw.address.toLowerCase() as Address,
    topic0,
    blockNumber: raw.blockNumber ?? 0n,
    logIndex: raw.logIndex ?? -1,
    txHash: raw.transactionHash,
  };
  if (raw.blockNumber === null || raw.logIndex === null || raw.transactionHash === null) {
    return { ok: false, skip: { ...base, reason: "pending" } };
  }
  if (!topic0) return { ok: false, skip: { ...base, reason: "unknown_event", error: "anonymous log" } };
  try {
    const d = decodeEventLog({ abi: KIND_ABI[kind], data: raw.data, topics: raw.topics as [Hex, ...Hex[]], strict: true });
    const args = (Array.isArray(d.args) ? {} : (d.args ?? {})) as Record<string, unknown>;
    return {
      ok: true,
      log: {
        kind,
        group: groupOf(kind),
        address: base.address,
        bookId,
        eventName: d.eventName ?? "",
        args,
        blockNumber: raw.blockNumber,
        logIndex: raw.logIndex,
        txHash: raw.transactionHash,
      },
    };
  } catch (e) {
    const name = (e as Error).name;
    const unknown = name === "AbiEventSignatureNotFoundError";
    const reason = unknown ? (KNOWN_EXTRA_TOPICS.has(topic0) ? "known_extra" : "unknown_event") : "bad_data";
    return { ok: false, skip: { ...base, reason, error: unknown ? undefined : (e as Error).message.split("\n")[0] } };
  }
}

/** Sort by (blockNumber, logIndex) and drop duplicates (same tx + logIndex). */
export function orderLogs(logs: DecodedLog[]): DecodedLog[] {
  const seen = new Set<string>();
  return [...logs]
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    .filter((l) => {
      const k = `${l.txHash}:${l.logIndex}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
