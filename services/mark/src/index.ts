// @bookrunner/mark — library entry (side-effect free). The service runner is src/main.ts
// (`bun run start`); manual marks: `bun run mark-now <bookId>`.
export * from "./domain/types";
export * from "./domain/nav";
export * from "./domain/inventory";
export * from "./domain/pnl";
export * from "./domain/preview";
export * from "./domain/sign";
export * from "./domain/readiness";
export * from "./ports";
export * from "./pipeline";
export * from "./scheduler";
export * from "./spool";
export { MarkChainAdapter } from "./adapters/chain";
export { PgMarkStore, committedMarkValues } from "./adapters/store";
export { LocalMarkSigner, ReceiptsRootAdapter } from "./adapters/signer";
export { loadMarkConfig, markEnvShape } from "./config";

if (import.meta.main) {
  const { main } = await import("./main");
  await main();
}
