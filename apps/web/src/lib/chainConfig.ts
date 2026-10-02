// Chain presets and the pure resolver behind config.ts (unit-tested without Vite). The app targets
// ONE chain per build: VITE_CHAIN_ID picks it (default devnet 31337); VITE_RPC_URL /
// VITE_EXPLORER_URL / VITE_FAUCET_URL override the preset's endpoints.

export const DEVNET_CHAIN_ID = 31337;
export const RHC_TESTNET_CHAIN_ID = 46630;
export const RHC_MAINNET_CHAIN_ID = 4663;

export interface ChainPreset {
  id: number;
  name: string;
  /** Short label for chips ("Devnet 31337", "RHC testnet"). */
  short: string;
  rpcUrl: string;
  explorerUrl: string;
  /** Where testnet gas comes from (empty: none / not applicable). */
  faucetUrl: string;
  kind: "devnet" | "testnet" | "mainnet" | "custom";
}

export const CHAIN_PRESETS: Record<number, ChainPreset> = {
  [DEVNET_CHAIN_ID]: {
    id: DEVNET_CHAIN_ID,
    name: "Bookrunner devnet",
    short: "Devnet 31337",
    rpcUrl: "http://127.0.0.1:8547",
    explorerUrl: "",
    faucetUrl: "",
    kind: "devnet",
  },
  [RHC_TESTNET_CHAIN_ID]: {
    id: RHC_TESTNET_CHAIN_ID,
    name: "Robinhood Chain Testnet",
    short: "RHC testnet",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    // VERIFY: official faucet per the Robinhood Chain testnet docs at build time.
    faucetUrl: "https://faucet.testnet.chain.robinhood.com",
    kind: "testnet",
  },
  [RHC_MAINNET_CHAIN_ID]: {
    id: RHC_MAINNET_CHAIN_ID,
    name: "Robinhood Chain",
    short: "Robinhood Chain",
    // VERIFY: mainnet RPC / explorer at launch; set VITE_RPC_URL / VITE_EXPLORER_URL.
    rpcUrl: "https://rpc.robinhood.chain.invalid",
    explorerUrl: "",
    faucetUrl: "",
    kind: "mainnet",
  },
};

export interface AppChainConfig extends ChainPreset {
  apiUrl: string;
  /** Optional USDC override; otherwise read from a book's tranche asset(). */
  usdcAddress: string | null;
}

type Env = Record<string, string | boolean | undefined>;

const str = (v: string | boolean | undefined): string => (typeof v === "string" ? v.trim() : "");
const noSlash = (s: string) => s.replace(/\/+$/, "");

/** VITE_* env -> the app's chain + endpoints. Unknown chain ids become a "custom" chain. */
export function resolveChainConfig(env: Env): AppChainConfig {
  const rawId = Number(str(env.VITE_CHAIN_ID) || DEVNET_CHAIN_ID);
  const id = Number.isInteger(rawId) && rawId > 0 ? rawId : DEVNET_CHAIN_ID;
  const preset: ChainPreset = CHAIN_PRESETS[id] ?? {
    id,
    name: str(env.VITE_CHAIN_NAME) || `Chain ${id}`,
    short: `Chain ${id}`,
    rpcUrl: "",
    explorerUrl: "",
    faucetUrl: "",
    kind: "custom",
  };
  const usdc = str(env.VITE_USDC_ADDRESS);
  return {
    ...preset,
    name: str(env.VITE_CHAIN_NAME) || preset.name,
    rpcUrl: str(env.VITE_RPC_URL) || preset.rpcUrl,
    explorerUrl: noSlash(str(env.VITE_EXPLORER_URL) || preset.explorerUrl),
    faucetUrl: noSlash(str(env.VITE_FAUCET_URL) || preset.faucetUrl),
    apiUrl: noSlash(str(env.VITE_API_URL) || "http://127.0.0.1:4400"),
    usdcAddress: /^0x[0-9a-fA-F]{40}$/.test(usdc) ? usdc : null,
  };
}

/** Label for any chain id the app may see (wallet, API, prepared txs). */
export function chainLabel(id: number | null | undefined, app?: Pick<ChainPreset, "id" | "short">): string {
  if (!id) return "No chain";
  if (app && id === app.id) return app.short;
  return CHAIN_PRESETS[id]?.short ?? `Chain ${id}`;
}

/** Block-explorer links (null when the chain has no explorer, e.g. devnet). */
export const explorerTx = (base: string, hash: string | null | undefined): string | null => (hash && base ? `${base}/tx/${hash}` : null);
export const explorerAddress = (base: string, a: string | null | undefined): string | null => (a && base ? `${base}/address/${a}` : null);

/** Native gas balance below which the wallet is flagged as needing testnet coins (0.0005 ETH). */
export const LOW_GAS_WEI = 500_000_000_000_000n;

export function gasStatus(balanceWei: bigint | null | undefined): "unknown" | "empty" | "low" | "ok" {
  if (balanceWei == null) return "unknown";
  if (balanceWei === 0n) return "empty";
  return balanceWei < LOW_GAS_WEI ? "low" : "ok";
}
