import { describe, expect, test } from "bun:test";
import { RECEIPT_KIND, hedgeAllowTree, usd, wad } from "@bookrunner/shared";
import { bookrunnerDeskAbi } from "@bookrunner/shared/abi";
import { type Address, type Hex, type Log, type TransactionReceipt, decodeAbiParameters, encodeAbiParameters, encodeEventTopics } from "viem";
import { type HedgeChain, Hedger } from "../src/agent/hedger";
import type { OraclePoint, StockTokenInfo } from "../src/chain/book-chain";
import { DESK_ACTION, type DeskAction } from "../src/chain/desk-actions";
import type { DeskRunResult, DeskRunner } from "../src/chain/desk-client";
import { type MmRecallInfo, planHedge, qtyForUsd } from "../src/domain/hedge-planner";
import { buildHedgeUniverse, defaultAllowPairs } from "../src/domain/hedge-universe";
import { FakeStore, nvdaMandate, silentLog } from "./helpers";

const DESK = "0x00000000000000000000000000000000000000d1" as Address;
const NVDA = "0x00000000000000000000000000000000000000a1" as Address;
const PRICE_ID = ("0x" + "4e564441".padEnd(64, "0")) as Hex;

class FakeHedgeChain implements HedgeChain {
  usdc = usd(100_000);
  hedge = 0n;
  balance = 0n;
  floatCap = 10n ** 30n;
  vaultIdle = usd(1_000_000);
  recall: MmRecallInfo | null = null;
  async vaultDeployable() {
    return this.vaultIdle;
  }
  async mmRecall() {
    return this.recall;
  }
  async deskHedgeUsd() {
    return this.hedge;
  }
  async deskValueUsd() {
    return this.usdc + this.hedge;
  }
  async deskUsdc() {
    return this.usdc;
  }
  async tokenBalance() {
    return this.balance;
  }
  async getToken(token: Address): Promise<StockTokenInfo> {
    return { token, priceId: PRICE_ID, multiplierWad: wad(1), decimals: 18, active: true, floatCapRaw: this.floatCap };
  }
  async oracleLatest(): Promise<OraclePoint> {
    return { priceWad: wad(190), publishedAt: 1, held: false, sourceCount: 3 };
  }
}

