// Kill sequence ordering + idempotency with recording fakes.
import { describe, expect, test } from "bun:test";
import { RECEIPT_KIND, VENUE, usd } from "@bookrunner/shared";
import { stringToHex } from "viem";
import { newKillJournal } from "../src/domain/transitions";
import { type KillContext, type KillPorts, finalActions, runKillSequence } from "../src/kill/sequence";
import type { BookRef, KillJournal } from "../src/types";
import { NVDA_TOKEN, OTHER_ADDR, type World, holding, makeRef, makeWorld, settings, silentLog } from "./fakes";

const journal = (breaches = ["INVENTORY"]): KillJournal => newKillJournal({ id: "1-1790000000", breaches }, { state: "breach" }, 1_790_000_000);

const ctx = (ref: BookRef, over: Partial<KillContext> = {}): KillContext => ({
  ref,
  netExposureUsd: 0n,
  deskHedgeUsd: usd(19_000),
  settings: settings(),
  log: silentLog,
  ...over,
});

const ports = (w: World, venue: KillPorts["venue"] = w.venue): KillPorts => ({
  chain: w.chain,
  store: w.store,
  bus: w.bus,
  queue: w.queue,
  venue,
  clock: w.clock,
  sleep: async () => {},
});

const without = (calls: string[], prefix: string) => calls.filter((c) => !c.startsWith(prefix));

describe("kill sequence ordering", () => {
  test("Orderly book: broadcast -> cancel-all -> flatten -> revoke venue key -> mandate.kill -> records", async () => {
    const w = makeWorld({ holdings: [holding(NVDA_TOKEN, 100, 190)] });
    const ref = makeRef(1, VENUE.ORDERLY);
    const res = await runKillSequence(journal(), ctx(ref), ports(w));
    expect(res.complete).toBe(true);
    const nvda = holding(NVDA_TOKEN, 100, 190);
    expect(w.calls).toEqual([
      "bus.publishKill",
      "venue.cancelAll",
      `chain.flatten:${NVDA_TOKEN}:${nvda.qtyRaw}:${usd(18_810)}`,
      `store.insertReceipt:${RECEIPT_KIND.HEDGE}`,
      "queue.enqueue:revoke_key",
      "chain.mandateKill:INVENTORY",
      "store.insertKillEvent",
      `store.insertReceipt:${RECEIPT_KIND.DECISION}`,
      "store.insertEvent:kill.executed",
      "bus.publishDomainEvent:kill.executed",
    ]);
    // venue ops job + kill broadcast payloads
    expect([...w.queue.jobs.values()]).toEqual([{ kind: "revoke_key", bookId: 1 }]);
    expect(w.bus.published.find((p) => p.channel === "kill:1")?.msg).toMatchObject({ bookId: 1, reason: "INVENTORY", breaches: ["INVENTORY"] });
    // records
    const ke = w.store.db.killEvents[0];
    expect(ke?.actions).toEqual(["kill_broadcast", "cancel_all", `flatten:${NVDA_TOKEN.toLowerCase()}`, "revoke_venue_key", "mandate_kill", "revoke_desk_keys"]);
    expect(ke?.txHashes).toHaveLength(2); // flatten + kill
    expect(res.journal.killTx).toBe(w.chain.state.killLogs[0]?.txHash ?? null);
    const ev = w.store.db.events[0];
    expect(ev?.type).toBe("kill.executed");
    expect(ev?.dedupeKey).toBe(`kill.executed:1:${res.journal.killTx?.toLowerCase()}`);
    expect(ev?.payload).toMatchObject({ bookId: 1, reason: "INVENTORY" });
    const decision = w.store.db.receipts.find((r) => r.kind === RECEIPT_KIND.DECISION);
    expect(decision?.payload).toMatchObject({ type: "kill", bookId: 1, reason: "INVENTORY" });
    expect(decision?.hourStart.getTime()).toBe(Math.floor(w.clock.t / 60_000) * 60_000);
    expect(w.store.db.hedges[0]).toMatchObject({ asset: NVDA_TOKEN.toLowerCase(), qtyRaw: (-nvda.qtyRaw).toString(), venue: "UNIV3" });
  });

  test("engine book: no venue client -> reduce-only on the adapter, no venue key job", async () => {
    const w = makeWorld({ holdings: [holding(NVDA_TOKEN, 10, 190)] });
    const ref = makeRef(3, VENUE.POOL_ENGINE);
    const res = await runKillSequence(journal(["DRAWDOWN", "SKEW"]), ctx(ref), ports(w, null));
    expect(res.complete).toBe(true);
    expect(without(w.calls, "store.insertReceipt:2")).toEqual([
      "bus.publishKill",
      "chain.setReduceOnly",
      expect.stringContaining("chain.flatten:") as unknown as string,
      "chain.mandateKill:DRAWDOWN",
      "store.insertKillEvent",
      `store.insertReceipt:${RECEIPT_KIND.DECISION}`,
      "store.insertEvent:kill.executed",
      "bus.publishDomainEvent:kill.executed",
    ]);
    expect(w.queue.jobs.size).toBe(0);
    expect(res.journal.actions.slice(0, 3)).toEqual(["kill_broadcast", "cancel_all:engine_reduce_only", "reduce_only"]);
    expect(res.journal.txHashes).toHaveLength(3); // reduce-only + flatten + kill
  });

  test("net-mode flatten never sells a hedge that offsets venue exposure", async () => {
    const w = makeWorld({ holdings: [holding(NVDA_TOKEN, 100, 190)] });
    const res = await runKillSequence(journal(), ctx(makeRef(), { netExposureUsd: usd(-20_000), deskHedgeUsd: usd(19_000) }), ports(w));
    expect(w.calls.some((c) => c.startsWith("chain.flatten"))).toBe(false);
    expect(res.journal.actions).toContain("flatten:none");
  });
});

