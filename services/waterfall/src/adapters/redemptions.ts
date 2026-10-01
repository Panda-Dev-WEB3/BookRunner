// Pending redemption discovery. Candidates (tranche, bucket, controller) come from the tranches'
// RedeemRequest logs (incremental scan) plus the indexer's `redemptions` table; the amounts are always
// read on-chain via tranche.pendingRedeemRequest(bucket, controller).
import { type Logger, TRANCHE } from "@bookrunner/shared";
import { trancheAbi } from "@bookrunner/shared/abi";
import type { Address, PublicClient } from "viem";
import type { BookRef } from "../kit/books";
import { scanEvents } from "../kit/logs";

export interface RedeemCandidate {
  kind: 0 | 1; // TRANCHE
  requestId: bigint;
  controller: Address;
}

export interface CandidateSource {
  candidates(ref: BookRef, afterIndex: bigint, upToIndex: bigint): Promise<RedeemCandidate[]>;
}

const key = (c: RedeemCandidate) => `${c.kind}:${c.requestId}:${c.controller.toLowerCase()}`;

/** Incremental RedeemRequest log index per tranche. */
export class RedeemLogIndex implements CandidateSource {
  private scanned = new Map<Address, bigint>();
  private entries = new Map<Address, Map<string, RedeemCandidate>>();

  constructor(
    private readonly pc: PublicClient,
    private readonly startBlock: bigint,
    private readonly chunk: bigint,
    private readonly log: Logger,
  ) {}

  async candidates(ref: BookRef, afterIndex: bigint, upToIndex: bigint): Promise<RedeemCandidate[]> {
    const head = await this.pc.getBlockNumber();
    const out: RedeemCandidate[] = [];
    for (const [kind, tranche] of [
      [TRANCHE.SENIOR, ref.components.senior],
      [TRANCHE.JUNIOR, ref.components.junior],
    ] as const) {
      const from = (this.scanned.get(tranche) ?? this.startBlock - 1n) + 1n;
      let map = this.entries.get(tranche);
      if (!map) {
        map = new Map();
        this.entries.set(tranche, map);
      }
      if (from <= head) {
        const logs = await scanEvents<{ controller: Address; requestId: bigint }>(this.pc, {
          address: tranche,
          abi: trancheAbi,
          eventName: "RedeemRequest",
          fromBlock: from,
          toBlock: head,
          chunk: this.chunk,
        });
        for (const l of logs) {
          const c: RedeemCandidate = { kind, requestId: l.args.requestId, controller: l.args.controller };
          map.set(key(c), c);
        }
        if (logs.length) this.log.debug({ bookId: ref.bookId, kind, found: logs.length }, "redeem requests indexed");
        this.scanned.set(tranche, head);
      }
      for (const [k, c] of map) {
        if (c.requestId <= afterIndex) map.delete(k); // settled at an earlier mark
        else if (c.requestId <= upToIndex) out.push(c);
      }
    }
    return out;
  }
}

/** Union of several candidate sources (a failing source is logged and skipped). */
export class UnionCandidates implements CandidateSource {
  constructor(
    private readonly sources: CandidateSource[],
    private readonly log: Logger,
  ) {}

  async candidates(ref: BookRef, afterIndex: bigint, upToIndex: bigint): Promise<RedeemCandidate[]> {
    const all = new Map<string, RedeemCandidate>();
    for (const s of this.sources) {
      try {
        for (const c of await s.candidates(ref, afterIndex, upToIndex)) all.set(key(c), c);
      } catch (err) {
        this.log.debug({ err: err instanceof Error ? err.message : String(err) }, "redemption candidate source failed");
      }
    }
    return [...all.values()];
  }
}

/** Sums on-chain pending shares per tranche for the candidates. */
export async function pendingShares(pc: PublicClient, ref: BookRef, cands: RedeemCandidate[]): Promise<{ senior: bigint; junior: bigint }> {
  const res = await Promise.all(
    cands.map((c) =>
      pc.readContract({
        address: c.kind === TRANCHE.SENIOR ? ref.components.senior : ref.components.junior,
        abi: trancheAbi,
        functionName: "pendingRedeemRequest",
        args: [c.requestId, c.controller],
      }),
    ),
  );
  let senior = 0n;
  let junior = 0n;
  cands.forEach((c, i) => {
    const v = res[i] ?? 0n;
    if (c.kind === TRANCHE.SENIOR) senior += v;
    else junior += v;
  });
  return { senior, junior };
}
