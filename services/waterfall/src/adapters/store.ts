// Postgres adapters: settlements (distribution + settlement receipts), redemption candidates from the
// indexer's table.
import { type Db, redemptions, settlements } from "@bookrunner/db";
import { REVENUE_SOURCE, dbUsd } from "@bookrunner/shared";
import { and, eq, isNull } from "drizzle-orm";
import { type Address, getAddress, isAddress } from "viem";
import type { BookRef } from "../kit/books";
import type { DistributedLog, SettlementReceivedLog, SettlementStore, StoredDistribution } from "../ports";
import type { CandidateSource, RedeemCandidate } from "./redemptions";

export const SOURCE_LABEL: Record<number, string> = {
  [REVENUE_SOURCE.VENUE_TAKER_SHARE]: "venue_taker_share",
  [REVENUE_SOURCE.ENGINE_FEES]: "engine_fees",
  [REVENUE_SOURCE.FUNDING]: "funding",
  [REVENUE_SOURCE.LIQUIDATION]: "liquidation",
  [REVENUE_SOURCE.OTHER]: "other",
};

export const DISTRIBUTION_SOURCE = "distribution";

/** Settlement row of a Distributed event (pure; also used by tests). */
export function distributionRow(d: DistributedLog) {
  return {
    bookId: d.bookId,
    ts: d.ts,
    source: DISTRIBUTION_SOURCE,
    grossUsd: dbUsd.toDb(d.amounts.gross),
    expensesUsd: dbUsd.toDb(d.amounts.expenses),
    carryUsd: dbUsd.toDb(d.amounts.carry),
    seniorUsd: dbUsd.toDb(d.amounts.senior),
    juniorUsd: dbUsd.toDb(d.amounts.junior),
    period: d.period,
    txHash: d.txHash,
    logIndex: d.logIndex,
  };
}

export class PgSettlementStore implements SettlementStore {
  constructor(private readonly db: Db) {}

  async distributionFor(bookId: number, period: number): Promise<StoredDistribution | null> {
    const [row] = await this.db
      .select()
      .from(settlements)
      .where(and(eq(settlements.bookId, bookId), eq(settlements.source, DISTRIBUTION_SOURCE), eq(settlements.period, period)))
      .limit(1);
    if (!row) return null;
    return {
      txHash: row.txHash,
      amounts: {
        gross: dbUsd.fromDb(row.grossUsd),
        expenses: dbUsd.fromDb(row.expensesUsd),
        carry: dbUsd.fromDb(row.carryUsd),
        senior: dbUsd.fromDb(row.seniorUsd),
        junior: dbUsd.fromDb(row.juniorUsd),
      },
    };
  }

  async insertDistribution(d: DistributedLog): Promise<void> {
    await this.db.insert(settlements).values(distributionRow(d)).onConflictDoNothing({ target: [settlements.txHash, settlements.logIndex] });
  }

  async insertReceived(bookId: number, period: number, logs: SettlementReceivedLog[]): Promise<void> {
    if (!logs.length) return;
    await this.db
      .insert(settlements)
      .values(
        logs.map((l) => ({
          bookId,
          ts: l.ts,
          source: SOURCE_LABEL[l.source] ?? "other",
          grossUsd: dbUsd.toDb(l.amount),
          period,
          txHash: l.txHash,
          logIndex: l.logIndex,
        })),
      )
      .onConflictDoNothing({ target: [settlements.txHash, settlements.logIndex] });
  }
}

/** Redemption candidates from the indexer's `redemptions` table (not yet honoured). */
export class DbRedeemCandidates implements CandidateSource {
  constructor(private readonly db: Db) {}

  async candidates(ref: BookRef, afterIndex: bigint, upToIndex: bigint): Promise<RedeemCandidate[]> {
    const rows = await this.db
      .select({ tranche: redemptions.tranche, wallet: redemptions.wallet, requestId: redemptions.requestId })
      .from(redemptions)
      .where(and(eq(redemptions.bookId, ref.bookId), isNull(redemptions.honouredMarkId)));
    const out: RedeemCandidate[] = [];
    for (const r of rows) {
      if (!/^\d+$/.test(r.requestId) || !isAddress(r.wallet)) continue;
      const id = BigInt(r.requestId);
      if (id <= afterIndex || id > upToIndex) continue;
      out.push({ kind: r.tranche === "junior" ? 1 : 0, requestId: id, controller: getAddress(r.wallet) as Address });
    }
    return out;
  }
}
