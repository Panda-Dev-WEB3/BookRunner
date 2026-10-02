// Network helpers for injected wallets (switch to / add the app chain) and test funds on devnet and
// testnet: native gas balance with a faucet pointer, mock-USDC mint (offered only when the token's
// mint is open, checked by an eth_call simulation), and an anvil top-up on devnet.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Address, createTestClient, erc20Abi, getAddress, http } from "viem";
import { trpc } from "../api/trpc";
import { Chip, Hash, cx } from "../components/ui";
import { gasStatus } from "../lib/chainConfig";
import { config } from "../lib/config";
import { fmtUsd, rawToDecimal } from "../lib/format";
import { DEVNET_TOPUP_WEI, TEST_USDC_AMOUNT, TRANCHE_ASSET_ABI, fmtEth, mockMintData, mockMintTx } from "../lib/funds";
import { type TxItem, initialItems, runSequential } from "../lib/txflow";
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
    <div className={cx("rounded-[2px] border border-warn/50 bg-warn/10 p-2.5 text-[12px]", className)} role="status">
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
    <div className="rounded-[2px] bg-warn/15 px-2 py-1.5 text-[11.5px]">
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

type MintState = { items: TxItem[]; running: boolean; error: string | null };

/** Gas + test USDC for the active wallet (wallet menu). Hidden on mainnet. */
export function WalletFunds() {
  const w = useWallet();
  const qc = useQueryClient();
  const address = w.active?.address ?? null;
  const gas = useGasBalance(isTestChain ? address : null);
  const usdc = useUsdcAddress();
  const [mint, setMint] = useState<MintState | null>(null);
  const [topUp, setTopUp] = useState<"idle" | "busy" | "failed">("idle");
  const devnet = config.chain.kind === "devnet";

  const usdcState = useQuery({
    queryKey: ["usdc-state", appChain.id, usdc.data ?? null, address],
    enabled: !!usdc.data && !!address && isTestChain,
    refetchInterval: 15_000,
    retry: false,
    queryFn: async () => {
      const token = usdc.data as Address;
      const me = address as Address;
      const [balance, symbol, mintable] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "USDC"),
        publicClient
          .call({ account: me, to: token, data: mockMintData(me, TEST_USDC_AMOUNT) })
          .then(() => true)
          .catch(() => false),
      ]);
      return { balance, symbol, mintable };
    },
  });

  if (!address || !isTestChain) return null;
  const status = gasStatus(gas.data);

  const anvilTopUp = async () => {
    setTopUp("busy");
    try {
      await createTestClient({ chain: appChain, mode: "anvil", transport: http(config.rpcUrl) }).setBalance({ address, value: DEVNET_TOPUP_WEI });
      setTopUp("idle");
      void qc.invalidateQueries({ queryKey: ["gas-balance"] });
    } catch {
      setTopUp("failed");
    }
  };

  const runMint = async () => {
    if (!w.executor || !usdc.data || !usdcState.data) return;
    const items = initialItems([mockMintTx(usdc.data, address, TEST_USDC_AMOUNT, appChain.id, usdcState.data.symbol)]);
    setMint({ items, running: true, error: null });
    const r = await runSequential(items, w.executor, (it) => setMint({ items: it, running: true, error: null }));
    setMint({ items: r.items, running: false, error: r.ok ? null : (r.items[0]?.error ?? "Mint failed") });
    void qc.invalidateQueries({ queryKey: ["usdc-state"] });
    void qc.invalidateQueries({ queryKey: ["gas-balance"] });
  };
  const mintItem = mint?.items[0];

  return (
    <div className="space-y-2 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink-2">Gas on {appChain.name}</span>
        <span className="flex items-center gap-1.5">
          <span className="num">{gas.isLoading ? "…" : gas.error ? "RPC unreachable" : fmtEth(gas.data)}</span>
          {status === "empty" && <Chip tone="critical">empty</Chip>}
          {status === "low" && <Chip tone="warn">low</Chip>}
        </span>
      </div>
      {(status === "empty" || status === "low") && (
        <div className="rounded-[2px] bg-warn/10 px-2 py-1.5 text-[11.5px]">
          This address needs {devnet ? "devnet" : "testnet"} ETH for gas before it can send transactions.
          {config.faucetUrl ? (
            <>
              {" "}
              <a className="link" href={config.faucetUrl} target="_blank" rel="noreferrer">
                Open the {appChain.name} faucet
              </a>{" "}
              and request coins for <span className="num break-all">{address}</span>.
            </>
          ) : devnet ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button type="button" className="btn h-6 min-h-6 text-[11.5px]" disabled={topUp === "busy"} onClick={() => void anvilTopUp()}>
                {topUp === "busy" ? "Funding…" : "Top up 10 ETH (anvil)"}
              </button>
              {topUp === "failed" && <span className="text-critical-ink">the RPC refused anvil_setBalance</span>}
            </div>
          ) : null}
        </div>
      )}
      {usdcState.data && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-ink-2">{usdcState.data.symbol} balance</span>
          <span className="num">{fmtUsd(rawToDecimal(usdcState.data.balance))}</span>
        </div>
      )}
      {usdcState.data?.mintable && (
        <div>
          <button
            type="button"
            className="btn h-7 min-h-7 w-full text-[12px]"
            disabled={!w.executor || mint?.running || status === "empty"}
            onClick={() => void runMint()}
            title={status === "empty" ? "Needs gas first" : undefined}
          >
            {mint?.running ? (mintItem?.status === "pending" ? "Minting…" : "Awaiting signature…") : `Get 10,000 test ${usdcState.data.symbol}`}
          </button>
          {mintItem?.hash && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-2">
              {mintItem.status === "confirmed" ? "Minted in" : "Sent"} <Hash value={mintItem.hash} kind="tx" />
            </div>
          )}
          {mint?.error && <div className="mt-1 text-[11px] text-critical-ink">{mint.error}</div>}
          <p className="mt-1 text-[10.5px] text-muted">Test networks only: the {devnet ? "devnet" : "testnet"} deployment settles in a mock token with an open mint.</p>
        </div>
      )}
    </div>
  );
}
