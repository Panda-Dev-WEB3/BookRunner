// Chain smoke test (BKRN_IT=1): spawns a PRIVATE anvil (AGENT_IT_ANVIL_PORT, default 8619; never the
// shared devnet), deploys the test-only fixtures from test/fixtures/sol (frozen-interface signatures,
// simplified semantics) and drives the real viem adapters: DeskClient (simulate -> send -> receipt,
// custom-error decoding), EngineVenue + ViemEngineChain (SetQuote, change thresholds, Trade-event
// scanning with block timestamps) and the trader-sim EngineTrader (mint, approve, margin, trade).
//   BKRN_IT=1 bun test test/chain.it.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { devAccount, publicClientFor, usd, walletClientFor } from "@bookrunner/shared";
import type { Subprocess } from "bun";
import type { Address, Hex, PublicClient } from "viem";
import { encodeSetQuote } from "../src/chain/desk-actions";
import { DeskClient } from "../src/chain/desk-client";
import { ViemEngineChain } from "../src/chain/engine-chain";
import { EngineTrader } from "../src/sim/engine-trader";
import { acceptablePriceWad, engineGate } from "../src/sim/trader-logic";
import { revertName } from "../src/util";
import { DEFAULT_RESEND, EngineVenue, tradeToFill } from "../src/venues/engine";
import { fixtureAdapter, fixtureDesk, fixtureEngine, fixtureUSDC } from "./fixtures/agent-fixtures";
import { nvdaMandate, silentLog } from "./helpers";

const IT = process.env.BKRN_IT === "1";
const PORT = Number(process.env.AGENT_IT_ANVIL_PORT ?? 8619);
const RPC = `http://127.0.0.1:${PORT}`;
const mandate = nvdaMandate({ maxInventoryUsd: usd(75_000), minQuoteWidthBps: 10, maxSkewBps: 25 });

