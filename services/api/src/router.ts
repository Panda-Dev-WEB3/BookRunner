// tRPC v11 app router (superjson). apps/web imports only the type:
//   import type { AppRouter } from "@bookrunner/api/router";
import { agentRouter } from "./routers/agent";
import { bookRouter } from "./routers/book";
import { charterRouter } from "./routers/charter";
import { eventsRouter, oracleRouter, receiptsRouter, riskRouter, settlementsRouter } from "./routers/misc";
import { trancheRouter } from "./routers/tranche";
import { createCallerFactory, router } from "./trpc";

export const appRouter = router({
  charter: charterRouter,
  book: bookRouter,
  tranche: trancheRouter,
  agent: agentRouter,
  risk: riskRouter,
  settlements: settlementsRouter,
  receipts: receiptsRouter,
  oracle: oracleRouter,
  events: eventsRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);

export type { ApiContext } from "./trpc";
export type { PreparedTx } from "./domain/txs";
export type { CharterDraftInput, CharterIssue, CharterView, MandateView } from "./domain/charter";
export type { BookSummary, MarkView, Paged } from "./routers/common";
