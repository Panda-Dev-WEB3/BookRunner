// Trading page order-panel logic (components/trade/tradeLogic.ts): size from USD or units, signed size, slippage,
// what an order does to the position, leverage, session badges, price age and the carried price's countdown, the
// client-side order checks, the close size, the engine revert messages, and the page's risk copy.
import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { encodeErrorResult } from "viem";
import {
  SESSION_BADGE,
  absUnitsText,
  closeDelta,
  fmtLeverage,
  fmtUnits,
  isNewRisk,
  leverageNote,
  leverageOf,
  notionalRaw,
  orderEffect,
  orderIssue,
  orderIssueText,
  parseSlippagePct,
  priceAge,
  priceWadOf,
  secondsLeft,
  signedSize,
  sizeFromInput,
  tradeRiskLines,
  unitsRaw,
} from "../src/components/trade/tradeLogic";
import { REVERT_ABI, revertReason } from "../src/lib/revert";

const WAD = 10n ** 18n;
const PX = 100n * WAD;
const market = (o: Partial<{ canTrade: boolean; newRisk: boolean; buyRoomUsd: string; sellRoomUsd: string; reasons: string[] }> = {}) => ({
  canTrade: o.canTrade ?? true,
  newRisk: o.newRisk ?? true,
  reasons: o.reasons ?? [],
  caps: { inventoryCapUsd: "75000.000000", quoteCapUsd: "75000.000000", buyRoomUsd: o.buyRoomUsd ?? "65000.000000", sellRoomUsd: o.sellRoomUsd ?? "71000.000000" },
});

describe("order size", () => {
  test("USD converts at the price and floors; units are taken as typed (18 decimals)", () => {
    expect(sizeFromInput("usd", "1000", PX)).toBe(10n * WAD);
    expect(sizeFromInput("usd", "1", 3n * WAD)).toBe(333_333_333_333_333_333n); // floored: never more than typed
    expect(sizeFromInput("units", "2.5", null)).toBe(25n * 10n ** 17n);
    expect(sizeFromInput("units", "0.000000000000000001", null)).toBe(1n);
    expect(sizeFromInput("usd", "100", null)).toBeNull();
    expect(sizeFromInput("usd", "0", PX)).toBeNull();
    expect(sizeFromInput("units", "abc", PX)).toBeNull();
    expect(signedSize("buy", 5n)).toBe(5n);
    expect(signedSize("sell", 5n)).toBe(-5n);
    expect(notionalRaw(-10n * WAD, PX)).toBe(1_000_000_000n);
    expect(priceWadOf("100.05")).toBe(100_050_000_000_000_000_000n);
    expect(priceWadOf("0")).toBeNull();
  });

  test("units display and parsing", () => {
    expect(fmtUnits(25n * 10n ** 17n)).toBe("2.5");
    expect(fmtUnits(-1_234_567_891n * 10n ** 12n)).toBe("-1,234.567891");
    expect(fmtUnits(1n)).toBe("0");
    expect(unitsRaw("-12.5")).toBe(-125n * 10n ** 17n);
    expect(absUnitsText("-12.5")).toBe("12.5");
  });

  test("slippage in percent: 0.01% .. 5%, at most 2 decimals", () => {
    expect(parseSlippagePct("0.5")).toBe(50);
    expect(parseSlippagePct("1")).toBe(100);
    expect(parseSlippagePct("0.01")).toBe(1);
    expect(parseSlippagePct("5")).toBe(500);
    expect(parseSlippagePct("5.01")).toBeNull();
    expect(parseSlippagePct("0")).toBeNull();
    expect(parseSlippagePct("0.005")).toBeNull();
    expect(parseSlippagePct("")).toBeNull();
  });
});

