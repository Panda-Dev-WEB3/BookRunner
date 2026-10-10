// The settlement token's symbol (lib/settlementToken.ts): sanitising what symbol() returns, the
// "USDC" fallback, and formatters that show the on-chain symbol (USDG on Robinhood Chain mainnet).
import { afterEach, describe, expect, test } from "bun:test";
import { encodeErrorResult, encodeFunctionData, getAddress } from "viem";
import { faqItems } from "../src/components/home/faqContent";
import { perWalletCapText, roomFigure } from "../src/components/invest/investCopy";
import { checkDeposit, promptText } from "../src/components/invest/logic";
import { feeSentence, lossSentence } from "../src/components/learn/sim";
import { amountIssueText } from "../src/lib/amount";
import { mockMintTx } from "../src/lib/funds";
import { REVERT_ABI, revertReason } from "../src/lib/revert";
import {
  DEFAULT_SETTLEMENT_SYMBOL,
  MAX_SYMBOL_LENGTH,
  getSettlementSymbol,
  sanitizeTokenSymbol,
  setSettlementSymbol,
  subscribeSettlementSymbol,
  unitLabel,
  withUnit,
} from "../src/lib/settlementToken";

const U = 1_000_000n;

afterEach(() => setSettlementSymbol(null));

describe("sanitizeTokenSymbol", () => {
  test("keeps a plain ticker, trimmed", () => {
    expect(sanitizeTokenSymbol("USDG")).toBe("USDG");
    expect(sanitizeTokenSymbol("  USDC \n")).toBe("USDC");
    expect(sanitizeTokenSymbol("usdc0")).toBe("usdc0");
  });

  test("drops anything but ASCII letters and digits, and caps the length", () => {
    expect(sanitizeTokenSymbol("USD₮0")).toBe("USD0");
    expect(sanitizeTokenSymbol("US<b>DG</b>")).toBe("USbDGb");
    expect(sanitizeTokenSymbol("USDG.e")).toBe("USDGe");
    expect(sanitizeTokenSymbol("A".repeat(40))).toBe("A".repeat(MAX_SYMBOL_LENGTH));
  });

  test("falls back to USDC on empty, symbol-only or non-string answers", () => {
    expect(DEFAULT_SETTLEMENT_SYMBOL).toBe("USDC");
    for (const raw of ["", "   ", "$$$", "💵", null, undefined, 42, {}, ["USDG"]]) expect(sanitizeTokenSymbol(raw)).toBe("USDC");
    expect(sanitizeTokenSymbol("", "TOKEN")).toBe("TOKEN");
  });
});

describe("the current symbol", () => {
  test("defaults to USDC, takes a sanitised chain value, resets on null", () => {
    expect(getSettlementSymbol()).toBe("USDC");
    setSettlementSymbol(" USDG ");
    expect(getSettlementSymbol()).toBe("USDG");
    setSettlementSymbol("");
    expect(getSettlementSymbol()).toBe("USDC");
    setSettlementSymbol("USDG");
    setSettlementSymbol(null);
    expect(getSettlementSymbol()).toBe("USDC");
  });

  test("notifies subscribers only when the symbol changes", () => {
    let calls = 0;
    const off = subscribeSettlementSymbol(() => calls++);
    setSettlementSymbol("USDG");
    setSettlementSymbol("USDG");
    expect(calls).toBe(1);
    setSettlementSymbol(null);
    expect(calls).toBe(2);
    off();
    setSettlementSymbol("USDG");
    expect(calls).toBe(2);
  });

  test("unit helpers", () => {
    expect(withUnit("1,000.00")).toBe("1,000.00 USDC");
    expect(withUnit("1,000.00", "USDG")).toBe("1,000.00 USDG");
    setSettlementSymbol("USDG");
    expect(withUnit("5.00")).toBe("5.00 USDG");
    expect(unitLabel()).toBe("USDG");
  });
});

