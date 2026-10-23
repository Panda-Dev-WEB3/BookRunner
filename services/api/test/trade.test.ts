// Trading page (2026-10): the PoolEngine math off-chain against vectors of contracts/test/engine/PoolEngine.t.sol
// (fill price, fee, margin after the fee, liquidation and off-hours requirement, margin ratio), the liquidation
// price against the engine predicate, the signed price a trade carries, the session states, the quote, the input
// refusals (reduce-only, off-hours, caps, split window / pending, leverage), and the prepared transactions (decoded
// and verified like the web does, tampered variants refused).
import { describe, expect, test } from "bun:test";
import { devAccount, priceTypedData, strToBytes32 } from "@bookrunner/shared";
import { attestedOracleAbi, poolEngineAbi } from "@bookrunner/shared/abi";
import { decodePriceData, encodePriceData, type PriceUpdate } from "@bookrunner/shared/eip712";
import { verifyPreparedTxs } from "@bookrunner/shared/preparedTx";
import { KEYS } from "@bookrunner/shared/queues";
import { TRPCError } from "@trpc/server";
import { type Address, type Hex, decodeFunctionData, encodeFunctionData, maxUint256 } from "viem";
import type { EngineMarketChainState } from "../src/chain/gateway";
import {
  type EnginePosition,
  WAD,
  fillPriceWad,
  isLiquidatable,
  liquidationPriceWad,
  marginRatioBps,
  maxWithdrawableUsd,
  newEntry,
  offHoursMarginBps,
  pnlUsd,
  requirementUsd,
  simulateTrade,
  traderEquityUsd,
} from "../src/domain/engine";
import { sessionOf, signedPriceFor, tradePrice } from "../src/domain/trade";
import { A } from "./fakes";
import { ALICE, NOW, type World, makeWorld } from "./fixtures";

const U = (n: number) => BigInt(Math.round(n * 1e6));
const UNITS = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const PX = 100n * WAD;
const sec = Math.floor(NOW / 1000);
const ORACLE = "0x00000000000000000000000000000000000000c8" as Address; // fakeDeployment().contracts.oracle
const ENGINE = "0x00000000000000000000000000000000000000cD" as Address; // fakeDeployment().contracts.poolEngine
const USDC = "0x00000000000000000000000000000000000000C2" as Address;
const ADAPTER = A(0xe8);
const PID = strToBytes32("NVDA");
const oracleKey = devAccount("oracleSigner");

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof TRPCError ? `${e.code}: ${e.message}` : String(e);
  }
};

// ------------------------------------------------------------------ PoolEngine.t.sol defaults (EngineBase._defaultCfg)
const MATH = {
  spreadBps: 10,
  skewBps: 0,
  takerFeeBps: 10,
  initialMarginBps: 1000,
  maintenanceMarginBps: 500,
  maxNetExposureUsd: U(75_000),
  inventoryCapUsd: U(75_000),
  longSize: 0n,
  shortSize: 0n,
  fundingIndex: 0n,
};
const flat = (marginUsd: bigint): EnginePosition => ({ size: 0n, entryPriceWad: 0n, marginUsd, fundingIndexAtEntry: 0n });
const opened = (marginUsd: bigint, size: bigint): EnginePosition => {
  const s = simulateTrade(MATH, flat(marginUsd), PX, size);
  return { size: s.newSize, entryPriceWad: s.newEntryWad, marginUsd: s.marginAfterUsd, fundingIndexAtEntry: 0n };
};

