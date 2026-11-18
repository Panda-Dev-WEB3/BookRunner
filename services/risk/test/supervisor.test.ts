import { describe, expect, test } from "bun:test";
import { type BookState, type Deployment, VENUE } from "@bookrunner/shared";
import type { DbBookRow } from "../src/ports";
import { type ChainGateway, RiskSupervisor } from "../src/supervisor";
import { type World, makeRef, makeWorld, settings, silentLog } from "./fakes";

const dep = (factory = "0x00000000000000000000000000000000000000fa"): Deployment =>
  ({ chainId: 31337, startBlock: 0, contracts: { factory }, stockTokens: {}, books: [] }) as unknown as Deployment;

function gatewayFor(w: World, states: Map<number, BookState>, opts: { listFails?: boolean } = {}) {
  const loaded: number[] = [];
  const gw: ChainGateway = {
    ...w.chain,
    async listBookIds() {
      if (opts.listFails) throw new Error("factory not deployed");
      return [...states.keys()];
    },
    async loadRef(bookId: number) {
      loaded.push(bookId);
      return makeRef(bookId, bookId === 3 ? VENUE.POOL_ENGINE : VENUE.ORDERLY);
    },
    async bookState(ref) {
      const s = states.get(ref.bookId);
      if (!s) throw new Error("unknown book");
      return s;
    },
  };
  return { gw, loaded };
}

function supervisor(w: World, gwf: () => ChainGateway, over: { dep?: () => Deployment | null; bookIds?: Set<number> | null; source?: "auto" | "chain" | "db" } = {}) {
  let made = 0;
  const sup = new RiskSupervisor({
    settings: settings({ intervalMs: 60_000 }),
    log: silentLog,
    store: w.store,
    bus: w.bus,
    queue: w.queue,
    clock: w.clock,
    refreshMs: 60_000,
    bookSource: over.source ?? "auto",
    bookIds: over.bookIds ?? null,
    chainId: 31337,
    loadDeployment: over.dep ?? (() => dep()),
    makeChain: () => {
      made++;
      return gwf();
    },
    makeVenues: () => w.venues,
  });
  return { sup, made: () => made };
}

describe("RiskSupervisor", () => {
  test("idles while the deployment file is missing", async () => {
    const w = makeWorld();
    const { sup, made } = supervisor(w, () => gatewayFor(w, new Map()).gw, { dep: () => null });
    await sup.refresh();
    await sup.refresh();
    expect(made()).toBe(0);
    expect(sup.activeBookIds).toEqual([]);
  });

  test("monitors Live/Retiring books only and stops them when they leave", async () => {
    const w = makeWorld();
    const states = new Map<number, BookState>([
      [1, "Live"],
      [2, "Subscription"],
      [3, "Retiring"],
    ]);
    const { gw, loaded } = gatewayFor(w, states);
    const { sup } = supervisor(w, () => gw);
    await sup.refresh();
    expect(sup.activeBookIds).toEqual([1, 3]);
    states.set(3, "Retired");
    states.set(2, "Live");
    await sup.refresh();
    expect(sup.activeBookIds).toEqual([1, 2]);
    expect(loaded.filter((id) => id === 1)).toHaveLength(1); // refs cached
    await sup.stopAll();
    expect(sup.activeBookIds).toEqual([]);
  });

  test("a transient discovery failure keeps an already running monitor alive", async () => {
    const w = makeWorld();
    const states = new Map<number, BookState>([[1, "Live"]]);
    const { gw } = gatewayFor(w, states);
    let rpcDown = false;
    const flaky: ChainGateway = {
      ...gw,
      bookState: async (ref) => {
        if (rpcDown) throw new Error("rpc timeout");
        return gw.bookState(ref);
      },
    };
    const { sup } = supervisor(w, () => flaky);
    await sup.refresh();
    expect(sup.activeBookIds).toEqual([1]);
    rpcDown = true;
    await sup.refresh();
    expect(sup.activeBookIds).toEqual([1]); // kept alive through the failed read
    rpcDown = false;
    states.set(1, "Retired");
    await sup.refresh();
    expect(sup.activeBookIds).toEqual([]);
  });

  test("RISK_BOOK_IDS allow-list", async () => {
    const w = makeWorld();
    const { gw } = gatewayFor(w, new Map<number, BookState>([[1, "Live"], [2, "Live"]]));
    const { sup } = supervisor(w, () => gw, { bookIds: new Set([2]) });
    await sup.refresh();
    expect(sup.activeBookIds).toEqual([2]);
    await sup.stopAll();
  });

  test("falls back to the books table when BookFactory.bookIds fails", async () => {
    const w = makeWorld();
    const row = (id: number): DbBookRow => ({
      id,
      venue: 0,
      symbol: "PERP_NVDA_USDC",
      underlying: "0x",
      state: "Live",
      bookAddr: "0x1",
      seniorAddr: "0x2",
      juniorAddr: "0x3",
      vaultAddr: "0x4",
      mandateAddr: "0x5",
      routerAddr: "0x6",
      deskAddr: "0x7",
      adapterAddr: "0x8",
    });
    w.store.liveBooks = async () => [row(7)];
    const { gw } = gatewayFor(w, new Map<number, BookState>([[7, "Live"]]), { listFails: true });
    const { sup } = supervisor(w, () => gw);
    await sup.refresh();
    expect(sup.activeBookIds).toEqual([7]);
    await sup.stopAll();
  });

  test("a changed deployment rebuilds the gateway and restarts monitors", async () => {
    const w = makeWorld();
    let current = dep("0x00000000000000000000000000000000000000fa");
    const { gw } = gatewayFor(w, new Map<number, BookState>([[1, "Live"]]));
    const { sup, made } = supervisor(w, () => gw, { dep: () => current });
    await sup.refresh();
    await sup.refresh();
    expect(made()).toBe(1);
    current = dep("0x00000000000000000000000000000000000000fb");
    await sup.refresh();
    expect(made()).toBe(2);
    expect(sup.activeBookIds).toEqual([1]);
    await sup.stopAll();
  });
});

