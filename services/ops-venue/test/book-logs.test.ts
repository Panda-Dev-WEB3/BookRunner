// RPC budget (deploy/server/MAINNET.md): the log watcher reads a range's adapter AND mandate logs with ONE
// eth_getLogs (ViemChain.bookLogs) and splits them by address; decoding is the same as the two separate calls.
import { describe, expect, test } from "bun:test";
import { createLogger, devAccount } from "@bookrunner/shared";
import { mMMandateAbi, orderlyAdapterAbi } from "@bookrunner/shared/abi";
import { type Address, type Hex, encodeAbiParameters, encodeEventTopics, getAddress, stringToHex } from "viem";
import { ViemChain } from "../src/chain";

const ADAPTER = getAddress("0x00000000000000000000000000000000000a0001");
const MANDATE = getAddress("0x00000000000000000000000000000000000b0001");
const OTHER = getAddress("0x00000000000000000000000000000000000c0001");

const raw = (address: Address, topics: Hex[], data: Hex, block: bigint, logIndex: number) => ({
  address,
  topics,
  data,
  blockNumber: block,
  transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex,
  logIndex,
  blockHash: `0x${"ab".repeat(32)}` as Hex,
  transactionIndex: 0,
  removed: false,
});

describe("ViemChain.bookLogs", () => {
  test("one eth_getLogs for adapters + mandates, split by address and decoded as before", async () => {
    const chain = new ViemChain({ contracts: {}, books: [], startBlock: 0 } as never, devAccount("opsVenue"), createLogger("t", "silent"), {
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:1",
      fallbackMarkInterval: 86_400,
    });
    const calls: Array<{ address: unknown; fromBlock: unknown; toBlock: unknown }> = [];
    const withdraw = raw(ADAPTER, encodeEventTopics({ abi: orderlyAdapterAbi, eventName: "WithdrawRequested", args: { account: 1, requestNonce: 7n } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [5_000_000n]), 10n, 3);
    const kill = raw(MANDATE, encodeEventTopics({ abi: mMMandateAbi, eventName: "Kill", args: { by: OTHER } }) as Hex[], encodeAbiParameters([{ type: "bytes32" }], [stringToHex("DRAWDOWN", { size: 32 })]), 11n, 0);
    (chain as unknown as { pc: unknown }).pc = {
      getLogs: async (a: { address: unknown; fromBlock: unknown; toBlock: unknown }) => {
        calls.push(a);
        return [withdraw, kill];
      },
    };
    const r = await chain.bookLogs([ADAPTER], [MANDATE], 1n, 20n);
    expect(calls).toEqual([{ address: [ADAPTER, MANDATE], fromBlock: 1n, toBlock: 20n }]);
    expect(r.adapter).toEqual([{ kind: "WithdrawRequested", adapter: ADAPTER, account: 1, amount: 5_000_000n, nonce: 7n, block: 10n, txHash: withdraw.transactionHash, logIndex: 3 }]);
    expect(r.mandate).toEqual([{ kind: "Kill", mandate: MANDATE, reason: stringToHex("DRAWDOWN", { size: 32 }), block: 11n, txHash: kill.transactionHash }]);
    // the same logs through the two historical calls decode identically
    expect(await chain.adapterLogs([ADAPTER], 1n, 20n)).toEqual(r.adapter);
    expect(await chain.mandateLogs([MANDATE], 1n, 20n)).toEqual(r.mandate);
    // nothing tracked / empty range: no call at all
    calls.length = 0;
    expect(await chain.bookLogs([], [], 1n, 20n)).toEqual({ adapter: [], mandate: [] });
    expect(await chain.bookLogs([ADAPTER], [MANDATE], 21n, 20n)).toEqual({ adapter: [], mandate: [] });
    expect(calls).toEqual([]);
  });
});
