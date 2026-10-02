// On-chain integration against the real MarkRegistry / RevenueRouter / BkrnFeeRouter / Backstop /
// BookrunnerConfig bytecode (plus the core test mocks for factory + book) on a PRIVATE anvil.
//   BKRN_IT=1 BKRN_CONTRACTS_OUT=<forge out dir> [BKRN_IT_ANVIL_PORT=8611] bun test test/chain.it.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Deployment, VENUE, chainFor, createLogger, devAccount, roleAccount, splitDistribution, strToBytes32, usd, walletClientFor } from "@bookrunner/shared";
import {
  type BookRef,
  MemoryEventSink,
  type SettlementStore,
  SettlementRunner,
  type StoredDistribution,
  TxSender,
  UnionCandidates,
  WaterfallChainAdapter,
  describeRevert,
} from "@bookrunner/waterfall";
import { type Abi, type Address, type Hex, type PublicClient, createPublicClient, encodeFunctionData, erc20Abi, http, keccak256, stringToHex, zeroAddress } from "viem";
import { LocalMarkSigner, MarkChainAdapter } from "../src/index";

const OUT = process.env.BKRN_CONTRACTS_OUT ?? "";
const PORT = Number(process.env.BKRN_IT_ANVIL_PORT ?? 8611);
const RPC = `http://127.0.0.1:${PORT}`;
const ENABLED = process.env.BKRN_IT === "1" && OUT !== "" && existsSync(join(OUT, "MarkRegistry.sol/MarkRegistry.json"));

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