describe("RiskSupervisor with a log subscription (RPC budget)", () => {
  class FakeWs {
    readyState = 1;
    private fns: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
    send() {}
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
  const FACTORY = "0x00000000000000000000000000000000000000fa";

  function rig(states: Map<number, BookState>) {
    const w = makeWorld();
    const sockets: FakeWs[] = [];
    let lists = 0;
    const stateReads: number[] = [];
    const base = gatewayFor(w, states).gw;
    const gw: ChainGateway = {
      ...base,
      async listBookIds() {
        lists++;
        return [...states.keys()];
      },
      async bookState(ref) {
        stateReads.push(ref.bookId);
        return base.bookState(ref);
      },
    };
    const sup = new RiskSupervisor({
      settings: settings({ intervalMs: 60_000 }),
      log: silentLog,
      store: w.store,
      bus: w.bus,
      queue: w.queue,
      clock: w.clock,
      refreshMs: 60_000,
      bookSource: "auto",
      bookIds: null,
      chainId: 31337,
      loadDeployment: () => dep(FACTORY),
      makeChain: () => gw,
      makeVenues: () => w.venues,
      wake: {
        wsUrl: "wss://example/ws",
        safetyMs: 300_000,
        ws: () => {
          const s = new FakeWs();
          sockets.push(s);
          return s as never;
        },
      },
    });
    const up = () => {
      sockets[0]!.emit("open");
      sockets[0]!.emit("message", JSON.stringify({ id: 1, result: "0xsub" }));
    };
    return { w, sup, sockets, up, lists: () => lists, stateReads };
  }

  test("idle between notifications: no factory listing and no state read of monitored books; unmonitored books still checked", async () => {
    const states = new Map<number, BookState>([
      [1, "Live"],
      [2, "Subscription"],
    ]);
    const r = rig(states);
    await r.sup.refresh(); // first pass: everything is read
    r.up();
    expect(r.sup.activeBookIds).toEqual([1]);
    r.w.clock.t += 10_000;
    await r.sup.refresh(); // the subscription coming up is a catch-up read
    expect(r.lists()).toBe(2);
    r.stateReads.length = 0;
    r.w.clock.t += 60_000;
    states.set(2, "Live"); // goes Live without any log: found by the next check of the unmonitored book
    await r.sup.refresh();
    expect(r.lists()).toBe(2); // not listed again
    expect(r.stateReads).toEqual([2]); // book 1 is monitored: its monitor reads the state every tick
    expect(r.sup.activeBookIds).toEqual([1, 2]);
    await r.sup.stopAll();
  });

  test("a notification (factory / book log) makes the next refresh a full one; the safety poll too", async () => {
    const states = new Map<number, BookState>([[1, "Live"]]);
    const r = rig(states);
    await r.sup.refresh();
    r.up();
    r.w.clock.t += 10_000;
    await r.sup.refresh(); // catch-up
    r.w.clock.t += 60_000;
    await r.sup.refresh();
    expect(r.lists()).toBe(2);
    states.set(4, "Subscription"); // BookCreated
    r.sockets[0]!.emit("message", JSON.stringify({ method: "eth_subscription", params: { subscription: "0xsub", result: { address: FACTORY, topics: ["0x01"], data: "0x", blockNumber: "0x10", logIndex: "0x0", transactionHash: "0x02" } } }));
    await r.sup.refresh();
    expect(r.lists()).toBe(3);
    r.w.clock.t += 300_000;
    await r.sup.refresh();
    expect(r.lists()).toBe(4); // safety poll
    await r.sup.stopAll();
  });

  test("subscription down (or no endpoint): every refresh is full, as before", async () => {
    const states = new Map<number, BookState>([[1, "Live"]]);
    const r = rig(states);
    await r.sup.refresh(); // socket never opens: not subscribed
    r.w.clock.t += 60_000;
    await r.sup.refresh();
    expect(r.lists()).toBe(2);
    await r.sup.stopAll();
  });
});
