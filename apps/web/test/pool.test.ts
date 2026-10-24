// Insurance pool page logic (components/pool/poolLogic.ts): 12-decimal shares, the queue phase in words, request
// statuses and actions, the first-loss slice, chart series, and the page's copy.
import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import {
  POOL_RISK_LINES,
  PHASE,
  actionableCount,
  canCancelDeposit,
  canCollectDeposit,
  canCollectWithdrawal,
  capFill,
  capTone,
  cooldownLine,
  depositStatus,
  firstLossView,
  flowBars,
  flowTotals,
  fmtShares,
  openRequests,
  phaseSentence,
  priceChangeText,
  sharePriceSeries,
  sharesInput,
  sharesRaw,
  withdrawIssueText,
  withdrawSharesIssue,
  withdrawalStatus,
} from "../src/components/pool/poolLogic";
import type { PoolDepositItem, PoolWithdrawalItem } from "../src/lib/api-types";

const S = 10n ** 12n;
const END = "2026-10-22T00:00:00.000Z";
const END_MS = Date.parse(END);

const dep = (o: Partial<PoolDepositItem> = {}): PoolDepositItem => ({
  depositId: 1,
  epoch: 2913,
  epochEndsAt: END,
  assetsUsd: "250.000000",
  status: "queued",
  shares: null,
  cancellable: true,
  requestedAt: "2026-10-20T10:00:00.000Z",
  requestTx: "0x01",
  ...o,
});

const wd = (o: Partial<PoolWithdrawalItem> = {}): PoolWithdrawalItem => ({
  requestId: 7,
  epoch: 2914,
  epochEndsAt: "2026-10-29T00:00:00.000Z",
  shares: "100.0",
  filledShares: "0.0",
  status: "queued",
  filledUsd: "0.000000",
  claimedUsd: "0.000000",
  claimableUsd: "0.000000",
  requestedAt: "2026-10-20T10:00:00.000Z",
  requestTx: "0x02",
  ...o,
});

describe("shares (12 decimals)", () => {
  test("parse, format and send back exactly", () => {
    expect(sharesRaw("12.5")).toBe(12n * S + S / 2n);
    expect(sharesRaw("0.000000000001")).toBe(1n);
    expect(sharesRaw("1.0000000000001")).toBeNull();
    expect(sharesRaw(null)).toBeNull();
    expect(fmtShares("1234.56789")).toBe("1,234.5678");
    expect(fmtShares("0.0")).toBe("0.0000");
    expect(fmtShares(null)).toBe("—");
    expect(sharesInput(12n * S + 1n)).toBe("12.000000000001");
    expect(sharesInput(5n * S)).toMatch(/^5(\.0*)?$/);
  });

  test("withdraw amount checks against the wallet's shares", () => {
    expect(withdrawSharesIssue("", 5n * S)).toBe("empty");
    expect(withdrawSharesIssue("0", 5n * S)).toBe("zero");
    expect(withdrawSharesIssue("5.000000000001", 5n * S)).toBe("exceeds-balance");
    expect(withdrawSharesIssue("5", 5n * S)).toBeNull();
    expect(withdrawSharesIssue("5", null)).toBeNull();
    expect(withdrawIssueText("exceeds-balance")).toContain("collect processed deposits first");
    expect(withdrawIssueText(null)).toBeNull();
  });
});

describe("queue phase", () => {
  const q = { epoch: 2913, endsAt: END, ended: false, phase: "open", hasWork: true, staleBooks: 0, graceEndsAt: "2026-10-23T00:00:00.000Z", nextEpochEndsAt: "2026-10-29T00:00:00.000Z" };
  test("each phase in plain words, with the grace end while waiting for marks", () => {
    expect(phaseSentence(q, "UTC")).toBe("Epoch 2913 is open until 22 Oct 2026, 00:00 UTC. A deposit or withdrawal request made now joins it, unless a cooldown pushes a withdrawal to a later epoch.");
    const waiting = phaseSentence({ ...q, ended: true, phase: "awaiting_marks", staleBooks: 2 }, "UTC");
    expect(waiting).toContain("waits for 2 pool-funded books to mark after that end, until 23 Oct 2026, 00:00 UTC at the latest");
    expect(phaseSentence({ ...q, ended: true, phase: "awaiting_marks", staleBooks: 1 }, "UTC")).toContain("1 pool-funded book to mark");
    expect(phaseSentence({ ...q, ended: true, phase: "processable" }, "UTC")).toContain("anyone can call processEpoch");
    expect(phaseSentence({ ...q, phase: "idle" }, "UTC")).toContain("29 Oct 2026");
    expect(PHASE.awaiting_marks.tone).toBe("warn");
  });
});

