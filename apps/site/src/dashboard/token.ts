// The settlement token's display symbol (USDC on testnet, USDG on Robinhood Chain mainnet). The
// address is BookrunnerConfig.usdc() (chain.ts readProtocol); its ERC-20 symbol() is read once by
// store.loadSettlementSymbol and published here. Pure: formatters default to the current symbol, so
// they keep their "USDC" wording in tests and pick up the chain's symbol on the live desk.

/** Shown while the symbol is loading, when the read fails, or when the token answers garbage. */
export const DEFAULT_SETTLEMENT_SYMBOL = "USDC";

/** Longest symbol shown (ERC-20 symbols are free text; ours are short tickers). */
export const MAX_SYMBOL_LENGTH = 11;

/**
 * A token's raw symbol() -> a safe display ticker: trimmed, ASCII letters and digits only, at most
 * MAX_SYMBOL_LENGTH characters (so it is also safe inside the desk's HTML). Anything else (empty,
 * non-string, all punctuation) -> the fallback.
 */
export function sanitizeTokenSymbol(raw: unknown, fallback: string = DEFAULT_SETTLEMENT_SYMBOL): string {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim().replace(/[^A-Za-z0-9]/g, "").slice(0, MAX_SYMBOL_LENGTH);
  return s === "" ? fallback : s;
}

let current = DEFAULT_SETTLEMENT_SYMBOL;

/** The settlement token's symbol as last read from chain (DEFAULT_SETTLEMENT_SYMBOL until then). */
export const settlementSymbol = (): string => current;

/** Publishes a symbol read from chain (sanitized; null / garbage resets to the default). */
export function setSettlementSymbol(raw: unknown): string {
  current = sanitizeTokenSymbol(raw);
  return current;
}

/** "1,000.00" -> "1,000.00 USDG": an amount with the settlement token's unit. */
export const withUnit = (amount: string, symbol: string = settlementSymbol()): string => `${amount} ${symbol}`;

/** The unit label alone, e.g. "Capital · USDG" or "Wallet USDG". */
export const unitLabel = (symbol: string = settlementSymbol()): string => symbol;
