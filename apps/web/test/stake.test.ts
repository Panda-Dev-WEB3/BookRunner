import { describe, expect, test } from "bun:test";
import { bkrnStakingAbi } from "@bookrunner/shared/abi/BkrnStaking";
import { checkCopy } from "@bookrunner/shared/copy";
import { decodeFunctionData, erc20Abi, getAddress } from "viem";
import {
  cancelUnstakeTx,
  claimTx,
  cooldownState,
  countdownLabel,
  fmtBkrn,
  fmtBkrnCompact,
  fmtShare,
  formatCountdown,
  poolShare,
  ratio,
  requestUnstakeTx,
  stakeAmountIssue,
  stakeBreakdown,
  stakeSetupDone,
  stakeTxs,
  unstakeAmountIssue,
  unstakeIssueText,
  withdrawTx,
} from "../src/components/stake/stakeLogic";

const BK = 10n ** 18n;
const STAKING = getAddress("0xc6a021711e61277cf15d08ef85cd77a99c90d2d1");
const TOKEN = getAddress("0xccfa4cebdbaec9f41975fd90d8f50b804fc25b94");
const CHAIN = 46630;
const WEEK = 604_800;

describe("cooldown state", () => {
  test("no request open", () => {
    expect(cooldownState(0n, 0, 1_000)).toEqual({ kind: "none" });
    expect(cooldownState(0n, 5_000, 1_000, WEEK)).toEqual({ kind: "none" });
  });

  test("cooling down with seconds left and progress", () => {
    const at = 1_000 + WEEK;
    const s = cooldownState(5n * BK, at, 1_000, WEEK);
    expect(s).toEqual({ kind: "cooling", amount: 5n * BK, availableAt: at, secondsLeft: WEEK, progress: 0 });
    const half = cooldownState(5n * BK, at, 1_000 + WEEK / 2, WEEK);
    expect(half.kind).toBe("cooling");
    if (half.kind === "cooling") {
      expect(half.secondsLeft).toBe(WEEK / 2);
      expect(half.progress).toBeCloseTo(0.5, 6);
    }
  });

  test("progress is unknown without the cooldown length and clamped when it changed", () => {
    const s = cooldownState(1n, 2_000, 1_000);
    expect(s.kind === "cooling" && s.progress).toBeNull();
    // cooldown shortened after the request: more time left than the new length -> clamped at 0
    const c = cooldownState(1n, 1_000 + WEEK, 1_000, 3_600);
    expect(c.kind === "cooling" && c.progress).toBe(0);
  });

  test("ready exactly at availableAt (the contract reverts only while now < availableAt)", () => {
    expect(cooldownState(3n, 2_000, 1_999, WEEK).kind).toBe("cooling");
    expect(cooldownState(3n, 2_000, 2_000, WEEK)).toEqual({ kind: "ready", amount: 3n, availableAt: 2_000 });
    expect(cooldownState(3n, 2_000, 9_999).kind).toBe("ready");
  });

  test("fractional now rounds the countdown up, never shows 0 while still cooling", () => {
    const s = cooldownState(1n, 2_000, 1_999.4, WEEK);
    expect(s.kind === "cooling" && s.secondsLeft).toBe(1);
  });
});

describe("countdown text", () => {
  test("days, hours, minutes, seconds", () => {
    expect(formatCountdown(WEEK)).toBe("7d 0h 00m");
    expect(formatCountdown(WEEK - 1)).toBe("6d 23h 59m");
    expect(formatCountdown(3 * 3_600 + 4 * 60 + 9)).toBe("3h 04m 09s");
    expect(formatCountdown(12 * 60 + 5)).toBe("12m 05s");
    expect(formatCountdown(45)).toBe("45s");
    expect(formatCountdown(0)).toBe("0s");
    expect(formatCountdown(-5)).toBe("0s");
    expect(formatCountdown(Number.NaN)).toBe("0s");
  });

  test("screen-reader label", () => {
    expect(countdownLabel(0)).toBe("ready now");
    expect(countdownLabel(2 * 86_400 + 3_600)).toBe("about 2 days 1 h left");
  });
});

