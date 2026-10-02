// Minimal ABI fragments the invest flow reads directly (JSON form, so no prose-like ABI strings).

const view = <N extends string, T extends string>(name: N, output: T) =>
  ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type: output }] }) as const;

const viewOf = <N extends string>(name: N) =>
  ({ type: "function", name, stateMutability: "view", inputs: [{ name: "wallet", type: "address" }], outputs: [{ name: "", type: "uint256" }] }) as const;

/** BookrunnerConfig: guardian pause and the fee parameters shown in the tranche terms. */
export const CONFIG_PARAMS_ABI = [view("newBooksPaused", "bool"), view("carryBps", "uint16"), view("expenseCapBps", "uint16")] as const;

/** Tranche: the current round (deposits open, committed so far, paused). */
export const TRANCHE_ROUND_ABI = [view("depositsOpen", "bool"), view("totalCommitted", "uint256"), view("paused", "bool")] as const;

/** Tranche: one wallet's commitment this round and its room under the per-wallet cap. */
export const TRANCHE_WALLET_ABI = [viewOf("committedOf"), viewOf("maxDeposit")] as const;
