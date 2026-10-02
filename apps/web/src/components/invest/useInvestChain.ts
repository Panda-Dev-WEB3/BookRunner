// Live chain reads for the invest flow, through the public RPC (so they work before a wallet is
// connected): the guardian pause and fee parameters from BookrunnerConfig, each tranche's current
// round (deposits open, committed so far, paused) and one wallet's room under the per-wallet cap.
import { type QueryClient, useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { appChain, publicClient } from "../../wallet/chains";
import { useAppContracts } from "../../wallet/contracts";
import { CONFIG_PARAMS_ABI, TRANCHE_ROUND_ABI, TRANCHE_WALLET_ABI } from "./abis";
import type { TrancheId } from "./logic";

const ROUNDS_KEY = "invest-tranche-rounds";
const WALLET_KEY = "invest-wallet-room";

export interface ProtocolParams {
  /** BookrunnerConfig.newBooksPaused(): every deposit is paused (redemptions are unaffected). */
  guardianPaused: boolean | null;
  carryBps: number | null;
  expenseCapBps: number | null;
}

/** Guardian pause, carry and expense cap (read once a minute). */
export function useProtocolParams() {
  const c = useAppContracts();
  const cfg = c.data?.config ?? null;
  return useQuery({
    queryKey: ["invest-protocol-params", appChain.id, cfg],
    enabled: cfg !== null,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<ProtocolParams> => {
      const address = cfg as Address;
      const [paused, carry, expense] = await Promise.all([
        publicClient.readContract({ address, abi: CONFIG_PARAMS_ABI, functionName: "newBooksPaused" }).catch(() => null),
        publicClient.readContract({ address, abi: CONFIG_PARAMS_ABI, functionName: "carryBps" }).catch(() => null),
        publicClient.readContract({ address, abi: CONFIG_PARAMS_ABI, functionName: "expenseCapBps" }).catch(() => null),
      ]);
      return { guardianPaused: paused, carryBps: carry === null ? null : Number(carry), expenseCapBps: expense === null ? null : Number(expense) };
    },
  });
}

export interface TrancheRound {
  /** Tranche.depositsOpen(): an open round, not paused, guardian not paused. */
  depositsOpen: boolean | null;
  /** USDC committed to the current round by every wallet (6 decimals). */
  totalCommitted: bigint | null;
  paused: boolean | null;
}

export type BookRounds = Record<TrancheId, TrancheRound>;

export interface TrancheAddresses {
  bookId: number;
  senior: Address;
  junior: Address;
}

async function readRound(address: Address): Promise<TrancheRound> {
  const [open, committed, paused] = await Promise.all([
    publicClient.readContract({ address, abi: TRANCHE_ROUND_ABI, functionName: "depositsOpen" }).catch(() => null),
    publicClient.readContract({ address, abi: TRANCHE_ROUND_ABI, functionName: "totalCommitted" }).catch(() => null),
    publicClient.readContract({ address, abi: TRANCHE_ROUND_ABI, functionName: "paused" }).catch(() => null),
  ]);
  return { depositsOpen: open, totalCommitted: committed, paused };
}

/** bookId -> both tranches' current round (polled every 30 s). */
export function useTrancheRounds(books: TrancheAddresses[]) {
  const key = books.map((b) => `${b.bookId}:${b.senior}:${b.junior}`).join(",");
  return useQuery({
    queryKey: [ROUNDS_KEY, appChain.id, key],
    enabled: books.length > 0,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: async (): Promise<Record<number, BookRounds>> => {
      const rows = await Promise.all(books.map(async (b) => [b.bookId, { senior: await readRound(b.senior), junior: await readRound(b.junior) }] as const));
      return Object.fromEntries(rows) as Record<number, BookRounds>;
    },
  });
}

export interface WalletTranche {
  /** This wallet's USDC committed to the current round. */
  committed: bigint | null;
  /** Tranche.maxDeposit(wallet): 0 when closed, uint256 max when uncapped (see walletRoomFromMaxDeposit). */
  maxDeposit: bigint | null;
}

/** The wallet's commitment and per-wallet room in both tranches of one book (polled every 15 s). */
export function useWalletRoom(book: TrancheAddresses | null, wallet: Address | null) {
  return useQuery({
    queryKey: [WALLET_KEY, appChain.id, book?.senior ?? null, book?.junior ?? null, wallet],
    enabled: !!book && !!wallet,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: async (): Promise<Record<TrancheId, WalletTranche>> => {
      const b = book as TrancheAddresses;
      const me = wallet as Address;
      const one = async (address: Address): Promise<WalletTranche> => {
        const [committed, maxDeposit] = await Promise.all([
          publicClient.readContract({ address, abi: TRANCHE_WALLET_ABI, functionName: "committedOf", args: [me] }).catch(() => null),
          publicClient.readContract({ address, abi: TRANCHE_WALLET_ABI, functionName: "maxDeposit", args: [me] }).catch(() => null),
        ]);
        return { committed, maxDeposit };
      };
      const [senior, junior] = await Promise.all([one(b.senior), one(b.junior)]);
      return { senior, junior };
    },
  });
}

/** Refresh the invest flow's chain reads (call after a deposit, withdrawal request or claim). */
export async function invalidateInvestReads(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: [ROUNDS_KEY] }),
    qc.invalidateQueries({ queryKey: [WALLET_KEY] }),
    qc.invalidateQueries({ queryKey: ["topup-rounds"] }),
  ]);
}
