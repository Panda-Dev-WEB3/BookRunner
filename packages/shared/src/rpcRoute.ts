// Primary / fallback RPC routing state (clients.ts rpcTransport). One entry per primary URL in this process; a
// request that fails on the primary because of the PROVIDER (HTTP 429, 5xx, timeout, no connection) is answered by the
// fallback instead, and the primary is tried again only after a cool-off: 15 s doubling to 5 min for an ordinary
// failure, 30 min after a 429 "Monthly capacity ..." (a plan cap does not clear by itself within the hour). The log
// subscriptions follow the primary: while any route is on its fallback they stay down and the services poll, exactly
// as without a WebSocket URL (logSubscription.ts). Nothing here ever holds, logs or exposes a URL: only the provider's
// name (providerLabel) and a classified reason.

export type RpcFailureReason = "capacity" | "rate_limited" | "server_error" | "timeout" | "network";

export interface RpcFallbackStatus {
  /** the provider that is failing, by name (never a URL) */
  provider: string;
  reason: RpcFailureReason;
  /** HTTP status of the failure when there was one */
  status: number | null;
  /** unix ms the primary first failed (this stretch) */
  since: number;
  /** unix ms the primary is tried again */
  retryAt: number;
  /** operator-facing sentence, no URL */
  message: string;
}

/** "Alchemy" / "Dwellir" / "Robinhood public RPC" / "primary RPC" from a URL's host (never its path or key). */
export function providerLabel(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/(^|\.)alchemy(api)?\.(com|io)$/.test(host)) return "Alchemy";
    if (/(^|\.)dwellir\.com$/.test(host)) return "Dwellir";
    if (/(^|\.)chain\.robinhood\.com$/.test(host)) return "Robinhood public RPC";
  } catch {
    // fall through
  }
  return "primary RPC";
}

export function failureMessage(provider: string, reason: RpcFailureReason, status: number | null): string {
  switch (reason) {
    case "capacity":
      return `${provider} monthly capacity limit reached: switch plan or key`;
    case "rate_limited":
      return `${provider} is rate limiting (HTTP 429): reduce the request rate or raise the plan`;
    case "server_error":
      return `${provider} is answering with server errors${status ? ` (HTTP ${status})` : ""}`;
    case "timeout":
      return `${provider} is timing out`;
    default:
      return `${provider} is unreachable`;
  }
}

/** The provider-side failure behind `err` (viem wraps it several causes deep), or null when it is not one (a revert, a bad request). */
export function classifyRpcFailure(err: unknown): { reason: RpcFailureReason; status: number | null } | null {
  let status: number | null = null;
  let code: number | null = null;
  let isHttp = false;
  let isTimeout = false;
  const text: string[] = [];
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    const o = e as { name?: unknown; status?: unknown; code?: unknown; details?: unknown; message?: unknown; shortMessage?: unknown; body?: unknown; cause?: unknown };
    if (o.name === "HttpRequestError") isHttp = true;
    if (o.name === "TimeoutError") isTimeout = true;
    if (typeof o.status === "number" && status === null) status = o.status;
    if (typeof o.code === "number" && code === null) code = o.code;
    for (const v of [o.details, o.message, o.shortMessage]) if (typeof v === "string") text.push(v);
    if (typeof o.body === "string") text.push(o.body);
    else if (o.body && typeof o.body === "object") {
      try {
        text.push(JSON.stringify(o.body));
      } catch {
        // unprintable body
      }
    }
    e = o.cause;
  }
  const all = text.join(" ");
  if (/monthly capacity/i.test(all)) return { reason: "capacity", status: status ?? 429 };
  if (status === 429 || code === 429) return { reason: "rate_limited", status: status ?? 429 };
  if (status !== null && status >= 500 && status <= 599) return { reason: "server_error", status };
  if (isTimeout || /timed out|timeout/i.test(all)) return { reason: "timeout", status };
  if (isHttp && status === null) return { reason: "network", status: null };
  return null;
}

interface Route {
  provider: string;
  failures: number;
  since: number | null;
  retryAt: number;
  reason: RpcFailureReason;
  status: number | null;
}

export const RPC_CAPACITY_COOLOFF_MS = 30 * 60_000;
export const RPC_PROBE_MIN_MS = 15_000;
export const RPC_PROBE_MAX_MS = 5 * 60_000;

type Listener = (onFallback: boolean) => void;

/** The process's routes, keyed by an opaque id (the transport passes its primary URL; it is never read back out). */
export class RpcRoutes {
  private routes = new Map<string, Route>();
  private listeners = new Set<Listener>();

  /** Is this primary to be tried now (healthy, or its cool-off is over)? */
  usePrimary(key: string, now = Date.now()): boolean {
    const r = this.routes.get(key);
    return !r || r.since === null || now >= r.retryAt;
  }

  onFallback(key?: string): boolean {
    for (const [k, r] of this.routes) if ((key === undefined || k === key) && r.since !== null) return true;
    return false;
  }

  /** The primary failed with `failure`: the fallback serves until the cool-off is over. Returns true on the first failure of a stretch. */
  fail(key: string, provider: string, failure: { reason: RpcFailureReason; status: number | null }, now = Date.now()): boolean {
    const was = this.onFallback();
    const cur = this.routes.get(key);
    if (cur && cur.since !== null && now < cur.retryAt) {
      // another request that was in flight when the primary failed: the same stretch, no longer cool-off
      if (failure.reason === "capacity" && cur.reason !== "capacity") {
        cur.reason = "capacity";
        cur.status = failure.status;
        cur.retryAt = now + RPC_CAPACITY_COOLOFF_MS;
      }
      return false;
    }
    const r = cur ?? { provider, failures: 0, since: null, retryAt: 0, reason: failure.reason, status: failure.status };
    r.failures++;
    r.since ??= now;
    r.reason = failure.reason;
    r.status = failure.status;
    r.retryAt = now + (failure.reason === "capacity" ? RPC_CAPACITY_COOLOFF_MS : Math.min(RPC_PROBE_MIN_MS * 2 ** Math.min(r.failures - 1, 5), RPC_PROBE_MAX_MS));
    this.routes.set(key, r);
    if (!was) this.emit(true);
    return r.failures === 1;
  }

  /** The primary answered: back to it. Returns true when it had been failing. */
  ok(key: string): boolean {
    const r = this.routes.get(key);
    if (!r || r.since === null) return false;
    this.routes.delete(key);
    if (!this.onFallback()) this.emit(false);
    return true;
  }

  /** Every route on its fallback, as operator sentences (no URL). */
  status(): RpcFallbackStatus[] {
    return [...this.routes.values()]
      .filter((r): r is Route & { since: number } => r.since !== null)
      .map((r) => ({ provider: r.provider, reason: r.reason, status: r.status, since: r.since, retryAt: r.retryAt, message: failureMessage(r.provider, r.reason, r.status) }));
  }

  /** The oldest failing route (what /health and the alert report), or null. */
  primaryStatus(): RpcFallbackStatus | null {
    const all = this.status();
    return all.length === 0 ? null : all.reduce((a, b) => (a.since <= b.since ? a : b));
  }

  /** Called with true when the first route goes to its fallback, false when the last one is back on its primary. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  reset(): void {
    const was = this.onFallback();
    this.routes.clear();
    if (was) this.emit(false);
  }

  private emit(on: boolean): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(on);
      } catch {
        // a listener never breaks routing
      }
    }
  }
}

export const rpcRoutes = new RpcRoutes();
