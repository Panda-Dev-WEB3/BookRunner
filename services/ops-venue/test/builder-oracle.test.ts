// Live builder price push (src/builderOracle, docs/VERIFY.md O18) against a local fake Builder Oracle WebSocket server:
// auth URL + signature, message shape, ping/pong, cadence (>= 1/s by re-sending the latest signed price), stop on
// held / stale, rejects, reconnect with backoff. No network beyond 127.0.0.1, no real keys.
import { afterEach, describe, expect, test } from "bun:test";
import * as ed from "@noble/ed25519";
import { type BuilderFeedStatusMsg, KEYS, type OracleVenueFeedMsg, type OracleVenuePrice } from "@bookrunner/shared";
import type { Server, ServerWebSocket } from "bun";
import { BuilderPriceFeed, builderFeedTargets, type FeedSocket } from "../src/builderOracle/feed";
import { BuilderOracleSocket, backoffMs, ORACLE_WS_DOMAINS, oracleWsUrl, resolveOracleWsDomain, roundPushPrice } from "../src/builderOracle/socket";
import { type BuilderFeedEnv, builderPushEnabled, startBuilderPriceFeed } from "../src/builderOracle/wire";
import { loadOpsEnv } from "../src/config";
import { keyFromSecret } from "../src/orderly/auth";
import type { TrackedBook } from "../src/worker/context";
import { log } from "./helpers";

const SEED = "0x" + "11".repeat(32);
const ACCOUNT = `0x${"cd".repeat(32)}`;
const SYM = "PERP_NVDA_USDC_bookrunner";

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await Bun.sleep(5);
  }
};

function b64urlDecode(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64url"));
}

// ------------------------------------------------------------------ fake Builder Oracle server
type Auth = "ok" | "fail" | "silent";
interface Conn {
  url: URL;
  ws: ServerWebSocket<{ url: URL }>;
  msgs: Array<Record<string, unknown>>;
  closed: boolean;
  at: number;
}

/** Minimal client WebSocket stand-in (liveness test): the test plays the server. */
class FakeWs {
  readyState = 0;
  pings = 0;
  answerPings = false;
  sent: string[] = [];
  private ls = new Map<string, Array<(ev: unknown) => void>>();
  constructor(readonly url: string) {}
  addEventListener(t: string, l: (ev: unknown) => void) {
    this.ls.set(t, [...(this.ls.get(t) ?? []), l]);
  }
  private emit(t: string, ev: unknown) {
    for (const l of this.ls.get(t) ?? []) l(ev);
  }
  send(s: string) {
    this.sent.push(s);
  }
  ping() {
    this.pings++;
    if (this.answerPings) queueMicrotask(() => this.emit("pong", {}));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code: 1006, reason: "" }));
  }
  serverOpen() {
    this.readyState = 1;
    this.emit("open", {});
  }
  serverSend(m: unknown) {
    this.emit("message", { data: JSON.stringify(m) });
  }
}

