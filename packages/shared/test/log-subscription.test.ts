// RPC budget: the log subscription (eth_subscribe "logs" over WebSocket) used as a trigger by the indexer and the
// oracle: subscribe on open, route notifications of its own subscription only, up/down state, reconnect with
// backoff, resubscribe on a filter change, liveness by ping frames, refusal = down. A fake socket stands in.
import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { LogSubscription, type SubscriptionLog, type WsLike, deriveWsUrl, parseSubscriptionLog } from "../src/logSubscription";

type Ev = "open" | "message" | "close" | "error" | "pong";

class FakeWs implements WsLike {
  readyState = 0;
  sent: Array<{ id: number; method: string; params: unknown[] }> = [];
  pings = 0;
  closed = false;
  private readonly fns = new Map<Ev, Array<(ev: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: Ev, fn: (ev: { data?: unknown }) => void) {
    this.fns.set(type, [...(this.fns.get(type) ?? []), fn]);
  }
  emit(type: Ev, data?: unknown) {
    for (const f of this.fns.get(type) ?? []) f({ data });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  ping() {
    this.pings++;
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  reply(id: number, result: unknown) {
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
  notify(subscription: string, result: unknown) {
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result } }));
  }
}

const A = getAddress("0x00000000000000000000000000000000000a0001");
const B = getAddress("0x00000000000000000000000000000000000b0001");
const rawLog = (address: string, block: number) => ({ address, topics: ["0x01"], data: "0x", blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${"aa".repeat(32)}`, logIndex: "0x2", removed: false });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function setup(over: Partial<ConstructorParameters<typeof LogSubscription>[0]> = {}) {
  const sockets: FakeWs[] = [];
  const logs: SubscriptionLog[] = [];
  const states: boolean[] = [];
  const sub = new LogSubscription({
    url: "wss://example.invalid/v2/KEY",
    filter: { address: [A], topics: [["0x01", "0x02"]] },
    onLogs: (l) => logs.push(...l),
    onState: (u) => states.push(u),
    ws: (u) => {
      const s = new FakeWs(u);
      sockets.push(s);
      return s;
    },
    reconnectMs: 5,
    maxReconnectMs: 20,
    pingMs: 0,
    ...over,
  });
  return { sub, sockets, logs, states };
}

describe("LogSubscription", () => {
  test("subscribes on open; up once the id arrives; only its own notifications are delivered", () => {
    const { sub, sockets, logs, states } = setup();
    sub.start();
    const ws = sockets[0]!;
    expect(ws.url).toBe("wss://example.invalid/v2/KEY");
    ws.open();
    expect(ws.sent).toEqual([{ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", { address: [A], topics: [["0x01", "0x02"]] }] } as never]);
    expect(sub.up).toBe(false);
    ws.reply(1, "0xsub1");
    expect(sub.up).toBe(true);
    expect(states).toEqual([true]);
    ws.notify("0xsub1", rawLog(A, 42));
    ws.notify("0xother", rawLog(A, 43));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ address: A, blockNumber: 42n, logIndex: 2, removed: false });
    expect(sub.subscribes).toBe(1);
    sub.stop();
    expect(ws.closed).toBe(true);
    expect(states).toEqual([true, false]);
  });

  test("a closed socket is down at once and reconnects with backoff, then resubscribes", async () => {
    const { sub, sockets, states } = setup();
    sub.start();
    sockets[0]!.open();
    sockets[0]!.reply(1, "0xs");
    sockets[0]!.emit("close");
    expect(sub.up).toBe(false);
    await tick(15);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.reply(sockets[1]!.sent[0]!.id, "0xs2");
    expect(sub.up).toBe(true);
    expect(states).toEqual([true, false, true]);
    sub.stop();
  });

  test("an eth_subscribe refusal (no logs subscriptions on this endpoint) is down + retry, never up", async () => {
    const { sub, sockets, states } = setup();
    sub.start();
    sockets[0]!.open();
    sockets[0]!.emit("message", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }));
    expect(sub.up).toBe(false);
    expect(sockets[0]!.closed).toBe(true);
    await tick(15);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(states).toEqual([]);
    sub.stop();
  });

  test("setFilter resubscribes (down, then up: the consumer catches up); an unchanged filter is a no-op", () => {
    const { sub, sockets, states } = setup();
    sub.start();
    const ws = sockets[0]!;
    ws.open();
    ws.reply(1, "0xs1");
    sub.setFilter({ address: [A], topics: [["0x01", "0x02"]] });
    expect(ws.sent).toHaveLength(1);
    sub.setFilter({ address: [A, B], topics: [["0x01", "0x02"]] });
    expect(ws.sent.map((m) => m.method)).toEqual(["eth_subscribe", "eth_unsubscribe", "eth_subscribe"]);
    expect(ws.sent[1]!.params).toEqual(["0xs1"]);
    expect(sub.up).toBe(false);
    ws.reply(ws.sent[2]!.id, "0xs2");
    expect(states).toEqual([true, false, true]);
    sub.stop();
  });

  test("no address to watch: connected but never subscribed (the consumer keeps polling)", () => {
    const { sub, sockets } = setup({ filter: { address: [] } });
    sub.start();
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([]);
    sub.setFilter({ address: [A] });
    expect(sockets[0]!.sent.map((m) => m.method)).toEqual(["eth_subscribe"]);
    sub.stop();
  });

  test("ping frames keep it alive; silence (no pong, no message) reconnects", async () => {
    const { sub, sockets } = setup({ pingMs: 5, silenceMs: 12 });
    sub.start();
    sockets[0]!.open();
    sockets[0]!.reply(1, "0xs");
    await tick(8);
    expect(sockets[0]!.pings).toBeGreaterThanOrEqual(1);
    sockets[0]!.emit("pong");
    await tick(30);
    expect(sockets[0]!.closed).toBe(true); // no pong since: presumed dead
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    sub.stop();
  });

  test("parseSubscriptionLog and deriveWsUrl", () => {
    expect(parseSubscriptionLog({ nope: 1 })).toBeNull();
    expect(parseSubscriptionLog({ ...rawLog(A, 1), removed: true })?.removed).toBe(true);
    expect(deriveWsUrl("https://robinhood-mainnet.g.alchemy.com/v2/KEY")).toBe("wss://robinhood-mainnet.g.alchemy.com/v2/KEY");
    expect(deriveWsUrl("https://api-robinhood-mainnet-archive.n.dwellir.com/KEY")).toBeNull(); // unknown provider: override needed
    expect(deriveWsUrl("https://api-robinhood-mainnet-archive.n.dwellir.com/KEY", "wss://x.example/KEY")).toBe("wss://x.example/KEY");
    expect(deriveWsUrl("http://127.0.0.1:8547")).toBeNull();
    expect(deriveWsUrl(undefined)).toBeNull();
    expect(deriveWsUrl("https://evil-alchemy.com.example.org/k")).toBeNull();
  });
});