describe("requests", () => {
  test("a deposit can be cancelled only while queued, flagged by the API, and before its epoch ends", () => {
    expect(canCancelDeposit(dep(), END_MS - 1)).toBe(true);
    expect(canCancelDeposit(dep(), END_MS)).toBe(false);
    expect(canCancelDeposit(dep({ cancellable: false }), END_MS - 1)).toBe(false);
    expect(canCancelDeposit(dep({ status: "ready" }), END_MS - 1)).toBe(false);
    expect(depositStatus(dep(), END_MS - 1, "USDC", "UTC").label).toBe("Queued");
    expect(depositStatus(dep(), END_MS + 1, "USDC", "UTC").label).toBe("Awaiting processing");
  });

  test("collect shares once processed; collect a withdrawal's filled part", () => {
    const ready = dep({ status: "ready", shares: "249.9", cancellable: false });
    expect(canCollectDeposit(ready)).toBe(true);
    expect(canCollectDeposit(dep({ status: "ready", shares: "0.0" }))).toBe(false);
    expect(depositStatus(ready, END_MS, "USDC").detail).toContain("249.9000 shares");
    const filling = wd({ status: "filling", filledShares: "40.0", claimableUsd: "40.100000" });
    expect(canCollectWithdrawal(filling)).toBe(true);
    expect(withdrawalStatus(filling, "USDC").label).toBe("Partly filled");
    expect(withdrawalStatus(filling, "USDC").detail).toContain("40.0000 of 100.0000 shares");
    expect(withdrawalStatus(wd({ status: "filling" }), "USDC").label).toBe("Filling");
    expect(withdrawalStatus(wd(), "USDC", "UTC").detail).toContain("epoch 2914");
    const p = { deposits: [ready, dep({ depositId: 2 }), dep({ depositId: 3, status: "claimed" })], withdrawals: [filling, wd({ requestId: 8, status: "claimed" })] };
    expect(actionableCount(p)).toBe(2);
    expect(actionableCount(undefined)).toBe(0);
    const open = openRequests(p);
    expect(open.deposits.map((d) => d.depositId)).toEqual([1, 2]);
    expect(open.withdrawals.map((w) => w.requestId)).toEqual([7]);
  });

  test("cooldown line only while it runs", () => {
    expect(cooldownLine({ cooldownEnds: END, inCooldown: true }, END_MS - 1, "UTC")).toContain("Cooldown until 22 Oct 2026, 00:00 UTC");
    expect(cooldownLine({ cooldownEnds: END, inCooldown: false }, END_MS)).toBe("");
    expect(cooldownLine({ cooldownEnds: null, inCooldown: null }, 0)).toBe("");
  });
});

describe("first-loss slice and exposure", () => {
  test("against the 10% level of what the books hold (pool audit 2026-10-23 A-M2)", () => {
    expect(firstLossView(1000, 1000, 10_000)).toMatchObject({ below: false, fill: 1 });
    expect(firstLossView(650, 1000, 5000)).toMatchObject({ below: false }); // 13% of the claims
    const low = firstLossView(650, 1000, 8000);
    expect(low.below).toBe(true);
    expect(low.text).toContain("8.1% of what the books hold, below the 10% level");
    expect(firstLossView(500, null, 0)).toMatchObject({ levelBps: 1000, below: false });
  });
  test("market cap use", () => {
    expect(capFill(5000)).toBe(0.5);
    expect(capFill(null)).toBeNull();
    expect([capTone(5000), capTone(8500), capTone(10_000), capTone(null)]).toEqual(["good", "warn", "critical", "neutral"]);
  });
});

describe("history", () => {
  test("share price series sorted, malformed points dropped", () => {
    const s = sharePriceSeries([
      { ts: "2026-10-02T00:00:00Z", sharePriceUsd: "1.010000" },
      { ts: "2026-10-01T00:00:00Z", sharePriceUsd: "1.000000" },
      { ts: "bad", sharePriceUsd: "1" },
    ]);
    expect(s.map((p) => p.v)).toEqual([1, 1.01]);
  });
  test("daily flows: losses below zero, exact totals", () => {
    const flows = [
      { day: "2026-10-02", premiumUsd: "1.500000", lossUsd: "0.000000", recoveryUsd: "0.000000" },
      { day: "2026-10-01", premiumUsd: "2.250001", lossUsd: "10.000000", recoveryUsd: "1.000000" },
    ];
    const b = flowBars(flows);
    expect(b.map((x) => x.day)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(b[0]?.loss).toBe(-10);
    expect(flowTotals(flows)).toEqual({ premium: 3_750_001n, loss: 10_000_000n, recovery: 1_000_000n });
  });
  test("observed change, never a rate", () => {
    expect(priceChangeText({ startUsd: "1.000000", endUsd: "1.012300", changeBps: 123 })).toBe("+1.23% (1.000000 to 1.012300)");
    expect(priceChangeText({ startUsd: "1.000000", endUsd: "0.990000", changeBps: -100 })).toBe("-1.00% (1.000000 to 0.990000)");
    expect(priceChangeText(null)).toBe("—");
  });
});

describe("copy", () => {
  test("the risk box and every status line pass the copy rules", () => {
    const lines = [
      ...POOL_RISK_LINES,
      phaseSentence({ epoch: 1, endsAt: END, ended: true, phase: "awaiting_marks", hasWork: true, staleBooks: 2, graceEndsAt: END, nextEpochEndsAt: END }),
      depositStatus(dep(), 0, "USDC").detail,
      withdrawalStatus(wd({ status: "filling" }), "USDC").detail,
      firstLossView(500, 1000, 8000).text,
      firstLossView(500, 1000, 0).text,
      cooldownLine({ cooldownEnds: END, inCooldown: true }, 0),
    ];
    for (const l of lines) expect(checkCopy(l)).toEqual([]);
    // the owner's wording, without the banned "protected": Junior and Senior first, exits never refused
    expect(POOL_RISK_LINES.join(" ")).toContain("Junior and Senior");
    expect(POOL_RISK_LINES.join(" ")).toContain("never refused");
  });
});
