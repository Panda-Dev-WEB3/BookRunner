// Live builder price push (src/builderOracle, docs/VERIFY.md O18) against a local fake Builder Oracle WebSocket server:
// auth URL + signature, message shape, ping/pong, cadence (>= 1/s by re-sending the latest signed price), stop on
// held / stale, rejects, reconnect with backoff. No network beyond 127.0.0.1, no real keys.
import { afterEach, describe, expect, test } from "bun:test";
import * as ed from "@noble/ed25519";
import type { OracleVenueFeedMsg, OracleVenuePrice } from "@bookrunner/shared";
import type { Server, ServerWebSocket } from "bun";
import { BuilderPriceFeed, builderFeedTargets, type FeedSocket } from "../src/builderOracle/feed";
import { BuilderOracleSocket, backoffMs, ORACLE_WS_DOMAINS, oracleWsUrl, resolveOracleWsDomain } from "../src/builderOracle/socket";
import { keyFromSecret } from "../src/orderly/auth";
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
          this.conns.push({ url: ws.data.url, ws, msgs: [], closed: false });
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
      { symbol: SYM, bookIds: [1, 2] },
      { symbol: "PERP_AAPL_USDC_bookrunner", bookIds: [5] },
    ]);
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
    await until(() => srv.conns.length >= 3, 2_000);
    expect(sock.ready).toBe(false);
    expect(sock.lastError).toContain("auth failed: invalid signature");
    // gaps between attempts grow (40, 80, ... ms): the 3rd attempt cannot come before ~120 ms
    expect(srv.conns.length).toBeLessThanOrEqual(4);
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

function feedHarness(over: { socket?: FakeSocket | null; targets?: Array<{ symbol: string; bookIds: number[] }> } = {}) {
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

  test("a reject reported by the socket marks the symbol rejected until pushes are accepted again", () => {
    const h = feedHarness();
    h.feed.onFeed(feedMsg(1_000, [price()]));
    h.feed.tick();
    h.feed.onReject({ id: "x", base: "NVDA", error: "unknown base_ccy", at: 1_000 });
    h.at(2_000);
    h.feed.tick();
    expect(h.sym()).toMatchObject({ state: "rejected", error: "unknown base_ccy", failingSince: 2_000 });
    h.at(3_000);
    h.feed.tick();
    expect(h.sym()).toMatchObject({ state: "pushing", failingSince: null });
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