describe("engine math = PoolEngine.sol", () => {
  test("fill price: buy rounds up, sell down, skew shifts both sides", () => {
    expect(fillPriceWad(PX, 10, 0, WAD)).toBe(100_050_000_000_000_000_000n);
    expect(fillPriceWad(PX, 10, 0, -WAD)).toBe(99_950_000_000_000_000_000n);
    expect(fillPriceWad(PX, 10, 5, WAD)).toBe(100_100_000_000_000_000_000n);
    expect(fillPriceWad(PX, 10, -5, -WAD)).toBe(99_900_000_000_000_000_000n);
    expect(fillPriceWad(3n, 10, 0, WAD)).toBe(4n); // ceil
  });

  test("test_liquidate_feeSplit: margin 108.9995 after the fee; at 93 equity 38.4995 < 46.5, ratio 413 bps", () => {
    const s = simulateTrade(MATH, flat(U(110)), PX, UNITS(10));
    expect(s.fillPriceWad).toBe(100_050_000_000_000_000_000n);
    expect(s.feeUsd).toBe(1_000_500n);
    expect(s.marginAfterUsd).toBe(108_999_500n);
    expect(s.refusal).toBeNull();
    const p = opened(U(110), UNITS(10));
    const at93 = 93n * WAD;
    expect(traderEquityUsd(p, at93, 0n)).toBe(38_499_500n);
    expect(requirementUsd(p.size, at93, 500n)).toBe(46_500_000n);
    expect(isLiquidatable(p, at93, 0n, 500)).toBe(true);
    expect(marginRatioBps(p, at93, 0n)).toBe(Number((38_499_500n * 10_000n) / 930_000_000n));
  });

  test("test_offHours_maintenanceIsTwiceInitialMargin: 150 long is liquidatable while held, 300 short is not", () => {
    expect(offHoursMarginBps(1000)).toBe(2000);
    expect(offHoursMarginBps(6000)).toBe(10_000);
    const alice = opened(U(150), UNITS(10));
    const bob = opened(U(300), -UNITS(10));
    expect(isLiquidatable(alice, PX, 0n, 500)).toBe(false);
    expect(isLiquidatable(alice, PX, 0n, offHoursMarginBps(1000))).toBe(true);
    expect(isLiquidatable(bob, PX, 0n, offHoursMarginBps(1000))).toBe(false);
    // + 60 margin restores the off-hours requirement
    expect(isLiquidatable({ ...alice, marginUsd: alice.marginUsd + U(60) }, PX, 0n, 2000)).toBe(false);
  });

  test("liquidation price: the engine predicate flips exactly there (long at or below, short at or above)", () => {
    const long = opened(U(110), UNITS(10));
    const l = liquidationPriceWad(long, 0n, 500);
    expect(l.always).toBe(false);
    // closed form (100.05 * 1e4 - 108.9995 * 1e4 / 10) / 9500 = 93.8421...
    expect(Math.abs(Number(l.priceWad!) / 1e18 - (1_000_500 - 108_999.5) / 9_500)).toBeLessThan(1e-6);
    expect(isLiquidatable(long, l.priceWad!, 0n, 500)).toBe(true);
    expect(isLiquidatable(long, l.priceWad! + 1n, 0n, 500)).toBe(false);
    expect(isLiquidatable(long, 94n * WAD, 0n, 500)).toBe(false);

    const short = opened(U(110), -UNITS(10));
    const s = liquidationPriceWad(short, 0n, 500);
    expect(isLiquidatable(short, s.priceWad!, 0n, 500)).toBe(true);
    expect(isLiquidatable(short, s.priceWad! - 1n, 0n, 500)).toBe(false);
    expect(Number(s.priceWad!) / 1e18).toBeGreaterThan(105);

    // funding owed lowers the cushion: a long's liquidation price rises
    const owing = liquidationPriceWad({ ...long, fundingIndexAtEntry: -(10n ** 18n) * 10n ** 6n }, 0n, 500); // owes 1 USD per unit
    expect(owing.priceWad! > l.priceWad!).toBe(true);
    // fully collateralised long: no price liquidates it in session
    expect(liquidationPriceWad({ ...long, marginUsd: U(2000) }, 0n, 500)).toEqual({ priceWad: null, always: false });
    // requirement 100 % (off-hours with IM >= 50 %): a long under-collateralised at any price
    expect(liquidationPriceWad(long, 0n, 10_000).always).toBe(true);
  });

  test("average entry rounds against the trader; reductions keep it", () => {
    expect(newEntry(UNITS(1), UNITS(3), 100n * WAD, 103n * WAD)).toBe(102n * WAD);
    expect(newEntry(UNITS(1), UNITS(3), 100n * WAD, 101n * WAD)).toBe(100_666_666_666_666_666_667n); // long: up
    expect(newEntry(-UNITS(1), -UNITS(3), 100n * WAD, 101n * WAD)).toBe(100_666_666_666_666_666_666n); // short: down
    expect(newEntry(UNITS(3), UNITS(1), 100n * WAD, 1n)).toBe(100n * WAD);
    expect(newEntry(UNITS(1), -UNITS(1), 100n * WAD, 99n * WAD)).toBe(99n * WAD);
    expect(pnlUsd(-UNITS(1), 100n * WAD, 100n * WAD + 1n)).toBe(-1n); // floored against the trader
  });

  test("refusals: exposure cap, side cap, initial margin, reduction left liquidatable, settle shortfall", () => {
    expect(simulateTrade({ ...MATH, maxNetExposureUsd: U(500) }, flat(U(1000)), PX, UNITS(10)).refusal?.code).toBe("EXPOSURE_CAP");
    expect(simulateTrade({ ...MATH, inventoryCapUsd: U(500) }, flat(U(1000)), PX, UNITS(10)).refusal?.code).toBe("SIDE_CAP");
    const im = simulateTrade(MATH, flat(U(90)), PX, UNITS(10)).refusal;
    expect(im?.code).toBe("INITIAL_MARGIN");
    expect(im?.message).toContain("10x");
    // a quote without a wallet skips the margin checks
    expect(simulateTrade(MATH, flat(0n), PX, UNITS(10), false).refusal).toBeNull();
    const p = opened(U(110), UNITS(10));
    // price fell to 93: reducing by 1 leaves 9 units with equity under maintenance
    expect(simulateTrade(MATH, p, 93n * WAD, -UNITS(1)).refusal?.code).toBe("WOULD_BE_LIQUIDATABLE");
    expect(simulateTrade(MATH, p, 93n * WAD, -UNITS(10)).refusal).toBeNull(); // a full close is fine
    expect(simulateTrade(MATH, p, 945n * 10n ** 17n, -UNITS(1)).refusal).toBeNull(); // above it a reduction is fine
    expect(simulateTrade(MATH, p, 80n * WAD, -UNITS(10)).refusal?.code).toBe("SETTLE_SHORTFALL"); // loss beyond margin
    // a reduction is no new risk: caps do not apply
    expect(simulateTrade({ ...MATH, maxNetExposureUsd: 0n, inventoryCapUsd: 0n, longSize: p.size }, p, PX, -UNITS(5)).refusal).toBeNull();
  });

  test("safe max withdrawal keeps initial margin after a 1% adverse move", () => {
    const p = opened(U(500), UNITS(10));
    const max = maxWithdrawableUsd(MATH, p, PX);
    const adverse = 99n * WAD;
    const after = { ...p, marginUsd: p.marginUsd - max };
    expect(traderEquityUsd(after, adverse, 0n) >= requirementUsd(p.size, adverse, 1000n)).toBe(true);
    expect(traderEquityUsd({ ...after, marginUsd: after.marginUsd - U(1) }, adverse, 0n) < requirementUsd(p.size, adverse, 1000n)).toBe(true);
    expect(maxWithdrawableUsd(MATH, flat(U(42)), PX)).toBe(U(42));
    expect(maxWithdrawableUsd(MATH, opened(U(100), UNITS(10)), PX)).toBe(0n);
  });
});