describe.skipIf(!ENABLED)("on-chain: RevenueRouter distribution + MarkRegistry commit", () => {
  const log = createLogger("chain-it", "silent");
  let anvil: ReturnType<typeof Bun.spawn> | null = null;
  const pc = createPublicClient({ chain: chainFor(31337, RPC), transport: http(RPC), pollingInterval: 50 }) as PublicClient;
  const deployer = devAccount("deployer");
  const dw = walletClientFor(31337, RPC, deployer);
  const keeper = roleAccount("keeper");
  const markSigner = roleAccount("markSigner");
  const vault = devAccount("allocator0").address;
  const expenseRecipient = devAccount("allocator1").address;
  const c = {} as Record<"config" | "usdc" | "bkrn" | "senior" | "junior" | "feeRouter" | "backstop" | "factory" | "book" | "markRegistry" | "router", Address>;
  let ref: BookRef;
  let deployment: Deployment;

  async function deploy(file: string, name: string, args: unknown[] = []): Promise<Address> {
    const a = artifact(file, name);
    const hash = await dw.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const r = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
    return r.contractAddress;
  }
  async function call(address: Address, file: string, name: string, fn: string, args: unknown[] = []) {
    const { abi } = artifact(file, name);
    const hash = await dw.sendTransaction({ to: address, data: encodeFunctionData({ abi, functionName: fn, args }) });
    const r = await pc.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (r.status !== "success") throw new Error(`${name}.${fn} reverted`);
  }

  beforeAll(async () => {
    anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await pc.getBlockNumber();
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    const CFG = ["BookrunnerConfig.sol", "BookrunnerConfig"] as const;
    c.config = await deploy(...CFG, [deployer.address]);
    c.usdc = await deploy("MockERC20.sol", "MockERC20", ["USD Coin", "USDC", 6]);
    c.bkrn = await deploy("MockERC20.sol", "MockERC20", ["Bookrunner", "BKRN", 18]);
    c.senior = await deploy("MockERC20.sol", "MockERC20", ["S", "S", 6]);
    c.junior = await deploy("MockERC20.sol", "MockERC20", ["J", "J", 6]);
    await call(c.config, ...CFG, "setAddress", [strToBytes32("usdc"), c.usdc]);
    await call(c.config, ...CFG, "setAddress", [strToBytes32("bkrn"), c.bkrn]);
    c.feeRouter = await deploy("BkrnFeeRouter.sol", "BkrnFeeRouter", [c.config]);
    c.backstop = await deploy("Backstop.sol", "Backstop", [c.config]);
    c.factory = await deploy("CoreMocks.sol", "CoreMockFactory");
    c.book = await deploy("CoreMocks.sol", "CoreMockBook");
    c.markRegistry = await deploy("MarkRegistry.sol", "MarkRegistry", [c.config]);
    const impl = await deploy("RevenueRouter.sol", "RevenueRouter");
    // EIP-1167 clone of the router implementation
    const cloneHash = await dw.sendTransaction({ data: `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex });
    c.router = (await pc.waitForTransactionReceipt({ hash: cloneHash, pollingInterval: 50 })).contractAddress as Address;

    for (const [k, v] of [
      ["feeRouter", c.feeRouter],
      ["backstop", c.backstop],
      ["factory", c.factory],
      ["markRegistry", c.markRegistry],
      ["expenseRecipient", expenseRecipient],
    ] as const) {
      await call(c.config, ...CFG, "setAddress", [strToBytes32(k), v]);
    }
    await call(c.config, ...CFG, "setParam", [strToBytes32("markInterval"), 300n]);
    await call(c.config, ...CFG, "setParam", [strToBytes32("maxMarkAge"), 3600n]);
    await call(c.config, ...CFG, "grantRole", [keccak256(stringToHex("KEEPER")), keeper.address]);
    await call(c.config, ...CFG, "grantRole", [keccak256(stringToHex("MARK_SIGNER")), markSigner.address]);

    const components = { book: c.book, senior: c.senior, junior: c.junior, vault, mandate: zeroAddress, router: c.router, desk: zeroAddress, adapter: zeroAddress };
    await call(c.book, "CoreMocks.sol", "CoreMockBook", "setComponents", [components]);
    await call(c.book, "CoreMocks.sol", "CoreMockBook", "setHurdle", [6000]);
    await call(c.factory, "CoreMocks.sol", "CoreMockFactory", "register", [1n, components]);
    await call(c.router, "RevenueRouter.sol", "RevenueRouter", "initialize", [c.config, 1n, c.book]);
    await call(c.senior, "MockERC20.sol", "MockERC20", "mint", [vault, usd("70000")]);
    await call(c.junior, "MockERC20.sol", "MockERC20", "mint", [vault, usd("30000")]);

    ref = { bookId: 1, venue: VENUE.POOL_ENGINE, components };
    deployment = { chainId: 31337, startBlock: 0, contracts: c as unknown as Deployment["contracts"], stockTokens: {}, books: [] };
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  test("waterfall: fee flow -> distribute(period) -> Distributed parity with splitDistribution; idempotent", async () => {
    // fee flow arrives at the router (push + notify)
    await call(c.usdc, "MockERC20.sol", "MockERC20", "mint", [c.router, usd("1000")]);
    await call(c.router, "RevenueRouter.sol", "RevenueRouter", "notifySettlement", [4, usd("1000")]);

    const sender = new TxSender(pc, walletClientFor(31337, RPC, keeper), log, { pollingIntervalMs: 50 });
    const adapter = new WaterfallChainAdapter({ pc, sender, deployment, candidates: new UnionCandidates([], log), logChunk: 1000n, logLookback: 0n });
    // the core mocks have no lifecycle / venue adapter: pin those two reads
    const chain = Object.assign(Object.create(adapter) as WaterfallChainAdapter, { bookState: async () => "Live" as const, feesSwept: async () => `0x${"ee".repeat(32)}` as Hex, receivedInTx: async () => [] });
    const rows = new Map<string, StoredDistribution>();
    const store: SettlementStore = {
      distributionFor: async (b, p) => rows.get(`${b}:${p}`) ?? null,
      insertDistribution: async (d) => void rows.set(`${d.bookId}:${d.period}`, { txHash: d.txHash, amounts: d.amounts }),
      insertReceived: async () => {},
    };
    const events = new MemoryEventSink();
    const runner = new SettlementRunner({
      books: { get: async () => ref },
      chain,
      store,
      venueOps: { enqueueSweep: async () => {}, sweepJobState: async () => "completed" },
      events,
      expensesFor: () => usd("1.00"),
      log,
      sweepWaitMs: 0,
      pollMs: 1,
    });
    const head = await pc.getBlock();
    const period = Math.floor(Number(head.timestamp) / 300) * 300;
    const out = await runner.run({ bookId: 1, period });
    expect(out.status).toBe("distributed");
    if (out.status !== "distributed") return;
    const expected = splitDistribution({ gross: usd("1000"), expensesRequested: usd("1"), expenseCapBps: 2000n, carryBps: 1000n, seniorHurdleBps: 6000n, seniorSupply: usd("70000"), juniorSupply: usd("30000") });
    expect(out.split).toEqual(expected);
    expect(out.parityMismatches).toEqual([]);
    expect(await pc.readContract({ address: c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] })).toBe(expected.senior + expected.junior);
    expect(await pc.readContract({ address: c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [expenseRecipient] })).toBe(expected.expenses);
    expect(events.events.map((e) => e.type)).toEqual(["distribution.paid"]);

    // fresh DB: the Distributed log is found on-chain, nothing is re-sent
    rows.clear();
    const again = await runner.run({ bookId: 1, period });
    expect(again).toMatchObject({ status: "already", source: "chain", txHash: out.txHash });
    // direct second distribute reverts (AlreadyDistributed) -> classified via the log re-check
    let reverted = false;
    try {
      await adapter.distribute(ref, period, 0n);
    } catch (err) {
      reverted = true;
      expect(describeRevert(err, artifact("RevenueRouter.sol", "RevenueRouter").abi).errorName).toBe("AlreadyDistributed");
    }
    expect(reverted).toBe(true);
  });

  test("mark: local EIP-712 digest == MarkRegistry.hashMark; commit accepted; same period refused", async () => {
    const sender = new TxSender(pc, walletClientFor(31337, RPC, markSigner), log, { pollingIntervalMs: 50 });
    const chain = new MarkChainAdapter(pc, sender, deployment);
    const signer = new LocalMarkSigner(markSigner, 31337, c.markRegistry as Address);
    const head = await pc.getBlock();
    const periodEnd = BigInt(Math.floor(Number(head.timestamp) / 300) * 300);
    const input = { bookId: 1n, periodEnd, navUsd: usd("101000"), deployedValueUsd: usd("100000"), flowNonce: 3n, inventoryRoot: `0x${"11".repeat(32)}` as Hex, pnlJsonHash: `0x${"22".repeat(32)}` as Hex, receiptsRoot: `0x${"33".repeat(32)}` as Hex };
    expect(await chain.hashMark(input)).toBe(signer.digest(input));
    const sig = await signer.sign(input);
    const committed = await chain.commit(input, sig);
    expect(committed.markId).toBe(1n);
    expect(await chain.commitTxOf(1n)).toBe(committed.hash);
    const latest = await chain.latestCommitted(ref);
    expect(latest).toMatchObject({ markId: 1n, periodEnd: Number(periodEnd), applied: false });
    expect(latest?.signer.toLowerCase()).toBe(markSigner.address.toLowerCase());
    expect(latest?.input).toEqual(input);
    expect(await chain.markInterval()).toBe(300);
    expect(await chain.maxMarkAge()).toBe(3600);
    // a second commit for the same period is refused by the registry (the pipeline maps this to "unmarkable")
    // while the first can still be applied (same flowNonce as the book; a stale one would be replaceable)
    await call(c.book, "CoreMocks.sol", "CoreMockBook", "setFlowNonce", [3n]);
    let err: unknown;
    try {
      await chain.commit(input, sig);
    } catch (e) {
      err = e;
    }
    expect(describeRevert(err, artifact("MarkRegistry.sol", "MarkRegistry").abi).errorName).toBe("PeriodNotAfterLast");
    // a signature from a non-signer is refused
    const other = new LocalMarkSigner(devAccount("risk"), 31337, c.markRegistry as Address);
    const next = { ...input, periodEnd: periodEnd + 300n };
    let err2: unknown;
    try {
      await chain.commit(next, await other.sign(next));
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeDefined();
  });
});
