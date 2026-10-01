// @bookrunner/waterfall — library entry (side-effect free): settlement + keeper logic and the runtime
// kit reused by the mark service. The service runner is src/main.ts (`bun run start`).
export * from "./kit/loop";
export * from "./kit/period";
export * from "./kit/tx";
export * from "./kit/events";
export * from "./kit/receipts";
export * from "./kit/books";
export * from "./kit/deployment";
export * from "./kit/logs";
export * from "./kit/fmt";
export * from "./kit/env";
export * from "./domain/split";
export * from "./domain/expenses";
export * from "./domain/recall";
export * from "./domain/keeper";
export * from "./ports";
export * from "./settlement";
export * from "./keeper";
export { DISTRIBUTION_SOURCE, DbRedeemCandidates, PgSettlementStore, SOURCE_LABEL, distributionRow } from "./adapters/store";
export { type CandidateSource, type RedeemCandidate, RedeemLogIndex, UnionCandidates, pendingShares } from "./adapters/redemptions";
export { WaterfallChainAdapter } from "./adapters/chain";
export { BullVenueOps, sweepJobId } from "./adapters/venue-ops";
export { loadWaterfallConfig, waterfallEnvShape } from "./config";

if (import.meta.main) {
  const { main } = await import("./main");
  await main();
}