// ------------------------------------------------------------------ signed price, session
async function signed(at: number, o: { price?: bigint; held?: boolean; underlying?: Hex } = {}): Promise<{ update: PriceUpdate; sig: Hex }> {
  const update: PriceUpdate = { underlying: o.underlying ?? PID, priceWad: o.price ?? PX, publishedAt: BigInt(at), held: o.held ?? false, sourceCount: 1, sourcesHash: `0x${"11".repeat(32)}` as Hex };
  return { update, sig: await oracleKey.signTypedData(priceTypedData(31337, ORACLE, update)) };
}
const bundleOf = (xs: Array<{ update: PriceUpdate; sig: Hex }>, o: { oracle?: Address } = {}) => ({
  priceData: encodePriceData(
    xs.map((x) => x.update),
    xs.map((x) => x.sig),
  ),
  publishedAt: Math.max(...xs.map((x) => Number(x.update.publishedAt))),
  chainId: 31337,
  oracle: o.oracle ?? ORACLE,
});
const domain = { chainId: 31337, oracle: ORACLE };

describe("signed price and session", () => {
  test("the freshest print of the market, re-encoded alone; another oracle's bundle is ignored", async () => {
    const tsla = await signed(sec - 1, { underlying: strToBytes32("TSLA") });
    const nvda = await signed(sec - 3);
    const b = bundleOf([tsla, nvda]);
    const s = signedPriceFor(b, [], PID, domain);
    expect(Number(s!.update.publishedAt)).toBe(sec - 3);
    expect(decodePriceData(s!.priceData).updates).toHaveLength(1);
    expect(signedPriceFor(bundleOf([nvda], { oracle: A(0x99) }), [], PID, domain)).toBeNull();
    // a newer per-key message wins over the bundle
    const msg = await signed(sec - 1);
    const m = { priceId: "NVDA", underlying: PID, priceWad: PX.toString(), publishedAt: sec - 1, held: false, sourceCount: 1, sourcesHash: msg.update.sourcesHash, signature: msg.sig };
    expect(Number(signedPriceFor(b, [m], PID, domain)!.update.publishedAt)).toBe(sec - 1);
  });

  test("the trade uses the signed print only when it is newer than the stored one", async () => {
    const s = signedPriceFor(bundleOf([await signed(sec - 2)]), [], PID, domain);
    expect(tradePrice({ stored: { priceWad: PX, publishedAt: sec - 100, held: false } }, s)).toMatchObject({ source: "signed", publishedAt: sec - 2 });
    expect(tradePrice({ stored: { priceWad: PX, publishedAt: sec - 1, held: false } }, s)).toMatchObject({ source: "stored", priceData: "0x" });
    expect(tradePrice({ stored: null }, null)).toBeNull();
  });

  test("session: closed > split window > no price > off-hours > stale > close-only states > open", () => {
    const price = { priceWad: PX, publishedAt: sec - 2, held: false, source: "signed" as const, priceData: "0x" as Hex };
    const base = { bookState: "Live", price, nowSec: sec, maxAgeSec: 15, reduceOnly: false, closeOutAfter: 0, lossBudgetBlocked: false, split: { pending: false, window: false } };
    expect(sessionOf(base)).toMatchObject({ session: "open", canTrade: true, newRisk: true });
    expect(sessionOf({ ...base, bookState: "Subscription" }).session).toBe("closed");
    expect(sessionOf({ ...base, split: { pending: true, window: true } }).session).toBe("split_window");
    expect(sessionOf({ ...base, price: { ...price, held: true } })).toMatchObject({ session: "off_hours", canTrade: false });
    expect(sessionOf({ ...base, price: { ...price, publishedAt: sec - 13 } }).session).toBe("no_fresh_price"); // 13 > 15 - 3 headroom
    expect(sessionOf({ ...base, reduceOnly: true })).toMatchObject({ session: "reduce_only", canTrade: true, newRisk: false });
    expect(sessionOf({ ...base, split: { pending: true, window: false } })).toMatchObject({ session: "split_close_only", newRisk: false });
    expect(sessionOf({ ...base, lossBudgetBlocked: true }).session).toBe("reduce_only");
    expect(sessionOf({ ...base, bookState: "Retiring" }).newRisk).toBe(false);
  });
});

