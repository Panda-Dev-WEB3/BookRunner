import { describe, expect, test } from "bun:test";
import { fmtUntil, markLabel, pctLabel, settlementText, shares } from "../src/components/portfolio/display";
import {
  type TrancheLog,
  activityFromLogs,
  activityFromRedemptions,
  bookHolding,
  depositSettlement,
  markTimes,
  portfolioTotals,
  redemptionStage,
  redemptionStatus,
  sharesValue,
  splitFractions,
  stakingView,
  trancheIndex,
} from "../src/components/portfolio/model";
import type { PositionOut } from "../src/lib/api-types";

type T = PositionOut["tranches"][number];
type R = T["redemptions"][number];

const SENIOR = "0x00000000000000000000000000000000000000a1";
const JUNIOR = "0x00000000000000000000000000000000000000b2";

function tranche(over: Partial<T> & Pick<T, "tranche">): T {
  return {
    address: over.tranche === "senior" ? SENIOR : JUNIOR,
    shares: "0.000000",
    sharePrice: "1.000000000000000000",
    navValueUsd: "0.000000",
    committedUsd: "0.000000",
    depositsOpen: true,
    claimableAllocation: { shares: "0.000000", refundUsd: "0.000000" },
    claimableRedemptionUsd: "0.000000",
    redemptions: [],
    notice: "",
    ...over,
  };
}

function redemption(over: Partial<R>): R {
  return {
    requestId: "497490",
    shares: "100.000000",
    requestedAt: "2026-10-02T17:05:00.000Z",
    eligibleAt: "2026-10-02T17:05:00.000Z",
    settlesAtPeriodEnd: "2026-10-02T18:00:00.000Z",
    honouredMarkId: null,
    assetsUsd: null,
    status: "pending",
    requestTx: "0xabc",
    ...over,
  };
}

function position(bookId: number, tranches: T[], source: "chain" | "db" = "chain"): PositionOut {
  return { bookId, wallet: "0x00000000000000000000000000000000000000c3", tranches, totals: { navValueUsd: null, claimableRedemptionUsd: null }, source };
}

describe("bookHolding", () => {
  test("held shares, value and a deposit still waiting for its mark", () => {
    const h = bookHolding(
      position(1, [
        tranche({ tranche: "junior", shares: "50.000000", navValueUsd: "51.000000", sharePrice: "1.02" }),
        tranche({ tranche: "senior", shares: "1000.000000", navValueUsd: "1000.258004", committedUsd: "250.000000" }),
      ]),
    );
    expect(h.tranches.map((t) => t.tranche)).toEqual(["senior", "junior"]);
    expect(h.value).toBe(1_051_258_004n);
    expect(h.pendingDeposit).toBe(250_000_000n);
    expect(h.holdsShares).toBe(true);
    expect(h.canClaim).toBe(false);
    expect(h.hasPosition).toBe(true);
    expect(h.tranches[1]?.sharePriceWad).toBe(1_020_000_000_000_000_000n);
  });

  test("a settled round is claimable, not pending", () => {
    const h = bookHolding(
      position(2, [
        tranche({ tranche: "senior", committedUsd: "300.000000", claimableAllocation: { shares: "290.000000", refundUsd: "10.000000" } }),
        tranche({ tranche: "junior", claimableRedemptionUsd: "40.500000" }),
      ]),
    );
    expect(h.pendingDeposit).toBe(0n);
    expect(h.claimableShares).toBe(290_000_000n);
    expect(h.claimableUsd).toBe(50_500_000n);
    expect(h.canClaim).toBe(true);
    expect(h.hasPosition).toBe(true);
    expect(h.holdsShares).toBe(false);
  });

  test("queued shares count pending requests only", () => {
    const h = bookHolding(
      position(3, [
        tranche({
          tranche: "junior",
          shares: "10.000000",
          navValueUsd: "10.000000",
          redemptions: [redemption({ shares: "5.000000" }), redemption({ shares: "7.000000", status: "claimable" }), redemption({ shares: "1.000000", status: "claimed" })],
        }),
        tranche({ tranche: "senior" }),
      ]),
    );
    expect(h.queuedShares).toBe(5_000_000n);
    expect(h.tranches[0]?.redemptions.map((r) => r.status)).toEqual([]);
    expect(h.tranches[1]?.redemptions.map((r) => r.status)).toEqual(["pending", "claimable", "claimed"]);
  });

  test("an empty wallet has no position", () => {
    const h = bookHolding(position(1, [tranche({ tranche: "senior" }), tranche({ tranche: "junior" })]));
    expect(h.hasPosition).toBe(false);
    expect(h.value).toBe(0n);
  });

  test("indexed-only data: unknown value, redemptions still shown", () => {
    const blank = { shares: null, navValueUsd: null, committedUsd: null, depositsOpen: null, claimableAllocation: null, claimableRedemptionUsd: null };
    const h = bookHolding(position(1, [tranche({ tranche: "senior", ...blank, redemptions: [redemption({})] }), tranche({ tranche: "junior", ...blank })], "db"));
    expect(h.source).toBe("db");
    expect(h.value).toBeNull();
    expect(h.tranches[0]?.shares).toBeNull();
    expect(h.hasPosition).toBe(true);
    expect(h.canClaim).toBe(false);
  });

  test("unknown statuses are treated as pending", () => {
    expect(redemptionStatus("claimable")).toBe("claimable");
    expect(redemptionStatus("weird")).toBe("pending");
  });
});

