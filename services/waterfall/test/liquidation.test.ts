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
import { type EngineMarketCfg, type GasPolicy, type MarketRead, classifyRevert, gasAllowanceWei, priceUsed, usdToWei } from "../src/domain/liquidation";
import { type LiqCall, type LiquidationChain, LiquidationKeeper } from "../src/liquidationKeeper";

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
}

function keeper(o: { engine?: FakeEngine; signed?: SignedPrice | null; open?: string[]; gas?: Partial<GasPolicy>; now?: { ms: number } } = {}) {
  const engine = o.engine ?? new FakeEngine();
  const statuses: LiquidationKeeperStatus[] = [];
  const now = o.now ?? { ms: NOW };
  let openCalls = 0;
  const k = new LiquidationKeeper({
    chain: engine,
    openPositions: async () => {
      openCalls++;
      return (o.open ?? [ALICE, BOB]).map((trader) => ({ marketId: 1, trader }));
    },
    signedPrices: async () => (o.signed ? new Map([[PID.toLowerCase(), o.signed]]) : new Map()),
    writeStatus: async (s) => {
      statuses.push(s);
    },
    gas: { ethUsdWad: 3_000n * WAD, marginUsd: U(0.5), maxTxWei: 2n * 10n ** 15n, hourlyWei: 2n * 10n ** 16n, ...o.gas },
    keeper: "0x000000000000000000000000000000000000beef",
    log,
    intervalMs: 10_000,
    idleIntervalMs: 60_000,
    maxTxPerPass: 10,
    maxPositions: 1000,
    now: () => now.ms,
  });
  return { k, engine, statuses, now, openCalls: () => openCalls };
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

  test("gas guard: never more than reward + margin; per-tx and hourly caps; cap-only without ETH/USD", async () => {
    // reward 2.325 + margin 0.5 at 3000 USD/ETH = 9.416...e14 wei
    const allowance = usdToWei(U(2.825), 3_000n * WAD);
    const pol: GasPolicy = { ethUsdWad: 3_000n * WAD, marginUsd: U(0.5), maxTxWei: 10n ** 16n, hourlyWei: 10n ** 17n };
    expect(gasAllowanceWei(pol, U(2.325), 0n)).toBe(allowance);
    expect(gasAllowanceWei({ ...pol, maxTxWei: 1000n }, U(2.325), 0n)).toBe(1000n);
    expect(gasAllowanceWei(pol, U(2.325), 10n ** 17n)).toBe(0n); // hourly budget spent
    expect(gasAllowanceWei({ ...pol, ethUsdWad: 0n }, U(2.325), 0n)).toBe(10n ** 16n);

    const engine = new FakeEngine();
    engine.positions.set(ALICE, ALICE_110);
    engine.price = allowance / engine.gas + 1n; // just above
    const { k, statuses } = keeper({ engine, signed: await sign(93n * WAD, sec - 2), gas: { maxTxWei: 10n ** 16n } });
    await k.tick();
    expect(engine.sent).toEqual([]);
    expect(statuses[0]?.backlog[0]).toMatchObject({ reason: "gas_guard" });
    engine.price = allowance / engine.gas; // within
    await k.tick();
    expect(engine.sent).toHaveLength(1);
  });

  test("the hourly budget counts what was spent", async () => {
    const engine = new FakeEngine();
    engine.positions.set(ALICE, ALICE_110);
    engine.positions.set(BOB, { ...ALICE_110 });
    const { k } = keeper({ engine, signed: await sign(93n * WAD, sec - 2), gas: { hourlyWei: engine.gas * engine.price } });
    await k.tick();
    expect(engine.sent).toHaveLength(1); // the second would exceed the hour's budget
  });
});
