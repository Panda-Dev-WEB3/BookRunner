// Live top-up rounds of every listed book, read on-chain from Book.topUp() (polled every 60 s).
import { useQuery } from "@tanstack/react-query";
import { BOOK_TOPUP_ABI } from "../lib/abis";
import { type TopUpRound, parseTopUp } from "../lib/topup";
import { appChain, publicClient } from "./chains";
import { useAppContracts } from "./contracts";

export type { TopUpRound } from "../lib/topup";
export { isTopUpOpen, topUpCapacity } from "../lib/topup";

/** bookId -> its current top-up round (a book whose read fails is left out). */
export function useTopUpRounds() {
  const { books } = useAppContracts();
  const key = books.map((b) => `${b.bookId}:${b.book}`).join(",");
  return useQuery({
    queryKey: ["topup-rounds", appChain.id, key],
    enabled: books.length > 0,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<Record<number, TopUpRound>> => {
      const rows = await Promise.all(
        books.map((b) =>
          publicClient
            .readContract({ address: b.book, abi: BOOK_TOPUP_ABI, functionName: "topUp" })
            .then((raw) => parseTopUp(b.bookId, raw))
            .catch(() => null),
        ),
      );
      const out: Record<number, TopUpRound> = {};
      for (const r of rows) if (r) out[r.bookId] = r;
      return out;
    },
  });
}
