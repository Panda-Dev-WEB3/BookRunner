// Live data for the How it works page: the listed books (marked tranche NAVs, mark cadence), one
// showcase book's detail (latest signed mark, charter and mandate) and the staking contract (the
// backstop pool comes from wallet/backstop.ts). Every figure the page shows is read from the API or the chain.
import { useQuery } from "@tanstack/react-query";
import { type Address, erc20Abi } from "viem";
import { POLL, trpc } from "../../api/trpc";
import type { BookListItem } from "../../lib/api-types";
import { appChain, publicClient } from "../../wallet/chains";
import { useAppContracts } from "../../wallet/contracts";

// Minimal view fragments (the generated ABIs in @bookrunner/shared/abi are much larger than these reads need).
const uintView = <N extends string, T extends "uint256" | "uint64">(name: N, type: T) =>
  ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type }] }) as const;
/** BkrnStaking.totalStaked() (18dp) and cooldown() (seconds). */
const STAKING_ABI = [uintView("totalStaked", "uint256"), uintView("cooldown", "uint64")] as const;

export function useLiveBooks() {
  return trpc.book.list.useQuery(undefined, { refetchInterval: POLL.marks });
}

/** Books with a marked NAV (Live or Retiring), in book-id order. */
export function markedBooks(books: readonly BookListItem[] | undefined): BookListItem[] {
  return (books ?? []).filter((b) => (b.state === "Live" || b.state === "Retiring") && b.lastMark !== null).sort((a, b) => a.bookId - b.bookId);
}

/** The book the page uses for its live examples: the first marked book (NVDA on testnet). */
export function useShowcaseBook() {
  const list = useLiveBooks();
  const first = markedBooks(list.data)[0] ?? null;
  const detail = trpc.book.get.useQuery({ bookId: first?.bookId ?? 1 }, { enabled: first !== null, refetchInterval: POLL.marks });
  return { list, book: first, detail };
}

export interface StakingStats {
  /** BKRN staked in total (18dp); null when unreadable. */
  totalStaked: bigint | null;
  /** Unstake cooldown, seconds; null when unreadable. */
  cooldownSeconds: number | null;
  /** BKRN total supply (18dp); null when unreadable. */
  totalSupply: bigint | null;
}

/** BkrnStaking.totalStaked() and cooldown(), and BKRN's totalSupply(), read on-chain. */
export function useStakingStats() {
  const contracts = useAppContracts();
  const address: Address | null = contracts.data?.staking ?? null;
  const token: Address | null = contracts.data?.bkrn ?? null;
  return useQuery({
    queryKey: ["learn-staking-stats", appChain.id, address, token],
    enabled: address !== null,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<StakingStats> => {
      if (!address) throw new Error("Staking address unknown");
      const [staked, cooldown, supply] = await Promise.allSettled([
        publicClient.readContract({ address, abi: STAKING_ABI, functionName: "totalStaked" }),
        publicClient.readContract({ address, abi: STAKING_ABI, functionName: "cooldown" }),
        token ? publicClient.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }) : Promise.reject(new Error("BKRN address unknown")),
      ]);
      return {
        totalStaked: staked.status === "fulfilled" ? staked.value : null,
        cooldownSeconds: cooldown.status === "fulfilled" ? Number(cooldown.value) : null,
        totalSupply: supply.status === "fulfilled" ? supply.value : null,
      };
    },
  });
}
