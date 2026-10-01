import { type Account, type Chain, createPublicClient, createWalletClient, http, type PublicClient, type Transport, type WalletClient } from "viem";
import { chainFor } from "./chains";

export function publicClientFor(chainId: number, rpcUrl: string): PublicClient {
  return createPublicClient({ chain: chainFor(chainId, rpcUrl), transport: http(rpcUrl), batch: { multicall: true } }) as PublicClient;
}

export function walletClientFor(chainId: number, rpcUrl: string, account: Account): WalletClient<Transport, Chain, Account> {
  return createWalletClient({ chain: chainFor(chainId, rpcUrl), transport: http(rpcUrl), account });
}
