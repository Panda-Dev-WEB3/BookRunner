// Runtime configuration from Vite env (VITE_*). Defaults target the local devnet (31337); build with
// `--mode testnet` (apps/web/.env.testnet) for Robinhood Chain testnet (46630).
import { type AppChainConfig, explorerAddress, explorerTx, resolveChainConfig } from "./chainConfig";

const resolved: AppChainConfig = resolveChainConfig(import.meta.env as Record<string, string | boolean | undefined>);

export const config = {
  apiUrl: resolved.apiUrl,
  /** The single chain this build targets (wallet transport, explorer, dev-wallet gate). */
  chain: resolved,
  chainId: resolved.id,
  rpcUrl: resolved.rpcUrl,
  /** Block explorer base URL (tx / address links). Empty on devnet: hashes are shown with copy only. */
  explorerUrl: resolved.explorerUrl,
  faucetUrl: resolved.faucetUrl,
  usdcAddress: resolved.usdcAddress,
} as const;

export const trpcUrl = `${config.apiUrl}/trpc`;

export const txUrl = (hash: string | null | undefined): string | null => explorerTx(config.explorerUrl, hash);
export const addressUrl = (a: string | null | undefined): string | null => explorerAddress(config.explorerUrl, a);
