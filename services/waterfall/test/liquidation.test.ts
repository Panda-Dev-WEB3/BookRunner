// Liquidation keeper (2026-10 in-house engine markets) against a fake engine: detection at the fresh signed price with
// its priceData attached, the race (someone else liquidated first), the off-hours requirement (2 x initial margin while
// held) and the settled-market rule (maintenance), forceClose for settled / wind-down markets, the gas guard (reward +
// margin, per-tx and hourly caps), failures, the status written for alerts and the cadence.
import { describe, expect, test } from "bun:test";
import { createLogger, priceTypedData, strToBytes32 } from "@bookrunner/shared";
import { poolEngineAbi } from "@bookrunner/shared/abi";
import type { EnginePosition } from "@bookrunner/shared/engineMath";
import type { LiquidationKeeperStatus } from "@bookrunner/shared/liquidationKeeper";
import { type SignedPrice, signedPriceFor } from "@bookrunner/shared/signedPrice";
import { encodePriceData, type PriceUpdate } from "@bookrunner/shared/eip712";
import { BaseError, type Hex, encodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { liquidationEthUsd, loadWaterfallConfig } from "../src/config";
import { type EngineMarketCfg, type GasPolicy, type KeeperAction, type MarketRead, byStake, classifyRevert, gasDecision, priceUsed, usdToWei } from "../src/domain/liquidation";
import { TxRevertedError } from "../src/kit/tx";
import { type LiqCall, type LiquidationChain, LiquidationKeeper, type TraderRef } from "../src/liquidationKeeper";

const log = createLogger("liquidation-test", "silent");
const WAD = 10n ** 18n;
const U = (n: number) => BigInt(Math.round(n * 1e6));
const PID = strToBytes32("NVDA");
const NOW = 1_790_000_000_000;
const sec = NOW / 1000;
const ALICE = "0x0000000000000000000000000000000000000a11";
const BOB = "0x0000000000000000000000000000000000000b0b";
const ORACLE = "0x00000000000000000000000000000000000000c8" as const;
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

// PoolEngine.t.sol defaults: IM 10 %, MM 5 %, liquidation fee 0.5 %
const CFG: EngineMarketCfg = { underlying: PID, initialMarginBps: 1000, maintenanceMarginBps: 500, liquidationFeeBps: 50 };
// test_liquidate_feeSplit: deposit 110, long 10 at 100.05 -> margin 108.9995; test_offHours: 150 long, 300 short
const ALICE_110: EnginePosition = { size: 10n * WAD, entryPriceWad: 100_050_000_000_000_000_000n, marginUsd: 108_999_500n, fundingIndexAtEntry: 0n };
const ALICE_150: EnginePosition = { ...ALICE_110, marginUsd: 148_999_500n };
const BOB_300: EnginePosition = { size: -10n * WAD, entryPriceWad: 99_950_000_000_000_000_000n, marginUsd: 299_000_500n, fundingIndexAtEntry: 0n };

async function sign(price: bigint, at: number, held = false): Promise<SignedPrice> {
  const u: PriceUpdate = { underlying: PID, priceWad: price, publishedAt: BigInt(at), held, sourceCount: 1, sourcesHash: `0x${"11".repeat(32)}` as Hex };
  const sig = await signer.signTypedData(priceTypedData(31337, ORACLE, u));
  return signedPriceFor({ priceData: encodePriceData([u], [sig]), chainId: 31337, oracle: ORACLE }, [], PID, { chainId: 31337, oracle: ORACLE }) as SignedPrice;
}

class Revert extends BaseError {
  data: Hex;
  constructor(errorName: string, args: readonly unknown[]) {
    super(`reverted: ${errorName}`);
    this.data = encodeErrorResult({ abi: poolEngineAbi, errorName: errorName as never, args: args as never });
  }
}

class FakeEngine implements LiquidationChain {
  market: Omit<MarketRead, "cfg"> = { marketId: 1, fundingIndex: 0n, insuranceUsd: U(25_000), closeOutAfter: 0, stored: { priceWad: 100n * WAD, publishedAt: sec - 100, held: false }, settle: null };
  positions = new Map<string, EnginePosition>();
  reads = 0;
  configReads = 0;
  estimates: LiqCall[] = [];
  sent: LiqCall[] = [];
  gas = 200_000n;
  price = 10_000_000n; // 0.01 gwei
  estimateError: Error | null = null;
  sendError: Error | null = null;
  async readConfigs(ids: number[]) {
    this.configReads++;
    return { cfgs: new Map(ids.map((id) => [id, CFG] as const)), params: { maxPriceAge: 300, maxTradePriceAge: 15 } };
  }
  async readPass(_m: unknown, traders: Array<{ marketId: number; trader: string }>) {
    this.reads++;
    this.readPassSizes.push(traders.length);
    const positions = new Map<string, EnginePosition>();
    for (const t of traders) {
      const p = this.positions.get(t.trader.toLowerCase());
      if (p) positions.set(`${t.marketId}|${t.trader.toLowerCase()}`, p);
    }
    return { markets: new Map([[1, this.market]]), positions };
  }
  async estimate(call: LiqCall) {
    this.estimates.push(call);
    if (this.estimateError) throw this.estimateError;
    return this.gas;
  }
  async gasPrice() {
    return this.price;
  }
  async send(call: LiqCall, gas: bigint) {
    if (this.sendError) throw this.sendError;
    this.sent.push(call);
    expect(gas).toBe((this.gas * 13n) / 10n + 30_000n);
    return { hash: "0xabc" as Hex, costWei: this.gas * this.price };
  }
  readPassSizes: number[] = [];
}

const POLICY: GasPolicy = { ethUsdWad: 3_000n * WAD, marginUsd: U(0.5), maxTxWei: 2n * 10n ** 15n, hourlyWei: 2n * 10n ** 16n, badDebtOverrideUsd: U(50) };

function keeper(o: { engine?: FakeEngine; signed?: SignedPrice | null; open?: string[]; gas?: Partial<GasPolicy>; now?: { ms: number }; batchSize?: number; maxBatches?: number; reconcileMs?: number; rows?: Map<string, string> } = {}) {
  const engine = o.engine ?? new FakeEngine();
  const statuses: LiquidationKeeperStatus[] = [];
  const now = o.now ?? { ms: NOW };
  const rows = o.rows ?? new Map<string, string>();
  const repairs: Array<[number, string, string]> = [];
  let openCalls = 0;
  const k = new LiquidationKeeper({
    chain: engine,
    positions: {
      open: async (): Promise<TraderRef[]> => {
        openCalls++;
        return (o.open ?? [ALICE, BOB]).map((trader) => ({ marketId: 1, trader }));
      },
      all: async () => [...rows.entries()].map(([trader, sizeRaw]) => ({ marketId: 1, trader, sizeRaw })),
      repair: async (marketId, trader, sizeRaw) => {
        repairs.push([marketId, trader, sizeRaw]);
        rows.set(trader, sizeRaw);
      },
    },
    signedPrices: async () => (o.signed ? new Map([[PID.toLowerCase(), o.signed]]) : new Map()),
    writeStatus: async (s) => {
      statuses.push(s);
    },
    gas: { ...POLICY, ...o.gas },
    keeper: "0x000000000000000000000000000000000000beef",
    log,
    intervalMs: 10_000,
    idleIntervalMs: 60_000,
    maxTxPerPass: 10,
    batchSize: o.batchSize ?? 500,
    maxBatches: o.maxBatches ?? 10,
    reconcileMs: o.reconcileMs ?? 0,
    now: () => now.ms,
  });
  return { k, engine, statuses, now, repairs, openCalls: () => openCalls };
}

describe("liquidation keeper: detection", () => {
  test("liquidates only the position liquidatable at the fresh signed price, carrying that price", async () => {
    const signed = await sign(93n * WAD, sec - 2);
    const { k, engine, statuses } = keeper({ signed });
    engine.positions.set(ALICE, ALICE_110);
    engine.positions.set(BOB, BOB_300);
    expect(await k.tick()).toBe(10_000);
    expect(engine.reads).toBe(1);
    expect(engine.sent).toEqual([{ functionName: "liquidate", marketId: 1, trader: ALICE, priceData: signed.priceData }]);
    const s = statuses.at(-1)!;
    expect(s.lastPass).toMatchObject({ checked: 2, liquidated: 1, raced: 0 });
    expect(s.backlog).toEqual([]);
    // reward = half the nominal fee (930 * 0.5 % / 2), from the margin
    expect(s.totals.rewardsUsd).toBe("2.325000");
    expect(s.markets[0]).toMatchObject({ marketId: 1, regime: "open", openPositions: 2, priceAgeSec: 2 });
  });

  test("the stored price (100) does not liquidate: nothing is sent, not even an estimate", async () => {
    const { k, engine } = keeper({ signed: null });
    engine.positions.set(ALICE, ALICE_110);
    await k.tick();
    expect(engine.estimates).toEqual([]);
  });

  test("a signed print older than the stored one is not carried (priceData 0x); one past maxPriceAge neither", async () => {
    const engine = new FakeEngine();
    engine.market = { ...engine.market, stored: { priceWad: 93n * WAD, publishedAt: sec - 1, held: false } };
    engine.positions.set(ALICE, ALICE_110);
    const { k } = keeper({ engine, signed: await sign(100n * WAD, sec - 5) });
    await k.tick();
    expect(engine.sent[0]?.priceData).toBe("0x");
    const m: MarketRead = { ...engine.market, stored: { priceWad: 100n * WAD, publishedAt: sec - 1000, held: false }, cfg: CFG };
    expect(priceUsed(m, await sign(93n * WAD, sec - 301), sec, { maxPriceAge: 300, maxTradePriceAge: 15 })?.priceData).toBe("0x");
  });

  test("no open position: no chain read at all, idle cadence", async () => {
    const { k, engine, statuses } = keeper({ open: [] });
    expect(await k.tick()).toBe(60_000);
    expect(engine.reads + engine.configReads).toBe(0);
    expect(statuses[0]).toMatchObject({ markets: [], backlog: [] });
  });

  test("configs are read once and cached", async () => {
    const { k, engine } = keeper();
    engine.positions.set(BOB, BOB_300);
    await k.tick();
    await k.tick();
    expect(engine.configReads).toBe(1);
    expect(engine.reads).toBe(2);
  });
});

describe("liquidation keeper: the engine's rule", () => {
  test("off-hours (held): 2 x initial margin; the 150 long is liquidated at the held price, the 300 short is not; idle cadence", async () => {
    const signed = await sign(100n * WAD, sec - 2, true);
    const { k, engine } = keeper({ signed });
    engine.positions.set(ALICE, ALICE_150);
    engine.positions.set(BOB, BOB_300);
    expect(await k.tick()).toBe(10_000); // an action this pass keeps the fast cadence
    expect(engine.sent.map((c) => c.trader)).toEqual([ALICE]);
    engine.positions.delete(ALICE);
    expect(await k.tick()).toBe(60_000); // held and nothing to do: idle
    // the same 150 long in session (maintenance 5 %): untouched
    const open = keeper({ signed: await sign(100n * WAD, sec - 2, false) });
    open.engine.positions.set(ALICE, ALICE_150);
    await open.k.tick();
    expect(open.engine.sent).toEqual([]);
  });

  test("settled market (audit Task 7a): maintenance rule, and every other position is closed out with forceClose", async () => {
    const engine = new FakeEngine();
    engine.market = { ...engine.market, stored: { priceWad: 100n * WAD, publishedAt: sec - 3_600, held: true }, settle: { priceWad: 100n * WAD, effective: true } };
    engine.positions.set(ALICE, ALICE_150); // liquidatable while held, NOT under maintenance
    engine.positions.set(BOB, BOB_300);
    const { k, statuses } = keeper({ engine });
    await k.tick();
    expect(engine.sent.map((c) => [c.functionName, c.trader])).toEqual([
      ["forceClose", ALICE],
      ["forceClose", BOB],
    ]);
    expect(statuses[0]?.markets[0]?.regime).toBe("settled");
    // the settle price liquidates under maintenance
    engine.sent = [];
    engine.market = { ...engine.market, settle: { priceWad: 93n * WAD, effective: true } };
    engine.positions.set(ALICE, ALICE_110);
    await k.tick();
    expect(engine.sent[0]).toMatchObject({ functionName: "liquidate", trader: ALICE });
  });

  test("wind-down close-out: forceClose with a live fresh price only (never while held)", async () => {
    const engine = new FakeEngine();
    engine.market = { ...engine.market, closeOutAfter: sec - 10 };
    engine.positions.set(BOB, BOB_300);
    const live = keeper({ engine, signed: await sign(100n * WAD, sec - 2) });
    await live.k.tick();
    expect(engine.sent).toEqual([{ functionName: "forceClose", marketId: 1, trader: BOB, priceData: expect.any(String) }]);
    const heldEngine = new FakeEngine();
    heldEngine.market = { ...heldEngine.market, closeOutAfter: sec - 10 };
    heldEngine.positions.set(BOB, BOB_300);
    const held = keeper({ engine: heldEngine, signed: await sign(100n * WAD, sec - 2, true) });
    await held.k.tick();
    expect(heldEngine.sent).toEqual([]);
  });
});

describe("liquidation keeper: races, failures, gas guard", () => {
  test("race: NotLiquidatable / NoPosition at the estimate = someone else was first; no send, no failure, no backlog", async () => {
    const { k, engine, statuses } = keeper({ signed: await sign(93n * WAD, sec - 2) });
    engine.positions.set(ALICE, ALICE_110);
    engine.estimateError = new Revert("NotLiquidatable", [ALICE]);
    await k.tick();
    expect(engine.sent).toEqual([]);
    expect(statuses[0]).toMatchObject({ lastPass: { raced: 1 }, failures: { consecutive: 0 }, backlog: [] });
    expect(classifyRevert("NoPosition", "")).toBe("raced");
    expect(classifyRevert("StalePrice", "")).toBe("price");
    expect(classifyRevert(undefined, "out of gas")).toBe("failed");
  });

  test("a failed transaction stays in the backlog (since kept) and counts as a failure; a success resets it", async () => {
    const now = { ms: NOW };
    const { k, engine, statuses } = keeper({ signed: await sign(93n * WAD, sec - 2), now });
    engine.positions.set(ALICE, ALICE_110);
    engine.sendError = new Error("nonce too low");
    await k.tick();
    now.ms += 10_000;
    await k.tick();
    const s = statuses.at(-1)!;
    expect(s.failures).toMatchObject({ consecutive: 2, since: NOW, lastError: "nonce too low" });
    expect(s.backlog).toEqual([{ marketId: 1, trader: ALICE, action: "liquidate", since: NOW, reason: "failed", detail: "nonce too low" }]);
    engine.sendError = null;
    await k.tick();
    expect(statuses.at(-1)).toMatchObject({ failures: { consecutive: 0 }, backlog: [] });
  });

  test("a stale carried price is a price problem, retried, not a failure", async () => {
    const { k, engine, statuses } = keeper({ signed: await sign(93n * WAD, sec - 2) });
    engine.positions.set(ALICE, ALICE_110);
    engine.estimateError = new Revert("StalePrice", [PID, 1n]);
    await k.tick();
    expect(statuses[0]).toMatchObject({ failures: { consecutive: 0 }, backlog: [{ reason: "price" }] });
  });

});

// ------------------------------------------------------------------ review I-3: gas policy
const act = (o: Partial<KeeperAction>): KeeperAction => ({ marketId: 1, trader: ALICE, action: "liquidate", rewardUsd: 0n, badDebtUsd: 0n, equityUsd: 0n, requirementUsd: 0n, priceData: "0x", ...o });
// a dust long: 0.01 unit, margin 0.11 (liquidatable at 93, above water); a small and a large under-water long at 80
const DUST: EnginePosition = { size: WAD / 100n, entryPriceWad: ALICE_110.entryPriceWad, marginUsd: 110_000n, fundingIndexAtEntry: 0n };
const SMALL_UW: EnginePosition = { size: WAD / 10n, entryPriceWad: ALICE_110.entryPriceWad, marginUsd: 1_090_000n, fundingIndexAtEntry: 0n };
const CAROL = "0x0000000000000000000000000000000000000ca1";
const DAN = "0x0000000000000000000000000000000000000da1";

describe("gas policy (review I-3)", () => {
  const oneDollar = usdToWei(U(1), 3_000n * WAD);
  test("pays for itself: sent, never budget-limited; reward below the cost above water: dust, skipped", () => {
    expect(gasDecision(POLICY, act({ rewardUsd: U(2) }), oneDollar, POLICY.hourlyWei)).toEqual({ send: true, lossWei: 0n });
    expect(gasDecision(POLICY, act({ rewardUsd: U(0.75) }), oneDollar, 0n)).toMatchObject({ send: false, reason: "dust" });
    // a forceClose pays nothing but is a protocol duty: never dust, budget-limited
    expect(gasDecision(POLICY, act({ action: "forceClose" }), oneDollar / 4n, 0n)).toEqual({ send: true, lossWei: oneDollar / 4n });
    const dust = gasDecision(POLICY, act({ rewardUsd: U(0.01) }), oneDollar, 0n);
    expect(dust).toMatchObject({ send: false, reason: "dust" });
  });
  test("under water: large bad debt goes out whatever the hourly budget; small bad debt only while it lasts; never above what is at stake", () => {
    const spent = POLICY.hourlyWei; // budget gone
    expect(gasDecision(POLICY, act({ rewardUsd: 0n, badDebtUsd: U(91) }), oneDollar, spent)).toMatchObject({ send: true });
    expect(gasDecision(POLICY, act({ rewardUsd: 0n, badDebtUsd: U(1) }), oneDollar / 2n, spent)).toMatchObject({ send: false, reason: "gas_guard" });
    expect(gasDecision(POLICY, act({ rewardUsd: 0n, badDebtUsd: U(1) }), oneDollar / 2n, 0n)).toMatchObject({ send: true });
    expect(gasDecision(POLICY, act({ rewardUsd: 0n, badDebtUsd: U(0.1) }), oneDollar, 0n)).toMatchObject({ send: false, reason: "gas_guard" }); // costs more than at stake
    expect(gasDecision(POLICY, act({ rewardUsd: U(100), badDebtUsd: U(1000) }), POLICY.maxTxWei + 1n, spent)).toMatchObject({ send: false });
  });
  test("no ETH/USD (testnet): caps only, the override still bypasses the hourly budget", () => {
    const capOnly = { ...POLICY, ethUsdWad: 0n };
    expect(gasDecision(capOnly, act({ rewardUsd: U(5) }), 10n, capOnly.hourlyWei)).toMatchObject({ send: false });
    expect(gasDecision(capOnly, act({ badDebtUsd: U(60) }), 10n, capOnly.hourlyWei)).toMatchObject({ send: true });
  });
  test("candidates in order of what is at stake (max of reward and bad debt), liquidations before close-outs", () => {
    const xs = [act({ trader: "a", rewardUsd: U(1) }), act({ trader: "b", badDebtUsd: U(90) }), act({ trader: "c", action: "forceClose", badDebtUsd: U(500) }), act({ trader: "d", rewardUsd: U(5) })];
    expect(xs.sort(byStake).map((x) => x.trader)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("liquidation keeper: gas policy at work", () => {
  test("dust is skipped (backlog reason dust) while the real liquidation of the pass goes out", async () => {
    const engine = new FakeEngine();
    engine.price = 1_000_000_000n; // 1 gwei: 290k gas = 2.9e14 wei = ~0.87 USD
    engine.positions.set(ALICE, ALICE_110);
    engine.positions.set(CAROL, DUST);
    const { k, statuses } = keeper({ engine, open: [ALICE, CAROL], signed: await sign(93n * WAD, sec - 2) });
    await k.tick();
    expect(engine.sent.map((c) => c.trader)).toEqual([ALICE]);
    expect(statuses[0]?.backlog).toMatchObject([{ trader: CAROL, reason: "dust" }]);
  });

  test("an exhausted hourly budget never blocks a liquidation leaving bad debt above the override; the largest goes first", async () => {
    const engine = new FakeEngine();
    engine.price = 1_000_000_000n;
    engine.positions.set(CAROL, SMALL_UW);
    engine.positions.set(ALICE, ALICE_110); // under water at 80 by ~91 USD
    const { k, statuses } = keeper({ engine, open: [CAROL, ALICE], signed: await sign(80n * WAD, sec - 2), gas: { hourlyWei: 0n } });
    await k.tick();
    expect(engine.sent.map((c) => c.trader)).toEqual([ALICE]);
    expect(statuses[0]?.backlog).toMatchObject([{ trader: CAROL, reason: "gas_guard" }]);
  });

  test("a transaction that reverts on chain counts its gas against the hourly budget", async () => {
    const engine = new FakeEngine();
    engine.price = 1_000_000_000n;
    engine.positions.set(CAROL, SMALL_UW);
    engine.positions.set(DAN, { ...SMALL_UW });
    const burnt = 2n * 10n ** 14n;
    engine.sendError = new TxRevertedError("liquidate", "0xdead", burnt);
    // the budget fits one small under-water liquidation's loss plus nothing more
    const { k, statuses } = keeper({ engine, open: [CAROL, DAN], signed: await sign(80n * WAD, sec - 2), gas: { hourlyWei: 3n * 10n ** 14n } });
    await k.tick();
    const st = statuses[0]!;
    expect(st.totals.gasWei).toBe(burnt.toString());
    expect(st.backlog.map((b) => b.reason).sort()).toEqual(["failed", "gas_guard"]);
  });
});

// ------------------------------------------------------------------ review I-6: paging
describe("more open positions than one pass reads (review I-6)", () => {
  test("batches of batchSize per aggregate3; beyond maxBatches the positions are paged across passes and reported", async () => {
    const engine = new FakeEngine();
    const traders = Array.from({ length: 7 }, (_, i) => `0x${(0x100 + i).toString(16).padStart(40, "0")}`);
    for (const t of traders) engine.positions.set(t, BOB_300);
    const { k, statuses } = keeper({ engine, open: traders, batchSize: 2, maxBatches: 2 });
    await k.tick();
    expect(engine.readPassSizes).toEqual([2, 2]);
    expect(statuses[0]?.coverage).toMatchObject({ total: 7, checked: 4, truncated: true });
    expect(statuses[0]?.coverage.rotationSec).toBeGreaterThan(0);
    await k.tick();
    expect(engine.readPassSizes.slice(2)).toEqual([2, 2]);
    // every trader is read within two passes
    expect(statuses.at(-1)?.lastPass.checked).toBe(4);
    const all = keeper({ engine: new FakeEngine(), open: traders.slice(0, 3), batchSize: 2, maxBatches: 2 });
    await all.k.tick();
    expect(all.statuses[0]?.coverage).toMatchObject({ total: 3, checked: 3, truncated: false });
  });
});

// ------------------------------------------------------------------ review I-5: reconciliation
describe("reconciliation of the indexer's rows (review I-5)", () => {
  test("every row (size 0 too) is read on chain and its size repaired when it differs; at start, then every reconcileMs", async () => {
    const engine = new FakeEngine();
    engine.positions.set(ALICE, ALICE_110);
    engine.positions.set(BOB, { ...BOB_300, size: 0n });
    const rows = new Map([
      [ALICE, "0"], // a closing trade orphaned by a reorg left it at 0: open on chain
      [BOB, (-10n * WAD).toString()], // closed on chain
    ]);
    const now = { ms: NOW };
    const { k, statuses, repairs } = keeper({ engine, open: [], rows, reconcileMs: 600_000, now });
    await k.tick();
    expect(repairs).toEqual([
      [1, ALICE, (10n * WAD).toString()],
      [1, BOB, "0"],
    ]);
    expect(statuses[0]?.reconcile).toMatchObject({ checked: 2, repaired: 2, error: null });
    now.ms += 60_000;
    await k.tick();
    expect(repairs).toHaveLength(2); // not again before the interval
  });
});

// ------------------------------------------------------------------ review I-4: ETH/USD on mainnet
describe("ETH/USD of the gas policy (review I-4)", () => {
  test("mainnet with the keeper on refuses to start without it; a typo is refused; elsewhere 0 = caps only", () => {
    const base = loadWaterfallConfig({});
    expect(() => liquidationEthUsd({ ...base, CHAIN_ID: 4663 })).toThrow(/WATERFALL_LIQ_ETH_USD is required on mainnet/);
    expect(liquidationEthUsd({ ...base, CHAIN_ID: 4663, WATERFALL_LIQ_ENABLED: false })).toBe(0n);
    expect(liquidationEthUsd({ ...base, CHAIN_ID: 4663, WATERFALL_LIQ_ETH_USD: 3_000n * WAD })).toBe(3_000n * WAD);
    expect(liquidationEthUsd({ ...base, CHAIN_ID: 4663, WATERFALL_ETH_USD: 2_500n * WAD })).toBe(2_500n * WAD);
    expect(() => liquidationEthUsd({ ...base, CHAIN_ID: 4663, WATERFALL_LIQ_ETH_USD: 3n * WAD })).toThrow(/out of range/);
    expect(liquidationEthUsd({ ...base, CHAIN_ID: 46630 })).toBe(0n);
  });
});
