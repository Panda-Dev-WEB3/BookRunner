import { describe, expect, test } from "bun:test";
import { bkrnStakingAbi } from "@bookrunner/shared/abi/BkrnStaking";
import { bookAbi } from "@bookrunner/shared/abi/Book";
import { type Address, type Hex, decodeFunctionData, encodeErrorResult, encodeFunctionData, erc20Abi } from "viem";
import { ERRORS_ABI, errText, revertReason } from "../src/dashboard/revert";
import {
  MOCK_MINT_ABI,
  type StepExecutor,
  type TxStep,
  cancelUnstakeStep,
  claimRewardStep,
  fromPrepared,
  initialItems,
  mintTestUsdcStep,
  openTopUpStep,
  requestUnstakeStep,
  runSteps,
  stakeSteps,
  summarize,
  withdrawUnstakedStep,
} from "../src/dashboard/txs";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const STAKING = "0x3333333333333333333333333333333333333333" as Address;
const BKRN = "0x4444444444444444444444444444444444444444" as Address;
const BOOK = "0x5555555555555555555555555555555555555555" as Address;
const ONE = 10n ** 18n;

describe("prepared transactions", () => {
  const tx = { to: STAKING, data: encodeFunctionData({ abi: bkrnStakingAbi, functionName: "claimReward" }), value: "0", chainId: 46630, description: "x" };
  test("accepts API prepared txs for this chain, with the decoded call", () => {
    const [s] = fromPrepared([tx, { ...tx, signer: OTHER }]).concat();
    expect(s?.value).toBe(0n);
    expect(s?.decoded).toContain("claimReward");
    expect(fromPrepared([{ ...tx, signer: OTHER }])[0]?.signer).toBe(OTHER);
  });
  test("refuses another chain, value, bad target or calldata, unknown functions", () => {
    expect(() => fromPrepared([{ ...tx, chainId: 1 }])).toThrow(/chain 1/);
    expect(() => fromPrepared([{ ...tx, value: "1" }])).toThrow(/never send value/);
    expect(() => fromPrepared([{ ...tx, to: "0x12" }])).toThrow(/address/);
    expect(() => fromPrepared([{ ...tx, data: "nope" }])).toThrow(/calldata/);
    expect(() => fromPrepared([{ ...tx, data: "0xdeadbeef" }])).toThrow(/does not recognise/);
    // an ERC-20 transfer is never a prepared step
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [OTHER, 1n] });
    expect(() => fromPrepared([{ ...tx, to: BKRN, data: transfer }])).toThrow(/does not recognise/);
  });
  test("with a chain-derived expectation: only the flow's contracts, the entered amount, the user's account", () => {
    const approve = { ...tx, to: BKRN, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STAKING, 5n * ONE] }) };
    const stake = { ...tx, data: encodeFunctionData({ abi: bkrnStakingAbi, functionName: "stake", args: [5n * ONE] }) };
    const ok = fromPrepared([approve, stake], 46630, { targets: [BKRN, STAKING], amount: 5n * ONE, labels: { [BKRN]: "BKRN", [STAKING]: "BKRN staking" }, decimals: { [BKRN]: 18 } });
    expect(ok[0]?.decoded).toBe("BKRN.approve: let BKRN staking move 5 BKRN from your wallet (used by step 2)");
    expect(() => fromPrepared([approve, stake], 46630, { targets: [STAKING] })).toThrow(/not a contract of this flow/);
    expect(() => fromPrepared([approve, stake], 46630, { targets: [BKRN, STAKING], amount: ONE })).toThrow(/you entered/);
  });
});

