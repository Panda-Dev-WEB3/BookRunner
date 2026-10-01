// Tick-level behaviour of BookMonitor against recording fakes.
import { describe, expect, test } from "bun:test";
import { RECEIPT_KIND, VENUE, usd } from "@bookrunner/shared";
import { stringToHex } from "viem";
import type { RiskSettings } from "../src/config";
import { runMonitorLoop } from "../src/loop";
import { BookMonitor } from "../src/monitor";
import type { BookRef, RiskStatePayload } from "../src/types";
import { NVDA_TOKEN, OTHER_ADDR, type World, chainObs, holding, makeRef, makeWorld, settings, silentLog } from "./fakes";

function monitorFor(w: World, ref: BookRef = makeRef(), s: Partial<RiskSettings> = {}) {
  return new BookMonitor(ref, {
    chain: w.chain,
    store: w.store,
    bus: w.bus,
    queue: w.queue,
    venues: w.venues,
    clock: w.clock,
    settings: settings(s),
    log: silentLog,
    sleep: async () => {},
  });
}

const advance = (w: World, ms = 2000) => {
  w.clock.t += ms;
};

const riskState = (w: World, bookId = 1) => JSON.parse(w.bus.kv.get(`risk:${bookId}`) ?? "null") as RiskStatePayload | null;

/** Venue long 60k > 50k maxInventory (adapter report path); NAV unchanged at 100k (no drawdown). */
const breachingObs = () =>
  chainObs({
    adapter: { ...chainObs().adapter, netExposureUsd: usd(60_000), deployedValueUsd: usd(100_000) },
    desk: { hedgeNotionalUsd: 0n, valueUsd: 0n },
  });

describe("outputs", () => {
  test("publishes LimitsSnapshot + meta, live NAV and a limits row (on change + every N ticks)", async () => {
    const w = makeWorld();
    const m = monitorFor(w, makeRef(), { limitsEveryTicks: 3 });
    const r = await m.tick();
    expect(r.snapshot.state).toBe("ok");
    const st = riskState(w);
    expect(st).toMatchObject({ state: "ok", breaches: [], offHours: false });
    expect(st?.meta).toMatchObject({ bookId: 1, venue: "orderly", netExposureUsd: "-20000", liveNavUsd: "100000", exposureSource: "adapter_report" });
    expect(st?.meta.mandate).toBe(makeRef().components.mandate.toLowerCase());
    expect(JSON.parse(w.bus.kv.get("nav:1") ?? "{}")).toMatchObject({ navUsd: "100000", drawdownBps: 0, source: "risk" });
    expect(w.store.db.limits).toHaveLength(1);

    for (let i = 0; i < 2; i++) {
      advance(w);
      await m.tick();
    }
    expect(w.store.db.limits).toHaveLength(1); // unchanged within N ticks
    advance(w);
    await m.tick();
    expect(w.store.db.limits).toHaveLength(2); // every N ticks

    w.chain.state.obs = chainObs({ oracle: { priceWad: 190n * 10n ** 18n, publishedAt: 1, held: true, stale: false, source: "chain" } });
    advance(w);
    await m.tick();
    expect(w.store.db.limits).toHaveLength(3); // state change -> reduce_only row
    expect(w.store.db.limits.at(-1)).toMatchObject({ state: "reduce_only", offHours: true });
  });

  test("Orderly books prefer the live venue API for exposure and MM equity", async () => {
    const w = makeWorld();
    w.venue.acct = {
      equityUsd: usd(60_000),
      freeCollateralUsd: usd(50_000),
      position: { symbol: "PERP_NVDA_USDC", netQty: 300, avgPx: 190, markPx: 200, netExposureUsd: usd(60_000), unrealizedPnlUsd: usd(3_000) },
    };
    const r = await monitorFor(w).tick();
    expect(r.snapshot.breaches).toContain("INVENTORY");
    const st = riskState(w);
    expect(st?.meta.exposureSource).toBe("venue_api");
    // NAV = insurance 25k + live MM equity 60k + desk 16k = 101k
    expect(st?.meta.liveNavUsd).toBe("101000");
  });

  test("falls back to KEYS.oracleLast when the on-chain oracle read fails", async () => {
    const w = makeWorld({ obs: chainObs({ oracle: null }) });
    w.bus.kv.set(
      "oracle:NVDA",
      JSON.stringify({ priceId: "NVDA", priceWad: (190n * 10n ** 18n).toString(), price: 190, publishedAt: Math.floor(w.clock.t / 1000), held: true }),
    );
    const r = await monitorFor(w).tick();
    expect(r.snapshot.offHours).toBe(true);
    expect(riskState(w)?.meta.oracle).toMatchObject({ source: "redis", held: true });
  });
});