class FakeOracleServer {
  readonly conns: Conn[] = [];
  auth: Auth = "ok";
  server: Server<{ url: URL }>;
  constructor() {
    this.server = Bun.serve<{ url: URL }, never>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, server) => (server.upgrade(req, { data: { url: new URL(req.url) } }) ? undefined : new Response("upgrade required", { status: 426 })),
      websocket: {
        open: (ws) => {
          this.conns.push({ url: ws.data.url, ws, msgs: [], closed: false, at: Date.now() });
          if (this.auth === "ok") ws.send(JSON.stringify({ success: true }));
          if (this.auth === "fail") ws.send(JSON.stringify({ success: false, errorMsg: "invalid signature" }));
        },
        message: (ws, raw) => {
          const c = this.conns.find((x) => x.ws === ws);
          c?.msgs.push(JSON.parse(String(raw)) as Record<string, unknown>);
        },
        close: (ws) => {
          const c = this.conns.find((x) => x.ws === ws);
          if (c) c.closed = true;
        },
      },
    });
  }
  get domain() {
    return `ws://127.0.0.1:${this.server.port}`;
  }
  publishes(): Array<Record<string, unknown>> {
    return this.conns.flatMap((c) => c.msgs.filter((m) => m.event === "publish"));
  }
  stop() {
    this.server.stop(true);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function setup(opts: Partial<ConstructorParameters<typeof BuilderOracleSocket>[0]> = {}, auth: Auth = "ok") {
  const srv = new FakeOracleServer();
  srv.auth = auth;
  const key = await keyFromSecret(SEED);
  const sock = new BuilderOracleSocket({ domain: srv.domain, accountId: ACCOUNT, key, log, reconnectMs: 20, maxReconnectMs: 200, authTimeoutMs: 200, ...opts });
  cleanups.push(() => sock.stop(), () => srv.stop());
  return { srv, sock, key };
}

const price = (over: Partial<OracleVenuePrice> = {}): OracleVenuePrice => ({
  symbol: SYM,
  priceId: "NVDA",
  price: 190.25,
  held: false,
  stale: false,
  publishedAt: 1_700_000_000,
  signedAt: 1_000,
  ...over,
});
const feedMsg = (ts: number, prices: OracleVenuePrice[]): OracleVenueFeedMsg => ({ v: 1, ts, prices });

// ------------------------------------------------------------------ pure pieces
describe("builder oracle: URL, domain, backoff", () => {
  test("auth URL: documented path + query; sign = unpadded base64url Ed25519 over the UTF-8 timestamp", async () => {
    const key = await keyFromSecret(SEED);
    const u = new URL(await oracleWsUrl("wss://ws-oracle.orderly.org/", ACCOUNT, key, 1_711_440_000_123));
    expect(u.origin + u.pathname).toBe(`wss://ws-oracle.orderly.org/v1/ws/oracle/push/${ACCOUNT}`);
    expect(u.searchParams.get("orderly_key")).toBe(key.orderlyKey);
    expect(u.searchParams.get("timestamp")).toBe("1711440000123");
    const sign = u.searchParams.get("sign")!;
    expect(sign).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(await ed.verifyAsync(b64urlDecode(sign), new TextEncoder().encode("1711440000123"), key.publicKey)).toBe(true);
  });

  test("domain: explicit wins; mainnet documented; testnet by API host; unknown host -> not configured", () => {
    expect(resolveOracleWsDomain("https://api.orderly.org")).toBe(ORACLE_WS_DOMAINS.mainnet);
    expect(resolveOracleWsDomain("https://testnet-api.orderly.org")).toBe(ORACLE_WS_DOMAINS.testnet);
    expect(resolveOracleWsDomain("http://127.0.0.1:4420")).toBeNull();
    expect(resolveOracleWsDomain("https://testnet-api.orderly.org", "wss://x.example/")).toBe("wss://x.example");
  });

  test("backoff doubles from the base and caps", () => {
    expect([1, 2, 3, 4, 10].map((n) => backoffMs(n, 5_000, 60_000))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
  });

  test("targets: tradable books in a listed state, one per venue symbol", () => {
    const books = [
      { bookId: 2, symbol: SYM, state: "Live" as const, venueSymbolError: null },
      { bookId: 1, symbol: SYM, state: "Subscription" as const, venueSymbolError: null },
      { bookId: 3, symbol: "PERP_TSLA_USDC_bookrunner", state: "Retired" as const, venueSymbolError: null },
      { bookId: 4, symbol: "PERP_X-1_USDC", state: "Live" as const, venueSymbolError: "no market" },
      { bookId: 5, symbol: "PERP_AAPL_USDC_bookrunner", state: "Retiring" as const, venueSymbolError: null },
      { bookId: 6, symbol: "PERP_MSFT_USDC_bookrunner", state: "Cancelled" as const, venueSymbolError: null },
    ];
    expect(builderFeedTargets(books)).toEqual([
      { symbol: SYM, bookIds: [1, 2], preListing: false }, // one Live book: the market must be listed
      { symbol: "PERP_AAPL_USDC_bookrunner", bookIds: [5], preListing: false },
    ]);
    expect(builderFeedTargets([{ bookId: 7, symbol: SYM, state: "Subscription", venueSymbolError: null }])).toEqual([{ symbol: SYM, bookIds: [7], preListing: true }]);
  });

  test("prices are rounded to the documented 8 decimals", () => {
    expect(roundPushPrice(190.123456789)).toBe(190.12345679);
    expect(roundPushPrice(190.25)).toBe(190.25);
  });
});

// ------------------------------------------------------------------ socket against the fake server
describe("builder oracle socket (fake WS server)", () => {
  test("connects with a verifiable signature, authenticates, publishes the documented message, answers ping", async () => {
    const { srv, sock, key } = await setup();
    sock.start();
    await until(() => sock.ready);
    const c = srv.conns[0]!;
    expect(c.url.pathname).toBe(`/v1/ws/oracle/push/${ACCOUNT}`);
    const ts = c.url.searchParams.get("timestamp")!;
    expect(await ed.verifyAsync(b64urlDecode(c.url.searchParams.get("sign")!), new TextEncoder().encode(ts), key.publicKey)).toBe(true);
    expect(c.url.searchParams.get("orderly_key")).toBe(key.orderlyKey);

    const before = Date.now();
    const id = sock.publish("NVDA", 190.25);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    await until(() => c.msgs.length >= 1);
    const m = c.msgs[0]!;
    expect(Object.keys(m).sort()).toEqual(["data", "event", "id", "topic", "ts"]);
    expect(m).toMatchObject({ id, event: "publish", topic: "indexpricefeed", data: { base_ccy: "NVDA", price: 190.25 } });
    expect(m.ts as number).toBeGreaterThanOrEqual(before - 5);

    c.ws.send(JSON.stringify({ event: "ping" }));
    await until(() => c.msgs.some((x) => x.event === "pong"));
    expect(c.msgs.find((x) => x.event === "pong")).toEqual({ event: "pong" });
  });

  test("nothing is sent before the auth answer", async () => {
    const { srv, sock } = await setup({ authTimeoutMs: 5_000 }, "silent");
    sock.start();
    await until(() => srv.conns.length === 1 && sock.state === "authenticating");
    expect(sock.publish("NVDA", 1)).toBeNull();
    await Bun.sleep(20);
    expect(srv.publishes()).toHaveLength(0);
  });

  test("auth failure: errorMsg surfaced, reconnects with growing backoff, never ready", async () => {
    const { srv, sock } = await setup({ reconnectMs: 40, maxReconnectMs: 1_000 }, "fail");
    sock.start();
    await until(() => srv.conns.length >= 4, 3_000);
    expect(sock.ready).toBe(false);
    expect(sock.lastError).toContain("auth failed: invalid signature");
    // reconnect gaps follow the backoff: 40, 80, 160 ms (each attempt also costs a connect + auth round trip)
    const at = srv.conns.map((c) => c.at);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps[0]!).toBeGreaterThanOrEqual(35);
    expect(gaps[1]!).toBeGreaterThanOrEqual(75);
    expect(gaps[2]!).toBeGreaterThanOrEqual(155);
    expect(gaps[2]!).toBeGreaterThan(gaps[0]!);
  });

  test("liveness: a half-open connection (send works, no pong ever) is dropped and reconnected", async () => {
    const sockets: FakeWs[] = [];
    const key = await keyFromSecret(SEED);
    const sock = new BuilderOracleSocket({
      domain: "wss://oracle.test",
      accountId: ACCOUNT,
      key,
      log,
      reconnectMs: 10,
      livenessMs: 20,
      livenessTimeoutMs: 60,
      idleTimeoutMs: 0,
      webSocket: (url) => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });
    cleanups.push(() => sock.stop());
    sock.start();
    await until(() => sockets.length === 1);
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ success: true });
    expect(sock.ready).toBe(true);
    expect(sock.publish("NVDA", 1)).not.toBeNull(); // send() succeeds on the half-open socket
    await until(() => sockets.length === 2, 2_000);
    expect(sockets[0]!.pings).toBeGreaterThan(0);
    expect(sock.lastError ?? "").toMatch(/no pong|closed/);
    // a peer that answers pings keeps the connection
    sockets[1]!.answerPings = true;
    sockets[1]!.serverOpen();
    sockets[1]!.serverSend({ success: true });
    await Bun.sleep(200);
    expect(sockets).toHaveLength(2);
    expect(sock.ready).toBe(true);
  });

  test("no auth answer within authTimeoutMs: reconnect", async () => {
    const { srv, sock } = await setup({ authTimeoutMs: 50 }, "silent");
    sock.start();
    await until(() => srv.conns.length >= 2, 2_000);
    expect(sock.lastError).toMatch(/no auth response|closed/);
  });

  test("server drops the connection: reconnects and re-authenticates", async () => {
    const { srv, sock } = await setup();
    sock.start();
    await until(() => sock.ready);
    srv.conns[0]!.ws.close(1011, "restart");
    await until(() => !sock.ready);
    await until(() => sock.ready && srv.conns.length === 2);
    expect(sock.publish("NVDA", 191)).not.toBeNull();
    await until(() => srv.conns[1]!.msgs.length === 1);
  });

  test("idle timeout: no server message for idleTimeoutMs -> reconnect", async () => {
    const { srv, sock } = await setup({ idleTimeoutMs: 80 });
    sock.start();
    await until(() => sock.ready);
    await until(() => srv.conns.length >= 2, 2_000);
  });

  test("a rejected publish is attributed to its base_ccy by id", async () => {
    const rejects: Array<{ base: string | null; error: string }> = [];
    const { srv, sock } = await setup({ onReject: (r) => rejects.push({ base: r.base, error: r.error }) });
    sock.start();
    await until(() => sock.ready);
    const id = sock.publish("NVDA", 190);
    await until(() => srv.conns[0]!.msgs.length === 1);
    srv.conns[0]!.ws.send(JSON.stringify({ id, event: "publish", success: false, errorMsg: "unknown base_ccy" }));
    await until(() => rejects.length === 1);
    expect(rejects[0]).toEqual({ base: "NVDA", error: "unknown base_ccy" });
  });
});

