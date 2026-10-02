import { defineChain } from "viem";
import { anvil } from "viem/chains";

/** Robinhood Chain mainnet. VERIFY rpc/explorer URLs at build time (spec: 4663; Dwellir archive RPC). */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RHC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"] } }, // VERIFY
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.chain.robinhood.com" } }, // VERIFY
});

/** Robinhood Chain testnet (Arbitrum Orbit, chain id 46630 — verified via eth_chainId 2026-10-02). */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RHC_TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const localChain = defineChain({ ...anvil, rpcUrls: { default: { http: ["http://127.0.0.1:8547"] } } });

export function chainFor(chainId: number, rpcUrl?: string) {
  const base =
    chainId === robinhoodChain.id ? robinhoodChain : chainId === robinhoodTestnet.id ? robinhoodTestnet : chainId === 31337 ? localChain : null;
  if (!base) throw new Error(`unsupported chain ${chainId}`);
  return rpcUrl ? defineChain({ ...base, rpcUrls: { default: { http: [rpcUrl] } } }) : base;
}

export function explorerTxUrl(chainId: number, tx: string): string | null {
  if (chainId === robinhoodTestnet.id) return `https://explorer.testnet.chain.robinhood.com/tx/${tx}`;
  if (chainId === robinhoodChain.id) return `https://explorer.chain.robinhood.com/tx/${tx}`;
  return null;
}
