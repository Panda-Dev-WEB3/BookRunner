// Trading page data from the API (trade.* router). trade.markets is an optional procedure (an older API does not
// serve it): it goes through useOptional, and every other trade query waits until it is known to be served.
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useOptional } from "../../api/hooks";
import { POLL, trpc } from "../../api/trpc";
import type { TradeMarketsOut } from "../../lib/api-types";
import { invalidateWalletBalances } from "../../wallet/balances";

const parseMarkets = (raw: unknown): TradeMarketsOut | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as TradeMarketsOut) : null);

/** The open in-house markets. supported false: this API has no trade router yet. */
export function useTradeMarkets() {
  const q = useOptional("trade.markets", undefined, parseMarkets, { refetchInterval: POLL.list });
  return { q, supported: q.data?.supported ?? null, data: q.data?.supported ? (q.data.data ?? undefined) : undefined };
}

export function useTradeMarket(marketId: number, enabled: boolean) {
  return trpc.trade.market.useQuery({ marketId }, { enabled: enabled && marketId > 0, refetchInterval: POLL.live });
}

export function useTradePosition(marketId: number, wallet: string | null, enabled: boolean) {
  return trpc.trade.position.useQuery({ marketId, wallet: wallet ?? "" }, { enabled: enabled && !!wallet && marketId > 0, refetchInterval: POLL.live });
}

/** A value that settles `ms` after its last change (the quote is not re-read on every keystroke). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function useTradeQuote(marketId: number, sizeDelta: bigint | null, wallet: string | null, slippageBps: number, enabled: boolean) {
  const size = useDebounced(sizeDelta === null ? null : sizeDelta.toString());
  return trpc.trade.quote.useQuery(
    { marketId, sizeDelta: size ?? "0", slippageBps, ...(wallet ? { wallet } : {}) },
    { enabled: enabled && size !== null && size !== "0", refetchInterval: POLL.live, placeholderData: (prev) => prev },
  );
}

/** Re-reads the market and the position after a confirmed transaction: now, and once more a few seconds later. */
export function useRefreshTrade(): () => void {
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  return useCallback(() => {
    void refreshTrade(utils, qc);
    setTimeout(() => void refreshTrade(utils, qc), 4_000);
  }, [utils, qc]);
}

async function refreshTrade(utils: ReturnType<typeof trpc.useUtils>, qc: QueryClient): Promise<void> {
  await Promise.all([utils.trade.invalidate(), qc.invalidateQueries({ queryKey: ["optional", "trade.markets"] }), invalidateWalletBalances(qc)]);
}
