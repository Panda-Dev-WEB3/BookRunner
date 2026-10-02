// "Mint 10,000 test USDC" from the user's own wallet: MockERC20.mint(self, 10_000e6). Test networks
// only (never offered on mainnet), and only after an eth_call simulation shows the token's mint is
// open, so a real USDC deployment never gets the button.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Address, Hex } from "viem";
import { type MintUnavailableReason, TEST_USDC_AMOUNT, mintAvailability, mockMintData, mockMintTx } from "../lib/funds";
import { type TxItem, runSequential } from "../lib/txflow";
import { invalidateWalletBalances } from "./balances";
import { appChain, publicClient } from "./chains";
import { useAppContracts } from "./contracts";
import { isTestChain } from "./network";
import { useWallet } from "./WalletContext";

export type MintStatus = "idle" | "signing" | "pending" | "confirmed" | "failed";
export type { MintUnavailableReason };

export interface MintTestUsdc {
  /** The button can be offered: test network, wallet connected, token mint is open. */
  available: boolean;
  /** Why it is not available (null when available). */
  reason: MintUnavailableReason | null;
  /** Amount minted per click, base units (10,000 USDC). */
  amount: bigint;
  status: MintStatus;
  hash: Hex | null;
  error: string | null;
  /** Sends the mint from the active wallet; resolves true once confirmed. */
  mint: () => Promise<boolean>;
  reset: () => void;
}

export function useMintTestUsdc(): MintTestUsdc {
  const w = useWallet();
  const qc = useQueryClient();
  const c = useAppContracts();
  const me = w.active?.address ?? null;
  const usdc = c.data?.usdc ?? null;
  const sim = useQuery({
    queryKey: ["usdc-mintable", appChain.id, usdc, me],
    enabled: isTestChain && usdc !== null && me !== null,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      publicClient
        .call({ account: me as Address, to: usdc as Address, data: mockMintData(me as Address, TEST_USDC_AMOUNT) })
        .then(() => true)
        .catch(() => false),
  });
  const [item, setItem] = useState<TxItem | null>(null);

  const reason = mintAvailability({ testChain: isTestChain, wallet: !!me && !!w.executor, usdc, contractsLoading: c.isLoading, simulated: sim.data });

  const mint = useCallback(async () => {
    // never send a mint that is not offered (mainnet, unknown chain, a real USDC)
    if (reason !== null || !w.executor || !me || !usdc) return false;
    const first: TxItem = { tx: mockMintTx(usdc, me, TEST_USDC_AMOUNT, appChain.id), status: "queued" };
    setItem(first);
    const r = await runSequential([first], w.executor, (items) => setItem(items[0] ?? null));
    void invalidateWalletBalances(qc);
    return r.ok;
  }, [reason, w.executor, me, usdc, qc]);

  const status: MintStatus = !item
    ? "idle"
    : item.status === "confirmed"
      ? "confirmed"
      : item.status === "failed" || item.status === "skipped"
        ? "failed"
        : item.status === "pending"
          ? "pending"
          : "signing";

  return {
    available: reason === null,
    reason,
    amount: TEST_USDC_AMOUNT,
    status,
    hash: item?.hash ?? null,
    error: item?.error ?? null,
    mint,
    reset: () => setItem(null),
  };
}
