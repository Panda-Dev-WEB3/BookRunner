// Orderly Builder Oracle WebSocket client (docs: https://orderly.network/docs/build-on-omnichain/user-flows/builder-oracle,
// docs/VERIFY.md O18). As documented:
//   URL      <domain>/v1/ws/oracle/push/<account_id>?orderly_key=<key>&timestamp=<unix ms>&sign=<sig>
//            sig = Ed25519(utf8(timestamp)) with the account's Orderly secret, unpadded base64url
//   auth     the first server message answers the connection: {success: true} or {success: false, errorMsg}
//   publish  {id, event: "publish", topic: "indexpricefeed", ts: <unix ms>, data: {base_ccy, price}}; no ack is
//            documented, a rejection comes back as {event: "publish", success: false, ...}
//   ping     server {event: "ping"} -> client {event: "pong"}
//   cadence  at least one publish per second per feed while the market session is open (BuilderPriceFeed)
// VERIFY: testnet domain (undocumented; DNS has testnet-ws-oracle.orderly.org), the exact auth / reject message shapes
// (does a reject echo id / base_ccy?), the server ping interval (idle timeout below), price precision limits.
import type { Logger } from "@bookrunner/shared";
import { type Ed25519Key, signMessage } from "../orderly/auth";

export const ORACLE_WS_PATH = "/v1/ws/oracle/push";
export const ORACLE_WS_TOPIC = "indexpricefeed";
/** Builder Oracle WebSocket domains. mainnet: documented default; testnet: VERIFY (not documented, resolves in DNS). */
export const ORACLE_WS_DOMAINS = {
  mainnet: "wss://ws-oracle.orderly.org",
  testnet: "wss://testnet-ws-oracle.orderly.org",
} as const;

/** Authenticated connection URL. Signs the timestamp string (docs sample: `private_key.sign(timestamp.encode())`). */
export async function oracleWsUrl(domain: string, accountId: string, key: Ed25519Key, timestampMs: number): Promise<string> {
  const ts = String(Math.floor(timestampMs));
  const sign = (await signMessage(key, ts)).replace(/=+$/, ""); // base64url, unpadded
  const q = new URLSearchParams({ orderly_key: key.orderlyKey, timestamp: ts, sign });
  return `${domain.replace(/\/+$/, "")}${ORACLE_WS_PATH}/${accountId}?${q.toString()}`;
}

/**
 * The domain for this Orderly REST base URL: ORDERLY_ORACLE_WS_URL when set, else mainnet / testnet by the API host,
 * else null (the push is then not configured: every target reports not-configured and alerts).
 */
export function resolveOracleWsDomain(baseUrl: string, explicit?: string | null): string | null {
  if (explicit) return explicit.replace(/\/+$/, "");
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return null;
  }
  if (host === "api.orderly.org") return ORACLE_WS_DOMAINS.mainnet;
  if (host === "testnet-api.orderly.org") return ORACLE_WS_DOMAINS.testnet;
  return null;
}

/** Reconnect delay after `failures` consecutive failed connections (1 = first): base, doubling, capped. */
export function backoffMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, failures - 1), maxMs);
}

export interface PublishReject {
  id: string | null;
  base: string | null;
  error: string;
  at: number;
}

export type OracleSocketState = "idle" | "connecting" | "authenticating" | "ready" | "backoff" | "stopped";

type WsLike = Pick<WebSocket, "readyState" | "send" | "close" | "addEventListener">;
export type WebSocketFactory = (url: string) => WsLike;

export interface BuilderOracleSocketOptions {
  /** wss domain, e.g. wss://ws-oracle.orderly.org */
  domain: string;
  /** Orderly account id of the builder (path segment) and its Orderly key (Ed25519) */
  accountId: string;
  key: Ed25519Key;
  log: Logger;
  now?: () => number;
  /** first reconnect delay (docs sample: 5 s), doubling per consecutive failure up to maxReconnectMs */
  reconnectMs?: number;
  maxReconnectMs?: number;
  /** no auth answer this long after open: reconnect */
  authTimeoutMs?: number;
  /** no server message (ping) this long: assume a dead connection and reconnect; 0 = off */
  idleTimeoutMs?: number;
  onReject?: (r: PublishReject) => void;
  /** tests: the WebSocket constructor */
  webSocket?: WebSocketFactory;
}

const OPEN = 1;
const PENDING_IDS_MAX = 2_000;

export class BuilderOracleSocket {
  private ws: WsLike | null = null;
  private st: OracleSocketState = "idle";
  private failures = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** recent publish ids -> base_ccy (to attribute a reject that echoes the id) */
  private readonly pending = new Map<string, string>();
  private seq = 0;
  lastError: string | null = null;
  readySince: number | null = null;
  readonly host: string | null;
  private readonly now: () => number;

  constructor(private readonly o: BuilderOracleSocketOptions) {
    this.now = o.now ?? Date.now;
    let host: string | null = null;
    try {
      host = new URL(o.domain).host;
    } catch {
      host = null;
    }
    this.host = host;
  }

  get state(): OracleSocketState {
    return this.st;
  }

  get ready(): boolean {
    return this.st === "ready" && this.ws?.readyState === OPEN;
  }

