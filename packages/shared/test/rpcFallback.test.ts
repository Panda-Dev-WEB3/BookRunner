// RPC fallback (clients.ts rpcTransport + rpcRoute.ts) and the usage meter (rpcMeter.ts).
import { describe, expect, test } from "bun:test";
import { createPublicClient, custom, HttpRequestError, TimeoutError } from "viem";
import { rpcTransport } from "../src/clients";
import { LogSubscription, type WsLike } from "../src/logSubscription";
import { RPC_CAPACITY_COOLOFF_MS, RPC_PROBE_MIN_MS, RpcRoutes, classifyRpcFailure, providerLabel } from "../src/rpcRoute";
import { RpcMeter, rpcCuFor } from "../src/rpcMeter";
import { rpcRoutes } from "../src/rpcRoute";

const KEY_URL = "https://eth-mainnet.g.alchemy.com/v2/SECRETKEYSECRETKEY1234";
const httpErr = (status: number, body = "{}") => new HttpRequestError({ url: KEY_URL, status, body: JSON.parse(body), details: body });
const capacity = () => httpErr(429, JSON.stringify({ jsonrpc: "2.0", error: { code: 429, message: "Monthly capacity limit exceeded." } }));

function endpoint(behaviour: () => unknown) {
  const seen: string[] = [];
  const base = custom(
    {
      async request({ method }) {
        seen.push(method);
        const r = behaviour();
        if (r instanceof Error) throw r;
        return r as never;
      },
    },
    { retryCount: 0 },
  );
  return { base, seen };
}

function rig(primaryBehaviour: () => unknown, clock: { t: number } = { t: 1_000_000 }) {
  const p = endpoint(primaryBehaviour);
  const f = endpoint(() => "0x20");
  const routes = new RpcRoutes();
  const meter = new RpcMeter();
  const pc = createPublicClient({
    transport: rpcTransport(KEY_URL, { base: p.base, fallbackBase: f.base, fallbackUrl: "https://rpc.mainnet.chain.robinhood.com", routes, meter, now: () => clock.t, delayMs: 1 }),
  });
  return { pc, p, f, routes, meter, clock };
}

describe("classifyRpcFailure", () => {
  test("provider failures versus errors the provider answered", () => {
    expect(classifyRpcFailure(capacity())).toEqual({ reason: "capacity", status: 429 });
    expect(classifyRpcFailure(httpErr(429))).toEqual({ reason: "rate_limited", status: 429 });
    expect(classifyRpcFailure(httpErr(503))?.reason).toBe("server_error");
    expect(classifyRpcFailure(new TimeoutError({ body: {}, url: KEY_URL }))?.reason).toBe("timeout");
    expect(classifyRpcFailure(new HttpRequestError({ url: KEY_URL, details: "fetch failed" }))?.reason).toBe("network");
    expect(classifyRpcFailure(httpErr(400))).toBeNull();
    expect(classifyRpcFailure(new Error("execution reverted: StalePrice"))).toBeNull();
    expect(classifyRpcFailure(null)).toBeNull();
  });

  test("provider names never carry a URL", () => {
    expect(providerLabel(KEY_URL)).toBe("Alchemy");
    expect(providerLabel("https://rpc.mainnet.chain.robinhood.com")).toBe("Robinhood public RPC");
    expect(providerLabel("https://node.example.org/key123")).toBe("primary RPC");
    expect(providerLabel("not a url")).toBe("primary RPC");
  });
});