describe("portfolioTotals", () => {
  const a = bookHolding(
    position(1, [
      tranche({ tranche: "senior", shares: "100.000000", navValueUsd: "100.000000", claimableAllocation: { shares: "10.000000", refundUsd: "1.000000" } }),
      tranche({ tranche: "junior", shares: "20.000000", navValueUsd: "25.000000", sharePrice: "1.25", redemptions: [redemption({ shares: "4.000000" })] }),
    ]),
  );
  const b = bookHolding(position(2, [tranche({ tranche: "senior", committedUsd: "500.000000" }), tranche({ tranche: "junior" })]));

  test("sums across books", () => {
    const t = portfolioTotals([a, b]);
    // senior: 100 held + 10 allocated shares waiting in escrow, at 1.0
    expect(t.value).toBe(135_000_000n);
    expect(t.senior).toBe(110_000_000n);
    expect(t.junior).toBe(25_000_000n);
    expect(t.pendingDeposit).toBe(500_000_000n);
    expect(t.claimableUsd).toBe(1_000_000n);
    expect(t.claimableShares).toBe(10_000_000n);
    expect(t.claimableSharesValue).toBe(10_000_000n);
    expect(t.queuedShares).toBe(4_000_000n);
    expect(t.queuedSharesValue).toBe(5_000_000n);
    expect(t.booksWithPosition).toBe(2);
    expect(t.booksClaimable).toBe(1);
    expect(t.partial).toBe(false);
  });

  test("an unreadable tranche is left out and flagged", () => {
    const c = bookHolding(position(3, [tranche({ tranche: "senior", shares: null, navValueUsd: null }), tranche({ tranche: "junior" })], "db"));
    expect(c.value).toBeNull();
    const t = portfolioTotals([a, c]);
    expect(t.value).toBe(135_000_000n);
    expect(t.partial).toBe(true);
    expect(portfolioTotals([a]).partial).toBe(false);
    expect(portfolioTotals([]).value).toBe(0n);
  });

  test("allocated shares waiting in escrow count in the value", () => {
    const h = bookHolding(
      position(5, [
        tranche({ tranche: "senior" }),
        tranche({ tranche: "junior", sharePrice: "1.017791247841269841", claimableAllocation: { shares: "12600.000000", refundUsd: "0.000000" } }),
      ]),
    );
    const j = h.tranches[1];
    expect(j?.heldValue).toBe(0n);
    expect(j?.claimableSharesValue).toBe(12_824_169_722n);
    expect(j?.value).toBe(12_824_169_722n);
    expect(h.holdsShares).toBe(false);
    expect(h.canClaim).toBe(true);
    expect(portfolioTotals([h])).toMatchObject({ value: 12_824_169_722n, junior: 12_824_169_722n, claimableSharesValue: 12_824_169_722n });
  });

  test("share value floors like the tranche contract", () => {
    expect(sharesValue(3n, 333_333_333_333_333_333n)).toBe(0n);
    expect(sharesValue(1_000_000n, 1_017_791_247_841_000_000n)).toBe(1_017_791n);
    expect(sharesValue(1n, null)).toBeNull();
  });
});

