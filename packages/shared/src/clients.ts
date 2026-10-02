import { type Account, type Chain, createPublicClient, createWalletClient, http, type PublicClient, type Transport, type WalletClient } from "viem";
import { chainFor } from "./chains";

/**
 * A load-balanced RPC can answer from a node that is a block or two behind the head another node just
 * reported: a read pinned to that head then fails (Robinhood Chain testnet: -32000 "unsupported block
 * number N", which viem surfaces as "Missing or invalid parameters"). Transient — the same request
 * succeeds a moment later.
 */
export function isLaggingNodeError(err: unknown): boolean {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const o = e as { details?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
    for (const v of [o.details, o.message, o.shortMessage]) if (typeof v === "string") parts.push(v);
    e = o.cause;
  }
  return /unsupported block number|header not found|unknown block|block not found/i.test(parts.join(" "));
}

export interface RpcTransportOptions {
  /** Retries of a lagging-node error (default 3). */
  retries?: number;
  /** Base delay between retries, multiplied by the attempt number (default 250 ms). */
  delayMs?: number;
  /** The wrapped transport (default viem http(url)); for tests. */
  base?: Transport;
}

/** viem http transport that retries lagging-node errors (isLaggingNodeError) and nothing else. */
export function rpcTransport(url: string, opts: RpcTransportOptions = {}): Transport {
  const base = opts.base ?? http(url);
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 250;
  return (config) => {
    const t = base(config);
    const request = (async (args: unknown, options?: unknown) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
        } catch (err) {
          if (attempt >= retries || !isLaggingNodeError(err)) throw err;
          await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        }
      }
    }) as typeof t.request;
    return { ...t, request };
  };
}

export function publicClientFor(chainId: number, rpcUrl: string): PublicClient {
  return createPublicClient({ chain: chainFor(chainId, rpcUrl), transport: rpcTransport(rpcUrl), batch: { multicall: true } }) as PublicClient;
}

export function walletClientFor(chainId: number, rpcUrl: string, account: Account): WalletClient<Transport, Chain, Account> {
  return createWalletClient({ chain: chainFor(chainId, rpcUrl), transport: rpcTransport(rpcUrl), account });
}
