import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { ChainGateway } from "./chain/gateway";
import type { ApiDeps } from "./deps";

export interface ApiContext {
  deps: ApiDeps;
}

const t = initTRPC.context<ApiContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // Never leak stack traces / driver internals for unexpected errors.
    const internal = error.code === "INTERNAL_SERVER_ERROR";
    return { ...shape, message: internal ? "internal error" : shape.message, data: { ...shape.data, stack: undefined } };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

export function fail(code: TRPCError["code"], message: string): never {
  throw new TRPCError({ code, message });
}

export function notFound(what: string): never {
  return fail("NOT_FOUND", `${what} not found`);
}

/** The chain gateway, or PRECONDITION_FAILED while the deployment is missing. */
export function requireChain(deps: ApiDeps): ChainGateway {
  const c = deps.chain();
  if (!c) fail("PRECONDITION_FAILED", "Contracts are not deployed yet (deployment file missing); on-chain actions are unavailable");
  return c;
}

/** Runs a chain read; on RPC failure logs and returns `fallback` instead of failing the request. */
export async function softChain<T>(deps: ApiDeps, what: string, fn: (c: ChainGateway) => Promise<T>, fallback: T): Promise<T> {
  const c = deps.chain();
  if (!c) return fallback;
  try {
    return await fn(c);
  } catch (err) {
    deps.log.warn({ err, what }, "chain read failed; serving DB data");
    return fallback;
  }
}

/** Chain read that must succeed for the procedure to make sense (prepared txs). */
export async function hardChain<T>(deps: ApiDeps, what: string, fn: (c: ChainGateway) => Promise<T>): Promise<T> {
  const c = requireChain(deps);
  try {
    return await fn(c);
  } catch (err) {
    deps.log.warn({ err, what }, "chain read failed");
    return fail("SERVICE_UNAVAILABLE", `Chain read failed (${what}); retry shortly`);
  }
}
