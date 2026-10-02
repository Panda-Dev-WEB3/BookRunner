// Minimal ABI fragments the browser reads directly (the full generated ABIs live in
// @bookrunner/shared/abi/<Contract> and can be imported per contract when a page needs more).

const addressGetter = <N extends string>(name: N) =>
  ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }) as const;

/** BookrunnerConfig: the protocol registry of sibling addresses. */
export const CONFIG_ADDRESSES_ABI = [
  addressGetter("usdc"),
  addressGetter("bkrn"),
  addressGetter("staking"),
  addressGetter("feeRouter"),
  addressGetter("backstop"),
  addressGetter("markRegistry"),
  addressGetter("oracle"),
  addressGetter("charter"),
  addressGetter("committee"),
  addressGetter("factory"),
] as const;

/** Book.config(): the BookrunnerConfig the book reads its siblings from. */
export const BOOK_CONFIG_ABI = [addressGetter("config")] as const;

/** Book.topUp(): the current top-up round (capacities in USDC, 6 decimals; endsAt unix seconds). */
export const BOOK_TOPUP_ABI = [
  {
    type: "function",
    name: "topUp",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "open", type: "bool" },
      { name: "endsAt", type: "uint64" },
      { name: "seniorCapacityUsd", type: "uint128" },
      { name: "juniorCapacityUsd", type: "uint128" },
    ],
  },
] as const;
