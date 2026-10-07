import { describe, expect, test } from "bun:test";
import { amountIssue, amountIssueText, apiAmount, formatAmountDisplay, formatAmountInput, normalizeAmount, parseAmount } from "../src/dashboard/amount";
import { bpsPct, duration, esc, pct, price, short, signedUsd, usd } from "../src/dashboard/format";

describe("amount parsing", () => {
  test("parses plain decimals exactly", () => {
    expect(parseAmount("1000")).toBe(1_000_000_000n);
    expect(parseAmount("0.5")).toBe(500_000n);
    expect(parseAmount(".5")).toBe(500_000n);
    expect(parseAmount("12.")).toBe(12_000_000n);
    expect(parseAmount("1,234.56")).toBe(1_234_560_000n);
    expect(parseAmount("1.000001")).toBe(1_000_001n);
    expect(parseAmount("1", 18)).toBe(10n ** 18n);
  });
  test("rejects what is not an amount", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(".")).toBeNull();
    expect(parseAmount("-1")).toBeNull();
    expect(parseAmount("1e6")).toBeNull();
    expect(parseAmount("1.0000001")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });
  test("normalizes to the API's canonical form", () => {
    expect(normalizeAmount("1000.")).toBe("1000");
    expect(normalizeAmount("0.50")).toBe("0.5");
    expect(normalizeAmount("1,000")).toBe("1000");
    expect(normalizeAmount("x")).toBeNull();
  });
  test("issues against balance and max", () => {
    expect(amountIssue("")).toBe("empty");
    expect(amountIssue("x")).toBe("invalid");
    expect(amountIssue("0")).toBe("zero");
    expect(amountIssue("10", { balance: 5_000_000n })).toBe("exceeds-balance");
    expect(amountIssue("10", { max: 5_000_000n })).toBe("above-max");
    expect(amountIssue("5", { balance: 5_000_000n, max: 5_000_000n })).toBeNull();
    expect(amountIssue("1.5", { decimals: 18, balance: 10n ** 18n })).toBe("exceeds-balance");
    expect(amountIssueText("exceeds-balance", "BKRN")).toContain("BKRN");
    expect(amountIssueText(null)).toBeNull();
  });
  test("formats base units", () => {
    expect(formatAmountDisplay(1_234_567_891n)).toBe("1,234.56");
    expect(formatAmountDisplay(1n)).toBe("<0.01");
    expect(formatAmountDisplay(null)).toBe("-");
    expect(formatAmountDisplay(-2_500_000n)).toBe("-2.50");
    expect(formatAmountInput(1_234_567_891n, 6, 2)).toBe("1234.56");
    expect(formatAmountInput(-1n)).toBe("0");
  });
  test("API decimal strings", () => {
    expect(apiAmount("134854.933474")).toBe(134_854_933_474n);
    expect(apiAmount("1.014313352802721088")).toBe(1_014_313n);
    expect(apiAmount("-5.5")).toBe(-5_500_000n);
    expect(apiAmount(null)).toBeNull();
    expect(apiAmount("n/a")).toBeNull();
  });
});

describe("display formatting", () => {
  test("money, prices and percentages", () => {
    expect(usd("134854.933474")).toBe("$134,854.93");
    expect(usd(null)).toBe("-");
    expect(signedUsd("243.64")).toBe("+$243.64");
    expect(signedUsd(-12)).toBe("-$12.00");
    expect(price("1.014313352803")).toBe("1.014313");
    expect(pct(0.108428)).toBe("10.8%");
    expect(bpsPct(6000)).toBe("60%");
    expect(bpsPct(9104)).toBe("91.04%");
  });
  test("durations, hashes and escaping", () => {
    expect(duration(45)).toBe("45s");
    expect(duration(900)).toBe("15 min");
    expect(duration(3 * 3600 + 300)).toBe("3 h 05 min");
    expect(duration(7 * 86400)).toBe("7 days");
    expect(short("0xa47B1aE8283C5DCAC9f8800e08F81928482AC915")).toBe("0xa47B…C915");
    expect(esc('<a href="x">')).toBe("&lt;a href=&quot;x&quot;&gt;");
  });
  test("copy rule: no em dashes in rendered helpers", () => {
    expect(usd(null)).not.toContain("—");
    expect(formatAmountDisplay(null)).not.toContain("—");
  });
});
