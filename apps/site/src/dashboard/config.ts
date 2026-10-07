// The one network this desk targets and where the API lives. Contract addresses are never listed
// here: they come from the API (book.list components) and the BookrunnerConfig a book points at.

export const CHAIN = {
  id: 46630,
  name: "Robinhood Chain Testnet",
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  nativeSymbol: "ETH",
  testnet: true,
} as const;

/** Same-origin API: nginx (and the dev / preview servers) proxy /trpc and /health to it. */
export const API_BASE = "";

/** The full operator app (React) served next to this site. */
export const OPERATOR_APP_URL = "/app/";

export const txUrl = (hash: string | null | undefined): string | null => (hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${CHAIN.explorerUrl}/tx/${hash}` : null);
export const addressUrl = (a: string | null | undefined): string | null => (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? `${CHAIN.explorerUrl}/address/${a}` : null);

/** EIP-3085 parameters for wallet_addEthereumChain. */
export function addChainParams() {
  return {
    chainId: `0x${CHAIN.id.toString(16)}`,
    chainName: CHAIN.name,
    nativeCurrency: { name: "Ether", symbol: CHAIN.nativeSymbol, decimals: 18 },
    rpcUrls: [CHAIN.rpcUrl],
    blockExplorerUrls: [CHAIN.explorerUrl],
  };
}
