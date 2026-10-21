// Insurance pool data from the API (pool.* router). pool.overview is an optional procedure (an older API does
// not serve it): it goes through useOptional, and every other pool query waits until it is known to be served.
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useOptional } from "../../api/hooks";
import { POLL, trpc } from "../../api/trpc";
import type { PoolOverviewOut } from "../../lib/api-types";
import { invalidateWalletBalances } from "../../wallet/balances";

const parseOverview = (raw: unknown): PoolOverviewOut | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as PoolOverviewOut) : null);

/** Pool totals, parameters and the queue. supported false: this API has no pool router yet. */
export function usePoolOverview() {
  const q = useOptional("pool.overview", undefined, parseOverview, { refetchInterval: POLL.slow });
  return {
    q,
    supported: q.data?.supported ?? null,
    data: q.data?.supported ? (q.data.data ?? undefined) : undefined,
  };
}

/** One wallet's shares, cooldown and requests (only once the API is known to serve the pool router). */
export function usePoolPosition(wallet: string | null, enabled: boolean) {
  return trpc.pool.position.useQuery({ wallet: wallet ?? "" }, { enabled: enabled && !!wallet, refetchInterval: POLL.marks });
}

export function usePoolEpochs(enabled: boolean, limit = 12) {
  return trpc.pool.epochs.useQuery({ limit }, { enabled, refetchInterval: POLL.slow });
}

export function usePoolHistory(enabled: boolean, days: number) {
  return trpc.pool.history.useQuery({ days }, { enabled, refetchInterval: POLL.slow });
}

export function usePoolExposure(enabled: boolean) {
  return trpc.pool.exposure.useQuery(undefined, { enabled, refetchInterval: POLL.slow });
}

/**
 * Re-reads the pool after a confirmed transaction: now, and once more a few seconds later (a public RPC node can
 * still answer from the block before the receipt for a moment), plus the wallet balances.
 */
export function useRefreshPool(): () => void {
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  return useCallback(() => {
    void refreshPool(utils, qc);
    setTimeout(() => void refreshPool(utils, qc), 4_000);
  }, [utils, qc]);
}

async function refreshPool(utils: ReturnType<typeof trpc.useUtils>, qc: QueryClient): Promise<void> {
  await Promise.all([utils.pool.invalidate(), qc.invalidateQueries({ queryKey: ["optional", "pool.overview"] }), invalidateWalletBalances(qc)]);
}
