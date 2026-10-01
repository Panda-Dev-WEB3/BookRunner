// Type-level probe (no runtime): compiled by `bun run typecheck:router-dom` under a browser config.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../src/router";

type Out = inferRouterOutputs<AppRouter>;
type In = inferRouterInputs<AppRouter>;

export const sharePrice: Out["book"]["list"][number]["seniorSharePrice"] = "1.0";
export const subscribeInput: In["tranche"]["subscribe"] = {
  bookId: 1,
  tranche: "senior",
  amountUsd: "10",
  wallet: "0x0000000000000000000000000000000000000001",
};
export const preparedTo: Out["tranche"]["redeem"]["tx"]["to"] = "0x0000000000000000000000000000000000000001";
export const notice: Out["tranche"]["redeem"]["notice"]["isGate"] = false;
