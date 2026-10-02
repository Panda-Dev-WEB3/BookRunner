// DeskClient against a fake EIP-1193 provider: every desk tx is sent with a buffered gas limit
// (estimate + 30% + 30k), never viem's raw eth_estimateGas (which OOGs the nested engine call of
// SetQuote when funding accrual runs in the mined block but not at estimation).
import { describe, expect, test } from "bun:test";
import { createLogger, devAccount, localChain } from "@bookrunner/shared";
import { type Address, type Hex, createPublicClient, createWalletClient, custom, decodeErrorResult, encodeErrorResult, keccak256, parseTransaction } from "viem";
import { DESK_ABI_WITH_ERRORS, DeskClient } from "../src/chain/desk-client";
import { encodeSetQuote } from "../src/chain/desk-actions";

const DESK = "0x00000000000000000000000000000000000d0e5c" as Address;
const ESTIMATE = 139_960n; // the tight estimate of the devnet SetQuote that OOG'd at 136,444 used + inner call

function fakeProvider() {
  const sent: Hex[] = [];
  let estimates = 0;
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_call":
        // execute(Action) returns bytes: empty
        return "0x0000000000000000000000000000000000000000000000000000000000000020" + "0".repeat(64);
      case "eth_estimateGas":
        estimates++;
        return `0x${ESTIMATE.toString(16)}`;
      case "eth_getTransactionCount":
        return `0x${sent.length.toString(16)}`;
      case "eth_gasPrice":
        return "0x3b9aca00";
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_blockNumber":
        return "0x64";
      case "eth_getBlockByNumber":
        return { number: "0x64", baseFeePerGas: "0x1", hash: keccak256("0x64"), timestamp: "0x1", transactions: [] };
      case "eth_sendRawTransaction":
        sent.push(p[0] as Hex);
        return keccak256(p[0] as Hex);
      case "eth_getTransactionReceipt":
        return {
          transactionHash: p[0],
          blockHash: keccak256("0xb1"),
          blockNumber: "0x64",
          contractAddress: null,
          cumulativeGasUsed: "0x5208",
          effectiveGasPrice: "0x1",
          from: devAccount("deskKeyIndex").address,
          gasUsed: "0x5208",
          logs: [],
          logsBloom: `0x${"0".repeat(512)}`,
          status: "0x1",
          to: DESK,
          transactionIndex: "0x0",
          type: "0x2",
        };
      default:
        throw new Error(`unsupported rpc ${method}`);
    }
  };
  return { request, sent, estimates: () => estimates };
}

describe("DeskClient gas", () => {
  test("bufferedGas = estimate * 1.3 + 30k", async () => {
    const { bufferedGas } = await import("../src/chain/desk-client");
    expect(bufferedGas(100_000n)).toBe(160_000n);
    expect(bufferedGas(ESTIMATE)).toBe(211_948n);
  });

  test("SetQuote is sent with the buffered limit, not the raw estimate", async () => {
    const provider = fakeProvider();
    const transport = custom({ request: provider.request });
    const pub = createPublicClient({ chain: localChain, transport, pollingInterval: 5 });
    const wallet = createWalletClient({ chain: localChain, transport, account: devAccount("deskKeyIndex") });
    const client = new DeskClient(pub as never, wallet, DESK, createLogger("desk-test", "silent"), 5_000);
    await client.run(encodeSetQuote(12, -3, 50_000_000_000n), "test");
    expect(provider.sent).toHaveLength(1);
    const tx = parseTransaction(provider.sent[0] as never);
    expect(tx.to?.toLowerCase()).toBe(DESK);
    expect(tx.gas).toBe(211_948n); // 139,960 * 1.3 + 30,000
    expect(tx.gas! > ESTIMATE).toBe(true);
  });

  test("vault InsufficientIdle (FundDesk) decodes through the desk ABI", () => {
    const data = encodeErrorResult({ abi: DESK_ABI_WITH_ERRORS, errorName: "InsufficientIdle", args: [5_000_000_000n, 1_069_836_017n] });
    expect(data.slice(0, 10)).toBe("0xc8564bd3");
    expect(decodeErrorResult({ abi: DESK_ABI_WITH_ERRORS, data }).errorName).toBe("InsufficientIdle");
  });
});
