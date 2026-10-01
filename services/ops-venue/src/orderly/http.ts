// Signed Orderly REST transport: ed25519 auth headers, method-specific content types, Orderly
// envelope parsing ({success, data, code, message}), retry with backoff on network errors / 429 / 5xx,
// and client-side spacing for the documented per-endpoint rate limits.
import { type Ed25519Key, signRequest } from "./auth";
import { RATE_SPACING_MS } from "./paths";

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export class OrderlyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
  get unauthorized() {
    return this.status === 401 || this.code === -1002 || this.code === -1001;
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Account id header; defaults to the transport's account. */
  accountId?: string;
  /** Signing key; `null` = send unsigned (permissive mock / public endpoints). Defaults to the transport key. */
  key?: Ed25519Key | null;
  /** Retries on transient failures (default 3). Use 0 for non-idempotent calls. */
  retries?: number;
}

export interface OrderlyHttpOptions {
  baseUrl: string;
  accountId?: string;
  key?: Ed25519Key | null;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { path: string; attempt: number; reason: string }) => void;
}

interface Envelope {
  success?: boolean;
  data?: unknown;
  code?: number;
  message?: string;
}

export function buildPath(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.append(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export class OrderlyHttp {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastCall = new Map<string, number>();

  constructor(readonly o: OrderlyHttpOptions) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async space(path: string) {
    const gap = RATE_SPACING_MS[path];
    if (!gap) return;
    const last = this.lastCall.get(path) ?? 0;
    const wait = last + gap - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastCall.set(path, this.now());
  }

  async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: RequestOptions = {}): Promise<T> {
    const pathWithQuery = buildPath(path, opts.query);
    const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
    const key = opts.key === undefined ? (this.o.key ?? null) : opts.key;
    const accountId = opts.accountId ?? this.o.accountId;
    const retries = opts.retries ?? 3;
    let attempt = 0;
    for (;;) {
      await this.space(path);
      const headers: Record<string, string> = {
        "content-type": method === "GET" || method === "DELETE" ? "application/x-www-form-urlencoded" : "application/json",
      };
      if (accountId) headers["orderly-account-id"] = accountId;
      if (key && accountId) Object.assign(headers, await signRequest(key, accountId, { method, pathWithQuery, body, timestamp: this.now() }));
      else headers["orderly-timestamp"] = String(this.now());
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.o.baseUrl.replace(/\/+$/, "")}${pathWithQuery}`, { method, headers, ...(body ? { body } : {}) });
      } catch (err) {
        if (attempt >= retries) throw new OrderlyHttpError(0, null, `network error: ${String((err as Error).message ?? err)}`, path);
        await this.backoff(path, ++attempt, String(err));
        continue;
      }
      const text = await res.text();
      let env: Envelope = {};
      try {
        env = text ? (JSON.parse(text) as Envelope) : {};
      } catch {
        env = { message: text.slice(0, 300) };
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        await this.backoff(path, ++attempt, `HTTP ${res.status}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
        continue;
      }
      if (!res.ok || env.success === false) {
        throw new OrderlyHttpError(res.status, typeof env.code === "number" ? env.code : null, `${method} ${path}: ${env.message ?? `HTTP ${res.status}`}`, path);
      }
      return (env.data ?? env) as T;
    }
  }

  private async backoff(path: string, attempt: number, reason: string, ms?: number) {
    this.o.onRetry?.({ path, attempt, reason });
    await this.sleep(ms ?? Math.min(250 * 2 ** (attempt - 1), 4000));
  }
}
