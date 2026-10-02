// TxSender against a fake EIP-1193 provider: sends use a buffered gas limit (estimate + 30% + 30k),
// an explicit ContractCall.gas is used as is.
import { describe, expect, test } from "bun:test";
import { createLogger, devAccount, localChain } from "@bookrunner/shared";
import { revenueRouterAbi } from "@bookrunner/shared/abi";
import { type Address, type Hex, createPublicClient, createWalletClient, custom, keccak256, parseTransaction } from "viem";
import { TxSender } from "../src/kit/tx";

const ROUTER = "0x0000000000000000000000000000000000000601" as Address;
const ESTIMATE = 0x30000n;

function fakeProvider() {
  const sent: Hex[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_call":
        return "0x";
      case "eth_estimateGas":
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
          from: devAccount("keeper").address,
          gasUsed: "0x5208",
          logs: [],
          logsBloom: `0x${"0".repeat(512)}`,
          status: "0x1",
          to: ROUTER,
          transactionIndex: "0x0",
          type: "0x2",
        };
      default:
        throw new Error(`unsupported rpc ${method}`);
    }
  };
  return { request, sent };
}

function sender() {
  const provider = fakeProvider();
  const transport = custom({ request: provider.request });
  const pc = createPublicClient({ chain: localChain, transport, pollingInterval: 5 });
  const wallet = createWalletClient({ chain: localChain, transport, account: devAccount("keeper") });
  return { tx: new TxSender(pc as never, wallet, createLogger("tx-test", "silent"), { pollingIntervalMs: 5 }), sent: provider.sent };
}

describe("TxSender gas", () => {
  test("sends with estimate * 1.3 + 30k", async () => {
    const { tx, sent } = sender();
    await tx.send({ address: ROUTER, abi: revenueRouterAbi, functionName: "distribute", args: [1_790_000_100n, 0n], label: "distribute" });
    expect(sent).toHaveLength(1);
    const parsed = parseTransaction(sent[0] as never);
    expect(parsed.gas).toBe(285_590n);
  });

  test("an explicit gas limit is used as is", async () => {
    const { tx, sent } = sender();
    await tx.send({ address: ROUTER, abi: revenueRouterAbi, functionName: "distribute", args: [1_790_000_100n, 0n], label: "distribute", gas: 500_000n });
    expect(parseTransaction(sent[0] as never).gas).toBe(500_000n);
  });
});
