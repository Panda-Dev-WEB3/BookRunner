// @bookrunner/receipts — library entry (side-effect free). The service runner is src/main.ts
// (`bun run start`); running this file directly also starts the service.
export * from "./windows";
export * from "./trees";
export * from "./store";
export { PgReceiptsStore } from "./store-pg";
export {
  type PeriodReceiptsRoot,
  type ProcessOptions,
  type ProcessStats,
  type ReceiptProofResult,
  type ReceiptsDeps,
  computeWindowRoots,
  ensureWindowRoots,
  periodRootWith,
  processClosedWindows,
  receiptProofWith,
  toHourly,
  toLeaf,
} from "./roots";
export {
  closeReceiptsDefaults,
  configureReceipts,
  periodReceiptsRoot,
  receiptProof,
  resolveReceiptsDeps,
  windowRoot,
  windowRoots,
} from "./defaults";

if (import.meta.main) {
  const { main } = await import("./main");
  await main();
}
