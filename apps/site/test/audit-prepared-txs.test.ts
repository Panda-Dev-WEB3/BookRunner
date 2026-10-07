// AUDIT (area 6, off-chain): the book desk (apps/site/src/dashboard) signs API-prepared transactions
// after checking only chainId, address syntax, hex calldata and value == 0 (txs.ts fromPrepared). The
// review modal shows the API's own `description`, never the decoded calldata, so whoever controls the
// API response (a compromised api process, which also holds the role mnemonic in its env) can turn
// "Approve 100 USDC for the Senior tranche" into approve(attacker, max) on the real USDC contract.
// Secure behaviour asserted here: an ERC-20 approve whose spender is not the target of a later step of
// the same flow (the contract that will pull the funds) is refused before any wallet prompt.
import { describe, expect, test } from "bun:test";
import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { fromPrepared } from "../src/dashboard/txs";

const USDC = "0x6666666666666666666666666666666666666666";
const TRANCHE = "0x7777777777777777777777777777777777777777";
const ATTACKER = "0xbAdbAdbAdbAdbAdbAdbAdbAdbAdbAdbAdbAdbAdb";
const trancheAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [] },
] as const;

describe("audit: API-prepared transactions are checked against what they do", () => {
  test("an approve to a spender no later step targets is refused (description says tranche, calldata says attacker)", () => {
    const steps = [
      {
        to: USDC,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ATTACKER, maxUint256] }),
        value: "0",
        chainId: 46630,
        description: "Approve 100 USDC for the Senior tranche of book #1",
      },
      {
        to: TRANCHE,
        data: encodeFunctionData({ abi: trancheAbi, functionName: "deposit", args: [100_000_000n, "0x1111111111111111111111111111111111111111"] }),
        value: "0",
        chainId: 46630,
        description: "Commit 100 USDC to the Senior tranche of book #1",
      },
    ];
    expect(() => fromPrepared(steps)).toThrow();
  });
});
