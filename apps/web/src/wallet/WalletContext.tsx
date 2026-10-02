// Active signer: the injected browser wallet (wagmi) or, on devnet only, a dev wallet that signs
// with an anvil test account behind a protocol role. Exposes one executor for prepared txs and the
// network helpers (switch / add the app chain) for injected wallets on another chain.
import type { DevRole } from "@bookrunner/shared/devkeys";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type Address, type Hex, createPublicClient, createWalletClient, http } from "viem";
import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { getConnection, sendTransaction, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import { useHealth } from "../api/hooks";
import type { PreparedTx } from "../lib/api-types";
import { config } from "../lib/config";
import { DEVNET_CHAIN_ID, devAccountFor, devAddress, devEntry, isDevRole } from "../lib/devwallet";
import { errText } from "../lib/txflow";
import type { TxExecutor } from "../lib/txflow";
import { addChainParams, appChain, chainName, wagmiConfig } from "./chains";

type Mode = "dev" | "injected" | null;

export interface ActiveWallet {
  kind: "dev" | "injected";
  address: Address;
  label: string;
  devRole: DevRole | null;
  chainId: number | null;
}

interface WalletCtx {
  active: ActiveWallet | null;
  /** Dev wallets are offered only on a devnet build (VITE_CHAIN_ID 31337) whose API is on 31337. */
  devAvailable: boolean;
  devRole: DevRole | null;
  deriving: boolean;
  injectedAvailable: boolean;
  connecting: boolean;
  connectError: string | null;
  /** Chain the API reports (null while unknown). */
  apiChainId: number | null;
  /** Injected wallet connected on a chain other than the app chain. */
  wrongNetwork: boolean;
  switching: boolean;
  networkError: string | null;
  selectDev(role: DevRole): void;
  connectInjected(): Promise<void>;
  disconnect(): void;
  switchToAppChain(): Promise<boolean>;
  addAppChain(): Promise<boolean>;
  executor: TxExecutor<PreparedTx> | null;
}

const Ctx = createContext<WalletCtx | null>(null);
const STORAGE_KEY = "bkrn.wallet";

function readStored(): { mode: Mode; role: DevRole | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const j = raw ? (JSON.parse(raw) as { mode?: unknown; role?: unknown }) : {};
    const mode = j.mode === "dev" || j.mode === "injected" ? j.mode : null;
    return { mode, role: typeof j.role === "string" && isDevRole(j.role) ? j.role : null };
  } catch {
    return { mode: null, role: null };
  }
}

function writeStored(v: { mode: Mode; role: DevRole | null }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    // storage blocked: the choice simply is not remembered
  }
}

function wrongChainError(txChainId: number): Error {
  return new Error(
    `Prepared for ${chainName(txChainId)} but this app is built for ${chainName(appChain.id)} (VITE_CHAIN_ID). Point the app and the API at the same chain.`,
  );
}

function devExecutor(role: DevRole): TxExecutor<PreparedTx> {
  const account = devAccountFor(role);
  const wallet = createWalletClient({ account, chain: appChain, transport: http(config.rpcUrl) });
  const pub = createPublicClient({ chain: appChain, transport: http(config.rpcUrl) });
  return {
    async send(tx) {
      if (tx.chainId !== DEVNET_CHAIN_ID) throw new Error(`Prepared for chain ${tx.chainId}; the dev wallet signs on devnet 31337 only`);
      return wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || "0") });
    },
    async wait(hash: Hex) {
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return { status: r.status, blockNumber: r.blockNumber };
    },
  };
}

const injectedExecutor: TxExecutor<PreparedTx> = {
  async send(tx) {
    if (tx.chainId !== appChain.id) throw wrongChainError(tx.chainId);
    // wagmi's injected connector adds the chain (wallet_addEthereumChain) when the wallet lacks it.
    if (getConnection(wagmiConfig).chainId !== appChain.id) await switchChain(wagmiConfig, { chainId: appChain.id, addEthereumChainParameter: addChainParams() });
    return sendTransaction(wagmiConfig, { to: tx.to, data: tx.data, value: BigInt(tx.value || "0"), chainId: appChain.id });
  },
  async wait(hash) {
    const r = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: appChain.id, timeout: 300_000 });
    return { status: r.status, blockNumber: r.blockNumber };
  },
};

