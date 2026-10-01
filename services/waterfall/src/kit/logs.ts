// Chunked event-log scanning (RPC providers cap eth_getLogs block ranges).
import type { Abi, Address, PublicClient } from "viem";

export interface ScanRange {
  fromBlock: bigint;
  toBlock: bigint;
  chunk: bigint;
}

export function scanRanges({ fromBlock, toBlock, chunk }: ScanRange): Array<[bigint, bigint]> {
  if (chunk <= 0n) throw new Error("chunk must be positive");
  const out: Array<[bigint, bigint]> = [];
  for (let a = fromBlock; a <= toBlock; a += chunk) {
    const b = a + chunk - 1n < toBlock ? a + chunk - 1n : toBlock;
    out.push([a, b]);
  }
  return out;
}

export interface DecodedLog<A = Record<string, unknown>> {
  args: A;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
  address: Address;
}

/** getContractEvents over [fromBlock, toBlock] in chunks; newest-last. */
export async function scanEvents<A = Record<string, unknown>>(
  pc: PublicClient,
  q: { address: Address | Address[]; abi: Abi; eventName: string; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint; chunk?: bigint },
): Promise<Array<DecodedLog<A>>> {
  const out: Array<DecodedLog<A>> = [];
  if (q.toBlock < q.fromBlock) return out;
  for (const [a, b] of scanRanges({ fromBlock: q.fromBlock, toBlock: q.toBlock, chunk: q.chunk ?? 10_000n })) {
    const logs = await pc.getContractEvents({
      address: q.address,
      abi: q.abi,
      eventName: q.eventName,
      ...(q.args ? { args: q.args } : {}),
      fromBlock: a,
      toBlock: b,
      strict: true,
    } as Parameters<PublicClient["getContractEvents"]>[0]);
    for (const l of logs as unknown as Array<{ args: A; blockNumber: bigint; transactionHash: `0x${string}`; logIndex: number; address: Address }>) {
      out.push({ args: l.args, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex, address: l.address });
    }
  }
  return out;
}
