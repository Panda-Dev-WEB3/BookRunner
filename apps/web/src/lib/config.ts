// Runtime configuration from Vite env (VITE_*). Defaults target the local devnet (31337); build with
// `--mode testnet` (apps/web/.env.testnet) for Robinhood Chain testnet (46630).
import { routerBasename } from "./basePath";
import { type AppChainConfig, explorerAddress, explorerTx, resolveChainConfig } from "./chainConfig";

const env = import.meta.env as Record<string, string | boolean | undefined>;
const resolved: AppChainConfig = resolveChainConfig(env);
const wcProjectId = typeof env.VITE_WALLETCONNECT_PROJECT_ID === "string" ? env.VITE_WALLETCONNECT_PROJECT_ID.trim() : "";

export const config = {
  /** Same-origin builds call {origin}/trpc and {origin}/health at the host root, never under the app mount. */
  apiUrl: resolved.apiUrl,
  /** react-router basename: "/app" in a deployed build (vite base "/app/"), undefined on the dev server. */
  basename: routerBasename(import.meta.env.BASE_URL),
  /** The single chain this build targets (wallet transport, explorer, dev-wallet gate). */
  chain: resolved,
  chainId: resolved.id,
  rpcUrl: resolved.rpcUrl,
  /** Block explorer base URL (tx / address links). Empty on devnet: hashes are shown with copy only. */
  explorerUrl: resolved.explorerUrl,
  faucetUrl: resolved.faucetUrl,
  usdcAddress: resolved.usdcAddress,
  /** WalletConnect Cloud project id (VITE_WALLETCONNECT_PROJECT_ID). Empty: the WalletConnect option is hidden. */
  walletConnectProjectId: wcProjectId,
  /** Public source repository and docs (footer, Learn page). */
  repoUrl: "https://github.com/Panda-Dev-WEB3/BookRunner",
  docsUrl: "https://github.com/Panda-Dev-WEB3/BookRunner/tree/main/docs",
} as const;

export const trpcUrl = `${config.apiUrl}/trpc`;

export const txUrl = (hash: string | null | undefined): string | null => explorerTx(config.explorerUrl, hash);
export const addressUrl = (a: string | null | undefined): string | null => explorerAddress(config.explorerUrl, a);