  start(): void {
    if (this.st !== "idle" && this.st !== "stopped") return;
    this.st = "idle";
    void this.connect();
  }

  stop(): void {
    this.st = "stopped";
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.clearConnTimers();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already closed
    }
  }

  /** Sends one price; null when not authenticated (nothing sent). Returns the message id. */
  publish(base: string, price: number): string | null {
    if (!this.ready || !this.ws) return null;
    const id = `${(this.seq++ & 0xffff).toString(16).padStart(4, "0")}${Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0")}`;
    const msg = { id, event: "publish", topic: ORACLE_WS_TOPIC, ts: this.now(), data: { base_ccy: base, price } };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.lastError = `send failed: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
    this.pending.set(id, base);
    if (this.pending.size > PENDING_IDS_MAX) this.pending.delete(this.pending.keys().next().value as string);
    return id;
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private clearConnTimers(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.authTimer = null;
    this.idleTimer = null;
  }

  private armIdle(ws: WsLike): void {
    const ms = this.o.idleTimeoutMs ?? 60_000;
    if (ms <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fail(ws, `no message from the server for ${ms} ms`), ms);
  }

  private async connect(): Promise<void> {
    if (this.st === "stopped") return;
    this.st = "connecting";
    let ws: WsLike;
    try {
      const url = await oracleWsUrl(this.o.domain, this.o.accountId, this.o.key, this.now());
      if (this.isStopped()) return;
      ws = (this.o.webSocket ?? ((u: string) => new WebSocket(u)))(url);
    } catch (err) {
      this.scheduleReconnect(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.st = "authenticating";
      this.authTimer = setTimeout(() => this.fail(ws, "no auth response"), this.o.authTimeoutMs ?? 10_000);
      this.armIdle(ws);
    });
    ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ws, ev.data));
    ws.addEventListener("error", () => {
      if (this.ws === ws) this.lastError = "websocket error";
    });
    ws.addEventListener("close", (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearConnTimers();
      const wasReady = this.st === "ready";
      this.readySince = null;
      if (this.isStopped()) return;
      const why = this.st === "backoff" ? (this.lastError ?? "closed") : `closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`;
      if (wasReady) this.o.log.warn({ host: this.host, err: why }, "builder oracle websocket closed; reconnecting");
      this.scheduleReconnect(why);
    });
  }

  private isStopped(): boolean {
    return this.st === "stopped";
  }

  private onMessage(ws: WsLike, data: unknown): void {
    if (this.ws !== ws) return;
    this.armIdle(ws);
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8")) as Record<string, unknown>;
    } catch {
      this.o.log.debug({ host: this.host }, "builder oracle: non-JSON message ignored");
      return;
    }
    if (m.event === "ping") {
      try {
        ws.send(JSON.stringify({ event: "pong" }));
      } catch {
        // the close handler reconnects
      }
      return;
    }
    if (this.st === "authenticating" && typeof m.success === "boolean" && m.event !== "publish") {
      if (this.authTimer) clearTimeout(this.authTimer);
      this.authTimer = null;
      if (m.success) {
        this.st = "ready";
        this.readySince = this.now();
        this.failures = 0;
        this.lastError = null;
        this.o.log.info({ host: this.host, accountId: this.o.accountId }, "builder oracle websocket authenticated");
      } else {
        this.fail(ws, `auth failed: ${errorText(m)}`);
      }
      return;
    }
    if (m.event === "publish" && m.success === false) {
      const id = typeof m.id === "string" ? m.id : null;
      const data = (m.data ?? {}) as Record<string, unknown>;
      const base = (id ? this.pending.get(id) : undefined) ?? (typeof data.base_ccy === "string" ? data.base_ccy : null);
      const r: PublishReject = { id, base, error: errorText(m), at: this.now() };
      this.lastError = `publish rejected${base ? ` (${base})` : ""}: ${r.error}`;
      this.o.onReject?.(r);
      return;
    }
    if (m.event === "publish" && typeof m.id === "string") this.pending.delete(m.id); // an ack, if Orderly sends one
  }

  /** A connection-level failure: close it; the close handler schedules the reconnect. */
  private fail(ws: WsLike, why: string): void {
    if (this.ws !== ws) return;
    this.lastError = why;
    this.st = "backoff";
    this.o.log.warn({ host: this.host, err: why }, "builder oracle websocket failure");
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  private scheduleReconnect(why: string): void {
    if (this.isStopped()) return;
    this.failures++;
    this.lastError = why;
    this.st = "backoff";
    const wait = backoffMs(this.failures, this.o.reconnectMs ?? 5_000, this.o.maxReconnectMs ?? 60_000);
    if (this.failures === 1 || this.failures % 10 === 0) this.o.log.warn({ host: this.host, err: why, failures: this.failures, retryInMs: wait }, "builder oracle websocket reconnect scheduled");
    this.later(wait, () => void this.connect());
  }
}

function errorText(m: Record<string, unknown>): string {
  for (const k of ["errorMsg", "message", "error", "msg"]) if (typeof m[k] === "string" && m[k]) return (m[k] as string).slice(0, 200);
  return JSON.stringify(m).slice(0, 200);
}
