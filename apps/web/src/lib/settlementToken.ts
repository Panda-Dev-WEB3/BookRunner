// The settlement token's display symbol (USDC on testnet, USDG on Robinhood Chain mainnet). The
// address is BookrunnerConfig.usdc() (wallet/contracts.ts); its ERC-20 symbol() is read once by
// wallet/settlementSymbol.ts and published here. Pure helpers default to the current symbol, so
// formatters keep working unchanged in tests (default "USDC") and pick up the chain's symbol live.

/** Shown while the symbol is loading, when the read fails, or when the token answers garbage. */
export const DEFAULT_SETTLEMENT_SYMBOL = "USDC";

/** Longest symbol shown (ERC-20 symbols are free text; ours are short tickers). */
export const MAX_SYMBOL_LENGTH = 11;

/**
 * A token's raw symbol() -> a safe display ticker: trimmed, ASCII letters and digits only, at most
 * MAX_SYMBOL_LENGTH characters. Anything else (empty, non-string, all symbols) -> the default.
 */
export function sanitizeTokenSymbol(raw: unknown, fallback: string = DEFAULT_SETTLEMENT_SYMBOL): string {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim().replace(/[^A-Za-z0-9]/g, "").slice(0, MAX_SYMBOL_LENGTH);
  return s === "" ? fallback : s;
}

let current = DEFAULT_SETTLEMENT_SYMBOL;
const listeners = new Set<() => void>();

/** The settlement token's symbol as last read from chain (DEFAULT_SETTLEMENT_SYMBOL until then). */
export const getSettlementSymbol = (): string => current;

/** Publishes a symbol read from chain (sanitized; null / garbage resets to the default). */
export function setSettlementSymbol(raw: unknown): void {
  const next = sanitizeTokenSymbol(raw);
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

/** useSyncExternalStore subscription (wallet/settlementSymbol.ts). */
export function subscribeSettlementSymbol(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** "1,000.00" -> "1,000.00 USDG": an amount with the settlement token's unit. */
export const withUnit = (amount: string, symbol: string = getSettlementSymbol()): string => `${amount} ${symbol}`;

/** The unit label alone, e.g. for a field label "Capital · USDG" or a column "Desk USDG". */
export const unitLabel = (symbol: string = getSettlementSymbol()): string => symbol;
