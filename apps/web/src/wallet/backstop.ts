// The shared backstop pool's USDC balance, read on-chain from Backstop.balance() through the public
// client (works before a wallet connects). One query for every page that shows the pool.
import { useQuery } from "@tanstack/react-query";
import { BACKSTOP_BALANCE_ABI } from "../lib/abis";
import { appChain, publicClient } from "./chains";
import { useAppContracts } from "./contracts";

/** USDC held by the shared backstop pool (6 decimals). Polled every 60 s. */
export function useBackstopBalance() {
  const c = useAppContracts();
  const backstop = c.data?.backstop ?? null;
  return useQuery({
    queryKey: ["backstop-balance", appChain.id, backstop],
    enabled: backstop !== null,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<bigint> => {
      if (!backstop) throw new Error("Backstop address unknown");
      return publicClient.readContract({ address: backstop, abi: BACKSTOP_BALANCE_ABI, functionName: "balance" });
    },
  });
}
