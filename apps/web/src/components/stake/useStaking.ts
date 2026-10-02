// Live staking data read straight from the chain through the app's public client: protocol-wide
// figures (BkrnStaking, BkrnFeeRouter, Backstop) and one wallet's position. Addresses come from
// useAppContracts() (book.list -> Book.config() -> BookrunnerConfig getters). A failed read
// becomes null for that one figure, so a single bad call never blanks the page.
import { backstopAbi } from "@bookrunner/shared/abi/Backstop";
import { bkrnFeeRouterAbi } from "@bookrunner/shared/abi/BkrnFeeRouter";
import { bkrnStakingAbi } from "@bookrunner/shared/abi/BkrnStaking";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { type Address, erc20Abi } from "viem";
import { invalidateWalletBalances } from "../../wallet/balances";
import { appChain, publicClient } from "../../wallet/chains";
import { type AppContracts, useAppContracts } from "../../wallet/contracts";
import type { StakePosition } from "./stakeLogic";

export const STAKING_QUERY_KEY = ["staking"] as const;
const POLL_MS = 15_000;

export interface StakingProtocol {
  staking: Address;
  bkrn: Address;
  feeRouter: Address;
  backstop: Address;
  /** Every staked BKRN, including locked bonds and stake in cooldown (18 dp). */
  totalStaked: bigint | null;
  /** Current unstake cooldown in seconds (applies to requests made from now on). */
  cooldownSec: number | null;
  /** Fixed BKRN supply (18 dp). */
  totalSupply: bigint | null;
  /** Lifetime protocol carry received by the fee router (USDC 6 dp). */
  carryReceivedUsd: bigint | null;
  /** Lifetime carry sent to the backstop pool (USDC 6 dp). */
  toBackstopUsd: bigint | null;
  /** Lifetime USDC spent on buybacks (USDC 6 dp). */
  buybackSpentUsd: bigint | null;
  /** Carry waiting for the next buyback (USDC 6 dp). */
  buybackPendingUsd: bigint | null;
  /** Lifetime BKRN bought back and distributed to stakers (18 dp). */
  distributedBkrn: bigint | null;
  /** USDC the backstop holds now (6 dp). */
  backstopBalanceUsd: bigint | null;
  /** Lifetime cover the backstop has paid to books (6 dp). */
  backstopCoveredUsd: bigint | null;
}

type Read = <T>(p: Promise<T>) => Promise<T | null>;
const soft: Read = (p) => p.catch(() => null);

async function readProtocol(c: AppContracts): Promise<StakingProtocol> {
  const st = { address: c.staking, abi: bkrnStakingAbi } as const;
  const fr = { address: c.feeRouter, abi: bkrnFeeRouterAbi } as const;
  const bs = { address: c.backstop, abi: backstopAbi } as const;
  const [totalStaked, cooldown, totalSupply, carry, toBackstop, buybackSpent, buybackPending, distributed, backstopBalance, covered] = await Promise.all([
    soft(publicClient.readContract({ ...st, functionName: "totalStaked" })),
    soft(publicClient.readContract({ ...st, functionName: "cooldown" })),
    soft(publicClient.readContract({ address: c.bkrn, abi: erc20Abi, functionName: "totalSupply" })),
    soft(publicClient.readContract({ ...fr, functionName: "totalCarryReceived" })),
    soft(publicClient.readContract({ ...fr, functionName: "totalToBackstop" })),
    soft(publicClient.readContract({ ...fr, functionName: "totalBuybackUsdc" })),
    soft(publicClient.readContract({ ...fr, functionName: "buybackPending" })),
    soft(publicClient.readContract({ ...fr, functionName: "totalBkrnDistributed" })),
    soft(publicClient.readContract({ ...bs, functionName: "balance" })),
    soft(publicClient.readContract({ ...bs, functionName: "totalCovered" })),
  ]);
  return {
    staking: c.staking,
    bkrn: c.bkrn,
    feeRouter: c.feeRouter,
    backstop: c.backstop,
    totalStaked,
    cooldownSec: cooldown === null ? null : Number(cooldown),
    totalSupply,
    carryReceivedUsd: carry,
    toBackstopUsd: toBackstop,
    buybackSpentUsd: buybackSpent,
    buybackPendingUsd: buybackPending,
    distributedBkrn: distributed,
    backstopBalanceUsd: backstopBalance,
    backstopCoveredUsd: covered,
  };
}

/** Protocol-wide staking figures, polled every 15 s. */
export function useStakingProtocol() {
  const c = useAppContracts();
  const q = useQuery({
    queryKey: [...STAKING_QUERY_KEY, "protocol", appChain.id, c.data?.staking ?? null],
    enabled: c.data !== undefined,
    refetchInterval: POLL_MS,
    retry: 1,
    queryFn: () => readProtocol(c.data as AppContracts),
  });
  return {
    data: q.data,
    contracts: c.data,
    isLoading: c.isLoading || (c.data !== undefined && q.isLoading),
    error: c.error ?? q.error ?? null,
    noBooks: c.noBooks,
    refetch: () => {
      c.refetch();
      void q.refetch();
    },
  };
}

async function readPosition(staking: Address, bkrn: Address, me: Address): Promise<StakePosition> {
  const st = { address: staking, abi: bkrnStakingAbi } as const;
  // These must all succeed: a partial position would show wrong actions (e.g. a missing lock).
  const [staked, locked, available, pending, earned, allowance] = await Promise.all([
    publicClient.readContract({ ...st, functionName: "stakedOf", args: [me] }),
    publicClient.readContract({ ...st, functionName: "lockedOf", args: [me] }),
    publicClient.readContract({ ...st, functionName: "availableOf", args: [me] }),
    publicClient.readContract({ ...st, functionName: "pendingUnstakeOf", args: [me] }),
    publicClient.readContract({ ...st, functionName: "earned", args: [me] }),
    publicClient.readContract({ address: bkrn, abi: erc20Abi, functionName: "allowance", args: [me, staking] }),
  ]);
  const [pendingAmount, availableAt] = pending;
  return { staked, locked, available, pending: pendingAmount, availableAt: Number(availableAt), earned, allowance };
}

/** One wallet's staking position (default: none until an address is given), polled every 15 s. */
export function useStakePosition(address: Address | null | undefined) {
  const c = useAppContracts();
  const staking = c.data?.staking ?? null;
  const bkrn = c.data?.bkrn ?? null;
  return useQuery({
    queryKey: [...STAKING_QUERY_KEY, "position", appChain.id, staking, address ?? null],
    enabled: !!address && staking !== null && bkrn !== null,
    refetchInterval: POLL_MS,
    retry: 1,
    queryFn: () => readPosition(staking as Address, bkrn as Address, address as Address),
  });
}

/** Refresh the staking views and the wallet balances after a staking transaction. */
export async function invalidateStaking(qc: QueryClient): Promise<void> {
  await Promise.all([qc.invalidateQueries({ queryKey: STAKING_QUERY_KEY }), invalidateWalletBalances(qc)]);
}