// ------------------------------------------------------------------ router
function engineMarket(o: Partial<EngineMarketChainState> = {}, st: Partial<EngineMarketChainState["state"]> = {}): EngineMarketChainState {
  return {
    engine: ENGINE,
    adapter: ADAPTER,
    marketId: 1,
    nowSec: sec,
    config: {
      underlying: PID,
      symbol: strToBytes32("NVDA-PERP"),
      takerFeeBps: 10,
      makerFeeBps: 0,
      initialMarginBps: 1000,
      maintenanceMarginBps: 500,
      liquidationFeeBps: 50,
      fundingVelocityBps: 100,
      maxNetExposureUsd: U(75_000),
    },
    state: { spreadBps: 10, skewBps: 0, reduceOnly: false, longSize: 0n, shortSize: 0n, poolCashUsd: U(100_000), insuranceUsd: U(25_000), fundingIndex: 0n, ...st },
    inventoryCapUsd: U(75_000),
    closeOutAfter: 0,
    fundingRatePerDayWad: 0n,
    lossBudgetBlocked: false,
    stored: { priceWad: PX, publishedAt: sec - 100, held: false },
    maxPriceAge: 300,
    maxTradePriceAge: 15,
    ...o,
  };
}

async function world(o: { market?: Partial<EngineMarketChainState>; state?: Partial<EngineMarketChainState["state"]>; bookState?: string; printAgo?: number; held?: boolean } = {}): Promise<World> {
  const w = makeWorld();
  w.data.books.push({
    id: 7,
    charterId: 7,
    seniorAddr: A(0xe2).toLowerCase(),
    juniorAddr: A(0xe3).toLowerCase(),
    vaultAddr: A(0xe4).toLowerCase(),
    venue: 1,
    symbol: "NVDA-PERP",
    createdAt: new Date(NOW - 86_400_000),
    bookAddr: A(0xe1).toLowerCase(),
    mandateAddr: A(0xe5).toLowerCase(),
    routerAddr: A(0xe6).toLowerCase(),
    deskAddr: A(0xe7).toLowerCase(),
    adapterAddr: ADAPTER.toLowerCase(),
    underlying: PID,
    name: "NVDA perpetual",
    state: o.bookState ?? "Live",
    subscriptionEnds: new Date(NOW - 3_600_000),
    seniorNav: null,
    juniorNav: null,
    navUsd: null,
    lastMarkId: 0,
    updatedAt: new Date(NOW),
  } as never);
  w.chain.engineMarkets.set(ADAPTER.toLowerCase(), engineMarket(o.market, o.state));
  w.kv.put(KEYS.oracleBundle, bundleOf([await signed(sec - (o.printAgo ?? 2), { held: o.held })]));
  return w;
}

