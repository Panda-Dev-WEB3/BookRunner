// Expense accounting for RevenueRouter.distribute(period, expensesRequested). The router caps the
// request at expenseCapBps of gross on-chain; this module only computes the request.
//   fixed   (devnet): WATERFALL_EXPENSES_USD per period per book.
//   metered:         oracle cost per period + keeper gas spent on the book since its last distribution,
//                    converted at WATERFALL_ETH_USD (VERIFY: source ETH/USD from the oracle on RHC).

export interface ExpenseConfig {
  mode: "fixed" | "metered";
  fixedUsd: bigint; // 6dp
  oracleCostUsd: bigint; // 6dp per period
  ethUsdWad: bigint; // USD per ETH, WAD
}

/** wei * (USD/ETH, WAD) -> USD 6dp: wei * price / 1e18 (ETH) / 1e18 (WAD) * 1e6 = / 1e30. */
export function gasCostUsd(wei: bigint, ethUsdWad: bigint): bigint {
  return (wei * ethUsdWad) / 10n ** 30n;
}

export function expensesRequested(cfg: ExpenseConfig, gasWeiSinceLast: bigint): bigint {
  if (cfg.mode === "fixed") return cfg.fixedUsd;
  return cfg.oracleCostUsd + gasCostUsd(gasWeiSinceLast, cfg.ethUsdWad);
}

/** Per-book keeper gas meter (in memory; a restart under-claims, never over-claims). */
export class GasMeter {
  private wei = new Map<number, bigint>();

  add(bookId: number | undefined, costWei: bigint) {
    if (bookId === undefined) return;
    this.wei.set(bookId, (this.wei.get(bookId) ?? 0n) + costWei);
  }

  pending(bookId: number): bigint {
    return this.wei.get(bookId) ?? 0n;
  }

  /**
   * Called after a distribution: the metered gas has been requested. Anything the on-chain cap cut
   * off is forgone (never carried into later periods).
   */
  reset(bookId: number) {
    this.wei.set(bookId, 0n);
  }
}
