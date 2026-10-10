// Reads the settlement token's ERC-20 symbol() once (the token is BookrunnerConfig.usdc(), resolved
// by useAppContracts) and publishes it to lib/settlementToken.ts. Until it answers, or if the read
// fails, every label shows DEFAULT_SETTLEMENT_SYMBOL ("USDC").
import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { erc20Abi } from "viem";
import { getSettlementSymbol, sanitizeTokenSymbol, setSettlementSymbol, subscribeSettlementSymbol } from "../lib/settlementToken";
import { appChain, publicClient } from "./chains";
import { useAppContracts } from "./contracts";

/** The settlement token's display symbol; re-renders the caller when it changes. */
export function useSettlementSymbol(): string {
  return useSyncExternalStore(subscribeSettlementSymbol, getSettlementSymbol, getSettlementSymbol);
}

/** Mounted once at the app root: one symbol() read per settlement token address. */
export function SettlementSymbolSync(): null {
  const c = useAppContracts();
  const token = c.data?.usdc ?? null;
  const q = useQuery({
    queryKey: ["settlement-symbol", appChain.id, token],
    enabled: token !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
    queryFn: async () => sanitizeTokenSymbol(await publicClient.readContract({ address: token as NonNullable<typeof token>, abi: erc20Abi, functionName: "symbol" })),
  });
  const value = q.data ?? null;
  useEffect(() => {
    // null (loading or failed) keeps / restores the default label
    setSettlementSymbol(value);
  }, [value]);
  return null;
}
