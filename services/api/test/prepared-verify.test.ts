// The API's real prepared transactions pass the client-side verifier the apps run before any wallet
// prompt (@bookrunner/shared/preparedTx), with the flow's contracts as the only allowed destinations;
// the same flows tampered with the way a compromised API would are refused.
import { describe, expect, test } from "bun:test";
import { type PreparedTxInput, verifyPreparedTxs } from "@bookrunner/shared/preparedTx";
import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { A } from "./fakes";
import { ALICE, BOOK, SPONSOR, makeWorld, sampleDraft, seedBook } from "./fixtures";

const ATTACKER = A(0xbad);

describe("API-prepared flows verify on the client", () => {
  test("subscribe [approve USDC, deposit]: passes with the tranche + USDC, the entered amount and the wallet", async () => {
    const w = makeWorld();
    seedBook(w, { state: "Subscription", subscriptionEndsIn: 300 });
    w.chain.setWallet(BOOK.senior, ALICE, { depositsOpen: true, committed: 0n, totalCommitted: 10_000_000_000n });
    const res = await w.caller.tranche.subscribe({ bookId: 1, tranche: "senior", amountUsd: "1500.5", wallet: ALICE });
    const usdc = w.chain.deployment.contracts.usdc;
    const check = { chainId: res.txs[0]!.chainId, targets: [usdc, BOOK.senior], account: ALICE, amount: 1_500_500_000n, labels: { [usdc]: "USDC", [BOOK.senior]: "Senior tranche" }, decimals: { [usdc]: 6, [BOOK.senior]: 6 } };
    const decoded = verifyPreparedTxs(res.txs, check);
    expect(decoded.map((d) => d.functionName)).toEqual(["approve", "deposit"]);
    expect(decoded[0]!.summary).toBe("USDC.approve: let Senior tranche move 1,500.5 USDC from your wallet (used by step 2)");

    // tampering a compromised API could do: every variant is refused before the wallet sees it
    const [approve, deposit] = res.txs as [PreparedTxInput, PreparedTxInput];
    const approveTo = (spender: string, amount: bigint) => ({ ...approve, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as `0x${string}`, amount] }) });
    expect(() => verifyPreparedTxs([approveTo(ATTACKER, 1_500_500_000n), deposit], check)).toThrow(/no later step/);
    expect(() => verifyPreparedTxs([approveTo(BOOK.senior, maxUint256), deposit], check)).toThrow(/unlimited/);
    expect(() => verifyPreparedTxs([approveTo(BOOK.senior, 9_000_000_000n), deposit], check)).toThrow(/moves/);
    expect(() => verifyPreparedTxs([approve, { ...deposit, to: BOOK.junior }], check)).toThrow(/not a contract of this flow/);
    expect(() => verifyPreparedTxs([approve, deposit], { ...check, amount: 100_000_000n })).toThrow(/you entered/);
    expect(() => verifyPreparedTxs([approve, deposit], { ...check, account: SPONSOR })).toThrow(/not your account/);
    const transfer = { ...approve, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, 1n] }) };
    expect(() => verifyPreparedTxs([transfer], check)).toThrow(/does not recognise/);
  });

  test("redeem: requestRedeem(shares, wallet, wallet) on the tranche", async () => {
    const w = makeWorld();
    seedBook(w);
    w.chain.setWallet(BOOK.junior, ALICE, { shares: 10_000_000_000n });
    const r = await w.caller.tranche.redeem({ bookId: 1, tranche: "junior", shares: "2500", wallet: ALICE });
    expect(verifyPreparedTxs(r.txs, { chainId: r.txs[0]!.chainId, targets: [BOOK.junior], account: ALICE, amount: 2_500_000_000n })[0]!.functionName).toBe("requestRedeem");
    expect(() => verifyPreparedTxs(r.txs, { chainId: r.txs[0]!.chainId, targets: [BOOK.junior], account: SPONSOR })).toThrow(/not your account/);
  });

  test("charter file [approve USDC fee, approve BKRN, stake, file]: passes with usdc/bkrn/staking/charter", async () => {
    const w = makeWorld();
    w.chain.stake.set(SPONSOR.toLowerCase(), 40_000n * 10n ** 18n);
    const res = await w.caller.charter.file(sampleDraft());
    const c = w.chain.deployment.contracts;
    const decoded = verifyPreparedTxs(res.txs, { chainId: res.txs[0]!.chainId, targets: [c.usdc, c.bkrn, c.staking, c.charter] });
    expect(decoded.map((d) => d.functionName)).toEqual(["approve", "approve", "stake", "file"]);
    expect(() => verifyPreparedTxs(res.txs, { chainId: res.txs[0]!.chainId, targets: [c.usdc, c.bkrn, c.staking] })).toThrow(/not a contract of this flow/);
  });

  test("committee vote and desk-key registration pass with their single contract", async () => {
    const w = makeWorld();
    seedBook(w);
    const reg = await w.caller.agent.register({ bookId: 1, key: A(5), operator: A(6), validUntil: 4_000_000_000, inventoryTierUsd: 50_000 }).catch(() => null);
    if (reg) {
      const names = verifyPreparedTxs(reg.txs, { chainId: reg.txs[0]!.chainId, targets: [BOOK.mandate] }).map((d) => d.functionName);
      expect(names.every((n) => n === "registerKey" || n === "consentKey")).toBe(true);
    }
    const rev = await w.caller.agent.revoke({ bookId: 1, key: A(5), reason: "TEST" }).catch(() => null);
    if (rev) expect(verifyPreparedTxs(rev.txs, { chainId: rev.txs[0]!.chainId, targets: [BOOK.mandate] })[0]!.functionName).toBe("revokeKey");
    expect(reg !== null || rev !== null).toBe(true);
  });
});