const setTrader = (w: World, p: EnginePosition, o: { balance?: bigint; allowance?: bigint } = {}) =>
  w.chain.engineTraders.set(`1|${ALICE.toLowerCase()}`, { position: p, usdcBalance: o.balance ?? U(10_000), usdcAllowance: o.allowance ?? 0n });
const check = (o: { amount?: bigint } = {}) => ({ chainId: 31337, targets: [ENGINE, USDC, ORACLE], account: ALICE, ...o });

describe("trade router: reads", () => {
  test("markets: the open engine market with its price, session, caps, fees and margins", async () => {
    const w = await world({ state: { longSize: UNITS(100), shortSize: -UNITS(40) } });
    const r = await w.caller.trade.markets();
    expect(r.chainReadable).toBe(true);
    expect(r.markets).toHaveLength(1);
    const m = r.markets[0]!;
    expect(m).toMatchObject({ marketId: 1, bookId: 7, symbol: "NVDA-PERP", session: "open", canTrade: true, tradePriceMaxAgeSeconds: 15 });
    expect(m.price).toMatchObject({ price: "100.0", source: "signed", ageSeconds: 2 });
    expect(m.quote).toMatchObject({ buyPrice: "100.05", sellPrice: "99.95" });
    expect(m.margin).toMatchObject({ maxLeverage: 10, holdableLeverage: 5, offHoursMarginBps: 2000 });
    expect(m.openInterest).toMatchObject({ longUsd: "10000.000000", shortUsd: "4000.000000", poolNetExposureUsd: "-6000.000000" });
    // buy room = min(75k - 10k, 75k - 6k), sell room = min(75k - 4k, 75k + 6k)
    expect(m.caps).toMatchObject({ buyRoomUsd: "65000.000000", sellRoomUsd: "71000.000000" });
    // the list reads the split gate at a basis rounded down to 30 s
    expect(w.chain.splitCalls[0]!.basisAt % 30).toBe(0);
  });

  test("no market open yet: engine books not live are not listed; the chain down is not an error", async () => {
    expect((await (await world({ bookState: "Subscription" })).caller.trade.markets()).markets).toEqual([]);
    const w = makeWorld();
    expect((await w.caller.trade.markets()).markets).toEqual([]);
    w.chain.failAll = true;
    expect(await w.caller.trade.markets()).toMatchObject({ chainReadable: true, markets: [] }); // no engine book: no chain read
    const down = await world();
    down.chain.failAll = true;
    expect(await down.caller.trade.markets()).toMatchObject({ chainReadable: false, markets: [] });
    expect(await code((await world()).caller.trade.market({ marketId: 9 }))).toContain("NOT_FOUND");
  });

  test("position: equity, PnL, liquidation prices (session and off-hours) and the safe max withdrawal", async () => {
    const w = await world();
    const p = opened(U(110), UNITS(10));
    setTrader(w, p);
    const r = await w.caller.trade.position({ marketId: 1, wallet: ALICE });
    expect(r).toMatchObject({ side: "long", size: "10.0", entryPrice: "100.05", marginUsd: "108.999500", unrealizedPnlUsd: "-0.500000", equityUsd: "108.499500" });
    expect(Number(r.liquidationPrice)).toBeCloseTo(93.8421, 3);
    expect(Number(r.liquidationPriceOffHours)).toBeGreaterThan(Number(r.liquidationPrice));
    expect(r.leverage).toBeCloseTo(9.21, 2);
    expect(r.maxWithdrawUsd).toBe("0.000000");
  });

  test("quote: fill, impact, fee, resulting margin ratio and liquidation price; leverage refused; off-hours warning", async () => {
    const w = await world();
    setTrader(w, flat(U(110)));
    const q = await w.caller.trade.quote({ marketId: 1, wallet: ALICE, sizeDelta: UNITS(10).toString() });
    expect(q).toMatchObject({ side: "buy", fillPrice: "100.05", priceImpactBps: 5, feeUsd: "1.000500", notionalUsd: "1000.500000", newRisk: true, refusal: null, slippageBps: 50 });
    expect(q.after).toMatchObject({ side: "long", marginUsd: "108.999500", equityUsd: "108.499500" });
    expect(Number(q.after.liquidationPrice)).toBeCloseTo(93.8421, 3);
    expect(q.acceptablePrice).toBe("100.55025");
    expect(q.warnings.join(" ")).toContain("session close");
    setTrader(w, flat(U(90)));
    expect((await w.caller.trade.quote({ marketId: 1, wallet: ALICE, sizeDelta: UNITS(10).toString() })).refusal?.code).toBe("INITIAL_MARGIN");
    // no wallet: no margin check, the required margin is stated
    const anon = await w.caller.trade.quote({ marketId: 1, sizeDelta: (-UNITS(2)).toString() });
    expect(anon).toMatchObject({ side: "sell", fillPrice: "99.95", refusal: null });
    expect(anon.warnings.join(" ")).toContain("20.000000");
  });
});