describe("breach -> kill", () => {
  test("confirmed breach emits limit.breached then runs the kill sequence exactly once", async () => {
    const w = makeWorld({ obs: breachingObs(), holdings: [holding(NVDA_TOKEN, 10, 190)] });
    const m = monitorFor(w);

    const t1 = await m.tick();
    expect(t1.snapshot.state).toBe("breach");
    expect(t1.effects).toEqual([]); // not yet confirmed
    expect(riskState(w)?.state).toBe("breach"); // published immediately

    advance(w);
    const t2 = await m.tick();
    expect(t2.effects).toEqual(["emit_breach", "run_kill"]);
    expect(t2.killComplete).toBe(true);
    const order = w.calls.filter((c) => !c.startsWith(`store.insertReceipt:${RECEIPT_KIND.HEDGE}`));
    expect(order).toEqual([
      "store.insertEvent:limit.breached",
      "bus.publishDomainEvent:limit.breached",
      `store.insertReceipt:${RECEIPT_KIND.DECISION}`,
      "bus.publishKill",
      "venue.cancelAll",
      expect.stringContaining("chain.flatten:") as unknown as string,
      "queue.enqueue:revoke_key",
      "chain.mandateKill:INVENTORY",
      "store.insertKillEvent",
      `store.insertReceipt:${RECEIPT_KIND.DECISION}`,
      "store.insertEvent:kill.executed",
      "bus.publishDomainEvent:kill.executed",
    ]);
    const breachEvt = w.store.db.events.find((e) => e.type === "limit.breached");
    expect(breachEvt?.dedupeKey).toMatch(/^limit\.breached:1:1-\d+$/);
    expect(breachEvt?.payload).toMatchObject({ bookId: 1, breaches: ["INVENTORY"] });

    // chain now reports killed: classification "killed", nothing is re-run
    const n = w.calls.length;
    for (let i = 0; i < 3; i++) {
      advance(w);
      const t = await m.tick();
      expect(t.snapshot.state).toBe("killed");
      expect(t.effects).toEqual([]);
    }
    expect(w.calls.length).toBe(n);
    expect(riskState(w)?.meta).toMatchObject({ killed: true, killReason: "INVENTORY" });
  });

  test("restart after a completed kill never re-runs it (Redis state, or kill_events alone)", async () => {
    const w = makeWorld({ obs: breachingObs() });
    const m = monitorFor(w);
    await m.tick();
    advance(w);
    await m.tick();
    const n = w.calls.length;

    advance(w);
    const restarted = await monitorFor(w).tick();
    expect(restarted.effects).toEqual(["check_kill_followup"]); // verification only
    expect(w.calls.length).toBe(n);

    w.bus.kv.delete("risk:1"); // Redis wiped: derive from chain Kill log + kill_events
    advance(w);
    await monitorFor(w).tick();
    expect(w.calls.length).toBe(n);
    expect(w.store.db.killEvents).toHaveLength(1);
  });

  test("a kill interrupted after the broadcast resumes on restart from the persisted journal", async () => {
    const w = makeWorld({ obs: breachingObs() });
    w.chain.state.failMandateKill = 99;
    const m = monitorFor(w);
    await m.tick();
    advance(w);
    const t2 = await m.tick();
    expect(t2.killComplete).toBe(false);
    expect(riskState(w)?.meta.monitor.kill?.done).toEqual(["broadcast", "cancel_all", "reduce_only", "flatten", "revoke_venue_key"]);

    // process restarts; the breach has cleared meanwhile, but a started kill is always completed
    w.chain.state.failMandateKill = 0;
    w.chain.state.obs = chainObs();
    advance(w);
    const r = await monitorFor(w).tick();
    expect(r.effects).toEqual(["run_kill"]);
    expect(r.killComplete).toBe(true);
    expect(w.calls.filter((c) => c === "bus.publishKill")).toHaveLength(1);
    expect(w.calls.filter((c) => c === "venue.cancelAll")).toHaveLength(1);
    expect(w.store.db.killEvents).toHaveLength(1);
  });

  test("persisted state from another deployment is ignored", async () => {
    const w = makeWorld();
    const foreign = {
      state: "breach",
      breaches: ["INVENTORY"],
      meta: {
        mandate: "0x000000000000000000000000000000000000dead",
        monitor: { kill: { episodeId: "1-1", done: [], failed: {}, actions: [], txHashes: [], breaches: ["INVENTORY"], reason: "INVENTORY" } },
      },
    };
    w.bus.kv.set("risk:1", JSON.stringify(foreign));
    const r = await monitorFor(w).tick();
    expect(r.effects).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  test("drawdown kill from live NAV with no mark yet", async () => {
    // accounted 100k (index = high-water = 1e18 since window close), live NAV 91k -> -900 bps
    const w = makeWorld({ obs: chainObs({ adapter: { ...chainObs().adapter, deployedValueUsd: usd(75_000) } }) });
    const m = monitorFor(w, makeRef(), { breachConfirmTicks: 1 });
    const r = await m.tick();
    expect(r.snapshot.drawdownBps).toBe(-900);
    expect(r.snapshot.breaches).toEqual(["DRAWDOWN"]);
    expect(w.calls).toContain("chain.mandateKill:DRAWDOWN");
  });

  test("alert mode emits limit.breached but never kills", async () => {
    const w = makeWorld({ obs: breachingObs() });
    const m = monitorFor(w, makeRef(), { killMode: "alert", breachConfirmTicks: 1 });
    await m.tick();
    advance(w);
    await m.tick();
    expect(w.calls).toEqual(["store.insertEvent:limit.breached", "bus.publishDomainEvent:limit.breached", `store.insertReceipt:${RECEIPT_KIND.DECISION}`]);
  });

  test("a failed limit.breached write is retried next tick (once written, never again)", async () => {
    const w = makeWorld({ obs: breachingObs() });
    w.store.db.failInsertEvent = 1;
    const m = monitorFor(w, makeRef(), { killMode: "alert", breachConfirmTicks: 1 });
    await m.tick();
    expect(w.store.db.events).toHaveLength(0);
    advance(w);
    await m.tick();
    advance(w);
    await m.tick();
    expect(w.store.db.events.filter((e) => e.type === "limit.breached")).toHaveLength(1);
  });
});

describe("kills not initiated by this run", () => {
  test("book drawdown kill at mark: follow-up legs run once, no second mandate.kill", async () => {
    const w = makeWorld({ holdings: [holding(NVDA_TOKEN, 10, 190)], obs: chainObs({ desk: { hedgeNotionalUsd: usd(1_900), valueUsd: usd(1_900) }, adapter: { ...chainObs().adapter, netExposureUsd: 0n } }) });
    w.chain.state.killed = true;
    w.chain.state.killReason = stringToHex("DRAWDOWN", { size: 32 });
    w.chain.state.killLogs.push({ txHash: "0xbeef", reason: w.chain.state.killReason, by: OTHER_ADDR, blockNumber: 9n });
    const m = monitorFor(w);
    const r = await m.tick();
    expect(r.effects).toEqual(["check_kill_followup"]);
    expect(w.calls.filter((c) => !c.startsWith("store.insertReceipt:2"))).toEqual([
      "bus.publishKill",
      "venue.cancelAll",
      expect.stringContaining("chain.flatten:") as unknown as string,
      "queue.enqueue:revoke_key",
      "store.insertKillEvent",
      `store.insertReceipt:${RECEIPT_KIND.DECISION}`,
      "store.insertEvent:kill.executed",
      "bus.publishDomainEvent:kill.executed",
    ]);
    expect(w.store.db.killEvents[0]).toMatchObject({ reason: "DRAWDOWN", breaches: ["DRAWDOWN"] });
    expect(w.store.db.killEvents[0]?.actions[0]).toBe("mandate_kill:external");
    expect(w.store.db.killEvents[0]?.txHashes[0]).toBe("0xbeef");
    const n = w.calls.length;
    advance(w);
    await m.tick();
    expect(w.calls.length).toBe(n);
  });

  test("RETIRE wind-down is not treated as a risk kill", async () => {
    const w = makeWorld();
    w.chain.state.killed = true;
    w.chain.state.killReason = stringToHex("RETIRE", { size: 32 });
    const r = await monitorFor(w).tick();
    expect(r.snapshot.state).toBe("killed");
    expect(w.calls).toEqual([]);
  });

  test("engine book follow-up re-asserts reduce-only and skips the venue key job", async () => {
    const w = makeWorld();
    w.chain.state.killed = true;
    w.chain.state.killReason = stringToHex("DRAWDOWN", { size: 32 });
    w.chain.state.killLogs.push({ txHash: "0xcafe", reason: w.chain.state.killReason, by: OTHER_ADDR, blockNumber: 3n });
    await monitorFor(w, makeRef(3, VENUE.POOL_ENGINE)).tick();
    expect(w.calls).toContain("chain.setReduceOnly");
    expect(w.calls).not.toContain("queue.enqueue:revoke_key");
    expect(w.calls).not.toContain("venue.cancelAll");
  });
});

describe("runMonitorLoop", () => {
  test("survives failing ticks with backoff and stops on abort", async () => {
    let ticks = 0;
    let failures = 0;
    const ac = new AbortController();
    const fake = {
      log: silentLog,
      async tick() {
        ticks++;
        if (ticks <= 2) {
          failures++;
          throw new Error("rpc down");
        }
        if (ticks >= 4) ac.abort();
      },
    };
    await runMonitorLoop(fake, ac.signal, 1);
    expect(failures).toBe(2);
    expect(ticks).toBe(4);
  });

  test("a failing chain observation rejects the tick (the loop backs off) without side effects", async () => {
    const w = makeWorld();
    w.chain.state.observeFails = 1;
    const m = monitorFor(w);
    await expect(m.tick()).rejects.toThrow("rpc down");
    expect(w.calls).toEqual([]);
    const r = await m.tick();
    expect(r.snapshot.state).toBe("ok");
  });
});
