// Pull oracle against the PRODUCTION AttestedOracle + BookrunnerConfig (BKRN_IT=1; artifacts from
// contracts/out, i.e. `bash scripts/forge.sh build` first) on a PRIVATE anvil (AGENT_IT_PULL_ANVIL_PORT,
// default 8621; never the shared devnet). The engine / desk are the test fixtures (test/fixtures/sol),
// relaying to the real oracle exactly like PoolEngine / BookrunnerDesk do:
//   - the shared encodePriceData + EIP-712 price signatures verify in AttestedOracle.update (anyone
//     relays); not-newer / replayed entries are skipped, stale-on-arrival skipped, a wrong signer or a
//     garbage signature on a newer entry reverts BadSigner;
//   - DeskClient sends SetQuote as executeWithPrices with the freshest bundle (passes where plain execute
//     is off-hours on the stale stored price), falls back to execute on a rejected bundle;
//   - EngineTrader carries priceData through trade(..., priceData) / liquidate(..., priceData): the
//     maxTradePriceAge bound on new risk, reductions on the stored price, liquidation at the carried price;
//   - the shared VenueReport typed data equals OrderlyAdapter.hashReport (LOW_GAS.md §2).
//   BKRN_IT=1 bun test test/pull.it.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type OracleBundleMsg,
  type OraclePriceMsg,
  type PriceUpdate,
  devAccount,
  encodePriceData,
  priceId,
  priceTypedData,
  publicClientFor,
  usd,
  venueReportTypedData,
  walletClientFor,
} from "@bookrunner/shared";
import { attestedOracleAbi, bookrunnerConfigAbi, orderlyAdapterAbi } from "@bookrunner/shared/abi";
import type { Subprocess } from "bun";
import { type Abi, type Address, type Hex, type PublicClient, hashTypedData, keccak256, parseEventLogs, toHex } from "viem";
import { encodeSetQuote } from "../src/chain/desk-actions";
import { DeskClient } from "../src/chain/desk-client";
import { EXECUTE_WITH_PRICES_SIG, LIQUIDATE_WITH_PRICES_SIG, ORACLE_UPDATE_SIG, TRADE_WITH_PRICES_SIG, supportsFunction } from "../src/chain/lowgas-abi";
import { type BundleSource, PullPrices, deskPriceData, toPriceData } from "../src/chain/pull-prices";
import { EngineTrader } from "../src/sim/engine-trader";
import { acceptablePriceWad, classifyTradeError, engineFillPriceWad } from "../src/sim/trader-logic";
import { revertName } from "../src/util";
import { fixtureAdapter, fixtureDesk, fixtureEngine, fixtureUSDC } from "./fixtures/agent-fixtures";
import { silentLog } from "./helpers";

const IT = process.env.BKRN_IT === "1";
const PORT = Number(process.env.AGENT_IT_PULL_ANVIL_PORT ?? 8621);
const RPC = `http://127.0.0.1:${PORT}`;
const OUT = resolve(import.meta.dir, "../../../contracts/out");
const NVDA = priceId("NVDA");
const TSLA = priceId("TSLA");
const UNIT = 10n ** 18n;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const p = resolve(OUT, file, `${name}.json`);
  if (!existsSync(p)) throw new Error(`${p} missing: run \`bash scripts/forge.sh build\` before BKRN_IT=1`);
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