describe("trade router: refusals before anything is built", () => {
  const order = (w: World, size: bigint) => w.caller.trade.order({ marketId: 1, wallet: ALICE, sizeDelta: size.toString() });

  test("off-hours (held price): no trade, closes included", async () => {
    const w = await world({ held: true });
    setTrader(w, opened(U(500), UNITS(1)));
    expect(await code(order(w, UNITS(1)))).toContain("off-hours");
    expect(await code(w.caller.trade.close({ marketId: 1, wallet: ALICE }))).toContain("off-hours");
  });

  test("no fresh signed price", async () => {
    const w = await world({ printAgo: 40 });
    setTrader(w, flat(U(500)));
    expect(await code(order(w, UNITS(1)))).toContain("fresh enough");
  });

  test("reduce-only: new risk refused, a reduction and a close are built", async () => {
    const w = await world({ state: { reduceOnly: true, longSize: UNITS(2) } });
    setTrader(w, opened(U(500), UNITS(2)));
    expect(await code(order(w, UNITS(1)))).toContain("reduce-only");
    expect((await order(w, -UNITS(1))).txs).toHaveLength(1);
    expect((await w.caller.trade.close({ marketId: 1, wallet: ALICE })).quote.after.side).toBe("flat");
  });

  test("caps: the pool's net exposure cap and the side inventory cap", async () => {
    const w = await world({ market: { config: { ...engineMarket().config, maxNetExposureUsd: U(500) } } });
    setTrader(w, flat(U(10_000)));
    expect(await code(order(w, UNITS(10)))).toContain("cap of 500.00");
    const w2 = await world({ market: { inventoryCapUsd: U(800) } });
    setTrader(w2, flat(U(10_000)));
    expect(await code(order(w2, UNITS(10)))).toContain("inventory cap");
  });

  test("split: window refuses every trade, pending refuses new risk only (audit N-1)", async () => {
    const w = await world({ state: { longSize: UNITS(1) } });
    setTrader(w, opened(U(500), UNITS(1)));
    w.chain.split = { pending: false, window: true };
    expect(await code(w.caller.trade.close({ marketId: 1, wallet: ALICE }))).toContain("pre-split");
    w.chain.split = { pending: true, window: false };
    expect(await code(order(w, UNITS(1)))).toContain("split is pending");
    expect((await w.caller.trade.close({ marketId: 1, wallet: ALICE })).txs).toHaveLength(1);
    // the order reads the gate at the carried price's exact basis
    expect(w.chain.splitCalls.at(-1)!.basisAt).toBe(sec - 2);
  });

  test("leverage over the maximum, and a closed book", async () => {
    const w = await world();
    setTrader(w, flat(U(50)));
    expect(await code(order(w, UNITS(10)))).toContain("maximum leverage (10x)");
    expect(await code((await world({ bookState: "Retired" })).caller.trade.order({ marketId: 1, wallet: ALICE, sizeDelta: "1" }))).toContain("NOT_FOUND");
  });

  test("withdraw: above the margin, above the safe max with a position, off-hours with a position", async () => {
    const w = await world();
    setTrader(w, opened(U(110), UNITS(10)));
    expect(await code(w.caller.trade.withdraw({ marketId: 1, wallet: ALICE, amountUsd: "500" }))).toContain("108.999500 of margin");
    expect(await code(w.caller.trade.withdraw({ marketId: 1, wallet: ALICE, amountUsd: "1" }))).toContain("At most 0.000000");
    const held = await world({ held: true });
    setTrader(held, opened(U(500), UNITS(1)));
    expect(await code(held.caller.trade.withdraw({ marketId: 1, wallet: ALICE, amountUsd: "1" }))).toContain("session is closed");
    // flat: off-hours does not matter
    setTrader(held, flat(U(50)));
    expect((await held.caller.trade.withdraw({ marketId: 1, wallet: ALICE, amountUsd: "50" })).txs).toHaveLength(1);
  });
});

