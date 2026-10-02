// Data for the Portfolio page: every book's tranche.position for the wallet (API), the wallet's
// tranche events (read from the chain's logs, since the API keeps no per-wallet activity feed) and
// its BKRN staking state (staking contract views).
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { type Address, parseAbiItem } from "viem";
import { POLL, refreshPositions, trpc } from "../../api/trpc";
import type { BookListItem } from "../../lib/api-types";
import { invalidateWalletBalances } from "../../wallet/balances";
import { appChain, publicClient } from "../../wallet/chains";
import { type BookContracts, useAppContracts } from "../../wallet/contracts";
import { useTopUpRounds } from "../../wallet/topUp";
import {
  type ActivityItem,
  type BookHolding,
  type StakingRaw,
  type TrancheLog,
  activityFromLogs,
  bookHolding,
  portfolioTotals,
  trancheIndex,
} from "./model";

export interface PortfolioEntry {
  book: BookListItem;
  /** null while the position is loading or failed to load. */
  holding: BookHolding | null;
  loading: boolean;
  error: unknown;
}

/** Positions of `wallet` in every listed book, with wallet-wide totals. */
export function usePortfolio(wallet: Address) {
  const books = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.marks });
  const list = books.data ?? [];
  const positions = trpc.useQueries((t) => list.map((b) => t.tranche.position({ bookId: b.bookId, wallet }, { refetchInterval: POLL.marks })));
  const rounds = useTopUpRounds();
  const entries: PortfolioEntry[] = list.map((book, i) => {
    const q = positions[i];
    const data = q?.data;
    return {
      book,
      holding: data ? bookHolding(data) : null,
      loading: !data && !!q && !q.error && !q.failureReason,
      error: data ? null : (q?.error ?? q?.failureReason ?? null),
    };
  });
  const holdings = entries.flatMap((e) => (e.holding ? [e.holding] : []));
  return {
    booksQuery: books,
    entries,
    holdings,
    totals: portfolioTotals(holdings),
    rounds: rounds.data,
    /** Book list or at least one position still loading (nothing to show for it yet). */
    loading: books.isLoading || entries.some((e) => e.loading),
    failed: entries.filter((e) => e.error !== null && e.holding === null),
    refetch: () => {
      void books.refetch();
      for (const q of positions) void q.refetch();
    },
  };
}

export const ACTIVITY_QUERY_KEY = ["wallet-activity"] as const;
export const STAKING_QUERY_KEY = ["wallet-staking"] as const;

const EVENTS = {
  committed: parseAbiItem("event Committed(address indexed wallet, address indexed receiver, uint256 assets, uint256 round)"),
  allocation: parseAbiItem("event AllocationClaimed(address indexed wallet, uint256 shares, uint256 refund)"),
  redeemRequest: parseAbiItem("event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares)"),
  redemptionClaim: parseAbiItem("event RedemptionClaimed(address indexed controller, address indexed receiver, uint256 assets)"),
} as const;

/** Rows shown in the activity list. */
const ACTIVITY_LIMIT = 15;

/**
 * The wallet's deposits, allocation claims, redemption requests and redemption claims across every
 * book's tranches, newest first, with block times. Errors (an RPC that limits log queries) surface as
 * a query error so the page can fall back to the API's redemption list.
 */
export function useWalletActivity(wallet: Address | null, books: BookContracts[]) {
  const addresses = books.flatMap((b) => [b.senior, b.junior]);
  return useQuery({
    queryKey: [...ACTIVITY_QUERY_KEY, appChain.id, wallet, addresses.join(",")],
    enabled: wallet !== null && addresses.length > 0,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<ActivityItem[]> => {
      const me = wallet as Address;
      const range = { address: addresses, fromBlock: 0n, toBlock: "latest" } as const;
      const [deposits, allocations, requests, claims] = await Promise.all([
        publicClient.getLogs({ ...range, event: EVENTS.committed, args: { receiver: me } }),
        publicClient.getLogs({ ...range, event: EVENTS.allocation, args: { wallet: me } }),
        publicClient.getLogs({ ...range, event: EVENTS.redeemRequest, args: { owner: me } }),
        publicClient.getLogs({ ...range, event: EVENTS.redemptionClaim, args: { controller: me } }),
      ]);
      const toLog = (l: { address: string; eventName: string; args: object; transactionHash: string | null; blockNumber: bigint | null; logIndex: number | null }): TrancheLog => ({
        address: l.address,
        eventName: l.eventName,
        args: l.args as Readonly<Record<string, unknown>>,
        transactionHash: l.transactionHash,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
      });
      const logs = [...deposits.map(toLog), ...allocations.map(toLog), ...requests.map(toLog), ...claims.map(toLog)];
      const items = activityFromLogs(logs, trancheIndex(books), ACTIVITY_LIMIT);
      const blocks = [...new Set(items.flatMap((i) => (i.blockNumber === null ? [] : [i.blockNumber])))];
      const times = new Map<bigint, number | null>(
        await Promise.all(
          blocks.map(async (n): Promise<[bigint, number | null]> => [
            n,
            await publicClient
              .getBlock({ blockNumber: n })
              .then((b) => Number(b.timestamp))
              .catch(() => null),
          ]),
        ),
      );
      return items.map((i) => ({ ...i, timestamp: i.blockNumber === null ? null : (times.get(i.blockNumber) ?? null) }));
    },
  });
}

const accountView = <N extends string>(name: N) =>
  ({ type: "function", name, stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }) as const;

/** The BkrnStaking views this page reads (a small fragment of the generated ABI). */
const STAKING_VIEWS_ABI = [
  accountView("stakedOf"),
  accountView("lockedOf"),
  accountView("availableOf"),
  accountView("earned"),
  {
    type: "function",
    name: "pendingUnstakeOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "amount", type: "uint256" },
      { name: "availableAt", type: "uint64" },
    ],
  },
] as const;

/** BKRN staking state of `wallet` (null address or unknown staking contract: disabled). */
export function useStakingSummary(wallet: Address | null) {
  const c = useAppContracts();
  const staking = c.data?.staking ?? null;
  const q = useQuery({
    queryKey: [...STAKING_QUERY_KEY, appChain.id, staking, wallet],
    enabled: wallet !== null && staking !== null,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: async (): Promise<StakingRaw> => {
      const address = staking as Address;
      const account = wallet as Address;
      const abi = STAKING_VIEWS_ABI;
      const args = [account] as const;
      const [staked, locked, available, earned, pending] = await Promise.all([
        publicClient.readContract({ address, abi, functionName: "stakedOf", args }),
        publicClient.readContract({ address, abi, functionName: "lockedOf", args }),
        publicClient.readContract({ address, abi, functionName: "availableOf", args }),
        publicClient.readContract({ address, abi, functionName: "earned", args }),
        publicClient.readContract({ address, abi, functionName: "pendingUnstakeOf", args }),
      ]);
      return { staked, locked, available, earned, pendingUnstake: pending[0], unstakeAvailableAt: Number(pending[1]) };
    },
  });
  return { ...q, stakingAddress: staking, contractsLoading: c.isLoading, contractsError: c.error };
}

/** Refresh everything a claim or a redemption request changes. */
export async function refreshAfterTx(qc: QueryClient, utils: ReturnType<typeof trpc.useUtils>): Promise<void> {
  refreshPositions(utils);
  await Promise.all([
    utils.book.list.invalidate(),
    invalidateWalletBalances(qc),
    qc.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY }),
  ]);
}
