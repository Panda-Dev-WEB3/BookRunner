// End-to-end on a PRIVATE anvil (never the shared one): BKRN_IT=1 [ANVIL_BIN=anvil] [IT_ANVIL_PORT=8591] bun test test/chain.it.test.ts
// Contracts: test/fixtures/FakeOrderlyStack.sol (stand-ins with the frozen IOrderlyAdapter events),
// compiled into test/fixtures/fake-orderly.json with Docker forge (solc 0.8.30), from the repo root:
//   bash scripts/forge.sh build --root /repo/services/ops-venue/test/fixtures --contracts /repo/services/ops-venue/test/fixtures \
//     --out /repo/services/ops-venue/test/fixtures/.out --cache-path /repo/services/ops-venue/test/fixtures/.cache --use 0.8.30
//   then {Name: {abi, bytecode: bytecode.object}} for FakeUSDC / FakeVault / FakeAdapter from .out (delete .out/.cache).
// Exercises: mock-orderly deposit indexer on real logs, ViemChain reads/writes (report, withdrawRequest,
// confirmWithdraw, operatorWithdraw, sweepToVault, mint + creditFees, sweepFees, forwardPendingFees,
// txState), the report hold, the withdraw saga (confirm before payout) and the fee saga (earmark first).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DepositIndexer } from "@bookrunner/mock-orderly";
import { ACCOUNT, type Deployment, devAccount, localChain } from "@bookrunner/shared";
import { type Abi, type Address, createPublicClient, createWalletClient, type Hex, http } from "viem";
import { ViemChain } from "../src/chain";
import fixture from "./fixtures/fake-orderly.json";
import { BUILDER_ID, log, makeCtx, SYMBOL, trackedBook } from "./helpers";
import { keyFromSecret } from "../src/orderly/auth";
import { BookRegistry } from "../src/worker/books";
import { FeeSweeper } from "../src/worker/fees";
import { LogWatcher } from "../src/worker/logs";
import { loadOrCreateBuilderKey, Provisioner } from "../src/worker/provision";
import { Reporter } from "../src/worker/reporter";
import { WithdrawProcessor } from "../src/worker/withdrawals";

const enabled = process.env.BKRN_IT === "1";
const d = enabled ? describe : describe.skip;
const PORT = Number(process.env.IT_ANVIL_PORT ?? 8591);
const RPC = `http://127.0.0.1:${PORT}`;
const SINK_VAULT = "0x000000000000000000000000000000000000dEaD" as Address;
const SINK_ROUTER = "0x000000000000000000000000000000000000bEEF" as Address;

