// RPC usage meter: a cheap in-process counter of JSON-RPC requests per method (the transport in clients.ts counts every
// request it sends to the PRIMARY provider, each call inside an HTTP batch too, which is how Alchemy bills), with an
// ESTIMATE of compute units (CU). The CU table below is hard-coded from Alchemy's published per-method costs and is
// only an estimate: the owner's plan prices a few methods differently (MAINNET.md "RPC budget"), and a provider's
// invoice is the truth. Exposed on a service's /health (`rpc.usage`) and summarised once an hour in its log line
// "rpc usage" (attached by createLogger, nothing to wire per service). Requests sent to the fallback provider are
// counted apart: they cost the primary's plan nothing.

/** Estimated CU per method (Alchemy's published table; an ESTIMATE, not an invoice). */
export const RPC_CU_ESTIMATE: Readonly<Record<string, number>> = {
  eth_call: 26,
  eth_getLogs: 75,
  eth_blockNumber: 10,
  eth_getBlockByNumber: 16,
  eth_chainId: 0,
  eth_getTransactionReceipt: 15,
  eth_sendRawTransaction: 40,
  eth_subscribe: 10,
  /** a pushed subscription notification (billed by bytes on Alchemy, about 10 CU for a typical log) */
  eth_subscription: 10,
};
export const RPC_CU_UNKNOWN = 20;

export const rpcCuFor = (method: string): number => RPC_CU_ESTIMATE[method] ?? RPC_CU_UNKNOWN;

export interface RpcUsageSnapshot {
  service: string | null;
  /** unix ms the counters started (process start or the last reset) */
  since: number;
  seconds: number;
  /** always true: the CU figures use a hard-coded table of Alchemy's published per-method costs */
  estimate: true;
  methods: Record<string, { calls: number; cu: number }>;
  totalCalls: number;
  totalCu: number;
  cuPerSec: number;
  /** requests answered by the fallback provider (not part of totalCu) */
  fallbackCalls: number;
}

/** The subset of a logger the hourly summary needs. */
interface MeterLog {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
}

export class RpcMeter {
  private counts = new Map<string, number>();
  private fallbackCalls = 0;
  private since = Date.now();
  private service: string | null = null;
  private log: MeterLog | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** One request (or `n`) of `method`; `via: "fallback"` counts apart from the primary's CU. */
  count(method: string, via: "primary" | "fallback" = "primary", n = 1): void {
    if (via === "fallback") this.fallbackCalls += n;
    else this.counts.set(method, (this.counts.get(method) ?? 0) + n);
    this.arm();
  }

  /** Names the service and gives the hourly summary a logger (createLogger does; the first caller wins). */
  attach(service: string, log: MeterLog): void {
    if (this.service !== null) return;
    this.service = service;
    this.log = log;
    if (this.counts.size > 0 || this.fallbackCalls > 0) this.arm();
  }

  /** A routing event (fallback on / off) in the service's log; dropped before a logger is attached. */
  event(level: "info" | "warn", o: object, msg: string): void {
    this.log?.[level](o, msg);
  }

  snapshot(now = Date.now()): RpcUsageSnapshot {
    const methods: RpcUsageSnapshot["methods"] = {};
    let totalCalls = 0;
    let totalCu = 0;
    for (const [m, calls] of [...this.counts].sort((a, b) => b[1] * rpcCuFor(b[0]) - a[1] * rpcCuFor(a[0]))) {
      const cu = calls * rpcCuFor(m);
      methods[m] = { calls, cu };
      totalCalls += calls;
      totalCu += cu;
    }
    const seconds = Math.max(1, Math.round((now - this.since) / 1000));
    return { service: this.service, since: this.since, seconds, estimate: true, methods, totalCalls, totalCu, cuPerSec: Math.round((totalCu / seconds) * 100) / 100, fallbackCalls: this.fallbackCalls };
  }

  /** Logs the usage since the counters started (they keep growing: the line carries the running CU/s). */
  report(): void {
    const s = this.snapshot();
    this.log?.info({ rpcUsage: s }, `rpc usage (estimate): ${s.totalCalls} calls, ~${s.totalCu} CU in ${s.seconds} s = ~${s.cuPerSec} CU/s`);
  }

  reset(): void {
    this.counts.clear();
    this.fallbackCalls = 0;
    this.since = Date.now();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer || !this.log) return;
    this.timer = setInterval(() => this.report(), 3_600_000);
    (this.timer as { unref?: () => void }).unref?.();
  }
}

/** The process's meter. */
export const rpcMeter = new RpcMeter();
