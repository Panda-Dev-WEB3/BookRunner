// ChainWake: chain reads due on a notification or the safety poll while subscribed, every poll interval otherwise.
import { describe, expect, test } from "bun:test";
import { ChainWake } from "../src/chainWake";
import type { WsLike } from "../src/logSubscription";
import { rpcRoutes } from "../src/rpcRoute";

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

const ADDR = "0x0000000000000000000000000000000000000001" as const;
const logMsg = (sub: string) => JSON.stringify({ method: "eth_subscription", params: { subscription: sub, result: { address: ADDR, topics: ["0x01"], data: "0x", blockNumber: "0x10", logIndex: "0x0", transactionHash: "0x02" } } });

function rig(o: { url?: string | null } = {}) {
  const clock = { t: 1_000_000 };
  const sockets: FakeWs[] = [];
  const wake = new ChainWake({
    url: o.url === undefined ? "wss://example/ws" : o.url,
    label: "test",
    filter: () => ({ address: [ADDR] }),
    pollMs: 60_000,
    safetyMs: 300_000,
    minGapMs: 5_000,
    ws: () => {
      const w = new FakeWs();
      sockets.push(w);
      return w;
    },
    now: () => clock.t,
  });
  const up = () => {
    wake.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", JSON.stringify({ id: 1, result: "0xsub" }));
  };
  return { wake, clock, sockets, up };
}

describe("ChainWake", () => {
  test("no WebSocket: due every pollMs, exactly the polling it replaces", () => {
    const { wake, clock } = rig({ url: null });
    wake.start();
    expect(wake.subscribed).toBe(false);
    expect(wake.due()).toBe(true); // first read
    wake.begin();
    clock.t += 59_000;
    expect(wake.due()).toBe(false);
    clock.t += 1_000;
    expect(wake.due()).toBe(true);
  });

  test("subscribed: idle until a notification or the safety poll", () => {
    const { wake, clock, sockets, up } = rig();
    up();
    expect(wake.subscribed).toBe(true);
    expect(wake.due()).toBe(true); // catch-up on coming up
    wake.begin();
    clock.t += 200_000;
    expect(wake.due()).toBe(false); // far past pollMs, still idle
    sockets[0]!.emit("message", logMsg("0xsub"));
    expect(wake.due()).toBe(true);
    wake.begin();
    clock.t += 299_000;
    expect(wake.due()).toBe(false);
    clock.t += 1_000;
    expect(wake.due()).toBe(true); // safety poll
  });

  test("a busy contract costs no more than one read per minGap", () => {
    const { wake, clock, sockets, up } = rig();
    up();
    wake.begin();
    clock.t += 1_000;
    sockets[0]!.emit("message", logMsg("0xsub"));
    expect(wake.due()).toBe(false); // too soon after the last read
    clock.t += 4_000;
    expect(wake.due()).toBe(true);
  });

  test("a failed read is due again; a notification during a read is not lost", () => {
    const { wake, clock, sockets, up } = rig();
    up();
    wake.begin();
    clock.t += 10_000;
    wake.failed();
    expect(wake.due()).toBe(true);
    wake.begin();
    clock.t += 6_000;
    sockets[0]!.emit("message", logMsg("0xsub")); // arrived after begin()
    expect(wake.due()).toBe(true);
  });

  test("onWake fires on a notification and can be removed", () => {
    const { wake, sockets, up } = rig();
    up();
    let n = 0;
    const off = wake.onWake(() => n++);
    sockets[0]!.emit("message", logMsg("0xsub"));
    off();
    sockets[0]!.emit("message", logMsg("0xsub"));
    expect(n).toBe(1);
  });

  test("while the primary RPC fails it polls again (subscription down), and subscribes again after", () => {
    rpcRoutes.reset();
    const { wake, clock, sockets, up } = rig();
    up();
    wake.begin();
    clock.t += 61_000;
    expect(wake.due()).toBe(false);
    rpcRoutes.fail("p", "Alchemy", { reason: "capacity", status: 429 });
    expect(wake.subscribed).toBe(false);
    expect(wake.due()).toBe(true); // pollMs passed: polling as before
    rpcRoutes.ok("p");
    expect(sockets).toHaveLength(2);
    rpcRoutes.reset();
    wake.stop();
  });
});