describe("rpcTransport fallback", () => {
  test("a healthy primary serves everything and the fallback is never touched", async () => {
    const r = rig(() => "0x10");
    expect(await r.pc.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(r.f.seen).toEqual([]);
    expect(r.routes.primaryStatus()).toBeNull();
  });

  test("HTTP 5xx, 429 and a timeout are answered by the fallback within the same request", async () => {
    for (const err of [httpErr(502), httpErr(429), new TimeoutError({ body: {}, url: KEY_URL })]) {
      const r = rig(() => err);
      expect(await r.pc.getBlockNumber({ cacheTime: 0 })).toBe(32n);
      expect(r.routes.primaryStatus()?.provider).toBe("Alchemy");
    }
  });

  test("a revert or a bad request is not a provider failure: no fallback", async () => {
    const r = rig(() => httpErr(400));
    await expect(r.pc.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(r.f.seen).toEqual([]);
    expect(r.routes.primaryStatus()).toBeNull();
  });

  test("the primary is tried again after the short cool-off and takes over when it answers", async () => {
    let failing = true;
    const r = rig(() => (failing ? httpErr(503) : "0x10"));
    await r.pc.getBlockNumber({ cacheTime: 0 });
    const before = r.p.seen.length;
    r.clock.t += RPC_PROBE_MIN_MS - 1;
    await r.pc.getBlockNumber({ cacheTime: 0 });
    expect(r.p.seen.length).toBe(before); // still cooling off: fallback only
    failing = false;
    r.clock.t += 2;
    expect(await r.pc.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(r.routes.primaryStatus()).toBeNull();
  });

  test("a monthly capacity 429 keeps the fallback for 30 minutes", async () => {
    const r = rig(() => capacity());
    await r.pc.getBlockNumber({ cacheTime: 0 });
    const st = r.routes.primaryStatus();
    expect(st?.reason).toBe("capacity");
    expect(st?.message).toBe("Alchemy monthly capacity limit reached: switch plan or key");
    expect(st?.retryAt).toBe(r.clock.t + RPC_CAPACITY_COOLOFF_MS);
    const before = r.p.seen.length;
    r.clock.t += RPC_CAPACITY_COOLOFF_MS - 1;
    await r.pc.getBlockNumber({ cacheTime: 0 });
    expect(r.p.seen.length).toBe(before);
    r.clock.t += 2;
    await r.pc.getBlockNumber({ cacheTime: 0 });
    expect(r.p.seen.length).toBe(before + 1); // probed once, failed, back on the fallback
  });

  test("the status and its message never contain the URL or the key", async () => {
    const r = rig(() => capacity());
    await r.pc.getBlockNumber({ cacheTime: 0 });
    const text = JSON.stringify(r.routes.status());
    expect(text).not.toContain("SECRETKEY");
    expect(text).not.toContain("alchemy.com");
    expect(text).not.toContain("https://");
  });

  test("a transaction broadcast is not re-sent after a timeout, but is after an outright refusal", async () => {
    const mk = (err: Error) => {
      const r = rig(() => err);
      return { r, send: () => (r.pc as unknown as { request(a: { method: string }): Promise<unknown> }).request({ method: "eth_sendRawTransaction" }) };
    };
    const t = mk(new TimeoutError({ body: {}, url: KEY_URL }));
    await expect(t.send()).rejects.toThrow();
    expect(t.r.f.seen).toEqual([]);
    expect(t.r.routes.primaryStatus()).not.toBeNull(); // later reads still use the fallback
    const c = mk(capacity());
    await c.send();
    expect(c.r.f.seen).toEqual(["eth_sendRawTransaction"]);
  });

  test("without a fallback the transport behaves as before", async () => {
    const p = endpoint(() => httpErr(503));
    const pc = createPublicClient({ transport: rpcTransport(KEY_URL, { base: p.base, fallbackUrl: null, routes: new RpcRoutes(), meter: new RpcMeter() }) });
    await expect(pc.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
  });

  test("concurrent failures are one stretch (no cool-off inflation)", () => {
    const routes = new RpcRoutes();
    routes.fail("k", "Alchemy", { reason: "server_error", status: 503 }, 1000);
    routes.fail("k", "Alchemy", { reason: "server_error", status: 503 }, 1001);
    routes.fail("k", "Alchemy", { reason: "server_error", status: 503 }, 1002);
    expect(routes.primaryStatus()?.retryAt).toBe(1000 + RPC_PROBE_MIN_MS);
  });
});

describe("usage meter", () => {
  test("counts per method, estimates CU from the table, keeps the fallback apart", async () => {
    const r = rig(() => "0x10");
    await r.pc.getBlockNumber({ cacheTime: 0 });
    await r.pc.getBlockNumber({ cacheTime: 0 });
    await r.pc.getChainId();
    const s = r.meter.snapshot();
    expect(s.estimate).toBe(true);
    expect(s.methods.eth_blockNumber).toEqual({ calls: 2, cu: 20 });
    expect(s.methods.eth_chainId).toEqual({ calls: 1, cu: 0 });
    expect(s.totalCu).toBe(20);
    expect(s.fallbackCalls).toBe(0);
  });

  test("the CU table", () => {
    expect([rpcCuFor("eth_call"), rpcCuFor("eth_getLogs"), rpcCuFor("eth_blockNumber"), rpcCuFor("eth_getBlockByNumber"), rpcCuFor("eth_chainId")]).toEqual([26, 75, 10, 16, 0]);
    expect([rpcCuFor("eth_getTransactionReceipt"), rpcCuFor("eth_sendRawTransaction"), rpcCuFor("eth_subscribe"), rpcCuFor("eth_subscription"), rpcCuFor("eth_whatever")]).toEqual([15, 40, 10, 10, 20]);
  });

  test("requests answered by the fallback do not count as the primary's CU", async () => {
    const r = rig(() => httpErr(503));
    await r.pc.getBlockNumber({ cacheTime: 0 });
    const s = r.meter.snapshot();
    expect(s.fallbackCalls).toBe(1);
    expect(s.methods.eth_blockNumber?.calls).toBe(1); // the one request the primary refused
  });

  test("the hourly report is one log line without secrets", () => {
    const lines: string[] = [];
    const m = new RpcMeter();
    m.attach("oracle", { info: (_o, msg) => lines.push(msg), warn: () => {} });
    m.count("eth_call", "primary", 3);
    m.report();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("estimate");
    expect(lines[0]).toContain("78 CU");
    m.stop();
  });
});

class FakeWs implements WsLike {
  readyState = 1;
  sent: string[] = [];
  private fns: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  addEventListener(t: string, fn: (ev: { data?: unknown }) => void) {
    (this.fns[t] ??= []).push(fn);
  }
  emit(t: string, data?: unknown) {
    for (const f of this.fns[t] ?? []) f({ data });
  }
}

describe("log subscriptions follow the primary", () => {
  test("down while a route is on its fallback, back up (resubscribed) when it recovers", () => {
    rpcRoutes.reset();
    const sockets: FakeWs[] = [];
    const states: boolean[] = [];
    const sub = new LogSubscription({
      url: "wss://example/ws",
      filter: { address: ["0x0000000000000000000000000000000000000001"] },
      onLogs: () => {},
      onState: (u) => states.push(u),
      ws: () => {
        const w = new FakeWs();
        sockets.push(w);
        return w;
      },
      pingMs: 0,
    });
    sub.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", JSON.stringify({ id: 1, result: "0xsub" }));
    expect(states).toEqual([true]);
    rpcRoutes.fail("p", "Alchemy", { reason: "capacity", status: 429 });
    expect(states).toEqual([true, false]);
    expect(sockets[0]!.readyState).toBe(3);
    expect(sockets).toHaveLength(1); // no reconnect while paused
    rpcRoutes.ok("p");
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("open");
    expect(sockets[1]!.sent.some((s) => s.includes("eth_subscribe"))).toBe(true);
    sub.stop();
    rpcRoutes.reset();
  });

  test("started while on the fallback: stays down, no socket", () => {
    rpcRoutes.reset();
    rpcRoutes.fail("p", "Alchemy", { reason: "server_error", status: 503 });
    let opened = 0;
    const sub = new LogSubscription({ url: "wss://example/ws", filter: { address: ["0x0000000000000000000000000000000000000001"] }, onLogs: () => {}, ws: () => (opened++, new FakeWs()) });
    sub.start();
    expect(opened).toBe(0);
    expect(sub.up).toBe(false);
    sub.stop();
    rpcRoutes.reset();
  });
});