describe("amounts and transaction prompts show the on-chain symbol (USDG)", () => {
  const me = getAddress("0x1111111111111111111111111111111111111111");
  const senior = getAddress("0x3333333333333333333333333333333333333333");
  const junior = getAddress("0x4444444444444444444444444444444444444444");
  const usdg = getAddress("0x6666666666666666666666666666666666666666");
  const ctx = { book: "NVDA", tranches: { senior, junior }, settlesText: null, eligibleText: null };
  const abi = [
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
    { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "a", type: "uint256" }, { name: "r", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
    { type: "function", name: "claimRedemption", stateMutability: "nonpayable", inputs: [{ name: "c", type: "address" }, { name: "r", type: "address" }], outputs: [] },
  ] as const;
  const tx = (to: string, data: string) => ({ to, data, description: "api text" });

  test("wallet prompts", () => {
    setSettlementSymbol("USDG");
    expect(promptText(tx(usdg, encodeFunctionData({ abi, functionName: "approve", args: [senior, 500n * U] })), ctx)).toBe(
      "Allow NVDA Senior to move up to 500.00 USDG from your wallet. This only sets a spending limit: no USDG moves yet.",
    );
    expect(promptText(tx(senior, encodeFunctionData({ abi, functionName: "deposit", args: [1_000n * U, me] })), ctx)).toBe(
      "Deposit 1,000.00 USDG into NVDA Senior. It waits there until the round settles and cannot be cancelled before then.",
    );
    expect(promptText(tx(senior, encodeFunctionData({ abi, functionName: "claimRedemption", args: [me, me] })), ctx)).toBe("Collect the USDG from your settled NVDA Senior withdrawals.");
  });

  test("deposit checks, round figures and caps", () => {
    setSettlementSymbol("USDG");
    const c = checkDeposit("600", { tranche: "senior", balance: 1_000n * U, walletRoom: 500n * U, capacityRemaining: null });
    expect(c.error).toBe("Above the per-wallet cap: you can add at most 500.00 USDG in this round.");
    expect(checkDeposit("2000", { tranche: "senior", balance: 1_000n * U, walletRoom: null, capacityRemaining: null }).error).toBe("This is more USDG than the wallet holds.");
    expect(amountIssueText("exceeds-balance")).toBe("This is more USDG than the wallet holds.");
    expect(perWalletCapText(250_000n * U, 100_000n * U)).toBe("250,000 USDG per round; this round takes at most 100,000 USDG per tranche");
    expect(roomFigure({ committed: 0n, capacity: 100_000n * U, remaining: 100_000n * U, over: false, filled: 0 })).toBe("0 of 100,000 USDG committed");
    // an explicit symbol wins over the current one
    expect(perWalletCapText(50_000n * U, null, false, "USDC")).toBe("50,000 USDC per round");
  });

  test("revert reasons and the test-token mint", () => {
    setSettlementSymbol("USDG");
    const data = encodeErrorResult({ abi: REVERT_ABI, errorName: "InsufficientLiquidity", args: [400_159_336n, 0n] });
    expect(revertReason({ data })).toContain("not moved enough USDG to the tranche yet (400.15 USDG needed, 0.00 USDG available)");
    expect(mockMintTx(usdg, me, 10_000n * U, 46630).description).toContain("Mint 10,000 test USDG");
  });

  test("simulator sentences and the FAQ", () => {
    const fee = { gross: 1_000n * U, expenses: 20n * U, carry: 98n * U, senior: 529n * U, junior: 353n * U, rule: "split" } as unknown as Parameters<typeof feeSentence>[0];
    expect(feeSentence(fee, "USDG")).toContain("Senior earned 529.00 USDG and Junior earned 353.00 USDG");
    setSettlementSymbol("USDG");
    expect(feeSentence(fee)).toContain("From 1,000.00 USDG of fee flow");
    const loss = { loss: 10n * U, juniorLoss: 10n * U, seniorLoss: 0n, backstopCovered: 0n } as unknown as Parameters<typeof lossSentence>[0];
    expect(lossSentence(loss)).toBe("Junior absorbed 10.00 USDG of the 10.00 USDG loss. Senior lost nothing, because Junior still had NAV left.");
    const text = (s?: string) =>
      faqItems({ testnet: false, chainName: "Robinhood Chain", chainId: 4663, settlementSymbol: s })
        .flatMap((f) => f.answer)
        .join(" ");
    expect(text("USDG")).toContain("approve USDG, then to deposit it");
    expect(text("USDG")).toContain("books are funded in USDG on this network");
    expect(text("USDG")).not.toContain("USDC");
    expect(text()).toContain("books are funded in USDC on this network");
  });
});