const hasWindowEthereum = (): boolean => typeof window !== "undefined" && !!(window as { ethereum?: unknown }).ethereum;

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const health = useHealth();
  const apiChainId = health.data?.chainId ?? null;
  const devAvailable = config.chainId === DEVNET_CHAIN_ID && (apiChainId === null || apiChainId === DEVNET_CHAIN_ID);
  const conn = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disc = useDisconnect();
  const [{ mode, role }, setSel] = useState(readStored);
  const [devAddr, setDevAddr] = useState<Address | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);

  useEffect(() => writeStored({ mode, role }), [mode, role]);

  useEffect(() => {
    if (mode !== "dev" || !role || !devAvailable) {
      setDevAddr(null);
      return;
    }
    setDeriving(true);
    // seed derivation is synchronous; let the current frame paint first
    const id = setTimeout(() => {
      setDevAddr(devAddress(role));
      setDeriving(false);
    }, 0);
    return () => clearTimeout(id);
  }, [mode, role, devAvailable]);

  const selectDev = useCallback((r: DevRole) => setSel({ mode: "dev", role: r }), []);

  // EIP-6963 discovered wallets first (named connectors), then the generic window.ethereum one.
  const injectedConnector = connectors.find((c) => c.id !== "injected") ?? connectors[0];
  const [windowProvider, setWindowProvider] = useState(hasWindowEthereum);
  useEffect(() => {
    // Some wallets inject after load: MetaMask fires "ethereum#initialized"; re-check once more later.
    const check = () => setWindowProvider(hasWindowEthereum());
    window.addEventListener("ethereum#initialized", check);
    const t = setTimeout(check, 1_500);
    return () => {
      window.removeEventListener("ethereum#initialized", check);
      clearTimeout(t);
    };
  }, []);
  const hasProvider = connectors.some((c) => c.id !== "injected") || windowProvider;

  const connectInjected = useCallback(async () => {
    setConnectError(null);
    const connector = injectedConnector;
    if (!connector || !hasProvider) {
      setConnectError("No browser wallet found. Install one, or use a dev wallet on the local devnet.");
      return;
    }
    try {
      await connect.mutateAsync({ connector, chainId: appChain.id });
      setSel((s) => ({ mode: "injected", role: s.role }));
    } catch (e) {
      // Connected but the wallet refused to switch: keep the connection, the network helper offers the switch.
      if (getConnection(wagmiConfig).isConnected) setSel((s) => ({ mode: "injected", role: s.role }));
      setConnectError(errText(e));
    }
  }, [connect, injectedConnector, hasProvider]);

  const disconnect = useCallback(() => {
    if (conn.isConnected) disc.mutate();
    setSel((s) => ({ mode: null, role: s.role }));
  }, [conn.isConnected, disc]);

  const switchToAppChain = useCallback(async () => {
    setNetworkError(null);
    setSwitching(true);
    try {
      await switchChain(wagmiConfig, { chainId: appChain.id, addEthereumChainParameter: addChainParams() });
      return true;
    } catch (e) {
      setNetworkError(errText(e));
      return false;
    } finally {
      setSwitching(false);
    }
  }, []);

  const addAppChain = useCallback(async () => {
    setNetworkError(null);
    setSwitching(true);
    try {
      const connector = conn.connector ?? injectedConnector;
      const provider = (await connector?.getProvider()) as Eip1193 | undefined;
      if (!provider) throw new Error("No browser wallet found");
      await provider.request({ method: "wallet_addEthereumChain", params: [addChainParams()] });
      return true;
    } catch (e) {
      setNetworkError(errText(e));
      return false;
    } finally {
      setSwitching(false);
    }
  }, [conn.connector, injectedConnector]);

  const active = useMemo<ActiveWallet | null>(() => {
    if (mode === "dev" && devAvailable && role && devAddr) {
      return { kind: "dev", address: devAddr, label: devEntry(role)?.label ?? role, devRole: role, chainId: DEVNET_CHAIN_ID };
    }
    if (mode !== "dev" && conn.isConnected && conn.address) {
      return { kind: "injected", address: conn.address, label: conn.connector?.name ?? "Browser wallet", devRole: null, chainId: conn.chainId ?? null };
    }
    return null;
  }, [mode, devAvailable, role, devAddr, conn.isConnected, conn.address, conn.connector, conn.chainId]);

  const executor = useMemo(() => {
    if (!active) return null;
    return active.kind === "dev" && active.devRole ? devExecutor(active.devRole) : injectedExecutor;
  }, [active]);

  const value: WalletCtx = {
    active,
    devAvailable,
    devRole: role,
    deriving,
    injectedAvailable: hasProvider,
    connecting: connect.isPending,
    connectError,
    apiChainId,
    wrongNetwork: active?.kind === "injected" && active.chainId !== null && active.chainId !== appChain.id,
    switching,
    networkError,
    selectDev,
    connectInjected,
    disconnect,
    switchToAppChain,
    addAppChain,
    executor,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}

export const sameAddress = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