describe("kill sequence idempotency", () => {
  test("a complete journal is a no-op", async () => {
    const w = makeWorld();
    const first = await runKillSequence(journal(), ctx(makeRef()), ports(w));
    const n = w.calls.length;
    const again = await runKillSequence(first.journal, ctx(makeRef()), ports(w));
    expect(again.complete).toBe(true);
    expect(w.calls.length).toBe(n);
    expect(w.store.db.killEvents).toHaveLength(1);
  });

  test("mandate.kill failure aborts the run; resuming never repeats completed steps", async () => {
    const w = makeWorld({ holdings: [holding(NVDA_TOKEN, 100, 190)] });
    w.chain.state.failMandateKill = 2; // both attempts of the first run fail
    const ref = makeRef();
    const r1 = await runKillSequence(journal(), ctx(ref), ports(w));
    expect(r1.complete).toBe(false);
    expect(r1.error).toContain("mandate_kill");
    expect(r1.journal.done).toEqual(["broadcast", "cancel_all", "reduce_only", "flatten", "revoke_venue_key"]);
    expect(w.store.db.killEvents).toHaveLength(0);

    const before = w.calls.length;
    const r2 = await runKillSequence(r1.journal, ctx(ref), ports(w));
    expect(r2.complete).toBe(true);
    expect(w.calls.slice(before)).toEqual([
      "chain.mandateKill:INVENTORY",
      "store.insertKillEvent",
      `store.insertReceipt:${RECEIPT_KIND.DECISION}`,
      "store.insertEvent:kill.executed",
      "bus.publishDomainEvent:kill.executed",
    ]);
    expect(w.calls.filter((c) => c === "bus.publishKill")).toHaveLength(1);
    expect(w.calls.filter((c) => c.startsWith("chain.flatten"))).toHaveLength(1);
  });

  test("already killed on-chain (book drawdown kill at mark raced us): no second mandate.kill", async () => {
    const w = makeWorld();
    w.chain.state.killed = true;
    w.chain.state.killLogs.push({ txHash: "0xfeed", reason: stringToHex("DRAWDOWN", { size: 32 }), by: OTHER_ADDR, blockNumber: 7n });
    const res = await runKillSequence(journal(), ctx(makeRef()), ports(w));
    expect(res.complete).toBe(true);
    expect(w.calls.some((c) => c.startsWith("chain.mandateKill"))).toBe(false);
    expect(res.journal.actions).toContain("mandate_kill:already_killed");
    expect(res.journal.killTx).toBe("0xfeed");
    expect(w.store.db.events[0]?.dedupeKey).toBe("kill.executed:1:0xfeed");
  });

  test("best-effort steps fail without blocking the on-chain kill and are recorded as failed", async () => {
    const w = makeWorld();
    w.venue.failCancel = 99;
    const res = await runKillSequence(journal(), ctx(makeRef()), ports(w));
    expect(res.complete).toBe(true);
    expect(w.calls).toContain("chain.mandateKill:INVENTORY");
    expect(finalActions(res.journal)).toContain("cancel_all:failed");
    expect(w.store.db.killEvents[0]?.actions).toContain("cancel_all:failed");
  });

  test("a failed record step resumes without duplicating kill_events / receipts; the event is published once", async () => {
    const w = makeWorld();
    w.store.db.failInsertEvent = 2;
    const r1 = await runKillSequence(journal(), ctx(makeRef()), ports(w));
    expect(r1.complete).toBe(false);
    expect(r1.journal.done).toContain("record_receipt");
    const r2 = await runKillSequence(r1.journal, ctx(makeRef()), ports(w));
    expect(r2.complete).toBe(true);
    expect(w.store.db.killEvents).toHaveLength(1);
    expect(w.store.db.receipts.filter((r) => r.kind === RECEIPT_KIND.DECISION)).toHaveLength(1);
    expect(w.store.db.events).toHaveLength(1);
    expect(w.calls.filter((c) => c === "bus.publishDomainEvent:kill.executed")).toHaveLength(1);
  });

  test("the venue key job is enqueued with a per-episode job id (BullMQ dedupe)", async () => {
    const w = makeWorld();
    const j = journal();
    await runKillSequence(j, ctx(makeRef()), ports(w));
    expect([...w.queue.jobs.keys()]).toEqual([`revoke_key-1-${j.episodeId}`]);
  });
});