describe("trade router: prepared transactions (verified like the web does)", () => {
  test("order: trade(marketId, sizeDelta, acceptable at 0.5%, priceData of this market only)", async () => {
    const w = await world();
    setTrader(w, flat(U(500)));
    const size = UNITS(2.5);
    const r = await w.caller.trade.order({ marketId: 1, wallet: ALICE, sizeDelta: size.toString() });
    const call = decodeFunctionData({ abi: poolEngineAbi, data: r.txs[0]!.data });
    expect(call.functionName).toBe("trade");
    const [mid, delta, acceptable, priceData] = call.args as unknown as [bigint, bigint, bigint, Hex];
    expect([mid, delta]).toEqual([1n, size]);
    expect(acceptable).toBe((100_050_000_000_000_000_000n * 10_050n) / 10_000n);
    const carried = decodePriceData(priceData).updates;
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ underlying: PID, publishedAt: BigInt(sec - 2) });
    const steps = verifyPreparedTxs(r.txs, check({ amount: size }));
    expect(steps[0]!.summary).toContain("buy 2.5 units");
    expect(r.warnings.join(" ")).toContain("must be mined before");

    // tampering a compromised API could do
    const tamper = (args: readonly [bigint, bigint, bigint, Hex]) => [{ ...r.txs[0]!, data: encodeFunctionData({ abi: poolEngineAbi, functionName: "trade", args }) }];
    expect(() => verifyPreparedTxs(tamper([1n, size, maxUint256, priceData]), check({ amount: size }))).toThrow(/price limit/);
    expect(() => verifyPreparedTxs(tamper([1n, size * 10n, acceptable, priceData]), check({ amount: size }))).toThrow(/you entered/);
    expect(() => verifyPreparedTxs(r.txs, { ...check({ amount: size }), targets: [USDC] })).toThrow(/not a contract of this flow/);
    // the 3-argument overload (stored price) is not a prepared step
    const stored = [{ ...r.txs[0]!, data: encodeFunctionData({ abi: poolEngineAbi, functionName: "trade", args: [1n, size, acceptable] }) }];
    expect(() => verifyPreparedTxs(stored, check())).toThrow(/does not recognise/);
    // a sell carries a floor, never 0
    setTrader(w, opened(U(500), UNITS(2)));
    const c = await w.caller.trade.close({ marketId: 1, wallet: ALICE, slippageBps: 100 });
    const cargs = decodeFunctionData({ abi: poolEngineAbi, data: c.txs[0]!.data }).args as unknown as [bigint, bigint, bigint, Hex];
    expect(cargs[1]).toBe(-UNITS(2));
    expect(cargs[2]).toBe((99_950_000_000_000_000_000n * 9_900n) / 10_000n);
    expect(() => verifyPreparedTxs([{ ...c.txs[0]!, data: encodeFunctionData({ abi: poolEngineAbi, functionName: "trade", args: [1n, -UNITS(2), 0n, cargs[3]] }) }], check())).toThrow(/price limit/);
    // a portion
    const half = await w.caller.trade.close({ marketId: 1, wallet: ALICE, portionBps: 5_000 });
    expect((decodeFunctionData({ abi: poolEngineAbi, data: half.txs[0]!.data }).args as unknown as bigint[])[1]).toBe(-UNITS(1));
  });

  test("deposit: [approve exactly the amount to the engine, depositMargin]; allowance in place: one step; allowed off-hours", async () => {
    const w = await world({ held: true });
    setTrader(w, flat(0n), { balance: U(100) });
    const r = await w.caller.trade.deposit({ marketId: 1, wallet: ALICE, amountUsd: "250.5" });
    const steps = verifyPreparedTxs(r.txs, check({ amount: U(250.5) }));
    expect(steps.map((s) => s.functionName)).toEqual(["approve", "depositMargin"]);
    expect(steps[0]!.args).toEqual([ENGINE, U(250.5)]);
    expect(steps[1]!.args).toEqual([1n, U(250.5)]);
    expect(r.warnings[0]).toContain("below the amount");
    expect(() => verifyPreparedTxs(r.txs, check({ amount: U(25) }))).toThrow(/you entered/);
    setTrader(w, flat(0n), { allowance: U(1_000) });
    expect((await w.caller.trade.deposit({ marketId: 1, wallet: ALICE, amountUsd: "10" })).txs).toHaveLength(1);
  });

  test("withdraw: flat [withdrawMargin]; with a position [oracle.update(signed price), withdrawMargin]", async () => {
    const w = await world();
    setTrader(w, flat(U(80)));
    const flatR = await w.caller.trade.withdraw({ marketId: 1, wallet: ALICE, amountUsd: "80" });
    expect(verifyPreparedTxs(flatR.txs, check({ amount: U(80) })).map((s) => s.functionName)).toEqual(["withdrawMargin"]);

    const p = opened(U(500), UNITS(10));
    setTrader(w, p);
    const max = maxWithdrawableUsd(MATH, p, PX);
    const pos = await w.caller.trade.withdraw({ marketId: 1, wallet: ALICE, amountUsd: (Number(max) / 1e6).toFixed(6) });
    const steps = verifyPreparedTxs(pos.txs, check({ amount: max }));
    expect(steps.map((s) => s.functionName)).toEqual(["update", "withdrawMargin"]);
    expect(pos.txs[0]!.to.toLowerCase()).toBe(ORACLE.toLowerCase());
    const relayed = decodeFunctionData({ abi: attestedOracleAbi, data: pos.txs[0]!.data }).args as unknown as [Hex];
    expect(decodePriceData(relayed[0]).updates[0]!.publishedAt).toBe(BigInt(sec - 2));
    expect(pos.warnings[0]).toContain("must be mined before");
    // the oracle is not a destination of this flow: refused
    expect(() => verifyPreparedTxs(pos.txs, { ...check(), targets: [ENGINE] })).toThrow(/not a contract of this flow/);
  });
});