describe("amount checks", () => {
  test("stake is checked against the wallet balance with 18 decimals", () => {
    expect(stakeAmountIssue("", 10n * BK)).toBe("empty");
    expect(stakeAmountIssue("abc", 10n * BK)).toBe("invalid");
    expect(stakeAmountIssue("0", 10n * BK)).toBe("zero");
    expect(stakeAmountIssue("10", 10n * BK)).toBeNull();
    expect(stakeAmountIssue("10.000000000000000001", 10n * BK)).toBe("exceeds-balance");
    expect(stakeAmountIssue("0.000000000000000001", 10n * BK)).toBeNull();
    // unknown balance: not checked
    expect(stakeAmountIssue("5", null)).toBeNull();
  });

  test("unstake requests are capped at the free stake", () => {
    expect(unstakeAmountIssue("4", 4n * BK)).toBeNull();
    expect(unstakeAmountIssue("4.5", 4n * BK)).toBe("above-max");
    expect(unstakeAmountIssue("1", 0n)).toBe("above-max");
    expect(unstakeIssueText("above-max", 0n)).toContain("Nothing is free to unstake");
    expect(unstakeIssueText("above-max", 4n * BK)).toContain("4.00 BKRN");
    expect(unstakeIssueText("zero", 4n * BK)).toBeNull();
  });

  test("BKRN display", () => {
    expect(fmtBkrn(1_234_567n * 10n ** 15n)).toBe("1,234.56 BKRN");
    expect(fmtBkrn(1n)).toBe("<0.01 BKRN");
    expect(fmtBkrn(null)).toBe("—");
    expect(fmtBkrn(2_200_000n * BK, 0)).toBe("2,200,000 BKRN");
  });

  test("compact headline figures", () => {
    expect(fmtBkrnCompact(2_200_000n * BK)).toBe("2.2M");
    expect(fmtBkrnCompact(1_000_000_000n * BK)).toBe("1B");
    expect(fmtBkrnCompact(12_345n * BK)).toBe("12.3K");
    expect(fmtBkrnCompact(9_999n * BK + 5n * 10n ** 17n)).toBe("9,999.50");
    expect(fmtBkrnCompact(0n)).toBe("0.00");
    expect(fmtBkrnCompact(undefined)).toBe("—");
  });
});

describe("breakdown and share", () => {
  test("ratio is exact enough and bounded", () => {
    expect(ratio(1n, 4n)).toBe(0.25);
    expect(ratio(0n, 4n)).toBe(0);
    expect(ratio(5n, 0n)).toBe(0);
    expect(ratio(9n, 4n)).toBe(1);
    expect(ratio(1_000_000n * BK, 2_200_000n * BK)).toBeCloseTo(0.454545, 6);
  });

  test("staked splits into free, cooling and locked", () => {
    const parts = stakeBreakdown({ staked: 10n * BK, available: 5n * BK, pending: 2n * BK, locked: 3n * BK });
    expect(parts.map((p) => p.part)).toEqual(["available", "pending", "locked"]);
    expect(parts.map((p) => p.share)).toEqual([0.5, 0.2, 0.3]);
    expect(parts.reduce((s, p) => s + p.amount, 0n)).toBe(10n * BK);
    expect(stakeBreakdown({ staked: 0n, available: 0n, pending: 0n, locked: 0n }).every((p) => p.share === 0)).toBe(true);
  });

  test("pool share", () => {
    expect(poolShare(1n, null)).toBeNull();
    expect(poolShare(1n, 0n)).toBeNull();
    expect(poolShare(300_000n * BK, 2_200_000n * BK)).toBeCloseTo(0.136363, 6);
    expect(fmtShare(null)).toBe("—");
    expect(fmtShare(0)).toBe("0%");
    expect(fmtShare(0.00004)).toBe("<0.01%");
    expect(fmtShare(0.136363)).toBe("13.64%");
  });
});