describe("what an order does", () => {
  test("new risk and effect, as PoolEngine.isNewRisk", () => {
    expect(isNewRisk(0n, 1n)).toBe(true);
    expect(isNewRisk(2n, 3n)).toBe(true);
    expect(isNewRisk(2n, 1n)).toBe(false);
    expect(isNewRisk(2n, -1n)).toBe(true); // flip
    expect(isNewRisk(2n, 0n)).toBe(false);
    expect([orderEffect(0n, 1n), orderEffect(2n, 1n), orderEffect(2n, -1n), orderEffect(2n, -2n), orderEffect(2n, -3n)]).toEqual(["open", "increase", "reduce", "close", "flip"]);
  });

  test("leverage = notional / equity", () => {
    expect(leverageOf(1_000_000_000n, 108_499_500n)).toBe(9.21);
    expect(leverageOf(0n, 1n)).toBeNull();
    expect(leverageOf(1n, 0n)).toBeNull();
    expect(fmtLeverage(9.21)).toBe("9.21x");
    expect(fmtLeverage(10)).toBe("10x");
    expect(fmtLeverage(12.25)).toBe("12.3x");
    expect(fmtLeverage(null)).toBe("—");
  });

  test("client checks: size, a market that trades, new risk while close-only, the room on the side", () => {
    expect(orderIssue(market(), 0n, null)).toBe("no_size");
    expect(orderIssue(market({ canTrade: false, reasons: ["Off-hours."] }), 0n, WAD)).toBe("market_closed");
    expect(orderIssueText("market_closed", { reasons: ["Off-hours."] })).toBe("Off-hours.");
    const ro = market({ newRisk: false, reasons: ["The market is reduce-only: only reductions and closes fill."] });
    expect(orderIssue(ro, 0n, WAD)).toBe("new_risk_blocked");
    expect(orderIssue(ro, 2n * WAD, -WAD)).toBeNull(); // a reduction is fine
    expect(orderIssue(ro, 2n * WAD, -3n * WAD)).toBe("new_risk_blocked"); // a flip adds risk
    expect(orderIssue(market({ buyRoomUsd: "500.000000" }), 0n, 10n * WAD, notionalRaw(10n * WAD, PX))).toBe("above_room");
    expect(orderIssue(market({ buyRoomUsd: "500.000000" }), 0n, -10n * WAD, notionalRaw(10n * WAD, PX))).toBeNull(); // the sell side has room
  });

  test("close size: all, or a portion floored like the API", () => {
    expect(closeDelta((10n * WAD).toString(), 10_000)).toBe(-10n * WAD);
    expect(closeDelta((-3n).toString(), 5_000)).toBe(1n);
    expect(closeDelta((10n * WAD).toString(), 2_500)).toBe(-25n * 10n ** 17n);
  });
});

describe("session and price", () => {
  test("badges for every session", () => {
    expect(Object.keys(SESSION_BADGE).sort()).toEqual(["closed", "no_fresh_price", "off_hours", "open", "reduce_only", "split_close_only", "split_window"]);
    expect(SESSION_BADGE.open.tone).toBe("good");
    expect(SESSION_BADGE.off_hours.label).toBe("Off-hours");
  });

  test("price age is toned against the trade bound; the countdown of a carried price", () => {
    expect(priceAge(2, 15)).toEqual({ text: "2s ago", tone: "good" });
    expect(priceAge(13, 15).tone).toBe("warn");
    expect(priceAge(0, 15).text).toBe("just now");
    expect(priceAge(null, 15).text).toBe("no price");
    const until = "2026-10-23T12:00:15.000Z";
    expect(secondsLeft(until, Date.parse("2026-10-23T12:00:03.500Z"))).toBe(12);
    expect(secondsLeft(until, Date.parse("2026-10-23T12:01:00.000Z"))).toBe(0);
    expect(secondsLeft(null, 0)).toBeNull();
  });
});

describe("leverage rule", () => {
  const margin = { maxLeverage: 10, holdableLeverage: 5, offHoursMarginBps: 2000 };
  test("refused above the holdable leverage on this deployment (mainnet default), else a warning", () => {
    const on = leverageNote({ ...margin, refusesUnholdable: true });
    expect(on.title).toBe("Leverage up to 5x here");
    expect(on.body).toContain("refused");
    expect(on.body).toContain("20% of notional");
    const off = leverageNote({ ...margin, refusesUnholdable: false });
    expect(off.title).toContain("Above 5x");
    expect(off.body).toContain("up to 10x");
    expect(checkCopy([on.title, on.body, off.title, off.body].join("\n"))).toEqual([]);
  });
});

describe("copy", () => {
  test("risk lines pass the copy rules and state the rules of the market", () => {
    const lines = tradeRiskLines({ margin: { initialMarginBps: 1000, maintenanceMarginBps: 500, offHoursMarginBps: 2000, maxLeverage: 10, holdableLeverage: 5, refusesUnholdable: true, orderLeverageCap: 5 }, tradePriceMaxAgeSeconds: 15 });
    const text = lines.map((l) => `${l.title}. ${l.body}`).join("\n");
    expect(checkCopy(text)).toEqual([]);
    expect(text).toContain("10x");
    expect(text).toContain("20% of notional");
    expect(text).toContain("above 5x");
    expect(text).toContain("15 s");
    expect(tradeRiskLines(null)).toHaveLength(6);
  });

  test("engine reverts decode to plain reasons", () => {
    const enc = (errorName: string, args: readonly unknown[] = []) => encodeErrorResult({ abi: REVERT_ABI, errorName: errorName as never, args: args as never });
    expect(revertReason({ data: enc("OffHours", [1n]) })).toContain("session is closed");
    expect(revertReason({ data: enc("PriceNotAcceptable", [1n, 2n]) })).toContain("slippage limit");
    expect(revertReason({ data: enc("StalePrice", [`0x${"00".repeat(32)}`, 1n]) })).toContain("too old");
    expect(revertReason({ data: enc("InsufficientMargin", [46_500_000n, 38_499_500n]) })).toContain("46.50");
    expect(revertReason({ data: enc("WouldBeLiquidatable") })).toContain("maintenance margin");
  });
});
