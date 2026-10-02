// The one chain this build targets (shared/chains.ts reads process.env at import, so it is not used
// in the browser). Devnet 31337 by default; Robinhood Chain testnet 46630 with VITE_CHAIN_ID=46630.
import { type Chain, createPublicClient, defineChain, http } from "viem";
import { type Connector, type CreateConnectorFn, createConfig, createStorage, injected } from "wagmi";
import { walletConnect } from "./walletConnect";
import { chainLabel, isTestKind } from "../lib/chainConfig";
import { config } from "../lib/config";
import { safeLocalStorage } from "../lib/safeStorage";

const c = config.chain;

export const appChain: Chain = defineChain({
  id: c.id,
  name: c.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [c.rpcUrl] } },
  ...(c.explorerUrl ? { blockExplorers: { default: { name: `${c.name} explorer`, url: c.explorerUrl } } } : {}),
  testnet: isTestKind(c.kind),
});

/** Read-only client on the app chain (balances, simulations, devnet top-ups). */
export const publicClient = createPublicClient({ chain: appChain, transport: http(c.rpcUrl) });

/** WalletConnect (QR code / mobile wallets) is offered only when a WalletConnect Cloud project id is set. */
export const walletConnectEnabled = config.walletConnectProjectId !== "";

function walletConnectFn(): CreateConnectorFn {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://bookrunner.invalid";
  return walletConnect({
    projectId: config.walletConnectProjectId,
    showQrModal: true,
    metadata: { name: "Bookrunner", description: "The underwriting syndicate for on-chain perp markets.", url: origin, icons: [] },
  });
}

/** The last session connected through WalletConnect (wagmi's recentConnectorId, JSON-encoded). */
function lastUsedWalletConnect(): boolean {
  return walletConnectEnabled && (safeLocalStorage().getItem("wagmi.recentConnectorId") ?? "").includes("walletConnect");
}

function connectors(): CreateConnectorFn[] {
  // EIP-6963 wallets are discovered by wagmi itself (multiInjectedProviderDiscovery); `injected` is
  // the generic window.ethereum fallback for wallets that do not announce themselves.
  // WalletConnect is NOT registered here by default: wagmi runs every connector's setup() at
  // createConfig and getProvider() at reconnect, and WalletConnect's import and initialise its SDK
  // there (large chunks, calls to walletconnect.org / reown.com) for every visitor. It is
  // registered at load only to restore a session that used it; otherwise walletConnectConnector()
  // creates it when the person picks it.
  const list: CreateConnectorFn[] = [injected({ shimDisconnect: true })];
  if (lastUsedWalletConnect()) list.push(walletConnectFn());
  return list;
}

export const wagmiConfig = createConfig({
  chains: [appChain],
  // wagmi's default storage reads window.localStorage unguarded; blocked site data would throw here,
  // at module load, before React mounts.
  storage: createStorage({ storage: safeLocalStorage() }),
  connectors: connectors(),
  multiInjectedProviderDiscovery: true,
  transports: { [appChain.id]: http(c.rpcUrl) },
});

/**
 * The WalletConnect connector, created on first use (null when VITE_WALLETCONNECT_PROJECT_ID is
 * unset). Registered with the config the way wagmi's connect() registers a connector function, and
 * kept, so its SDK starts once.
 */
export function walletConnectConnector(): Connector | null {
  if (!walletConnectEnabled) return null;
  const existing = wagmiConfig.connectors.find((x) => x.type === "walletConnect");
  if (existing) return existing;
  const created = wagmiConfig._internal.connectors.setup(walletConnectFn());
  wagmiConfig._internal.connectors.setState((list) => [...list, created]);
  return created;
}

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export const chainName = (id: number | null | undefined): string => chainLabel(id, c);

/** EIP-3085 parameters for wallet_addEthereumChain (the "add network" helper). */
export function addChainParams() {
  return {
    chainId: `0x${c.id.toString(16)}`,
    chainName: c.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [c.rpcUrl],
    ...(c.explorerUrl ? { blockExplorerUrls: [c.explorerUrl] } : {}),
  };
}
