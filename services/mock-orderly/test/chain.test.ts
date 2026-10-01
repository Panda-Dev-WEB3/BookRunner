import { describe, expect, test } from "bun:test";
import { createLogger } from "@bookrunner/shared";
import { mockOrderlyVaultAbi, orderlyAdapterAbi } from "@bookrunner/shared/abi";
import { type Address, encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Hex, type Log, parseAbi, type PublicClient } from "viem";
import { DepositIndexer, decodeVaultDepositCalldata, decodeVaultDepositLog } from "../src/chain";
import { MockVenue } from "../src/venue";

const VAULT = "0x00000000000000000000000000000000000000f1" as Address;
const ADAPTER = "0x00000000000000000000000000000000000000a1" as Address;
const IF_ID = `0x${"11".repeat(32)}` as Hex;
const MM_ID = `0x${"22".repeat(32)}` as Hex;

const accountDeposit = parseAbi(["event AccountDeposit(bytes32 indexed accountId, address indexed userAddress, uint64 indexed depositNonce, bytes32 tokenHash, uint128 tokenAmount)"]);

function log(address: Address, topics: Hex[], data: Hex, tx: Hex, logIndex: number): Log {
  return { address, topics: topics as [Hex, ...Hex[]], data, transactionHash: tx, logIndex, blockNumber: 5n, blockHash: `0x${"00".repeat(32)}`, transactionIndex: 0, removed: false } as Log;
}

const depositLog = (accountId: Hex, amount: bigint, tx: Hex, i: number) =>
  log(VAULT, encodeEventTopics({ abi: accountDeposit, eventName: "AccountDeposit", args: { accountId, userAddress: ADAPTER, depositNonce: 1n } }) as Hex[], encodeAbiParameters([{ type: "bytes32" }, { type: "uint128" }], [`0x${"cc".repeat(32)}`, amount]), tx, i);

const venueDepositLog = (account: number, amount: bigint, tx: Hex, i: number) =>
  log(ADAPTER, encodeEventTopics({ abi: orderlyAdapterAbi, eventName: "VenueDeposit", args: { account } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [amount]), tx, i);

function indexer(venue: MockVenue, txs: Record<string, { to: Address; input: Hex }> = {}) {
  const client = {
    getTransaction: async ({ hash }: { hash: Hex }) => txs[hash] ?? { to: null, input: "0x" },
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => (functionName === "accountId" ? (args?.[0] === 0 ? IF_ID : MM_ID) : functionName === "venueKind" ? 0 : []),
  } as unknown as PublicClient;
  const ix = new DepositIndexer({ venue, chainId: 31337, rpcUrl: "http://x", log: createLogger("t", "silent"), client, loadDeployment: () => null });
  return ix;
}

describe("defensive deposit decoding", () => {
  test("Orderly AccountDeposit event shape", () => {
    expect(decodeVaultDepositLog(depositLog(IF_ID, 25_000_000_000n, "0x01", 0))).toEqual({ accountId: IF_ID, amount: 25_000_000_000n });
  });

  test("IOrderlyVault.deposit calldata", () => {
    const input = encodeFunctionData({ abi: mockOrderlyVaultAbi, functionName: "deposit", args: [{ accountId: MM_ID, brokerHash: `0x${"00".repeat(32)}`, tokenHash: `0x${"00".repeat(32)}`, tokenAmount: 7n }] });
    expect(decodeVaultDepositCalldata(input)).toEqual({ accountId: MM_ID, amount: 7n });
    expect(decodeVaultDepositCalldata("0xdeadbeef")).toBeNull();
  });

  test("vault event + adapter VenueDeposit in the same tx credit once; adapter-only deposits still credit", async () => {
    const venue = new MockVenue();
    const ix = indexer(venue);
    await ix.discover({ chainId: 31337, startBlock: 0, contracts: { factory: "0x0000000000000000000000000000000000000001" } as never, stockTokens: {}, books: [{ bookId: 1, name: "NVDA", symbol: "PERP_NVDA_USDC", venue: 0, components: { adapter: ADAPTER } as never }] });
    const n = await ix.processLogs([depositLog(IF_ID, 25_000_000_000n, "0x01", 0), venueDepositLog(0, 25_000_000_000n, "0x01", 1), venueDepositLog(1, 75_000_000_000n, "0x02", 0)], VAULT);
    expect(n).toBe(2);
    expect(venue.getAccount(IF_ID).holding).toBe(25_000_000_000);
    expect(venue.getAccount(MM_ID).holding).toBe(75_000_000_000);
    expect(venue.getAccount(IF_ID).owner).toBe(ADAPTER.toLowerCase());
    // replay is idempotent
    expect(await ix.processLogs([depositLog(IF_ID, 25_000_000_000n, "0x01", 0), venueDepositLog(1, 75_000_000_000n, "0x02", 0)], VAULT)).toBe(0);
  });

  test("unknown vault event shape falls back to direct-call calldata", async () => {
    const venue = new MockVenue();
    const input = encodeFunctionData({ abi: mockOrderlyVaultAbi, functionName: "deposit", args: [{ accountId: MM_ID, brokerHash: `0x${"00".repeat(32)}`, tokenHash: `0x${"00".repeat(32)}`, tokenAmount: 5_000_000n }] });
    const ix = indexer(venue, { "0x03": { to: VAULT, input } });
    const weird = log(VAULT, [`0x${"ee".repeat(32)}`], "0x", "0x03", 0);
    expect(await ix.processLogs([weird], VAULT)).toBe(1);
    expect(venue.getAccount(MM_ID).holding).toBe(5_000_000);
  });
});
