import { type Account, type Chain, createPublicClient, createWalletClient, http, type HttpTransportConfig, type PublicClient, type Transport, type WalletClient } from "viem";
import { chainFor } from "./chains";
import { type RpcMeter, rpcMeter } from "./rpcMeter";
import { type RpcRoutes, classifyRpcFailure, failureMessage, providerLabel, rpcRoutes } from "./rpcRoute";

/** What a service's /health serves under `rpc`: the failing primary (null = healthy) and the usage meter. Never a URL. */
export function rpcHealth(): { fallback: ReturnType<RpcRoutes["primaryStatus"]>; usage: ReturnType<RpcMeter["snapshot"]> } {
  return { fallback: rpcRoutes.primaryStatus(), usage: rpcMeter.snapshot() };
}

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
  /** The wrapped primary transport (default viem http(url)); for tests. */
  base?: Transport;
  /**
   * The secondary endpoint, used only while the primary fails (HTTP 429, 5xx, timeouts, no connection: rpcRoute.ts).
   * Default: RPC_FALLBACK_URL from the environment (set by the mainnet profile; unset on devnet / testnet); null = none.
   * Never the primary's own URL.
   */
  fallbackUrl?: string | null;
  /** The wrapped fallback transport (default viem http(fallbackUrl)); for tests. */
  fallbackBase?: Transport;
  /** Options of the default viem http transports (batching, timeout); retryCount is 0 on the primary when a fallback exists. */
  http?: HttpTransportConfig;
  /** Routing state and meter (default: the process's); for tests. */
  routes?: RpcRoutes;
  meter?: RpcMeter;
  now?: () => number;
}

const SEND_METHODS = new Set(["eth_sendRawTransaction", "eth_sendTransaction"]);

/**
 * viem http transport that (1) retries lagging-node errors (isLaggingNodeError), (2) counts every request per method
 * (rpcMeter: the usage meter), and (3) answers from the fallback endpoint while the primary fails because of the
 * provider (rpcRoute.ts). A transaction broadcast fails over only when the primary refused it outright (429 / capacity
 * cap): after a timeout or a 5xx the transaction may already be in the primary's mempool.
 */
export function rpcTransport(url: string, opts: RpcTransportOptions = {}): Transport {
  const fbUrl = opts.fallbackUrl === undefined ? (process.env.RPC_FALLBACK_URL?.trim() || null) : opts.fallbackUrl;
  const hasFallback = !!opts.fallbackBase || (!!fbUrl && fbUrl !== url);
  const base = opts.base ?? http(url, { ...opts.http, ...(hasFallback ? { retryCount: 0 } : {}) });
  const fbBase = opts.fallbackBase ?? (hasFallback && fbUrl ? http(fbUrl, opts.http) : null);
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 250;
  const routes = opts.routes ?? rpcRoutes;
  const meter = opts.meter ?? rpcMeter;
  const now = opts.now ?? Date.now;
  const provider = providerLabel(url);
  return (config) => {
    const t = base(config);
    const tf = hasFallback && fbBase ? fbBase(config) : null;
    const withRetry = (tr: typeof t) => async (args: unknown, options?: unknown) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await (tr.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
        } catch (err) {
          if (attempt >= retries || !isLaggingNodeError(err)) throw err;
          await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        }
      }
    };
    const primary = withRetry(t);
    const secondary = tf ? withRetry(tf) : null;
    const request = (async (args: unknown, options?: unknown) => {
      const method = String((args as { method?: unknown } | null)?.method ?? "unknown");
      if (!secondary) {
        meter.count(method);
        return await primary(args, options);
      }
      if (routes.usePrimary(url, now())) {
        meter.count(method);
        try {
          const res = await primary(args, options);
          if (routes.ok(url)) meter.event("info", { provider }, `${provider} answers again: back on the primary RPC (log subscriptions resume)`);
          return res;
        } catch (err) {
          const failure = classifyRpcFailure(err);
          if (!failure) throw err;
          if (routes.fail(url, provider, failure, now())) {
            meter.event("warn", { provider, reason: failure.reason, status: failure.status }, failureMessage(provider, failure.reason, failure.status) + ": serving from the fallback RPC");
          }
          if (SEND_METHODS.has(method) && failure.reason !== "capacity" && failure.reason !== "rate_limited") throw err;
        }
      }
      meter.count(method, "fallback");
      return await secondary(args, options);
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
