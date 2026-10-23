// Log subscription over WebSocket (eth_subscribe "logs"), RPC budget (deploy/server/MAINNET.md "RPC budget").
// Alchemy bills a subscription by the bytes it delivers (0.04 CU per byte, ~40 CU for a typical log) plus 10 CU per
// eth_subscribe, never per poll: a filtered subscription costs nothing while idle. Consumers use it as a TRIGGER only,
// never as their source of truth: a notification (or the subscription coming up) makes them run their normal,
// canonical read (the indexer's getLogs range, the oracle's Chainlink pass) at once, and they keep a slow safety poll,
// so a missed notification, a reorg or a dead socket costs latency, never data. While the subscription is down they
// poll at their normal cadence. Never `newHeads`: Robinhood Chain makes several blocks per second, each one billed.
// The URL carries the provider key: it is never logged (the `label` is).
import type { Address, Hex } from "viem";

export interface SubscriptionLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
  /** a reorg removed it (the consumer's canonical re-read decides what that means) */
  removed: boolean;
}

export interface LogFilter {
  address: readonly Address[];
  /** topic filters (eth_subscribe "logs" format): position -> one topic, any of several, or null = any */
  topics?: ReadonlyArray<Hex | readonly Hex[] | null>;
}

/** The subset of the WebSocket API used (Bun's global WebSocket; a fake in tests). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** protocol ping frame (Bun): liveness without a billed JSON-RPC call */
  ping?(): void;
  addEventListener(type: "open" | "message" | "close" | "error" | "pong", fn: (ev: { data?: unknown }) => void): void;
}
export type WsFactory = (url: string) => WsLike;

export interface SubscriptionLogger {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  debug(o: object, msg: string): void;
}

export interface LogSubscriptionOptions {
  url: string;
  filter: LogFilter;
  onLogs: (logs: SubscriptionLog[]) => void;
  /** true = subscribed (catch up now), false = not subscribed (poll at the normal cadence) */
  onState?: (up: boolean) => void;
  /** shown in logs instead of the URL */
  label?: string;
  log?: SubscriptionLogger;
  ws?: WsFactory;
  /** first reconnect delay, doubled up to maxReconnectMs */
  reconnectMs?: number;
  maxReconnectMs?: number;
  /** ping frame cadence while connected (0 = none) */
  pingMs?: number;
  /** no message or pong for this long: the socket is presumed dead and reconnected */
  silenceMs?: number;
}

const sameFilter = (a: LogFilter, b: LogFilter) =>
  JSON.stringify({ a: [...a.address].map((x) => x.toLowerCase()).sort(), t: a.topics ?? null }) === JSON.stringify({ a: [...b.address].map((x) => x.toLowerCase()).sort(), t: b.topics ?? null });

const big = (v: unknown): bigint | null => (typeof v === "string" && v.startsWith("0x") ? BigInt(v) : null);

/** A log notification's `result` (hex JSON) as a SubscriptionLog; null when it is not a log. */
export function parseSubscriptionLog(r: unknown): SubscriptionLog | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.address !== "string" || !Array.isArray(o.topics)) return null;
  const idx = big(o.logIndex);
  return {
    address: o.address as Address,
    topics: o.topics as Hex[],
    data: (typeof o.data === "string" ? o.data : "0x") as Hex,
    blockNumber: big(o.blockNumber),
    transactionHash: typeof o.transactionHash === "string" ? (o.transactionHash as Hex) : null,
    logIndex: idx === null ? null : Number(idx),
    removed: o.removed === true,
  };
}

export class LogSubscription {
  private ws: WsLike | null = null;
  private subId: string | null = null;
  private subscribeReq: number | null = null;
  private nextId = 1;
  private stopped = true;
  private failures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private upState = false;
  private filter: LogFilter;
  /** eth_subscribe requests sent (tests, /health) */
  subscribes = 0;

  constructor(private readonly o: LogSubscriptionOptions) {
    this.filter = o.filter;
  }

  /** Subscribed right now (a notification would be delivered). */
  get up(): boolean {
    return this.upState;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dropSocket();
    this.setUp(false);
  }

  /** A new filter (e.g. a book was added): resubscribed at once; the consumer catches up when it comes up again. */
  setFilter(filter: LogFilter): void {
    if (sameFilter(filter, this.filter)) return;
    this.filter = filter;
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    if (this.subId) this.send(ws, "eth_unsubscribe", [this.subId]);
    this.subId = null;
    this.setUp(false);
    this.subscribe(ws);
  }

