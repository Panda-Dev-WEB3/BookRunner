import { describe, expect, test } from "bun:test";
import { strToBytes32 } from "@bookrunner/shared";
import { bkrnStakingAbi, marketCharterAbi, mMMandateAbi, riskCommitteeAbi, trancheAbi } from "@bookrunner/shared/abi";
import { decodeFunctionData, erc20Abi } from "viem";
import {
  approveBkrnTx,
  approveUsdcTx,
  claimAllocationTx,
  claimCancelledRefundTx,
  claimRedemptionTx,
  committeeVoteTx,
  depositTx,
  fileCharterTx,
  registerKeyTx,
  requestRedeemTx,
  revokeKeyTx,
  stakeTx,
} from "../src/domain/txs";
import { A } from "./fakes";
import { sampleCharter } from "./fixtures";

const CHAIN = 31337;

describe("prepared transactions", () => {
  test("shape: {to, data, value: '0', chainId, description}", () => {
    const tx = approveUsdcTx(CHAIN, A(1), A(2), 5_000_000_000n, "the flat charter fee");
    expect(Object.keys(tx).sort()).toEqual(["chainId", "data", "description", "to", "value"]);
    expect(tx.value).toBe("0");
    expect(tx.chainId).toBe(CHAIN);
    expect(tx.to).toBe(A(1));
    expect(tx.description).toBe("Approve 5000 USDC for the flat charter fee");
  });

  test("USDC / BKRN approve round trip", () => {
    const u = decodeFunctionData({ abi: erc20Abi, data: approveUsdcTx(CHAIN, A(1), A(2), 123_450_000n, "x").data });
    expect(u.functionName).toBe("approve");
    expect(u.args).toEqual([A(2), 123_450_000n]);
    const b = decodeFunctionData({ abi: erc20Abi, data: approveBkrnTx(CHAIN, A(3), A(4), 10n ** 18n, "y").data });
    expect(b.args).toEqual([A(4), 10n ** 18n]);
  });

  test("staking.stake round trip", () => {
    const d = decodeFunctionData({ abi: bkrnStakingAbi, data: stakeTx(CHAIN, A(5), 7n * 10n ** 18n).data });
    expect(d.functionName).toBe("stake");
    expect(d.args).toEqual([7n * 10n ** 18n]);
  });

  test("MarketCharter.file round trip preserves every charter field", () => {
    const c = sampleCharter();
    const tx = fileCharterTx(CHAIN, A(6), c, "PERP_NVDA_USDC");
    const d = decodeFunctionData({ abi: marketCharterAbi, data: tx.data });
    expect(d.functionName).toBe("file");
    const got = (d.args as readonly [typeof c])[0];
    expect(got.underlying).toBe(c.underlying);
    expect(got.ifTargetUsd).toBe(25_000_000_000n);
    expect(got.mmInventoryUsd).toBe(75_000_000_000n);
    expect(got.mandate.maxInventoryUsd).toBe(50_000_000_000n);
    expect(got.mandate.killAtDrawdownBps).toBe(-800);
    expect(got.mandate.maxHedgeLeverage).toBe(100);
    expect(got.mandate.hedgeAllowRoot).toBe(c.mandate.hedgeAllowRoot);
    expect(got.juniorNoticeSeconds).toBe(900n);
    expect(got.subscriptionWindow).toBe(600);
    expect(got.symbol).toBe(strToBytes32("PERP_NVDA_USDC"));
    expect(got.sponsor).toBe(c.sponsor);
    expect(got.perWalletCapUsd).toBe(250_000_000_000n);
  });

  test("RiskCommittee.vote round trip", () => {
    const d = decodeFunctionData({ abi: riskCommitteeAbi, data: committeeVoteTx(CHAIN, A(7), 42, false).data });
    expect(d.functionName).toBe("vote");
    expect(d.args).toEqual([42n, false]);
  });

  test("tranche deposit / requestRedeem / claims round trip", () => {
    const t = A(8);
    const w = A(9);
    const dep = decodeFunctionData({ abi: trancheAbi, data: depositTx(CHAIN, t, 1_000_000n, w, "Senior").data });
    expect(dep.functionName).toBe("deposit");
    expect(dep.args).toEqual([1_000_000n, w]);
    const red = decodeFunctionData({ abi: trancheAbi, data: requestRedeemTx(CHAIN, t, 5_000_000n, w, "Junior").data });
    expect(red.functionName).toBe("requestRedeem");
    expect(red.args).toEqual([5_000_000n, w, w]);
    expect(decodeFunctionData({ abi: trancheAbi, data: claimAllocationTx(CHAIN, t, w, "Senior").data }).args).toEqual([w]);
    const cr = decodeFunctionData({ abi: trancheAbi, data: claimRedemptionTx(CHAIN, t, w, "Senior").data });
    expect(cr.functionName).toBe("claimRedemption");
    expect(cr.args).toEqual([w, w]);
    const cc = decodeFunctionData({ abi: trancheAbi, data: claimCancelledRefundTx(CHAIN, t, w, "Junior").data });
    expect(cc.functionName).toBe("claimCancelledRefund");
  });

  test("MMMandate.registerKey / revokeKey round trip", () => {
    const reg = decodeFunctionData({ abi: mMMandateAbi, data: registerKeyTx(CHAIN, A(10), A(11), A(12), 1_800_000_000n, 50_000_000_000n).data });
    expect(reg.functionName).toBe("registerKey");
    expect(reg.args).toEqual([A(11), A(12), 1_800_000_000n, 50_000_000_000n]);
    const rev = decodeFunctionData({ abi: mMMandateAbi, data: revokeKeyTx(CHAIN, A(10), A(11), "OPERATOR_ROTATION").data });
    expect(rev.functionName).toBe("revokeKey");
    expect(rev.args).toEqual([A(11), strToBytes32("OPERATOR_ROTATION")]);
  });
});
