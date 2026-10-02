import { describe, expect, test } from "bun:test";
import {
  DASH,
  ageMs,
  bpsPct,
  fmtAge,
  fmtBps,
  fmtDateTime,
  fmtDuration,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtSharePrice,
  fmtTime,
  fmtUsd,
  fmtUsdFloat,
  isZeroHash,
  rawToDecimal,
  shortHex,
  tickerOf,
  toNum,
  usdRaw,
} from "../src/lib/format";

describe("fmtUsd", () => {
  test("exact grouping from 6dp strings", () => {
    expect(fmtUsd("111741.438239")).toBe("111,741.44");
    expect(fmtUsd("0.000000")).toBe("0.00");
    expect(fmtUsd("1234567.5", { dp: 0 })).toBe("1,234,568");
    expect(fmtUsd("25000", { symbol: true })).toBe("$25,000.00");
  });
  test("no float rounding leaks", () => {
    expect(fmtUsd("0.105000")).toBe("0.11"); // half up on the exact value
    expect(fmtUsd("9007199254740993.000001", { dp: 6 })).toBe("9,007,199,254,740,993.000001");
  });
  test("signs", () => {
    expect(fmtUsd("-43.72", { signed: true })).toBe("-43.72");
    expect(fmtUsd("3.24", { signed: true })).toBe("+3.24");
    expect(fmtUsd("0", { signed: true })).toBe("0.00");
    expect(fmtUsd(-1_500_000n)).toBe("-1.50");
  });
  test("compact headline figures", () => {
    expect(fmtUsd("352940.28", { compact: true, symbol: true })).toBe("$352.9K");
    expect(fmtUsd("4200000", { compact: true })).toBe("4.2M");
    expect(fmtUsd("2500000000", { compact: true })).toBe("2.5B");
    expect(fmtUsd("9999", { compact: true })).toBe("9,999.00");
  });
  test("missing or malformed", () => {
    expect(fmtUsd(null)).toBe(DASH);
    expect(fmtUsd("abc")).toBe(DASH);
    expect(fmtUsdFloat(Number.NaN)).toBe(DASH);
    expect(fmtUsdFloat(-13420.084131, { signed: true, compact: true })).toBe("-13.4K");
  });
});

describe("number helpers", () => {
  test("toNum / usdRaw / rawToDecimal", () => {
    expect(toNum(" 1.5 ")).toBe(1.5);
    expect(toNum("")).toBeNull();
    expect(toNum("x")).toBeNull();
    expect(usdRaw("1.000001")).toBe(1_000_001n);
    expect(usdRaw("1.0000009")).toBe(1_000_000n); // floors beyond 6 decimals (protocol rounding)
    expect(usdRaw("1,5")).toBeNull();
    expect(rawToDecimal(1_500_000n)).toBe("1.5");
  });
  test("prices, share prices, bps, pct", () => {
    expect(fmtPrice(190.123)).toBe("190.12");
    expect(fmtPrice(1.234567)).toBe("1.2346");
    expect(fmtSharePrice("1.212439052571")).toBe("1.212439");
    expect(fmtSharePrice(null)).toBe(DASH);
    expect(fmtBps(-800)).toBe("-800 bps");
    expect(fmtBps(1.5, { signed: true })).toBe("+1.5 bps");
    expect(fmtPct(0.269045)).toBe("26.9%");
    expect(bpsPct(7000)).toBe("70%");
    expect(bpsPct(12_345)).toBe("123.5%");
    expect(fmtNum(-0.001, 2)).toBe("0.00");
    expect(fmtNum(1234.5, 1)).toBe("1,234.5");
  });
});

describe("time", () => {
  test("ages", () => {
    expect(fmtAge(500)).toBe("now");
    expect(fmtAge(12_000)).toBe("12s");
    expect(fmtAge(4 * 60_000)).toBe("4m");
    expect(fmtAge((3 * 60 + 12) * 60_000)).toBe("3h 12m");
    expect(fmtAge((50 * 60) * 60_000)).toBe("2d 2h");
    expect(ageMs("2026-10-02T06:00:00.000Z", Date.parse("2026-10-02T06:00:10.000Z"))).toBe(10_000);
    expect(ageMs(null, 0)).toBeNull();
  });
  test("durations", () => {
    expect(fmtDuration(600)).toBe("10 min");
    expect(fmtDuration(900)).toBe("15 min");
    expect(fmtDuration(172_800)).toBe("2 days");
    expect(fmtDuration(90_061)).toBe("1 day 1 h");
    expect(fmtDuration(0)).toBe("none");
  });
  test("fixed timestamps (unix seconds, ms, ISO)", () => {
    expect(fmtDateTime("2026-10-02T06:05:00.000Z", "UTC")).toBe("2026-10-02 06:05:00");
    expect(fmtDateTime(1790921100, "UTC")).toBe("2026-10-02 06:05:00");
    expect(fmtDateTime(1790921100000, "UTC")).toBe("2026-10-02 06:05:00");
    expect(fmtTime("2026-10-02T06:05:00.000Z", "UTC")).toBe("06:05:00");
    expect(fmtDateTime("nope")).toBe(DASH);
  });
});

describe("identifiers", () => {
  test("shortHex / tickerOf / isZeroHash", () => {
    expect(shortHex("0x095C1cB170f253849bea59573557ed36f0Faa471")).toBe("0x095C…a471");
    expect(shortHex("0x12")).toBe("0x12");
    expect(tickerOf("PERP_NVDA_USDC")).toBe("NVDA");
    expect(tickerOf("RHX5-PERP")).toBe("RHX5");
    expect(tickerOf("CUSTOM")).toBe("CUSTOM");
    expect(isZeroHash("0x0000000000000000000000000000000000000000000000000000000000000000")).toBe(true);
    expect(isZeroHash("0x6aed")).toBe(false);
  });
});
