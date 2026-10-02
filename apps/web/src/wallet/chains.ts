// The one chain this build targets (shared/chains.ts reads process.env at import, so it is not used
// in the browser). Devnet 31337 by default; Robinhood Chain testnet 46630 with VITE_CHAIN_ID=46630.
import { type Chain, createPublicClient, defineChain, http } from "viem";
import { type CreateConnectorFn, createConfig, injected } from "wagmi";
import { walletConnect } from "./walletConnect";
import { chainLabel } from "../lib/chainConfig";
import { config } from "../lib/config";

const c = config.chain;

export const appChain: Chain = defineChain({
  id: c.id,
  name: c.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [c.rpcUrl] } },
  ...(c.explorerUrl ? { blockExplorers: { default: { name: `${c.name} explorer`, url: c.explorerUrl } } } : {}),
  testnet: c.kind !== "mainnet",
});

/** Read-only client on the app chain (balances, simulations, devnet top-ups). */
export const publicClient = createPublicClient({ chain: appChain, transport: http(c.rpcUrl) });

/** WalletConnect (QR code / mobile wallets) is offered only when a WalletConnect Cloud project id is set. */
export const walletConnectEnabled = config.walletConnectProjectId !== "";

function connectors(): CreateConnectorFn[] {
  // EIP-6963 wallets are discovered by wagmi itself (multiInjectedProviderDiscovery); `injected` is
  // the generic window.ethereum fallback for wallets that do not announce themselves. The WalletConnect
  // provider (and its QR dialog) is imported lazily by the connector on first use.
  const list: CreateConnectorFn[] = [injected({ shimDisconnect: true })];
  if (walletConnectEnabled) {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://bookrunner.invalid";
    list.push(
      walletConnect({
        projectId: config.walletConnectProjectId,
        showQrModal: true,
        metadata: { name: "Bookrunner", description: "The underwriting syndicate for on-chain perp markets.", url: origin, icons: [] },
      }),
    );
  }
  return list;
}

export const wagmiConfig = createConfig({
  chains: [appChain],
  connectors: connectors(),
  multiInjectedProviderDiscovery: true,
  transports: { [appChain.id]: http(c.rpcUrl) },
});

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
