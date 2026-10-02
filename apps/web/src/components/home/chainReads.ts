// Live on-chain reads for the Home page: the backstop pool's USDC balance and how much has been
// committed so far to each book's open top-up round. Read-only, through the app's public client.
import { useQuery } from "@tanstack/react-query";
import { appChain, publicClient } from "../../wallet/chains";
import { useAppContracts } from "../../wallet/contracts";

const BACKSTOP_BALANCE_ABI = [{ type: "function", name: "balance", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const;
const TRANCHE_COMMITTED_ABI = [{ type: "function", name: "totalCommitted", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const;

/** USDC held by the shared backstop pool (6 decimals). Polled every 60 s. */
export function useBackstopPool() {
  const c = useAppContracts();
  const backstop = c.data?.backstop ?? null;
  return useQuery({
    queryKey: ["home-backstop-pool", appChain.id, backstop],
    enabled: backstop !== null,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<bigint> => {
      if (!backstop) throw new Error("Backstop address unknown");
      return publicClient.readContract({ address: backstop, abi: BACKSTOP_BALANCE_ABI, functionName: "balance" });
    },
  });
}

export interface RoundCommitted {
  senior: bigint;
  junior: bigint;
}

/** bookId -> USDC committed to the current round of each tranche (books whose read fails are left out). */
export function useRoundCommitments(bookIds: readonly number[]) {
  const { books } = useAppContracts();
  const wanted = books.filter((b) => bookIds.includes(b.bookId));
  const key = wanted.map((b) => `${b.bookId}:${b.senior}:${b.junior}`).join(",");
  return useQuery({
    queryKey: ["home-round-committed", appChain.id, key],
    enabled: wanted.length > 0,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<Record<number, RoundCommitted>> => {
      const rows = await Promise.all(
        wanted.map(async (b) => {
          try {
            const [senior, junior] = await Promise.all([
              publicClient.readContract({ address: b.senior, abi: TRANCHE_COMMITTED_ABI, functionName: "totalCommitted" }),
              publicClient.readContract({ address: b.junior, abi: TRANCHE_COMMITTED_ABI, functionName: "totalCommitted" }),
            ]);
            return [b.bookId, { senior, junior }] as const;
          } catch {
            return null;
          }
        }),
      );
      const out: Record<number, RoundCommitted> = {};
      for (const r of rows) if (r) out[r[0]] = r[1];
      return out;
    },
  });
}