function hedgeLog(token: Address, buy: boolean, amountIn: bigint, amountOut: bigint, notionalUsd: bigint): Log {
  return {
    address: DESK,
    topics: encodeEventTopics({ abi: bookrunnerDeskAbi, eventName: "HedgeExecuted", args: { token } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [buy, amountIn, amountOut, notionalUsd]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as Log;
}

class FakeRunner implements DeskRunner {
  readonly key = "0x00000000000000000000000000000000000000c1" as Address;
  actions: DeskAction[] = [];
  constructor(private readonly chain: FakeHedgeChain) {}
  async execute(a: DeskAction): Promise<Hex> {
    return (await this.run(a)).hash;
  }
  async run(a: DeskAction): Promise<DeskRunResult> {
    this.actions.push(a);
    const hash = `0x${this.actions.length.toString(16).padStart(64, "0")}` as Hex;
    const logs: Log[] = [];
    if (a.kind === DESK_ACTION.FundDesk) {
      const [amount] = decodeAbiParameters([{ type: "uint256" }], a.data);
      // UnderwritingVault.fundDesk: amount > deployable() reverts InsufficientIdle
      if (amount > this.chain.vaultIdle) throw new Error(`execute reverted: InsufficientIdle(${amount}, ${this.chain.vaultIdle})`);
      this.chain.vaultIdle -= amount;
      this.chain.usdc += amount;
    }
    if (a.kind === DESK_ACTION.InventoryToVault) {
      const [, amount] = decodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], a.data);
      if (this.chain.recall?.sync) this.chain.vaultIdle += amount; // engine: settles in the call
      else if (this.chain.recall) this.chain.recall = { ...this.chain.recall, inFlightUsd: this.chain.recall.inFlightUsd + amount };
    }
    if (a.kind === DESK_ACTION.Hedge) {
      const [token, buy, amountIn] = decodeAbiParameters([{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint24" }, { type: "bytes32" }], a.data);
      const out = buy ? qtyForUsd(amountIn, wad(190), wad(1), 18) : (amountIn * 190n) / 10n ** 12n;
      logs.push(hedgeLog(token, buy, amountIn, out, buy ? amountIn : out));
    }
    return { hash, receipt: { logs, status: "success" } as unknown as TransactionReceipt };
  }
}

function setup(rootOverride?: Hex) {
  const chain = new FakeHedgeChain();
  const runner = new FakeRunner(chain);
  const store = new FakeStore();
  const comps = [{ token: NVDA, weightBps: 10_000 }];
  const root = rootOverride ?? hedgeAllowTree(defaultAllowPairs(comps)).root;
  const mandate = nvdaMandate({ hedgeAllowRoot: root });
  const hedger = new Hedger({
    bookId: 1,
    desk: DESK,
    chain,
    runner,
    store,
    universe: buildHedgeUniverse(comps, mandate.hedgeAllowRoot),
    cfg: { minTradeUsd: usd(250), slippageBps: 100, perpEnabled: false, returnDustUsd: usd(1) },
    poolFee: 3000,
    receiptsIntervalSec: 60,
    log: silentLog,
    now: () => 1_760_000_000_000,
  });
  return { chain, runner, store, hedger, mandate };
}

describe("Hedger (executor)", () => {
  test("under-hedged short book: FundDesk first, then Hedge buy; hedge row + receipt from the event", async () => {
    const { chain, runner, store, hedger, mandate } = setup();
    chain.usdc = usd(10_000);
    const plan = await hedger.cycle({ mandate, mode: "normal", offHours: false, netExposureUsd: -usd(40_000), allowAddHedge: true });
    expect(plan.action).toBe("buy");
    expect(runner.actions.map((a) => a.kind)).toEqual([DESK_ACTION.FundDesk, DESK_ACTION.Hedge]);
    const [fund] = decodeAbiParameters([{ type: "uint256" }], runner.actions[0]!.data);
    expect(fund).toBe(usd(24_000));
    expect(store.hedges.length).toBe(1);
    const h = store.hedges[0]!;
    expect(h.row.qtyRaw).toBe(qtyForUsd(usd(34_000), wad(190), wad(1), 18));
    expect(h.row.valueUsd).toBe(usd(34_000));
    expect(h.row.asset).toBe(NVDA);
    expect(h.receipt.kind).toBe(RECEIPT_KIND.HEDGE);
  });

  test("long exposure with held spot: Flatten (no proof needed), negative qty recorded", async () => {
    const { chain, runner, store, hedger, mandate } = setup();
    chain.balance = qtyForUsd(usd(10_000), wad(190), wad(1), 18);
    chain.hedge = usd(10_000);
    const plan = await hedger.cycle({ mandate, mode: "normal", offHours: false, netExposureUsd: usd(30_000), allowAddHedge: true });
    expect(plan.action).toBe("flatten");
    expect(runner.actions.map((a) => a.kind)).toEqual([DESK_ACTION.Flatten]);
    expect(runner.actions[0]!.proof).toEqual([]);
    expect(store.hedges[0]!.row.qtyRaw).toBe(-chain.balance);
  });

  test("allow-list mismatch: Hedge legs are skipped instead of sending reverting txs", async () => {
    const { runner, hedger, mandate } = setup(("0x" + "22".repeat(32)) as Hex);
    const plan = await hedger.cycle({ mandate, mode: "normal", offHours: false, netExposureUsd: -usd(40_000), allowAddHedge: true });
    expect(plan.reason).toBe("ALLOW_LIST_MISMATCH");
    expect(runner.actions.length).toBe(0);
  });

  test("stale venue valuation blocks legs that add hedge but not reducing ones", async () => {
    const { runner, hedger, mandate } = setup();
    const plan = await hedger.cycle({ mandate, mode: "normal", offHours: false, netExposureUsd: -usd(40_000), allowAddHedge: false });
    expect(plan.reason).toBe("STALE_VENUE_VALUATION");
    expect(runner.actions.length).toBe(0);
    const m = nvdaMandate();
    const sell = planHedge(
      {
        mandate: m,
        netExposureUsd: -usd(20_000),
        deskHedgeUsd: usd(30_000),
        perpHedgeUsd: 0n,
        deskUsdcUsd: 0n,
        deskValueUsd: usd(30_000),
        vaultDeployableUsd: 0n,
        components: [{ token: NVDA, assetId: PRICE_ID, weightBps: 10_000, decimals: 18, priceWad: wad(190), multiplierWad: wad(1), balanceRaw: qtyForUsd(usd(30_000), wad(190), wad(1), 18), floatCapRaw: 10n ** 30n, proof: [] }],
        offHours: false,
        mode: "normal",
        perpAllowed: false,
        allowAddHedge: false,
      },
      { minTradeUsd: usd(250), slippageBps: 100, perpEnabled: false, returnDustUsd: usd(1) },
    );
    expect(sell.action).toBe("sell");
  });

  test("live book with an empty vault (engine): recall MM margin, then FundDesk, then buy - FundDesk never reverts InsufficientIdle", async () => {
    const { chain, runner, store, hedger, mandate } = setup();
    chain.usdc = 0n;
    chain.vaultIdle = usd(1_069.836017); // fee-flow dust only: closeWindow deployed IF + MM
    chain.recall = { recallableUsd: usd(90_000), inFlightUsd: 0n, sync: true };
    const plan = await hedger.cycle({ mandate, mode: "normal", offHours: false, netExposureUsd: -usd(40_000), allowAddHedge: true });
    expect(plan.action).toBe("buy");
    expect(runner.actions.map((a) => a.kind)).toEqual([DESK_ACTION.InventoryToVault, DESK_ACTION.FundDesk, DESK_ACTION.Hedge]);
    const [account, recalled] = decodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], runner.actions[0]!.data);
    expect(account).toBe(1); // MM
    expect(recalled).toBe(usd(34_000) - usd(1_069.836017));
    expect(store.hedges.length).toBe(1);
  });

  test("live book with an empty vault (Orderly): recall once, wait while it is in flight, then hedge", async () => {
    const { chain, runner, hedger, mandate } = setup();
    chain.usdc = 0n;
    chain.vaultIdle = 0n;
    chain.recall = { recallableUsd: usd(60_000), inFlightUsd: 0n, sync: false };
    const ctx = { mandate, mode: "normal" as const, offHours: false, netExposureUsd: -usd(40_000), allowAddHedge: true };
    expect((await hedger.cycle(ctx)).action).toBe("recall");
    expect((await hedger.cycle(ctx)).reason).toBe("RECALL_IN_FLIGHT");
    expect(runner.actions.map((a) => a.kind)).toEqual([DESK_ACTION.InventoryToVault]);
    // ops-venue paid the withdrawal and swept it to the vault
    chain.vaultIdle = usd(34_000);
    chain.recall = { ...chain.recall, inFlightUsd: 0n };
    expect((await hedger.cycle(ctx)).action).toBe("buy");
    expect(runner.actions.map((a) => a.kind)).toEqual([DESK_ACTION.InventoryToVault, DESK_ACTION.FundDesk, DESK_ACTION.Hedge]);
  });

  test("Retiring (flatten mode): Flatten holdings then ReturnToVault the desk USDC", async () => {
    const { chain, runner, hedger, mandate } = setup();
    chain.balance = qtyForUsd(usd(5_000), wad(190), wad(1), 18);
    chain.hedge = usd(5_000);
    chain.usdc = usd(700);
    await hedger.cycle({ mandate, mode: "flatten", offHours: false, netExposureUsd: -usd(1_000), allowAddHedge: true });
    expect(runner.actions.map((a) => a.kind)).toEqual([DESK_ACTION.Flatten, DESK_ACTION.ReturnToVault]);
    const [ret] = decodeAbiParameters([{ type: "uint256" }], runner.actions[1]!.data);
    expect(ret).toBe(usd(700));
  });
});