describe.skipIf(!IT)("pull oracle on the production AttestedOracle (private anvil)", () => {
  let anvil: Subprocess | null = null;
  let pub: PublicClient;
  const deployer = devAccount("deployer");
  const oracleSigner = devAccount("oracleSigner");
  const deskKey = devAccount("deskKeyIndex");
  const relayer = devAccount("trader3"); // anyone may relay AttestedOracle.update
  const addr = {} as Record<"config" | "oracle" | "usdc" | "engine" | "adapter" | "desk" | "orderly", Address>;

  const head = async () => Number((await pub.getBlock()).timestamp);
  const warp = async (sec: number) => {
    await pub.request({ method: "evm_increaseTime", params: [toHex(sec)] } as never);
    await pub.request({ method: "evm_mine", params: [] } as never);
  };
  const latest = (u: Hex) => pub.readContract({ address: addr.oracle, abi: attestedOracleAbi, functionName: "latest", args: [u] });
  const upd = (underlying: Hex, price: number, at: number, over: Partial<PriceUpdate> = {}): PriceUpdate => ({
    underlying,
    priceWad: BigInt(Math.round(price * 1e6)) * 10n ** 12n,
    publishedAt: BigInt(at),
    held: false,
    sourceCount: 3,
    sourcesHash: keccak256(toHex(`${underlying}:${at}`)),
    ...over,
  });
  const sign = (u: PriceUpdate, by = oracleSigner) => by.signTypedData(priceTypedData(31337, addr.oracle, u));
  const bundleOf = async (us: PriceUpdate[], by = oracleSigner): Promise<OracleBundleMsg> => ({
    priceData: encodePriceData(us, await Promise.all(us.map((u) => sign(u, by)))),
    publishedAt: Math.max(...us.map((u) => Number(u.publishedAt))),
    chainId: 31337,
    oracle: addr.oracle,
    priceIds: us.map((u) => u.underlying),
  });
  const send = async (account: typeof deployer, address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const w = walletClientFor(31337, RPC, account);
    const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as never);
    const hash = await w.writeContract(request as never);
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  };
  const relay = (priceData: Hex) => send(relayer, addr.oracle, attestedOracleAbi as unknown as Abi, "update", [priceData]);

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
    const deploy = async (a: { abi: Abi | readonly unknown[]; bytecode: Hex }, args: unknown[]) => {
      const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args } as never);
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      if (!r.contractAddress) throw new Error("deploy failed");
      return r.contractAddress;
    };
    addr.config = await deploy(artifact("BookrunnerConfig.sol", "BookrunnerConfig"), [deployer.address]);
    addr.oracle = await deploy(artifact("AttestedOracle.sol", "AttestedOracle"), [addr.config, oracleSigner.address, `0x${"00".repeat(32)}`]);
    addr.orderly = await deploy(artifact("OrderlyAdapter.sol", "OrderlyAdapter"), [keccak256(toHex("woofi_pro")), keccak256(toHex("USDC"))]);
    addr.usdc = await deploy(fixtureUSDC, []);
    addr.engine = await deploy(fixtureEngine, [addr.usdc]);
    addr.adapter = await deploy(fixtureAdapter, [addr.engine]);
    addr.desk = await deploy(fixtureDesk, [addr.adapter, deskKey.address]);
    await send(deployer, addr.adapter, fixtureAdapter.abi as unknown as Abi, "setDesk", [addr.desk]);
    await send(deployer, addr.engine, fixtureEngine.abi as unknown as Abi, "setOracle", [addr.oracle, NVDA]);
    await send(deployer, addr.desk, fixtureDesk.abi as unknown as Abi, "setOracle", [addr.oracle, NVDA]);
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  test("deployed-code detection: the production oracle has update(bytes); the fixtures expose the overloads", async () => {
    expect(await supportsFunction(pub, addr.oracle, ORACLE_UPDATE_SIG)).toBe(true);
    expect(await supportsFunction(pub, addr.desk, EXECUTE_WITH_PRICES_SIG)).toBe(true);
    expect(await supportsFunction(pub, addr.engine, TRADE_WITH_PRICES_SIG)).toBe(true);
    expect(await supportsFunction(pub, addr.engine, LIQUIDATE_WITH_PRICES_SIG)).toBe(true);
    expect(await supportsFunction(pub, addr.usdc, ORACLE_UPDATE_SIG)).toBe(false);
    const maxTradeAge = await pub.readContract({ address: addr.config, abi: bookrunnerConfigAbi, functionName: "maxTradePriceAge" });
    expect(Number(maxTradeAge)).toBe(15);
  });

  test("AttestedOracle.update: shared encoding verifies; replays / not-newer / stale-on-arrival skipped; bad signatures revert", async () => {
    const t = await head();
    const nv = upd(NVDA, 190.12, t);
    const b = await bundleOf([nv, upd(TSLA, 440, t - 400)]); // TSLA already older than maxPriceAge (300 s)
    await relay(b.priceData);
    expect(await latest(NVDA)).toEqual({ priceWad: nv.priceWad, publishedAt: BigInt(t), held: false, sourceCount: 3 });
    expect((await latest(TSLA)).publishedAt).toBe(0n); // skipped: stale on arrival

    // replay of the same bundle: no revert, no change
    const r = await relay(b.priceData);
    expect(parseEventLogs({ abi: attestedOracleAbi, logs: r.logs, eventName: "PricePushed" })).toHaveLength(0);

    // a signer that is not registered, on a NEWER entry: BadSigner(recovered)
    const forged = await bundleOf([upd(NVDA, 1, t + 1)], deployer);
    const e1 = await relay(forged.priceData).catch((e: unknown) => e);
    expect(revertName(e1)).toBe("BadSigner");
    // a garbage signature on a newer entry: BadSigner(0)
    const garbage = encodePriceData([upd(NVDA, 1, t + 1)], [`0x${"11".repeat(65)}`]);
    expect(revertName(await relay(garbage).catch((e: unknown) => e))).toBe("BadSigner");
    // signer clock ahead of the chain (> MAX_FUTURE_DRIFT): FuturePrice
    const future = await bundleOf([upd(NVDA, 191, t + 3_600)]);
    expect(revertName(await relay(future.priceData).catch((e: unknown) => e))).toBe("FuturePrice");
    expect((await latest(NVDA)).priceWad).toBe(nv.priceWad);
  }, 30_000);

  test("DeskClient: SetQuote rides executeWithPrices with the freshest bundle; rejected bundle -> plain execute", async () => {
    await warp(400); // the stored NVDA price is now older than maxPriceAge: the desk is off-hours on it
    const desk0 = new DeskClient(pub, walletClientFor(31337, RPC, deskKey), addr.desk, silentLog, 30_000);
    const offHours = await desk0.run(encodeSetQuote(12, 0, usd(50_000)), "stale-stored").catch((e: unknown) => e);
    expect(revertName(offHours)).toBe("OffHoursNewRisk");

    const t = await head();
    let nowMs = t * 1000;
    const older = await bundleOf([upd(NVDA, 100, t - 5)]);
    const newer = await bundleOf([upd(NVDA, 101, t)]);
    const streamMsg: OraclePriceMsg = (() => {
      const u = upd(NVDA, 100.5, t - 2);
      return { priceId: "NVDA", underlying: NVDA, priceWad: u.priceWad.toString(), price: 100.5, publishedAt: t - 2, held: false, sourceCount: 3, sources: [], sourcesHash: u.sourcesHash, signature: "0x" };
    })();
    streamMsg.signature = await sign(upd(NVDA, 100.5, t - 2));
    let redisBundle: OracleBundleMsg | null = older;
    let httpBundle: OracleBundleMsg | null = newer;
    const sources: BundleSource[] = [
      { name: "redis", get: async () => redisBundle },
      { name: "http", get: async () => httpBundle },
    ];
    const prices = new PullPrices({ sources, stream: () => [streamMsg], domain: { chainId: 31337, oracle: addr.oracle }, memoMs: 0, now: () => nowMs });
    const desk = new DeskClient(pub, walletClientFor(31337, RPC, deskKey), addr.desk, silentLog, 30_000, undefined, deskPriceData(prices, { bookPriceId: NVDA, componentPriceIds: async () => [], maxAgeSec: 60 }));
    const r1 = await desk.run(encodeSetQuote(12, 0, usd(50_000)), "pull");
    expect(r1.withPrices).toBe(true);
    expect(r1.receipt.status).toBe("success");
    expect((await latest(NVDA)).priceWad).toBe(101n * UNIT); // the freshest of redis / http / stream landed

    // skip empty work: with the stored price just landed (fresh, in-hours) the next SetQuote carries nothing
    const stored = async (id: Hex) => {
      const d = await latest(id);
      return { priceWad: d.priceWad, publishedAt: Number(d.publishedAt), held: d.held, sourceCount: d.sourceCount };
    };
    const lean = new DeskClient(
      pub,
      walletClientFor(31337, RPC, deskKey),
      addr.desk,
      silentLog,
      30_000,
      undefined,
      deskPriceData(prices, { bookPriceId: NVDA, componentPriceIds: async () => [], maxAgeSec: 60, stored, storedFreshSec: 120 }),
    );
    const rLean = await lean.run(encodeSetQuote(13, 0, usd(50_000)), "stored-fresh");
    expect(rLean.withPrices).toBe(false);
    expect(rLean.receipt.status).toBe("success");

    // the bundle is signed by a key the oracle does not know (signer rotated): retried as plain execute,
    // which passes on the price the previous tx stored
    nowMs += 2_000;
    redisBundle = await bundleOf([upd(NVDA, 99, t + 2)], deployer);
    httpBundle = null;
    const r2 = await desk.run(encodeSetQuote(14, 0, usd(50_000)), "rotated");
    expect(r2.withPrices).toBe(false);
    expect((await latest(NVDA)).priceWad).toBe(101n * UNIT);

    // nothing signed within the bound: plain execute without a simulation round trip on prices
    nowMs += 120_000;
    redisBundle = null;
    const r3 = await desk.run(encodeSetQuote(12, 0, usd(50_000)), "no-bundle");
    expect(r3.withPrices).toBe(false);
    console.log(`[gas] fixture desk SetQuote: executeWithPrices (1 fresh price) ${r1.receipt.gasUsed} vs plain execute ${r3.receipt.gasUsed}`);
  }, 60_000);

  test("EngineTrader: trade(..., priceData) under maxTradePriceAge, reductions on the stored price, liquidate(..., priceData)", async () => {
    const trader = new EngineTrader("trader0", pub, walletClientFor(31337, RPC, devAccount("trader0")), addr.engine, addr.usdc, silentLog, 30_000, true, { trade: true, liquidate: true });
    const victim = new EngineTrader("trader2", pub, walletClientFor(31337, RPC, devAccount("trader2")), addr.engine, addr.usdc, silentLog, 30_000, true, { trade: true, liquidate: true });
    await trader.ensureMargin(1n, usd(25_000), usd(100_000));
    await victim.ensureMargin(1n, usd(1_000), usd(10_000));
    const pool = await trader.poolView(1n);

    // a fresh signed price rides in the trade; the off-chain quote is what the engine fills at
    let t = await head();
    const sel = (u: PriceUpdate, sig: Hex) => toPriceData([{ update: u, sig, source: "test" }])!;
    const p1 = upd(NVDA, 100, t);
    const size = 10n * UNIT;
    const q1 = engineFillPriceWad(p1.priceWad, pool.spreadBps, pool.skewBps, size);
    await trader.trade(1n, size, acceptablePriceWad(q1, size, 20), sel(p1, await sign(p1)));
    expect((await trader.position(1n)).size).toBe(size);
    expect((await latest(NVDA)).priceWad).toBe(p1.priceWad);

    // 30 s later: new risk on the stored price (3-arg trade) is past maxTradePriceAge -> StalePrice
    await warp(30);
    const e1 = await trader.trade(1n, size, acceptablePriceWad(q1, size, 50)).catch((e: unknown) => e);
    expect(revertName(e1)).toBe("StalePrice");
    expect(classifyTradeError(revertName(e1), String(e1), { carriedPrice: false })).toBe("off_hours");
    // carrying a print that is newer than stored but already past maxTradePriceAge: stored, still rejected
    t = await head();
    const old = upd(NVDA, 100.2, t - 20);
    const e2 = await trader.trade(1n, size, acceptablePriceWad(q1, size, 50), sel(old, await sign(old))).catch((e: unknown) => e);
    expect(revertName(e2)).toBe("StalePrice");
    expect(classifyTradeError(revertName(e2), String(e2), { carriedPrice: true })).toBe("stale_price");
    // a reduction works on the stored (old) price without priceData
    const q0 = await trader.quotePrice(1n, -UNIT);
    await trader.trade(1n, -UNIT, acceptablePriceWad(q0, -UNIT, 50));
    expect((await trader.position(1n)).size).toBe(size - UNIT);
    // and new risk works again with a fresh carried price
    t = await head();
    const p2 = upd(NVDA, 100.4, t);
    const q2 = engineFillPriceWad(p2.priceWad, pool.spreadBps, pool.skewBps, size);
    await trader.trade(1n, size, acceptablePriceWad(q2, size, 20), sel(p2, await sign(p2)));
    expect((await trader.position(1n)).size).toBe(2n * size - UNIT);

    // victim: 50 units long on 1,000 USD margin; not liquidatable at the stored price
    t = await head();
    const p3 = upd(NVDA, 100, t + 1); // newer than p2 (same head second): a not-newer print would be skipped
    const big = 50n * UNIT;
    await victim.trade(1n, big, acceptablePriceWad(engineFillPriceWad(p3.priceWad, pool.spreadBps, pool.skewBps, big), big, 20), sel(p3, await sign(p3)));
    expect(await trader.liquidate(1n, victim.address)).toBeNull(); // simulated NotLiquidatable: no tx
    // an 18% drop carried in the liquidation itself: liquidated at the fresh price in one tx
    const crash = upd(NVDA, 82, t + 2);
    const hash = await trader.liquidate(1n, victim.address, sel(crash, await sign(crash)));
    expect(hash).not.toBeNull();
    expect((await victim.position(1n)).size).toBe(0n);
    expect((await latest(NVDA)).priceWad).toBe(crash.priceWad);
  }, 60_000);

  test("shared VenueReport typed data == OrderlyAdapter.hashReport (LOW_GAS.md §2 domain + typehash)", async () => {
    const r = { insuranceUsd: 25_000_000_000n, marginUsd: -1_234_567n, netExposureUsd: -40_000_000_000n, asOf: 1_790_000_000n };
    const onchain = await pub.readContract({ address: addr.orderly, abi: orderlyAdapterAbi, functionName: "hashReport", args: [r.insuranceUsd, r.marginUsd, r.netExposureUsd, r.asOf] });
    expect(hashTypedData(venueReportTypedData(31337, addr.orderly, r))).toBe(onchain);
    const typehash = await pub.readContract({ address: addr.orderly, abi: orderlyAdapterAbi, functionName: "REPORT_TYPEHASH" });
    expect(typehash).toBe(keccak256(toHex("VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)")));
  });
});
