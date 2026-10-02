// Committee upkeep: mirror RiskCommittee seats/bonds into the committee table, notify members as
// the 48h committee window runs down (committee.deadline_approaching / committee.window_elapsed),
// and sweep Filed charters with the permissionless RiskCommittee.tryFinalize (covers a verdict
// posted after enough approvals, and approvals deferred while newBooksPaused).
// Votes are indexed from RiskCommittee.Voted by the indexer.
import type { Logger } from "@bookrunner/shared";
import { type Address, zeroAddress } from "viem";
import type { EventBus } from "../adapters/events";

export interface CommitteeChain {
  committee(): Promise<{ members: Address[]; bonded: boolean[]; committeeBondBkrn: bigint; committeeWindowSec: number }>;
  /** Simulates tryFinalize and sends it only when it would decide the charter. */
  tryFinalize?(charterId: number): Promise<{ finalized: boolean; tx: string | null }>;
}

export interface CommitteeStore {
  upsertSeat(member: string, seat: number, bond: bigint | null): Promise<void>;
  unseatAllExcept(members: string[]): Promise<void>;
  filedCharters(): Promise<Array<{ id: number; filedAt: Date }>>;
}

export interface DeadlineNotice {
  charterId: number;
  kind: "deadline_approaching" | "window_elapsed";
  deadline: Date;
  remainingSec: number;
}

/** Pure: which filed charters need a deadline notification now. */
export function deadlineNotices(filed: Array<{ id: number; filedAt: Date }>, windowSec: number, warnSec: number, now: Date): DeadlineNotice[] {
  if (windowSec <= 0) return [];
  const out: DeadlineNotice[] = [];
  for (const f of filed) {
    const deadline = new Date(f.filedAt.getTime() + windowSec * 1000);
    const remainingSec = Math.floor((deadline.getTime() - now.getTime()) / 1000);
    if (remainingSec <= 0) out.push({ charterId: f.id, kind: "window_elapsed", deadline, remainingSec });
    else if (remainingSec <= warnSec) out.push({ charterId: f.id, kind: "deadline_approaching", deadline, remainingSec });
  }
  return out;
}

export async function syncCommittee(p: {
  chain: CommitteeChain;
  store: CommitteeStore;
  bus: EventBus;
  warnSec: number;
  now: Date;
  logger: Logger;
}): Promise<{ seated: number; notices: number; finalized: number[] }> {
  const c = await p.chain.committee();
  const seated: string[] = [];
  for (const [i, member] of c.members.entries()) {
    if (member === zeroAddress) continue;
    seated.push(member);
    await p.store.upsertSeat(member, i, c.bonded[i] ? c.committeeBondBkrn : 0n);
  }
  await p.store.unseatAllExcept(seated);

  const filed = await p.store.filedCharters();
  const finalized: number[] = [];
  if (p.chain.tryFinalize) {
    for (const f of filed) {
      try {
        const r = await p.chain.tryFinalize(f.id);
        if (r.finalized) {
          finalized.push(f.id);
          p.logger.info({ charterId: f.id, tx: r.tx }, "charter decided by the committee upkeep (tryFinalize)");
        }
      } catch (err) {
        p.logger.warn({ charterId: f.id, err: (err as Error).message }, "tryFinalize failed; retrying next sync");
      }
    }
  }

  const notices = deadlineNotices(filed.filter((f) => !finalized.includes(f.id)), c.committeeWindowSec, p.warnSec, p.now);
  let sent = 0;
  for (const n of notices) {
    const fresh = await p.bus.emit({
      type: `committee.${n.kind}`,
      bookId: n.charterId,
      dedupeKey: `committee.${n.kind}:${n.charterId}`,
      payload: {
        charterId: n.charterId,
        deadline: n.deadline.toISOString(),
        remainingSeconds: Math.max(n.remainingSec, 0),
        members: seated.map((m) => m.toLowerCase()),
      },
    });
    if (fresh) sent++;
  }
  if (sent) p.logger.info({ sent }, "committee notices emitted");
  return { seated: seated.length, notices: sent, finalized };
}