// ------------------------------------------------------------------ feed logic (fake socket, manual clock)
class FakeSocket implements FeedSocket {
  ready = true;
  state = "ready";
  lastError: string | null = null;
  host = "fake";
  sent: Array<{ base: string; price: number }> = [];
  publish(base: string, price: number) {
    if (!this.ready) return null;
    this.sent.push({ base, price });
    return "00000000";
  }
}

function feedHarness(over: { socket?: FakeSocket | null; targets?: Array<{ symbol: string; bookIds: number[]; preListing?: boolean }> } = {}) {
  let clock = 1_000;
  const socket = over.socket === undefined ? new FakeSocket() : over.socket;
  const feed = new BuilderPriceFeed({ socket, targets: () => over.targets ?? [{ symbol: SYM, bookIds: [1] }], log, now: () => clock, maxAgeMs: 10_000 });
  return {
    feed,
    socket,
    at: (ms: number) => {
      clock = ms;
    },
    sym: () => feed.status().symbols.find((s) => s.symbol === SYM)!,
  };
}

describe("builder price feed", () => {
  test("re-sends the latest signed price every tick between oracle ticks; a new signed price replaces it", () => {
    const h = feedHarness();
    h.feed.onFeed(feedMsg(1_000, [price()]));
    for (const t of [1_000, 2_000, 3_000]) {
      h.at(t);
      h.feed.tick();
    }
    expect(h.socket!.sent).toEqual([
      { base: "NVDA", price: 190.25 },
      { base: "NVDA", price: 190.25 },
      { base: "NVDA", price: 190.25 },
    ]);
    h.feed.onFeed(feedMsg(3_000, [price({ price: 191, signedAt: 3_000 })]));
    h.feed.onFeed(feedMsg(1_000, [price()])); // an older message (key re-read) never overrides
    h.at(4_000);
    h.feed.tick();
    expect(h.socket!.sent.at(-1)).toEqual({ base: "NVDA", price: 191 });
    expect(h.sym()).toMatchObject({ state: "pushing", lastPushAt: 4_000, price: 191, failingSince: null, error: null, base: "NVDA" });
  });

  test("held (session closed): nothing pushed and not failing", () => {
    const h = feedHarness();
    h.feed.onFeed(feedMsg(1_000, [price({ held: true })]));
    h.feed.tick();
    expect(h.socket!.sent).toHaveLength(0);
    expect(h.sym()).toMatchObject({ state: "held", failingSince: null });
  });

  test("stale per the oracle flag or by age: nothing pushed, failing since the first such tick", () => {
    const h = feedHarness();
    h.feed.onFeed(feedMsg(1_000, [price()]));
    h.feed.tick();
    h.feed.onFeed(feedMsg(2_000, [price({ stale: true })]));
    h.at(2_000);
    h.feed.tick();
    expect(h.socket!.sent).toHaveLength(1);
    expect(h.sym()).toMatchObject({ state: "stale", failingSince: 2_000 });

    const g = feedHarness();
    g.feed.onFeed(feedMsg(1_000, [price({ signedAt: 1_000 })]));
    g.at(11_000);
    g.feed.tick(); // exactly maxAge: still sent
    g.at(11_001);
    g.feed.tick();
    g.at(12_000);
    g.feed.tick();
    expect(g.socket!.sent).toHaveLength(1);
    expect(g.sym()).toMatchObject({ state: "stale", failingSince: 11_001 });
    expect(g.sym().error).toContain("old");
    g.feed.onFeed(feedMsg(12_500, [price({ signedAt: 12_500, price: 189 })]));
    g.at(13_000);
    g.feed.tick();
    expect(g.sym()).toMatchObject({ state: "pushing", failingSince: null, price: 189 });
  });

  test("no oracle price, invalid price, disconnected, not configured: each failing with a reason", () => {
    const h = feedHarness();
    h.feed.tick();
    expect(h.sym()).toMatchObject({ state: "no-price", failingSince: 1_000 });
    h.feed.onFeed(feedMsg(1_000, [price({ price: 0 })]));
    h.feed.tick();
    expect(h.sym().state).toBe("invalid");
    h.feed.onFeed(feedMsg(1_001, [price({ signedAt: 1_001 })]));
    h.socket!.ready = false;
    h.socket!.state = "backoff";
    h.socket!.lastError = "auth failed: x";
    h.feed.tick();
    expect(h.sym()).toMatchObject({ state: "disconnected", failingSince: 1_000, error: "builder oracle websocket backoff: auth failed: x" });

    const n = feedHarness({ socket: null });
    n.feed.onFeed(feedMsg(1_000, [price()]));
    n.feed.tick();
    expect(n.sym().state).toBe("not-configured");
    expect(n.feed.status().socket.state).toBe("not-configured");
  });

  test("rejects keep the symbol rejected for rejectHoldMs, so jittery reject latency never resets the failing run", () => {
    const h = feedHarness();
    h.feed.onFeed(feedMsg(1_000, [price()]));
    h.feed.tick();
    // steady rejection whose answers land irregularly (some ticks see none)
    const rejectsAt = [1_100, 2_900, 3_100, 6_900, 9_500];
    for (let t = 2_000; t <= 10_000; t += 1_000) {
      for (const r of rejectsAt) if (r <= t && r > t - 1_000) h.feed.onReject({ id: "x", base: "NVDA", error: "unknown base_ccy", at: r });
      h.feed.onFeed(feedMsg(t, [price({ signedAt: t })]));
      h.at(t);
      h.feed.tick();
      expect(h.sym()).toMatchObject({ state: "rejected", error: "unknown base_ccy", failingSince: 2_000 });
    }
    // 5 s without a reject: accepted again
    for (let t = 11_000; t <= 15_000; t += 1_000) {
      h.feed.onFeed(feedMsg(t, [price({ signedAt: t })]));
      h.at(t);
      h.feed.tick();
    }
    expect(h.sym()).toMatchObject({ state: "pushing", failingSince: null });
  });

  test("the oracle dies while the session is closed: the held price ages out, nothing is pushed after the open, and it fails", () => {
    const h = feedHarness();
    h.feed.onFeed(feedMsg(1_000, [price({ held: true, signedAt: 1_000 })]));
    h.feed.tick();
    expect(h.sym()).toMatchObject({ state: "held", failingSince: null });
    // no oracle message any more (alive, it re-signs held prices every tick); the session opens meanwhile
    for (const t of [5_000, 11_001, 60_000]) {
      h.at(t);
      h.feed.tick();
    }
    expect(h.socket!.sent).toHaveLength(0);
    expect(h.sym()).toMatchObject({ state: "stale", failingSince: 11_001 });
    expect(h.sym().error).toContain("last seen held");
  });

  test("max age never below 3 oracle ticks (ORACLE_TICK_MS carried in the feed)", () => {
    const h = feedHarness(); // maxAgeMs 10 s
    h.feed.onFeed({ ...feedMsg(1_000, [price({ signedAt: 1_000 })]), tickMs: 5_000 });
    h.at(15_000); // 14 s old: under 3 x 5 s
    h.feed.tick();
    expect(h.sym().state).toBe("pushing");
    h.at(16_001);
    h.feed.tick();
    expect(h.sym().state).toBe("stale");
  });

  test("preListing is carried to the status (alerts do not page it)", () => {
    const h = feedHarness({ targets: [{ symbol: SYM, bookIds: [1], preListing: true }] });
    h.feed.tick();
    expect(h.sym()).toMatchObject({ state: "no-price", preListing: true });
  });

  test("run: a hung Redis read or status write never blocks the 1/s publishes", async () => {
    const socket = new FakeSocket();
    const feed = new BuilderPriceFeed({ socket, targets: () => [{ symbol: SYM, bookIds: [1] }], log, intervalMs: 20, ioTimeoutMs: 50 });
    feed.onFeed(feedMsg(Date.now(), [price({ signedAt: Date.now() })]));
    const ac = new AbortController();
    let reads = 0;
    const run = feed.run(ac.signal, {
      refresh: () => {
        reads++;
        return new Promise<void>(() => {}); // never answers
      },
      publishStatus: () => new Promise<void>(() => {}),
      refreshEvery: 1,
      statusEvery: 1,
    });
    await Bun.sleep(300);
    ac.abort();
    await run;
    expect(socket.sent.length).toBeGreaterThanOrEqual(8);
    expect(reads).toBeGreaterThanOrEqual(2); // abandoned after ioTimeoutMs, then retried
  });

  test("symbols no longer targeted drop out of the status", () => {
    let targets = [{ symbol: SYM, bookIds: [1] }];
    let clock = 1_000;
    const feed = new BuilderPriceFeed({ socket: new FakeSocket(), targets: () => targets, log, now: () => clock });
    feed.tick();
    expect(feed.status().symbols).toHaveLength(1);
    targets = [];
    clock = 2_000;
    feed.tick();
    expect(feed.status().symbols).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ end to end: feed loop + socket + fake server
describe("builder price feed over the fake WS server", () => {
  test("cadence: one publish per interval with the same signed price, stops once the oracle marks it stale", async () => {
    const { srv, sock } = await setup();
    const feed = new BuilderPriceFeed({ socket: sock, targets: () => [{ symbol: SYM, bookIds: [1] }], log, intervalMs: 50, maxAgeMs: 60_000 });
    sock.start();
    await until(() => sock.ready);
    feed.onFeed(feedMsg(Date.now(), [price({ signedAt: Date.now() })]));
    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    const statuses: number[] = [];
    const run = feed.run(ac.signal, { publishStatus: async (s) => void statuses.push(s.ts), statusEvery: 2 });
    await until(() => srv.publishes().length >= 6, 2_000);
    const sent = srv.publishes();
    expect(new Set(sent.map((m) => (m.data as { price: number }).price))).toEqual(new Set([190.25]));
    const ts = sent.map((m) => m.ts as number);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
    expect(Math.max(...gaps)).toBeLessThan(1_000); // >= 1 publish/s (here every ~50 ms)

    feed.onFeed(feedMsg(Date.now() + 1, [price({ signedAt: Date.now(), stale: true })]));
    await Bun.sleep(60); // let an in-flight tick pass
    const n = srv.publishes().length;
    await Bun.sleep(200);
    expect(srv.publishes().length).toBe(n);
    expect(feed.status().symbols[0]!.state).toBe("stale");
    expect(statuses.length).toBeGreaterThan(1);
    ac.abort();
    await run;
  });
});

// ------------------------------------------------------------------ main.ts wiring + config
describe("builder price feed wiring (startBuilderPriceFeed) and config", () => {
  const ENV: BuilderFeedEnv = {
    ORDERLY_MODE: "live",
    ORDERLY_BASE_URL: "https://testnet-api.orderly.org",
    ORDERLY_SYMBOL_PRICE_SOURCE: "builder",
    OPS_BUILDER_PRICE_PUSH: true,
    OPS_BUILDER_PRICE_INTERVAL_MS: 20,
    OPS_BUILDER_PRICE_MAX_AGE_MS: 60_000,
    OPS_BUILDER_ORACLE_RECONNECT_MS: 20,
    OPS_BUILDER_ORACLE_MAX_RECONNECT_MS: 200,
    OPS_BUILDER_ORACLE_IDLE_MS: 0,
    OPS_BUILDER_ORACLE_LIVENESS_MS: 0,
    OPS_BUILDER_ORACLE_LIVENESS_TIMEOUT_MS: 15_000,
  };
  const book = { bookId: 1, symbol: SYM, state: "Live", venueSymbolError: null } as unknown as TrackedBook;

  function fakes(keyRaw: string | null) {
    let onMsg: ((ch: string, m: string) => void) | null = null;
    const subscribed: string[] = [];
    const statuses: BuilderFeedStatusMsg[] = [];
    return {
      redis: { get: async (k: string) => (k === KEYS.oracleVenueFeed ? keyRaw : null) },
      sub: {
        subscribe: async (ch: string) => void subscribed.push(ch),
        on: (_e: "message", cb: (ch: string, m: string) => void) => {
          onMsg = cb;
        },
      },
      emit: (ch: string, m: string) => onMsg?.(ch, m),
      subscribed,
      statuses,
    };
  }

  test("off unless ORDERLY_MODE=live, OPS_BUILDER_PRICE_PUSH and builder-priced listings", async () => {
    expect(builderPushEnabled(ENV)).toBe(true);
    expect(builderPushEnabled({ ...ENV, ORDERLY_MODE: "mock" })).toBe(false);
    expect(builderPushEnabled({ ...ENV, OPS_BUILDER_PRICE_PUSH: false })).toBe(false);
    expect(builderPushEnabled({ ...ENV, ORDERLY_SYMBOL_PRICE_SOURCE: "chainlink" })).toBe(false);
    const f = fakes(null);
    const key = await keyFromSecret(SEED);
    const h = await startBuilderPriceFeed({ env: { ...ENV, ORDERLY_MODE: "mock" }, log, builderAccountId: ACCOUNT, builderKey: key, keyFromSecret, books: () => [book], redis: f.redis, sub: f.sub, publishStatus: async () => {}, signal: new AbortController().signal });
    expect(h).toBeNull();
    expect(f.subscribed).toEqual([]);
  });

  test("the key re-read and the channel both feed the push; status is published", async () => {
    const { srv } = await setup();
    const now = Date.now();
    const f = fakes(JSON.stringify(feedMsg(now, [price({ signedAt: now, price: 190 })])));
    const ac = new AbortController();
    const key = await keyFromSecret(SEED);
    const h = (await startBuilderPriceFeed({
      env: { ...ENV, ORDERLY_ORACLE_WS_URL: srv.domain },
      log,
      builderAccountId: ACCOUNT,
      builderKey: key,
      keyFromSecret,
      books: () => [book],
      redis: f.redis,
      sub: f.sub,
      publishStatus: async (s) => void f.statuses.push(s),
      signal: ac.signal,
    }))!;
    cleanups.push(() => ac.abort());
    expect(f.subscribed).toEqual([KEYS.oracleVenueFeed]);
    await until(() => srv.publishes().some((m) => (m.data as { price: number }).price === 190));
    f.emit(KEYS.oracleVenueFeed, JSON.stringify(feedMsg(Date.now() + 10_000, [price({ signedAt: Date.now(), price: 191 })])));
    f.emit("bkrn:other", JSON.stringify(feedMsg(Date.now() + 20_000, [price({ signedAt: Date.now(), price: 999 })])));
    await until(() => srv.publishes().some((m) => (m.data as { price: number }).price === 191));
    expect(srv.publishes().some((m) => (m.data as { price: number }).price === 999)).toBe(false);
    expect(srv.conns[0]!.url.pathname).toBe(`/v1/ws/oracle/push/${ACCOUNT}`);
    await until(() => f.statuses.length > 0);
    expect(f.statuses[0]!.symbols[0]).toMatchObject({ symbol: SYM, bookIds: [1], preListing: false });
    ac.abort();
    await h.stop();
  });

  test("ORDERLY_ORACLE_ACCOUNT_ID and ORDERLY_ORACLE_KEY_SECRET: both or neither", () => {
    const base = { ORDERLY_MODE: "live" };
    expect(() => loadOpsEnv({ ...base, ORDERLY_ORACLE_ACCOUNT_ID: ACCOUNT })).toThrow("must be set together");
    expect(() => loadOpsEnv({ ...base, ORDERLY_ORACLE_KEY_SECRET: "x" })).toThrow("must be set together");
    expect(loadOpsEnv({ ...base, ORDERLY_ORACLE_ACCOUNT_ID: ACCOUNT, ORDERLY_ORACLE_KEY_SECRET: "x" }).ORDERLY_ORACLE_ACCOUNT_ID).toBe(ACCOUNT);
    expect(loadOpsEnv(base).OPS_BUILDER_ORACLE_LIVENESS_MS).toBe(5_000);
    expect(() => loadOpsEnv({ ...base, OPS_BUILDER_ORACLE_LIVENESS_MS: "20000" })).toThrow("LIVENESS_TIMEOUT_MS");
    expect(() => loadOpsEnv({ ...base, OPS_BUILDER_PRICE_INTERVAL_MS: "1500" })).toThrow();
  });
});
