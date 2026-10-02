import { describe, expect, test } from "bun:test";
import { amountIssue, amountIssueText, formatAmountDisplay, formatAmountInput, parseAmount, sanitizeAmountInput } from "../src/lib/amount";

describe("amount input", () => {
  test("sanitises what a person types", () => {
    expect(sanitizeAmountInput("1,000.50")).toBe("1000.50");
    expect(sanitizeAmountInput(" 12 345 ")).toBe("12345");
    expect(sanitizeAmountInput("abc12.3x4")).toBe("12.34");
    expect(sanitizeAmountInput("1.2.3")).toBe("1.23");
    expect(sanitizeAmountInput(".5")).toBe("0.5");
    expect(sanitizeAmountInput("007")).toBe("7");
    expect(sanitizeAmountInput("0")).toBe("0");
    expect(sanitizeAmountInput("00.10")).toBe("0.10");
    expect(sanitizeAmountInput("1.1234567")).toBe("1.123456");
    expect(sanitizeAmountInput("1.")).toBe("1.");
    expect(sanitizeAmountInput("5.9", 0)).toBe("5");
    expect(sanitizeAmountInput("")).toBe("");
  });

  test("parses to exact base units", () => {
    expect(parseAmount("1")).toBe(1_000_000n);
    expect(parseAmount("1234.56")).toBe(1_234_560_000n);
    expect(parseAmount("0.000001")).toBe(1n);
    expect(parseAmount("1.")).toBe(1_000_000n);
    expect(parseAmount(".5")).toBe(500_000n);
    expect(parseAmount("1", 18)).toBe(10n ** 18n);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(".")).toBeNull();
    expect(parseAmount("1.0000001")).toBeNull();
    expect(parseAmount("-1")).toBeNull();
    expect(parseAmount("1e6")).toBeNull();
  });

  test("formats back for the input (floored) and for display (grouped)", () => {
    expect(formatAmountInput(1_234_567_891n)).toBe("1234.567891");
    expect(formatAmountInput(1_234_567_891n, 6, 2)).toBe("1234.56");
    expect(formatAmountInput(10n ** 18n + 5n, 18, 6)).toBe("1");
    expect(formatAmountDisplay(12_345_678_900n)).toBe("12,345.67");
    expect(formatAmountDisplay(0n)).toBe("0.00");
    expect(formatAmountDisplay(1n)).toBe("<0.01");
    expect(formatAmountDisplay(10n ** 14n, 18, 4)).toBe("0.0001");
    expect(formatAmountDisplay(10n ** 13n, 18, 4)).toBe("<0.0001");
    expect(formatAmountDisplay(null)).toBe("—");
    expect(formatAmountDisplay(-2_500_000n)).toBe("-2.50");
  });

  test("reports the first problem with an amount", () => {
    expect(amountIssue("")).toBe("empty");
    expect(amountIssue("abc")).toBe("invalid");
    expect(amountIssue("0")).toBe("zero");
    expect(amountIssue("5", { min: 10_000_000n })).toBe("below-min");
    expect(amountIssue("50", { max: 20_000_000n })).toBe("above-max");
    expect(amountIssue("50", { balance: 20_000_000n })).toBe("exceeds-balance");
    expect(amountIssue("20", { balance: 20_000_000n })).toBeNull();
    expect(amountIssue("20", { balance: null })).toBeNull();
    expect(amountIssueText("empty")).toBeNull();
    expect(amountIssueText("exceeds-balance", "BKRN")).toContain("BKRN");
  });
});