describe.skipIf(!IT)("agent chain adapters on a private anvil", () => {
  let anvil: Subprocess | null = null;
  let pub: PublicClient;
  const deployer = devAccount("deployer");
  const deskKey = devAccount("deskKeyIndex");
  const addr: Record<"usdc" | "engine" | "adapter" | "desk", Address> = { usdc: "0x", engine: "0x", adapter: "0x", desk: "0x" } as never;

  beforeAll(async () => {
    anvil = Bun.spawn([process.env.ANVIL_BIN ?? "anvil", "--port", String(PORT), "--accounts", "24", "--silent"], { stdout: "ignore", stderr: "ignore" });
    pub = publicClientFor(31337, RPC);
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    const w = walletClientFor(31337, RPC, deployer);
    const deploy = async (abi: readonly unknown[], bytecode: Hex, args: unknown[]) => {
      const hash = await w.deployContract({ abi, bytecode, args } as never);
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 200 });
      if (!r.contractAddress) throw new Error("deploy failed");
      return r.contractAddress;
    };
    addr.usdc = await deploy(fixtureUSDC.abi, fixtureUSDC.bytecode, []);
    addr.engine = await deploy(fixtureEngine.abi, fixtureEngine.bytecode, [addr.usdc]);
    addr.adapter = await deploy(fixtureAdapter.abi, fixtureAdapter.bytecode, [addr.engine]);
    addr.desk = await deploy(fixtureDesk.abi, fixtureDesk.bytecode, [addr.adapter, deskKey.address]);
    const h = await w.writeContract({ address: addr.adapter, abi: fixtureAdapter.abi, functionName: "setDesk", args: [addr.desk] });
    await pub.waitForTransactionReceipt({ hash: h, pollingInterval: 200 });
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  test("EngineVenue sends SetQuote through the desk key and respects change thresholds", async () => {
    const desk = new DeskClient(pub, walletClientFor(31337, RPC, deskKey), addr.desk, silentLog, 30_000);
    const chain = await ViemEngineChain.create(pub, addr.engine, addr.adapter, { lookbackBlocks: 100, chunkBlocks: 3, startBlock: 0 });
    let now = 1_000_000;
    const sent: string[] = [];
    const venue = new EngineVenue(
      { chain, desk, mandate: () => mandate, oraclePx: () => 100, symbol: "RHX5-PERP", now: () => now, onSent: (_p, reason, hash) => sent.push(`${reason}:${hash}`) },
      { ...DEFAULT_RESEND, failureBackoffMs: 15_000 },
    );
    const q = { bid: { px: 99.94, qty: 25 }, ask: { px: 100.06, qty: 25 }, oraclePx: 100, theoretical: { bidPx: 99.94, askPx: 100.06 } };
    await venue.replaceQuote(q);
    expect(await chain.readQuote()).toEqual({ spreadBps: 12, skewBps: 0, maxNetExposureUsd: usd(3_750) });
    now += 1_000;
    await venue.replaceQuote(q);
    expect(sent.length).toBe(1);
    now += 6_000;
    await venue.replaceQuote({ ...q, theoretical: { bidPx: 100.025, askPx: 100.145 } }); // skew +8.5 bps
    expect((await chain.readQuote())?.skewBps).toBe(8);
    expect(sent.length).toBe(2);
  }, 30_000);

  test("DeskClient decodes mandate custom errors and rejects non-keys before sending", async () => {
    const desk = new DeskClient(pub, walletClientFor(31337, RPC, deskKey), addr.desk, silentLog, 30_000);
    const err = await desk.run(encodeSetQuote(5, 0, 1n), "too-narrow").catch((e: unknown) => e);
    expect(revertName(err)).toBe("QuoteWidthTooNarrow");
    const stranger = new DeskClient(pub, walletClientFor(31337, RPC, devAccount("trader3")), addr.desk, silentLog, 30_000);
    const err2 = await stranger.run(encodeSetQuote(12, 0, 1n), "not-a-key").catch((e: unknown) => e);
    expect(revertName(err2)).toBe("NotDeskKey");
  }, 30_000);

  test("trader-sim EngineTrader opens a position; ViemEngineChain scans it as a book fill", async () => {
    const trader = new EngineTrader("trader0", pub, walletClientFor(31337, RPC, devAccount("trader0")), addr.engine, addr.usdc, silentLog, 30_000, true);
    await trader.ensureMargin(1n, usd(25_000), usd(100_000));
    expect((await trader.position(1n)).marginUsd).toBe(usd(25_000));
    const size = 10n * 10n ** 18n; // 10 units ~ 1,000 USD, inside the 3,750 USD capacity
    const quote = await trader.quotePrice(1n, size);
    await trader.trade(1n, size, acceptablePriceWad(quote, size, 50));
    const chain = await ViemEngineChain.create(pub, addr.engine, addr.adapter, { lookbackBlocks: 100, chunkBlocks: 3, startBlock: 0 });
    const trades = await chain.tradesSince(0);
    expect(trades.length).toBe(1);
    const fill = tradeToFill(trades[0]!, "RHX5-PERP");
    expect(fill.side).toBe("sell"); // trader bought from the pool
    expect(fill.qty).toBe(10);
    expect(fill.px).toBeCloseTo(Number(quote) / 1e18, 9); // oracle 100 * (1e4 + 12/2 + 8) / 1e4 after the SetQuote above
    expect(fill.px).toBeCloseTo(100.14, 9);
    expect(fill.trader).toBe(devAccount("trader0").address.toLowerCase());
    expect(fill.ts).toBeGreaterThan(0);
    expect(await chain.tradesSince(0)).toEqual([]); // cursor advanced
    const st = await chain.readState();
    expect(st.netExposureUsd).toBe(-usd(1_000));

    // pool now short 1k of a 3.75k cap: a 4k buy would breach the cap -> rejected on-chain;
    const big = 40n * 10n ** 18n;
    const q2 = await trader.quotePrice(1n, big);
    await expect(trader.trade(1n, big, acceptablePriceWad(q2, big, 50))).rejects.toThrow();
    // the sim's pre-trade gate steers to the reducing side once the cap is near
    const pool = await trader.poolView(1n);
    expect(engineGate({ reduceOnly: pool.reduceOnly, oracleHeld: false, oracleStale: false, poolExposureUsd: -3_500, maxNetExposureUsd: Number(pool.maxNetExposureUsd) / 1e6 }).forceSide).toBe("sell");
  }, 30_000);
});