describe("setup", () => {
  const steps = (s: Record<string, "done" | "active" | "todo">) => Object.entries(s).map(([id, status]) => ({ id, status }));
  test("needs wallet, network and gas only", () => {
    expect(stakeSetupDone(steps({ connect: "done", network: "done", gas: "done", usdc: "active", invest: "todo" }))).toBe(true);
    expect(stakeSetupDone(steps({ connect: "done", network: "done", gas: "active", usdc: "todo", invest: "todo" }))).toBe(false);
    expect(stakeSetupDone(steps({ connect: "active", network: "todo", gas: "todo" }))).toBe(false);
    expect(stakeSetupDone([])).toBe(false);
  });
});

describe("prepared transactions", () => {
  const base = { chainId: CHAIN, staking: STAKING };

  test("approve exactly the amount when the allowance is short, then stake", () => {
    const txs = stakeTxs({ ...base, bkrn: TOKEN, amount: 250n * BK, allowance: 10n * BK });
    expect(txs).toHaveLength(2);
    const [approve, stake] = txs as [(typeof txs)[number], (typeof txs)[number]];
    expect(approve.to).toBe(TOKEN);
    const a = decodeFunctionData({ abi: erc20Abi, data: approve.data });
    expect(a.functionName).toBe("approve");
    expect(a.args).toEqual([STAKING, 250n * BK]);
    expect(stake.to).toBe(STAKING);
    const s = decodeFunctionData({ abi: bkrnStakingAbi, data: stake.data });
    expect(s.functionName).toBe("stake");
    expect(s.args).toEqual([250n * BK]);
    for (const t of txs) {
      expect(t.value).toBe("0");
      expect(t.chainId).toBe(CHAIN);
    }
  });

  test("skips the approval when the allowance already covers the amount", () => {
    expect(stakeTxs({ ...base, bkrn: TOKEN, amount: 5n * BK, allowance: 5n * BK })).toHaveLength(1);
    expect(stakeTxs({ ...base, bkrn: TOKEN, amount: 5n * BK, allowance: null })).toHaveLength(2);
    expect(stakeTxs({ ...base, bkrn: TOKEN, amount: 0n, allowance: 0n })).toHaveLength(0);
  });

  test("request, cancel, withdraw and claim encode the right calls", () => {
    const r = requestUnstakeTx({ ...base, amount: 7n * BK, cooldownSec: WEEK, pending: 0n });
    const rd = decodeFunctionData({ abi: bkrnStakingAbi, data: r.data });
    expect(rd.functionName).toBe("requestUnstake");
    expect(rd.args).toEqual([7n * BK]);
    expect(r.description).toContain("7 days");
    expect(decodeFunctionData({ abi: bkrnStakingAbi, data: cancelUnstakeTx({ ...base, pending: 1n }).data }).functionName).toBe("cancelUnstake");
    expect(decodeFunctionData({ abi: bkrnStakingAbi, data: withdrawTx({ ...base, pending: 1n }).data }).functionName).toBe("unstake");
    expect(decodeFunctionData({ abi: bkrnStakingAbi, data: claimTx({ ...base, earned: 1n }).data }).functionName).toBe("claimReward");
  });

  test("a second request says the cooldown restarts for everything pending", () => {
    const r = requestUnstakeTx({ ...base, amount: 2n * BK, cooldownSec: WEEK, pending: 3n * BK });
    expect(r.description).toContain("5.00 BKRN pending in total");
    expect(r.description).toContain("restarts");
  });

  test("descriptions follow the copy rules", () => {
    const all = [
      ...stakeTxs({ ...base, bkrn: TOKEN, amount: 1n * BK, allowance: 0n }),
      requestUnstakeTx({ ...base, amount: 1n, cooldownSec: null, pending: 0n }),
      requestUnstakeTx({ ...base, amount: 1n, cooldownSec: WEEK, pending: 1n }),
      cancelUnstakeTx({ ...base, pending: 1n }),
      withdrawTx({ ...base, pending: 1n }),
      claimTx({ ...base, earned: 1n }),
    ];
    for (const t of all) expect(checkCopy(t.description)).toEqual([]);
  });
});
