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
