// tRPC v11 client (superjson) against services/api. Typed procedures go through `trpc`; optional
// procedures this API version may not serve yet go through the untyped client (see useOptional).
import { createTRPCUntypedClient, httpBatchLink, httpLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import type { AppRouter } from "../lib/api-types";
import { trpcUrl } from "../lib/config";
import { errorCode } from "../lib/errors";

export const trpc = createTRPCReact<AppRouter>();

export function createTrpcClient() {
  return trpc.createClient({ links: [httpBatchLink({ url: trpcUrl, transformer: superjson, maxURLLength: 4000 })] });
}

/** Unbatched, untyped client for optional procedures (an unknown path must not fail a batch). */
export const untypedClient = createTRPCUntypedClient<AppRouter>({ links: [httpLink({ url: trpcUrl, transformer: superjson })] });

const NO_RETRY = new Set(["NOT_FOUND", "BAD_REQUEST", "FORBIDDEN", "PRECONDITION_FAILED", "CONFLICT", "UNAUTHORIZED"]);

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1_500,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => !NO_RETRY.has(errorCode(err) ?? "") && count < 2,
        retryDelay: (n) => Math.min(1_000 * 2 ** n, 8_000),
      },
      mutations: { retry: false },
    },
  });
}

/** Poll cadences (ms). Live panels 2-5s; marked data changes once per mark period. */
export const POLL = {
  live: 3_000,
  quote: 2_000,
  list: 5_000,
  marks: 15_000,
  slow: 30_000,
} as const;

/**
 * Re-reads wallet positions after a confirmed transaction: now, and once more a few seconds later,
 * because a public RPC node can still answer from the block before the receipt for a moment (the
 * API reads wallet positions uncached, so the second read sees the new state).
 */
export function refreshPositions(utils: ReturnType<typeof trpc.useUtils>, againAfterMs = 4_000): void {
  void utils.tranche.position.invalidate();
  setTimeout(() => void utils.tranche.position.invalidate(), againAfterMs);
}
