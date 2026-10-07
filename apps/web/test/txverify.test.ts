// TxRunner refuses prepared transactions that do not do what the flow says (before any wallet prompt).
import { describe, expect, test } from "bun:test";
import { trancheAbi } from "@bookrunner/shared/abi";
import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import type { PreparedTx } from "../src/lib/api-types";
import { appChain } from "../src/wallet/chains";
import { checkTxs } from "../src/wallet/txVerify";

const USDC = "0x6666666666666666666666666666666666666666";
const SENIOR = "0x7777777777777777777777777777777777777777";
const ME = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0xbadbadbadbadbadbadbadbadbadbadbadbadbadb";
const targets = { targets: [USDC, SENIOR], labels: { [USDC]: "USDC", [SENIOR]: "Senior tranche (book #1)" }, decimals: { [USDC]: 6, [SENIOR]: 6 } };

const step = (to: string, data: `0x${string}`, description: string): PreparedTx => ({ to: to as `0x${string}`, data, value: "0", chainId: appChain.id, description });
const approve = (spender: string, amount: bigint) => step(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as `0x${string}`, amount] }), "Approve 100 USDC for the Senior tranche of book #1");
const deposit = (amount: bigint, receiver = ME) => step(SENIOR, encodeFunctionData({ abi: trancheAbi, functionName: "deposit", args: [amount, receiver as `0x${string}`] }), "Commit 100 USDC");

describe("checkTxs (TxRunner)", () => {
  test("pending until the chain-derived contracts are known", () => {
    expect(checkTxs([approve(SENIOR, 100_000_000n), deposit(100_000_000n)], null).status).toBe("pending");
  });

  test("an honest approve + deposit passes and shows the decoded calls", () => {
    const r = checkTxs([approve(SENIOR, 100_000_000n), deposit(100_000_000n)], targets, { account: ME, amount: 100_000_000n });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.steps[0]!.summary).toBe("USDC.approve: let Senior tranche (book #1) move 100 USDC from your wallet (used by step 2)");
  });

  test("description says tranche, calldata says attacker / unlimited / another amount / another receiver: refused", () => {
    const refused = (txs: PreparedTx[], amount = 100_000_000n) => checkTxs(txs, targets, { account: ME, amount });
    expect(refused([approve(ATTACKER, 100_000_000n), deposit(100_000_000n)]).status).toBe("refused");
    expect(refused([approve(SENIOR, maxUint256), deposit(100_000_000n)]).status).toBe("refused");
    expect(refused([approve(SENIOR, 100_000_000n), deposit(100_000_000n)], 5_000_000n).status).toBe("refused");
    expect(refused([approve(SENIOR, 100_000_000n), deposit(100_000_000n, ATTACKER)]).status).toBe("refused");
    expect(refused([step(ATTACKER, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SENIOR, 1n] }), "x"), deposit(1n)], 1n).status).toBe("refused");
  });
});