d("ops-venue on a private anvil", () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const deployer = devAccount("deployer");
  const ops = devAccount("opsVenue");
  const pc = createPublicClient({ chain: localChain, transport: http(RPC), pollingInterval: 100 });
  const wc = createWalletClient({ chain: localChain, transport: http(RPC), account: deployer });
  const addr: Record<string, Address> = {};

  async function deploy(name: keyof typeof fixture, args: unknown[]): Promise<Address> {
    const f = fixture[name];
    const hash = await wc.deployContract({ abi: f.abi as Abi, bytecode: f.bytecode as Hex, args });
    const r = await pc.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
    return r.contractAddress;
  }
  async function call(name: keyof typeof fixture, address: Address, functionName: string, args: unknown[]) {
    const hash = await wc.writeContract({ address, abi: fixture[name].abi as Abi, functionName, args, chain: localChain });
    await pc.waitForTransactionReceipt({ hash });
  }
  const usdcBal = (who: Address) => pc.readContract({ address: addr.usdc as Address, abi: fixture.FakeUSDC.abi as Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

  beforeAll(async () => {
    proc = Bun.spawn([process.env.ANVIL_BIN ?? "anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await pc.getBlockNumber();
        break;
      } catch {
        await Bun.sleep(200);
      }
    }
    addr.usdc = await deploy("FakeUSDC", []);
    addr.vault = await deploy("FakeVault", [addr.usdc, ops.address]);
    addr.adapter = await deploy("FakeAdapter", [addr.usdc, addr.vault, SINK_VAULT, SINK_ROUTER, ops.address]);
    await call("FakeUSDC", addr.usdc, "mint", [deployer.address, 100_000_000_000n]);
    await call("FakeAdapter", addr.adapter, "depositToVenue", [ACCOUNT.IF, 25_000_000_000n]);
    await call("FakeAdapter", addr.adapter, "depositToVenue", [ACCOUNT.MM, 75_000_000_000n]);
  }, 60_000);

  afterAll(() => {
    proc?.kill();
  });

  test("deposits -> mock venue; report; withdraw saga; builder fee sweep", async () => {
    const dep = {
      chainId: 31337,
      startBlock: 0,
      contracts: { usdc: addr.usdc, orderlyVault: addr.vault, factory: "0x0000000000000000000000000000000000000001", config: "0x0000000000000000000000000000000000000002" },
      stockTokens: {},
      books: [{ bookId: 1, name: "NVDA", symbol: SYMBOL, venue: 0, components: { adapter: addr.adapter } }],
    } as unknown as Deployment;
    let now = Date.now();
    const t = await makeCtx({ now: () => now });
    const chain = new ViemChain(dep, ops, log, { chainId: 31337, rpcUrl: RPC, fallbackMarkInterval: 300, txPollMs: 100 });
    t.ctx.chain = chain;

    // 1) mock-orderly indexes the real deposit logs
    const ix = new DepositIndexer({ venue: t.mock.venue, chainId: 31337, rpcUrl: RPC, log, loadDeployment: () => dep });
    await ix.pollOnce();
    const accounts = await chain.accountIds(addr.adapter as Address);
    expect(t.mock.venue.getAccount(accounts.if).holding).toBe(25_000_000_000);
    expect(t.mock.venue.getAccount(accounts.mm).holding).toBe(75_000_000_000);
    await ix.pollOnce(); // idempotent
    expect(t.mock.venue.getAccount(accounts.mm).holding).toBe(75_000_000_000);

    // 2) provision + report
    const reg = new BookRegistry(t.ctx);
    const book = { ...trackedBook(), adapter: addr.adapter as Address, accounts };
    reg.books.set(1, book);
    await new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret)).ensure(book);
    t.mock.venue.setPrice("NVDA", 200, false);
    const reporter = new Reporter(t.ctx);
    t.ctx.settings.reportSettleSec = 3600; // deposits just landed: held while the venue may not reflect them
    expect(await reporter.report(book)).toBeNull();
    t.ctx.settings.reportSettleSec = 0;
    const tx = await reporter.report(book);
    expect(tx).toMatch(/^0x/);
    const ins = await pc.readContract({ address: addr.adapter as Address, abi: fixture.FakeAdapter.abi as Abi, functionName: "insuranceEquityUsd" });
    expect(ins).toBe(25_000_000_000n);

    // txState on a real node: mined / unknown hash with an unused nonce (dropped) / with a used nonce (replaced)
    const used = await pc.getTransactionCount({ address: ops.address });
    expect(await chain.txState({ hash: tx as Hex, nonce: used - 1, at: 0 })).toBe("success");
    const ghost = `0x${"ab".repeat(32)}` as Hex;
    expect(await chain.txState({ hash: ghost, nonce: used + 5, at: 0 })).toBe("dropped");
    expect(await chain.txState({ hash: ghost, nonce: 0, at: 0 })).toBe("replaced");

    // 3) withdraw: adapter.requestWithdraw(MM, 5k) -> saga -> venue request -> confirm -> vault pays adapter -> sweep to vault
    await call("FakeAdapter", addr.adapter as Address, "requestWithdraw", [ACCOUNT.MM, 5_000_000_000n]);
    expect(await reporter.report(book)).toBeNull(); // requested, not confirmed: no report
    const wp = new WithdrawProcessor(t.ctx, reg);
    const fees = new FeeSweeper(t.ctx, reg);
    const watcher = new LogWatcher(t.ctx, reg, {
      onAdapterLog: async (l) => {
        if (l.kind === "WithdrawRequested") await wp.onRequested(l);
        else fees.noteSwept(l.adapter, l.period, l.amount, l.block, l.txHash, l.logIndex);
      },
      onMandateLog: () => {},
    });
    await watcher.poll();
    await wp.processAll();
    const saga = Object.values(t.sagas.get().withdrawals)[0];
    expect(saga?.stage).toBe("swept");
    expect(saga?.txs?.confirm?.hash).toMatch(/^0x/);
    expect(await usdcBal(SINK_VAULT)).toBe(5_000_000_000n);
    expect(await pc.readContract({ address: addr.adapter as Address, abi: fixture.FakeAdapter.abi as Abi, functionName: "inTransitUsd" })).toBe(0n);
    expect((await chain.withdrawStatus(addr.adapter as Address, 1n)).status).toBe(2); // Confirmed
    expect(t.mock.venue.getAccount(accounts.mm).holding).toBe(70_000_000_000);
    await watcher.poll(); // replay-safe
    t.ctx.sagas.get().withdrawals = {}; // saga pruned / file lost: a replay of the confirmed request is ignored
    expect(await wp.onRequested({ kind: "WithdrawRequested", adapter: addr.adapter as Address, account: ACCOUNT.MM, amount: 5_000_000_000n, nonce: 1n, block: 1n, txHash: "0x01", logIndex: 0 })).toBeNull();

    // 4) builder fees: taker flow on the book's quote -> settlement -> earmark -> builder -> ops EOA -> adapter -> router
    t.mock.venue.placeOrder({ accountId: accounts.mm, keyId: null }, { symbol: SYMBOL, order_type: "LIMIT", side: "SELL", order_price: 200, order_quantity: 50 });
    t.mock.venue.externalTaker(SYMBOL, "BUY", 50);
    const rows = t.mock.venue.settleNow();
    const period = rows[0]?.period ?? 0;
    now = period * 1000 + 1000;
    const s = await fees.sweep(1, period);
    expect(s.stage).toBe("swept");
    expect(await usdcBal(SINK_ROUTER)).toBe(3_000_000n);
    expect(await pc.readContract({ address: addr.adapter as Address, abi: fixture.FakeAdapter.abi as Abi, functionName: "pendingFeesUsd" })).toBe(0n);
    expect(await fees.sweep(1, period)).toMatchObject({ stage: "swept" });
    expect(await usdcBal(SINK_ROUTER)).toBe(3_000_000n);
    expect(t.store.settlements).toHaveLength(1);
  }, 60_000);
});
