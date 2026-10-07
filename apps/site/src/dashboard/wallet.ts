// Browser wallets over plain EIP-1193: EIP-6963 discovery (window.ethereum as the fallback),
// eth_requestAccounts, chain detection, one-click switch / add of the desk's chain, and the
// accountsChanged / chainChanged events. The chosen wallet is remembered in localStorage.
import { type Address, type Hex, getAddress, isAddress, toHex } from "viem";
import { CHAIN, addChainParams } from "./config";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  /** data: URI (EIP-6963); anything else is ignored when rendering. */
  icon: string;
  rdns: string;
}

export interface DiscoveredWallet {
  info: WalletInfo;
  provider: Eip1193;
}

export interface WalletState {
  wallets: DiscoveredWallet[];
  active: DiscoveredWallet | null;
  address: Address | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
}

const STORAGE_KEY = "bookrunner.site.wallet.v1";
export const INJECTED_RDNS = "injected";

const storage = {
  get(): string | null {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  },
  set(v: string | null): void {
    try {
      if (v === null) globalThis.localStorage?.removeItem(STORAGE_KEY);
      else globalThis.localStorage?.setItem(STORAGE_KEY, v);
    } catch {
      /* blocked storage: the choice is simply not remembered */
    }
  },
};

/** "0xb626" / 46630 / "46630" -> 46630 (null when unparsable). */
export function parseChainId(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const n = v.startsWith("0x") ? Number.parseInt(v, 16) : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** First account of an eth_accounts / eth_requestAccounts answer, checksummed (null when none). */
export function firstAccount(v: unknown): Address | null {
  const a = Array.isArray(v) ? v[0] : null;
  return typeof a === "string" && isAddress(a) ? getAddress(a) : null;
}

/** Only data: image URIs are rendered as wallet icons (an announced icon is untrusted input). */
export const safeIcon = (icon: string): string | null => (/^data:image\/(png|svg\+xml|webp|jpeg|gif);/i.test(icon) ? icon : null);

/** Wallet errors that mean "the chain is unknown to the wallet: add it first". */
export const isUnknownChain = (e: unknown): boolean => {
  const o = (e ?? {}) as { code?: unknown; data?: { originalError?: { code?: unknown } }; message?: unknown };
  return o.code === 4902 || o.data?.originalError?.code === 4902 || (typeof o.message === "string" && /unrecognized chain|unknown chain|not been added/i.test(o.message));
};

type Listener = (s: WalletState) => void;

export class WalletManager {
  private state: WalletState = { wallets: [], active: null, address: null, chainId: null, connecting: false, error: null };
  private listeners = new Set<Listener>();
  private detach: (() => void) | null = null;

  get snapshot(): WalletState {
    return this.state;
  }

  get onRightChain(): boolean {
    return this.state.chainId === CHAIN.id;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<WalletState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Starts EIP-6963 discovery and restores a remembered wallet without prompting. */
  init(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("eip6963:announceProvider", ((e: CustomEvent<DiscoveredWallet>) => {
      const d = e.detail;
      if (!d?.info?.uuid || !d.provider || typeof d.provider.request !== "function") return;
      if (this.state.wallets.some((w) => w.info.uuid === d.info.uuid)) return;
      this.set({ wallets: [...this.state.wallets.filter((w) => w.info.rdns !== INJECTED_RDNS || w.provider !== d.provider), { info: d.info, provider: d.provider }] });
    }) as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // window.ethereum fallback for wallets that do not announce themselves
    setTimeout(() => {
      const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
      if (eth && typeof eth.request === "function" && !this.state.wallets.some((w) => w.provider === eth)) {
        this.set({ wallets: [...this.state.wallets, { info: { uuid: INJECTED_RDNS, name: "Browser wallet", icon: "", rdns: INJECTED_RDNS }, provider: eth }] });
      }
      void this.restore();
    }, 400);
  }

  private async restore(): Promise<void> {
    const rdns = storage.get();
    if (!rdns) return;
    const w = this.state.wallets.find((x) => x.info.rdns === rdns);
    if (!w) return;
    try {
      const account = firstAccount(await w.provider.request({ method: "eth_accounts" }));
      if (!account) return;
      const chainId = parseChainId(await w.provider.request({ method: "eth_chainId" }));
      this.attach(w);
      this.set({ active: w, address: account, chainId, error: null });
    } catch {
      /* stays disconnected */
    }
  }

  async connect(rdns: string): Promise<void> {
    const w = this.state.wallets.find((x) => x.info.rdns === rdns);
    if (!w) throw new Error("That wallet is no longer available. Reload the page and try again.");
    this.set({ connecting: true, error: null });
    try {
      const account = firstAccount(await w.provider.request({ method: "eth_requestAccounts" }));
      if (!account) throw new Error("The wallet returned no account.");
      const chainId = parseChainId(await w.provider.request({ method: "eth_chainId" }));
      this.attach(w);
      storage.set(w.info.rdns);
      this.set({ active: w, address: account, chainId, connecting: false });
    } catch (e) {
      this.set({ connecting: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  disconnect(): void {
    const w = this.state.active;
    this.detach?.();
    this.detach = null;
    storage.set(null);
    this.set({ active: null, address: null, chainId: null, error: null });
    // best effort: wallets that support it forget the site permission too
    void w?.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => undefined);
  }

  /** One click: switch to the desk's chain, adding it to the wallet first when unknown. */
  async switchChain(): Promise<void> {
    const w = this.state.active;
    if (!w) throw new Error("Connect a wallet first.");
    const chainId = toHex(CHAIN.id);
    try {
      await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (e) {
      if (!isUnknownChain(e)) throw e;
      await w.provider.request({ method: "wallet_addEthereumChain", params: [addChainParams()] });
      await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] }).catch(() => undefined);
    }
    const now = parseChainId(await w.provider.request({ method: "eth_chainId" }));
    this.set({ chainId: now });
  }

  /** eth_sendTransaction from the connected account; the wallet estimates gas. */
  async sendTransaction(tx: { to: Address; data: Hex; value: bigint }): Promise<Hex> {
    const w = this.state.active;
    const from = this.state.address;
    if (!w || !from) throw new Error("Connect a wallet first.");
    if (this.state.chainId !== CHAIN.id) throw new Error(`Switch your wallet to ${CHAIN.name} first.`);
    const hash = await w.provider.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data, value: toHex(tx.value) }] });
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("The wallet did not return a transaction hash.");
    return hash as Hex;
  }

  private attach(w: DiscoveredWallet): void {
    this.detach?.();
    const onAccounts = (...args: unknown[]) => {
      const a = firstAccount(args[0]);
      if (!a) {
        this.detach?.();
        this.detach = null;
        storage.set(null);
        this.set({ active: null, address: null, chainId: null });
      } else this.set({ address: a });
    };
    const onChain = (...args: unknown[]) => this.set({ chainId: parseChainId(args[0]) });
    const onDisconnect = () => this.set({ active: null, address: null, chainId: null });
    w.provider.on?.("accountsChanged", onAccounts);
    w.provider.on?.("chainChanged", onChain);
    w.provider.on?.("disconnect", onDisconnect);
    this.detach = () => {
      w.provider.removeListener?.("accountsChanged", onAccounts);
      w.provider.removeListener?.("chainChanged", onChain);
      w.provider.removeListener?.("disconnect", onDisconnect);
    };
  }
}