describe("desk-encoded steps", () => {
  test("test USDC mint: MockERC20.mint(self, 10,000e6)", () => {
    const s = mintTestUsdcStep(BKRN, ME);
    const d = decodeFunctionData({ abi: MOCK_MINT_ABI, data: s.data });
    expect(d.functionName).toBe("mint");
    expect(d.args).toEqual([ME, 10_000_000_000n]);
    expect(s.description).toContain("10,000 test USDC");
  });

  test("stake approves only when short, and only the amount", () => {
    const two = stakeSteps({ bkrn: BKRN, staking: STAKING, amount: 5n * ONE, allowance: ONE });
    expect(two).toHaveLength(2);
    const approve = decodeFunctionData({ abi: erc20Abi, data: two[0]?.data as Hex });
    expect(approve.functionName).toBe("approve");
    expect(approve.args).toEqual([STAKING, 5n * ONE]);
    expect(two[0]?.to).toBe(BKRN);
    const stake = decodeFunctionData({ abi: bkrnStakingAbi, data: two[1]?.data as Hex });
    expect(stake.functionName).toBe("stake");
    expect(stake.args).toEqual([5n * ONE]);
    expect(stakeSteps({ bkrn: BKRN, staking: STAKING, amount: ONE, allowance: 5n * ONE })).toHaveLength(1);
    expect(stakeSteps({ bkrn: BKRN, staking: STAKING, amount: ONE, allowance: null })).toHaveLength(2);
    expect(() => stakeSteps({ bkrn: BKRN, staking: STAKING, amount: 0n, allowance: null })).toThrow();
  });

  test("unstake request respects the free stake and explains the cooldown restart", () => {
    const s = requestUnstakeStep({ staking: STAKING, amount: ONE, available: 2n * ONE, pending: ONE, cooldownSec: 7 * 86400 });
    expect(decodeFunctionData({ abi: bkrnStakingAbi, data: s.data }).functionName).toBe("requestUnstake");
    expect(s.description).toContain("restarts");
    expect(() => requestUnstakeStep({ staking: STAKING, amount: 3n * ONE, available: 2n * ONE, pending: 0n, cooldownSec: null })).toThrow(/free to unstake/);
  });

  test("cancel / withdraw / claim", () => {
    expect(decodeFunctionData({ abi: bkrnStakingAbi, data: cancelUnstakeStep(STAKING, ONE).data }).functionName).toBe("cancelUnstake");
    expect(decodeFunctionData({ abi: bkrnStakingAbi, data: withdrawUnstakedStep(STAKING, ONE).data }).functionName).toBe("unstake");
    expect(decodeFunctionData({ abi: bkrnStakingAbi, data: claimRewardStep(STAKING, ONE).data }).functionName).toBe("claimReward");
  });

  test("top-up round: Book.openTopUp(window, senior, junior) with validation", () => {
    const s = openTopUpStep({ book: BOOK, windowSeconds: 86400, seniorCapacityUsd: 50_000_000_000n, juniorCapacityUsd: 0n, maxWindowSeconds: 30 * 86400 });
    const d = decodeFunctionData({ abi: bookAbi, data: s.data });
    expect(d.functionName).toBe("openTopUp");
    expect(d.args).toEqual([86400, 50_000_000_000n, 0n]);
    expect(() => openTopUpStep({ book: BOOK, windowSeconds: 0, seniorCapacityUsd: 1n, juniorCapacityUsd: 1n })).toThrow();
    expect(() => openTopUpStep({ book: BOOK, windowSeconds: 3600, seniorCapacityUsd: 0n, juniorCapacityUsd: 0n })).toThrow(/at least one/);
    expect(() => openTopUpStep({ book: BOOK, windowSeconds: 40 * 86400, seniorCapacityUsd: 1n, juniorCapacityUsd: 0n, maxWindowSeconds: 30 * 86400 })).toThrow(/at most/);
  });
});