describe("split, marks and settlement", () => {
  test("splitFractions", () => {
    expect(splitFractions(0n, 0n)).toEqual({ senior: 0, junior: 0 });
    expect(splitFractions(3n, 1n)).toEqual({ senior: 0.75, junior: 0.25 });
    expect(splitFractions(0n, 5n)).toEqual({ senior: 0, junior: 1 });
  });

  const mark = (periodEnd: number) => ({ markId: 1, periodEnd, periodEndAt: "", navUsd: "0", committedAt: "" });

  test("markTimes over the books held", () => {
    const books = [
      { bookId: 1, lastMark: mark(1_790_960_400) },
      { bookId: 2, lastMark: mark(1_790_956_800) },
      { bookId: 3, lastMark: null },
    ];
    expect(markTimes(books, [1])).toEqual({ newest: 1_790_960_400, oldest: 1_790_960_400, same: true, unmarked: [] });
    expect(markTimes(books, [1, 2, 3])).toEqual({ newest: 1_790_960_400, oldest: 1_790_956_800, same: false, unmarked: [3] });
    expect(markTimes(books, [])).toEqual({ newest: null, oldest: null, same: true, unmarked: [] });
  });

  const schedule = { intervalSeconds: 3600, cadence: "hourly", lastPeriodEnd: 1_790_960_400, nextPeriodEnd: 1_790_964_000, nextPeriodEndAt: "", status: "scheduled" as const, secondsUntil: 10 };
  const round = { bookId: 1, open: true, endsAt: 1_793_491_200, seniorCapacityUsd: 1n, juniorCapacityUsd: 1n };

  test("depositSettlement", () => {
    const live = { state: "Live", subscriptionEnds: "2026-10-02T13:41:32.000Z", markSchedule: schedule };
    expect(depositSettlement(live, round, 1_790_960_000)).toEqual({ kind: "round", endsAt: 1_793_491_200 });
    expect(depositSettlement(live, round, 1_793_491_200)).toEqual({ kind: "nextMark", at: 1_790_964_000 });
    expect(depositSettlement(live, undefined, 0)).toEqual({ kind: "nextMark", at: 1_790_964_000 });
    expect(depositSettlement({ ...live, state: "Subscription" }, round, 0)).toEqual({ kind: "window", at: 1_790_948_492 });
  });

  test("settlementText", () => {
    expect(settlementText({ kind: "round", endsAt: 1_793_491_200 }, "UTC")).toBe("Accepted at the first mark after the top-up round ends, 1 Nov 2026, 00:00 UTC, at that mark's share price.");
    expect(settlementText({ kind: "window", at: null })).toBe("Allocated when the subscription window closes.");
    expect(settlementText({ kind: "nextMark", at: 1_790_964_000 }, "UTC")).toBe("The round has ended: accepted at the next mark, 2 Oct 2026, 18:00 UTC.");
  });

  test("redemptionStage", () => {
    const now = Date.parse("2026-10-02T17:30:00.000Z");
    expect(redemptionStage({ status: "pending", eligibleAt: "2026-10-09T17:05:00.000Z" }, now)).toBe("notice");
    expect(redemptionStage({ status: "pending", eligibleAt: "2026-10-02T17:05:00.000Z" }, now)).toBe("queued");
    expect(redemptionStage({ status: "claimable", eligibleAt: "2026-10-09T17:05:00.000Z" }, now)).toBe("claimable");
  });
});

