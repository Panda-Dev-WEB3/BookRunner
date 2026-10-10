// The settlement token's symbol on the desk (src/dashboard/token.ts): sanitising what symbol()
// returns, the "USDC" fallback, and the desk's formatters with a non-default symbol (USDG).
import { afterEach, describe, expect, test } from "bun:test";
import { type Address, encodeErrorResult } from "viem";
import { amountIssueText } from "../src/dashboard/amount";
import { ERRORS_ABI, revertReason } from "../src/dashboard/revert";
import { DEFAULT_SETTLEMENT_SYMBOL, MAX_SYMBOL_LENGTH, sanitizeTokenSymbol, setSettlementSymbol, settlementSymbol, unitLabel, withUnit } from "../src/dashboard/token";
import { mintTestUsdcStep, openTopUpStep } from "../src/dashboard/txs";

const ME = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x6666666666666666666666666666666666666666" as Address;
const BOOK = "0x5555555555555555555555555555555555555555" as Address;

afterEach(() => setSettlementSymbol(null));

describe("sanitizeTokenSymbol", () => {
  test("keeps a plain ticker, trimmed", () => {
    expect(sanitizeTokenSymbol("USDG")).toBe("USDG");
    expect(sanitizeTokenSymbol("\t USDC  ")).toBe("USDC");
  });

  test("ASCII letters and digits only (safe inside the desk's HTML), capped in length", () => {
    expect(sanitizeTokenSymbol('<img src=x onerror="1">')).toBe("imgsrcxoner");
    expect(sanitizeTokenSymbol("<img src=x onerror=1>").length).toBeLessThanOrEqual(MAX_SYMBOL_LENGTH);
    expect(sanitizeTokenSymbol("USD₮0")).toBe("USD0");
    expect(sanitizeTokenSymbol("Z".repeat(30))).toBe("Z".repeat(MAX_SYMBOL_LENGTH));
  });

  test("falls back to USDC on empty, punctuation-only or non-string answers", () => {
    expect(DEFAULT_SETTLEMENT_SYMBOL).toBe("USDC");
    for (const raw of ["", "  ", "...", null, undefined, 6, { symbol: "USDG" }]) expect(sanitizeTokenSymbol(raw)).toBe("USDC");
  });
});

describe("current symbol", () => {
  test("USDC until the chain answers; the chain's symbol after; reset on a failed read", () => {
    expect(settlementSymbol()).toBe("USDC");
    expect(setSettlementSymbol(" USDG")).toBe("USDG");
    expect(settlementSymbol()).toBe("USDG");
    expect(unitLabel()).toBe("USDG");
    expect(withUnit("1,000.00")).toBe("1,000.00 USDG");
    expect(withUnit("1.00", "USDC")).toBe("1.00 USDC");
    setSettlementSymbol(null);
    expect(settlementSymbol()).toBe("USDC");
  });
});

describe("desk formatters with USDG", () => {
  test("amount messages, revert reasons and desk-encoded transactions", () => {
    expect(amountIssueText("exceeds-balance")).toBe("This is more USDC than the wallet holds.");
    setSettlementSymbol("USDG");
    expect(amountIssueText("exceeds-balance")).toBe("This is more USDG than the wallet holds.");
    expect(amountIssueText("above-max", "BKRN")).toBe("This is more BKRN than is available for this action.");
    const cap = encodeErrorResult({ abi: ERRORS_ABI, errorName: "WalletCapExceeded", args: [250_000_000_000n, 300_000_000_000n] });
    expect(revertReason({ cause: { data: cap } })).toContain("250,000.00 USDG");
    expect(mintTestUsdcStep(TOKEN, ME).description).toContain("Mint 10,000 test USDG");
    const round = openTopUpStep({ book: BOOK, windowSeconds: 86400, seniorCapacityUsd: 50_000_000_000n, juniorCapacityUsd: 0n, maxWindowSeconds: 30 * 86400 });
    expect(round.description).toContain("USDG");
    expect(round.description).not.toContain("USDC");
  });
});
