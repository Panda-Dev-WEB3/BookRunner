// ETH (gas), USDC and BKRN balances of the active wallet on the app chain, read through the
// public RPC (works for browser wallets and devnet dev wallets alike). Polls every 15 s; call
// invalidateWalletBalances() after a transaction that moves funds.
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { type Address, erc20Abi } from "viem";
import { appChain, publicClient } from "./chains";
import { useAppContracts } from "./contracts";
import { useWallet } from "./WalletContext";

export const BALANCES_QUERY_KEY = ["wallet-balances"] as const;

export interface WalletBalances {
  address: Address | null;
  /** Wei. undefined while loading, null when it could not be read. */
  eth: bigint | null | undefined;
  /** USDC base units (6 decimals). undefined while loading, null when unreadable. */
  usdc: bigint | null | undefined;
  /** BKRN base units (18 decimals). undefined while loading, null when unreadable. */
  bkrn: bigint | null | undefined;
  usdcAddress: Address | null;
  bkrnAddress: Address | null;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => Promise<void>;
}

/** One read, retried once: a single RPC hiccup (429 / 503 on the public RPC) is not "no balance". */
async function readTwice<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    try {
      return await f();
    } catch {
      return null;
    }
  }
}

const erc20Balance = (token: Address | null, owner: Address): Promise<bigint | null> =>
  token ? readTwice(() => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] })) : Promise.resolve(null);

/** Balances of `address` (default: the active wallet). */
export function useWalletBalances(address?: Address | null): WalletBalances {
  const w = useWallet();
  const owner = address === undefined ? (w.active?.address ?? null) : address;
  const c = useAppContracts();
  const usdc = c.data?.usdc ?? null;
  const bkrn = c.data?.bkrn ?? null;
  const tokensKnown = c.data !== undefined;
  const lastGood = useRef<{ owner: Address | null; eth: bigint | null; usdc: bigint | null; bkrn: bigint | null }>({ owner: null, eth: null, usdc: null, bkrn: null });
  const q = useQuery({
    queryKey: [...BALANCES_QUERY_KEY, appChain.id, owner, usdc, bkrn],
    enabled: owner !== null,
    refetchInterval: 15_000,
    retry: false,
    queryFn: async () => {
      const me = owner as Address;
      const [eth, u, b] = await Promise.all([readTwice(() => publicClient.getBalance({ address: me })), erc20Balance(usdc, me), erc20Balance(bkrn, me)]);
      // a read that still failed keeps the last value read for this wallet: unknown is not empty
      const last = lastGood.current.owner === me ? lastGood.current : null;
      const next = { eth: eth ?? last?.eth ?? null, usdc: u ?? last?.usdc ?? null, bkrn: b ?? last?.bkrn ?? null };
      lastGood.current = { owner: me, ...next };
      return next;
    },
  });
  const tokenValue = (v: bigint | null | undefined): bigint | null | undefined => {
    if (!q.data) return undefined;
    // token addresses still resolving: the token balance is "loading", not "unreadable"
    if (!tokensKnown) return c.error || c.noBooks ? null : undefined;
    return v;
  };
  return {
    address: owner,
    eth: q.data ? q.data.eth : undefined,
    usdc: tokenValue(q.data?.usdc),
    bkrn: tokenValue(q.data?.bkrn),
    usdcAddress: usdc,
    bkrnAddress: bkrn,
    isLoading: owner !== null && (q.isLoading || (!tokensKnown && c.isLoading)),
    isFetching: q.isFetching,
    error: q.error ?? null,
    refetch: async () => {
      await q.refetch();
    },
  };
}

/** Refresh every balance view (this hook, the gas checks and the mock-USDC panel). */
export async function invalidateWalletBalances(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: BALANCES_QUERY_KEY }),
    qc.invalidateQueries({ queryKey: ["gas-balance"] }),
    qc.invalidateQueries({ queryKey: ["usdc-state"] }),
  ]);
}