describe("activity", () => {
  const index = trancheIndex([{ bookId: 7, senior: SENIOR.toUpperCase().replace("0X", "0x"), junior: JUNIOR }]);
  const log = (eventName: string, args: Record<string, unknown>, blockNumber: bigint, logIndex: number, address = SENIOR): TrancheLog => ({
    address,
    eventName,
    args,
    transactionHash: `0xtx${blockNumber}${logIndex}`,
    blockNumber,
    logIndex,
  });

  test("decodes, filters and sorts newest first", () => {
    const items = activityFromLogs(
      [
        log("Committed", { assets: 500_000_000n }, 10n, 1),
        log("AllocationClaimed", { shares: 490_000_000n, refund: 10_000_000n }, 20n, 0),
        log("AllocationClaimed", { shares: 0n, refund: 3_000_000n }, 20n, 4, JUNIOR),
        log("AllocationClaimed", { shares: 0n, refund: 0n }, 21n, 0),
        log("RedeemRequest", { shares: 100_000_000n }, 30n, 2, JUNIOR),
        log("RedemptionClaimed", { assets: 101_000_000n }, 40n, 0, JUNIOR),
        log("Committed", { assets: 1n }, 50n, 0, "0x00000000000000000000000000000000000000ff"),
        log("Paused", {}, 60n, 0),
      ],
      index,
    );
    expect(items.map((i) => i.kind)).toEqual(["redemptionClaim", "redeemRequest", "refund", "allocation", "deposit"]);
    expect(items[0]).toMatchObject({ bookId: 7, tranche: "junior", amount: 101_000_000n, unit: "USDC" });
    expect(items[3]).toMatchObject({ tranche: "senior", amount: 490_000_000n, unit: "shares", refund: 10_000_000n });
    expect(items[2]).toMatchObject({ amount: 3_000_000n, unit: "USDC" });
  });

  test("de-duplicates and limits", () => {
    const l = log("Committed", { assets: 5n }, 1n, 0);
    expect(activityFromLogs([l, l], index)).toHaveLength(1);
    const many = Array.from({ length: 30 }, (_, i) => log("Committed", { assets: 1n }, BigInt(i + 1), 0));
    const top = activityFromLogs(many, index, 5);
    expect(top).toHaveLength(5);
    expect(top[0]?.blockNumber).toBe(30n);
  });

  test("falls back to the API's redemption requests", () => {
    const h = bookHolding(
      position(4, [
        tranche({ tranche: "senior", redemptions: [redemption({ requestedAt: "2026-10-01T10:00:00.000Z" }), redemption({ requestedAt: "2026-10-02T10:00:00.000Z", requestTx: "0xdef" })] }),
        tranche({ tranche: "junior" }),
      ]),
    );
    const items = activityFromRedemptions([h]);
    expect(items).toHaveLength(2);
    expect(items[0]?.timestamp).toBe(Date.parse("2026-10-02T10:00:00.000Z") / 1000);
    expect(items[0]?.txHash).toBe("0xdef");
    expect(items[1]?.txHash).toBe("0xabc");
    expect(items.every((i) => i.kind === "redeemRequest" && i.unit === "shares")).toBe(true);
  });
});

describe("staking and labels", () => {
  test("stakingView", () => {
    const base = { staked: 0n, locked: 0n, available: 0n, pendingUnstake: 0n, unstakeAvailableAt: 0, earned: 0n };
    expect(stakingView(base, 100)).toMatchObject({ hasStake: false, unstake: "none" });
    expect(stakingView({ ...base, staked: 5n, pendingUnstake: 2n, unstakeAvailableAt: 200 }, 100)).toMatchObject({ hasStake: true, unstake: "cooling" });
    expect(stakingView({ ...base, staked: 5n, pendingUnstake: 2n, unstakeAvailableAt: 200 }, 200).unstake).toBe("ready");
    expect(stakingView({ ...base, earned: 1n }, 0).hasStake).toBe(true);
  });

  test("fmtUntil", () => {
    expect(fmtUntil(100, 100)).toBe("now");
    expect(fmtUntil(100 + 30 * 60, 100)).toBe("in 30 min");
    expect(fmtUntil(100 + 5 * 3600, 100)).toBe("in 5 h");
    expect(fmtUntil(100 + 9 * 86_400, 100)).toBe("in 9 days");
    expect(fmtUntil(null, 100)).toBe("—");
  });

  test("pctLabel", () => {
    expect(pctLabel(0)).toBe("0%");
    expect(pctLabel(0.004)).toBe("<1%");
    expect(pctLabel(0.705)).toBe("71%");
    expect(pctLabel(0.996)).toBe(">99%");
    expect(pctLabel(1)).toBe("100%");
  });

  test("markLabel", () => {
    expect(markLabel({ newest: 1_790_960_400, oldest: 1_790_960_400, same: true }, "UTC")).toBe("At the latest mark (2 Oct 2026, 17:00 UTC)");
    expect(markLabel({ newest: 1_790_960_400, oldest: 1_790_956_800, same: false }, "UTC")).toBe("At each book's latest mark (2 Oct 2026, 16:00 UTC to 2 Oct 2026, 17:00 UTC)");
    expect(markLabel({ newest: null, oldest: null, same: true })).toBe("No mark yet");
  });

  test("share counts", () => {
    expect(shares(1_000_000n)).toBe("1.00 share");
    expect(shares(2_500_000n)).toBe("2.50 shares");
    expect(shares(null)).toBe("—");
  });
});
