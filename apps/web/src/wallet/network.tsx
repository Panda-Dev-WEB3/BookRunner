// Network helpers for injected wallets (switch to / add the app chain) and test funds on devnet and
// testnet: native gas balance with a faucet pointer and an anvil top-up on devnet. The mock-USDC mint
// lives in useMintTestUsdc.ts; balances in balances.ts.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Address, createTestClient, getAddress, http } from "viem";
import { trpc } from "../api/trpc";
import { cx } from "../components/ui";
import { gasStatus } from "../lib/chainConfig";
import { config } from "../lib/config";
import { DEVNET_TOPUP_WEI, TRANCHE_ASSET_ABI, fmtEth } from "../lib/funds";
import { invalidateWalletBalances } from "./balances";
import { appChain, chainName, publicClient } from "./chains";
import { useWallet } from "./WalletContext";

export const isTestChain = config.chain.kind !== "mainnet";

/** Native balance of an address on the app chain (polled; undefined while unknown or unreachable). */
export function useGasBalance(address: Address | null | undefined) {
  return useQuery({
    queryKey: ["gas-balance", appChain.id, address ?? null],
    enabled: !!address,
    queryFn: () => publicClient.getBalance({ address: address as Address }),
    refetchInterval: 15_000,
    retry: false,
  });
}

/** The USDC the books settle in: VITE_USDC_ADDRESS, else asset() of the first book's Senior tranche. */
export function useUsdcAddress() {
  const books = trpc.book.list.useQuery(undefined, { staleTime: 60_000 });
  const tranche = books.data?.[0]?.components.senior ?? null;
  return useQuery({
    queryKey: ["usdc-address", appChain.id, config.usdcAddress ?? tranche],
    enabled: !!config.usdcAddress || !!tranche,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async (): Promise<Address> =>
      config.usdcAddress
        ? getAddress(config.usdcAddress)
        : publicClient.readContract({ address: tranche as Address, abi: TRANCHE_ASSET_ABI, functionName: "asset" }),
  });
}

/** Banner for an injected wallet on another chain: switch (adds the chain when missing) or add it. */
export function NetworkNotice({ className }: { className?: string }) {
  const w = useWallet();
  if (!w.wrongNetwork || !w.active) return null;
  return (
    <div className={cx("rounded-control border border-warn/50 bg-warn/10 p-2.5 text-[12px]", className)} role="status">
      <div>
        The wallet is on <span className="font-medium">{chainName(w.active.chainId)}</span>; this build of Bookrunner runs on{" "}
        <span className="font-medium">{appChain.name}</span> (chain {appChain.id}).
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary h-7 min-h-7 text-[12px]" disabled={w.switching} onClick={() => void w.switchToAppChain()}>
          {w.switching ? "Waiting for the wallet…" : `Switch to ${appChain.name}`}
        </button>
        <button type="button" className="btn h-7 min-h-7 text-[12px]" disabled={w.switching} onClick={() => void w.addAppChain()}>
          Add network to wallet
        </button>
      </div>
      {w.networkError && <div className="mt-1.5 text-[11.5px] text-critical-ink">{w.networkError}</div>}
    </div>
  );
}

/** One-line gas warning with the faucet (used next to prepared transactions). */
export function GasWarning({ address }: { address: Address | null | undefined }) {
  const gas = useGasBalance(isTestChain ? address : null);
  const s = gasStatus(gas.data);
  if (!address || (s !== "empty" && s !== "low")) return null;
  return (
    <div className="rounded-control bg-warn/15 px-2 py-1.5 text-[11.5px]">
      {s === "empty" ? "This address has no" : "This address is low on"} {config.chain.kind === "devnet" ? "devnet" : "testnet"} ETH for gas ({fmtEth(gas.data)}).{" "}
      {config.faucetUrl ? (
        <a className="link" href={config.faucetUrl} target="_blank" rel="noreferrer">
          Get testnet coins from the faucet
        </a>
      ) : (
        "Fund it from the wallet menu."
      )}
    </div>
  );
}

/** Devnet only: anvil_setBalance top-up (10 ETH) for an address that has no gas. */
export function DevnetTopUp({ address, className }: { address: Address; className?: string }) {
  const qc = useQueryClient();
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  if (config.chain.kind !== "devnet") return null;
  const run = async () => {
    setState("busy");
    try {
      await createTestClient({ chain: appChain, mode: "anvil", transport: http(config.rpcUrl) }).setBalance({ address, value: DEVNET_TOPUP_WEI });
      setState("idle");
      void invalidateWalletBalances(qc);
    } catch {
      setState("failed");
    }
  };
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-2", className)}>
      <button type="button" className="btn btn-sm" disabled={state === "busy"} onClick={() => void run()}>
        {state === "busy" ? "Funding…" : "Top up 10 ETH (anvil)"}
      </button>
      {state === "failed" && <span className="text-[12px] text-critical-ink">the RPC refused anvil_setBalance</span>}
    </span>
  );
}