describe("runner", () => {
  const step = (d: string): TxStep => ({ to: STAKING, data: "0x00", value: 0n, description: d });
  const fakeExec = (opts: { failSimAt?: number; rejectAt?: number; revertAt?: number; account?: Address | null } = {}) => {
    const sent: string[] = [];
    let n = 0;
    const exec: StepExecutor = {
      account: () => (opts.account === undefined ? ME : opts.account),
      simulate: async () => {
        if (opts.failSimAt === n) throw Object.assign(new Error("execution reverted"), { data: encodeErrorResult({ abi: ERRORS_ABI, errorName: "DepositsClosed" }) });
      },
      send: async (s) => {
        if (opts.rejectAt === n) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        sent.push(s.description);
        n++;
        return `0x${String(n).padStart(64, "0")}` as Hex;
      },
      wait: async () => ({ status: opts.revertAt === n - 1 ? "reverted" : "success", blockNumber: 7n }),
    };
    return { exec, sent };
  };

  test("runs in order and confirms every step", async () => {
    const { exec, sent } = fakeExec();
    const updates: string[] = [];
    const r = await runSteps(initialItems([step("a"), step("b")]), exec, (items) => updates.push(items.map((i) => i.status).join(",")));
    expect(r.ok).toBe(true);
    expect(sent).toEqual(["a", "b"]);
    expect(summarize(r.items).allConfirmed).toBe(true);
    expect(updates).toContain("simulating,queued");
    expect(updates).toContain("confirmed,signing");
  });

  test("a failing simulation stops before the wallet prompt, with a plain reason", async () => {
    const { exec, sent } = fakeExec({ failSimAt: 1 });
    const r = await runSteps(initialItems([step("approve"), step("deposit"), step("after")]), exec, () => {});
    expect(r.ok).toBe(false);
    expect(sent).toEqual(["approve"]);
    expect(r.items.map((i) => i.status)).toEqual(["confirmed", "failed", "skipped"]);
    expect(r.items[1]?.error).toContain("Deposits into this tranche are closed");
  });

  test("a declined prompt is 'not sent' and a retry resumes after confirmed steps", async () => {
    const first = fakeExec({ rejectAt: 1 });
    const r1 = await runSteps(initialItems([step("a"), step("b")]), first.exec, () => {});
    expect(r1.items.map((i) => i.status)).toEqual(["confirmed", "skipped"]);
    expect(r1.items[1]?.error).toContain("declined");
    const second = fakeExec();
    const r2 = await runSteps(r1.items, second.exec, () => {});
    expect(r2.ok).toBe(true);
    expect(second.sent).toEqual(["b"]);
  });

  test("a reverted receipt fails the step; a signer mismatch never prompts", async () => {
    const { exec } = fakeExec({ revertAt: 0 });
    const r = await runSteps(initialItems([step("a")]), exec, () => {});
    expect(r.items[0]?.status).toBe("failed");
    expect(r.items[0]?.error).toContain("reverted");
    const m = fakeExec();
    const r2 = await runSteps(initialItems([{ ...step("consent"), signer: OTHER }]), m.exec, () => {});
    expect(m.sent).toEqual([]);
    expect(r2.items[0]?.error).toContain(OTHER);
    const none = fakeExec({ account: null });
    expect((await runSteps(initialItems([step("a")]), none.exec, () => {})).items[0]?.error).toContain("Connect a wallet");
  });
});

describe("revert decoding", () => {
  test("decodes custom errors from the error chain", () => {
    const data = encodeErrorResult({ abi: ERRORS_ABI, errorName: "WalletCapExceeded", args: [250_000_000_000n, 300_000_000_000n] });
    const e = { message: "wrapped", cause: { cause: { data } } };
    expect(revertReason(e)).toContain("250,000.00 USDC");
    expect(revertReason(new Error("x"))).toBeNull();
    const sponsor = encodeErrorResult({ abi: ERRORS_ABI, errorName: "NotSponsor" });
    expect(errText({ data: sponsor })).toContain("sponsor");
    expect(errText({ data: "0x12345678" })).toContain("0x12345678");
    expect(errText({ code: -32002, message: "already pending" })).toContain("already has a request open");
    expect(errText(new Error("first line\nsecond"))).toBe("first line");
  });
});