describe("leverage that survives a session close (TRADE_REFUSE_UNHOLDABLE_LEVERAGE)", () => {
  test("auto: refused on mainnet only; true / false force it", async () => {
    const { refuseUnholdable } = await import("../src/config");
    expect([refuseUnholdable("auto", 4663), refuseUnholdable("auto", 46630), refuseUnholdable("true", 31337), refuseUnholdable("0", 4663)]).toEqual([true, false, true, false]);
  });

  test("refused above the holdable leverage (5x) when on; a warning only when off; the market view says which", async () => {
    const w = await world();
    setTrader(w, flat(U(110)));
    const size = UNITS(10).toString(); // ~9.2x on 110
    expect((await w.caller.trade.quote({ marketId: 1, wallet: ALICE, sizeDelta: size })).refusal).toBeNull();
    expect((await w.caller.trade.markets()).markets[0]!.margin).toMatchObject({ refusesUnholdable: false, orderLeverageCap: 10 });
    w.deps.settings.tradeRefuseUnholdable = true;
    const q = await w.caller.trade.quote({ marketId: 1, wallet: ALICE, sizeDelta: size });
    expect(q.refusal?.code).toBe("UNHOLDABLE_LEVERAGE");
    expect(q.refusal?.message).toContain("Above 5x");
    expect(await code(w.caller.trade.order({ marketId: 1, wallet: ALICE, sizeDelta: size }))).toContain("session close");
    expect((await w.caller.trade.markets()).markets[0]!.margin).toMatchObject({ refusesUnholdable: true, orderLeverageCap: 5 });
    // 4x on 250 margin is holdable: built
    setTrader(w, flat(U(250)));
    expect((await w.caller.trade.order({ marketId: 1, wallet: ALICE, sizeDelta: size })).txs).toHaveLength(1);
    // a reduction is never refused by it
    setTrader(w, opened(U(110), UNITS(10)));
    expect((await w.caller.trade.order({ marketId: 1, wallet: ALICE, sizeDelta: (-UNITS(1)).toString() })).txs).toHaveLength(1);
  });
});