  private label(): string {
    return this.o.label ?? "log subscription";
  }

  private setUp(up: boolean): void {
    if (up === this.upState) return;
    this.upState = up;
    this.o.onState?.(up);
  }

  private send(ws: WsLike, method: string, params: unknown[]): number {
    const id = this.nextId++;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  }

  private subscribe(ws: WsLike): void {
    if (this.filter.address.length === 0) return; // nothing to watch: stay down (the consumer polls)
    const f: Record<string, unknown> = { address: [...this.filter.address] };
    if (this.filter.topics) f.topics = this.filter.topics;
    this.subscribes++;
    this.subscribeReq = this.send(ws, "eth_subscribe", ["logs", f]);
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WsLike;
    try {
      ws = (this.o.ws ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(this.o.url);
    } catch (err) {
      this.retry(err);
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.lastSeen = Date.now();
      this.subscribe(ws);
      const pingMs = this.o.pingMs ?? 30_000;
      if (pingMs > 0) {
        this.pingTimer = setInterval(() => {
          if (Date.now() - this.lastSeen > (this.o.silenceMs ?? 3 * pingMs)) {
            this.o.log?.warn({ subscription: this.label() }, "log subscription silent (no pong): reconnecting");
            this.fail(new Error("silent"));
            return;
          }
          try {
            ws.ping?.();
          } catch {
            // closed underneath: the close event reconnects
          }
        }, pingMs);
        (this.pingTimer as { unref?: () => void }).unref?.();
      }
    });
    ws.addEventListener("pong", () => {
      if (this.ws === ws) this.lastSeen = Date.now();
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      this.lastSeen = Date.now();
      this.onMessage(ev.data);
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.fail(new Error("socket closed"));
    });
    ws.addEventListener("error", () => {
      if (this.ws === ws) this.fail(new Error("socket error"));
    });
  }

  private onMessage(raw: unknown): void {
    let m: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { subscription?: string; result?: unknown } };
    try {
      m = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (m.id !== undefined && m.id === this.subscribeReq) {
      this.subscribeReq = null;
      if (typeof m.result === "string") {
        this.subId = m.result;
        if (this.failures > 0) this.o.log?.info({ subscription: this.label(), after: this.failures }, "log subscription restored");
        this.failures = 0;
        this.setUp(true);
      } else {
        this.fail(new Error(`eth_subscribe refused: ${m.error?.message ?? "no subscription id"}`));
      }
      return;
    }
    if (m.method === "eth_subscription" && m.params?.subscription === this.subId && this.subId !== null) {
      const l = parseSubscriptionLog(m.params.result);
      if (l) this.o.onLogs([l]);
    }
  }

  private dropSocket(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.subId = null;
    this.subscribeReq = null;
    try {
      ws?.close();
    } catch {
      // already closed
    }
  }

  private fail(err: unknown): void {
    this.dropSocket();
    this.setUp(false);
    this.retry(err);
  }

  private retry(err: unknown): void {
    if (this.stopped || this.reconnectTimer) return;
    this.failures++;
    const wait = Math.min((this.o.reconnectMs ?? 1_000) * 2 ** Math.min(this.failures - 1, 16), this.o.maxReconnectMs ?? 60_000);
    if (this.failures === 1 || this.failures % 10 === 0) {
      // the URL carries the provider key: never log a raw error message (a WebSocket constructor error quotes the URL)
      const msg = (err instanceof Error ? err.message : String(err)).split(this.o.url).join("<ws-url>").replace(/wss?:\/\/\S+/g, "<ws-url>");
      this.o.log?.warn({ subscription: this.label(), err: msg, retryInMs: wait, failures: this.failures }, "log subscription down: polling until it reconnects");
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }
}

/**
 * The WebSocket URL of an HTTPS RPC (RPC budget): an explicit override wins; else Alchemy endpoints map https:// ->
 * wss:// on the same path (Alchemy serves both); any other provider needs the override (null = no subscription).
 */
export function deriveWsUrl(rpcUrl: string | undefined, override?: string): string | null {
  const o = override?.trim();
  if (o) return o;
  if (!rpcUrl) return null;
  try {
    const u = new URL(rpcUrl);
    if (u.protocol !== "https:" || !/(^|\.)alchemy\.com$/i.test(u.hostname)) return null;
    u.protocol = "wss:";
    return u.toString();
  } catch {
    return null;
  }
}
