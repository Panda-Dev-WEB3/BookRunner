import { defineChain } from "viem";
import { anvil } from "viem/chains";

/** Robinhood Chain mainnet. VERIFY rpc/explorer URLs and chain id at build time (spec: 4663). */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RHC_RPC_URL ?? "https://rpc.robinhood.chain.invalid"] } }, // VERIFY (Dwellir archive)
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.robinhood.chain.invalid" } }, // VERIFY
});

export const localChain = defineChain({ ...anvil, rpcUrls: { default: { http: ["http://127.0.0.1:8547"] } } });

export function chainFor(chainId: number, rpcUrl?: string) {
  const base = chainId === robinhoodChain.id ? robinhoodChain : chainId === 31337 ? localChain : null;
  if (!base) throw new Error(`unsupported chain ${chainId}`);
  return rpcUrl ? defineChain({ ...base, rpcUrls: { default: { http: [rpcUrl] } } }) : base;
}
