// One alerting pass end to end with fakes: collect -> rules -> dedupe -> delivery -> persistence.
import { describe, expect, test } from "bun:test";
import type { Deliverer } from "../src/deliver";
import type { Message } from "../src/format";
import { type Memory, emptyMemory } from "../src/collect";
import { AlertService, MEMORY_KEY, STATE_KEY, type StorePort } from "../src/service";
import type { Snapshot } from "../src/types";
import { NOW, NOW_S, book, rules, snap } from "./fixtures";

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** The fixture snapshot as seen `now`: every "fresh" timestamp moves with the clock (marks stay put). */
function shift(s: Snapshot, now: number): Snapshot {
  const dt = now - NOW;
  return {
    ...s,
    now,
    books: s.books?.map((b) => ({ ...b, risk: b.risk ? { ...b.risk, ts: b.risk.ts === null ? null : b.risk.ts + dt } : null, venueReportAsOf: b.venueReportAsOf === null ? null : b.venueReportAsOf + dt / 1000 })) ?? null,
    supervisor: s.supervisor ? { ...s.supervisor, ts: s.supervisor.ts + dt } : s.supervisor,
    rpc: { ...s.rpc, headTs: s.rpc.headTs === null ? null : s.rpc.headTs + dt / 1000 },
    indexer: s.indexer?.map((c) => ({ ...c, updatedAt: c.updatedAt + dt })) ?? null,
    backup: s.backup ? { ...s.backup, ts: s.backup.ts + dt } : s.backup,
  };
}

function harness(opts: { channels?: string[]; failDelivery?: boolean; delivery?: Partial<ConstructorParameters<typeof AlertService>[0]["delivery"]> } = {}) {
  const clock = { ms: NOW };
  let current: Snapshot = snap();
  const sent: Message[] = [];
  const kv = new Map<string, string>();
  const store: StorePort = { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) };
  const deliverer: Deliverer = {
    channels: opts.channels ?? ["webhook (json)"],
    deliver: async (m) => {
      if (opts.failDelivery) return [{ channel: "webhook", ok: false, error: "HTTP 500" }];
      sent.push(m);
      return [{ channel: "webhook", ok: true }];
    },
  };
  let pings = 0;
  const make = () =>
    new AlertService({
      collect: async (mem: Memory) => ({ snapshot: shift(current, clock.ms), memory: mem }),
      deliverer,
      store,
      log: silent,
      now: () => clock.ms,
      heartbeat: async () => {
        pings++;
        return true;
      },
      rules: rules(),
      delivery: { label: "BookRunner testnet", email: null, webhook: null, heartbeatUrl: null, minIntervalSec: 60, maxPerHour: 20, clearSec: 120, digestHourUtc: null, ...opts.delivery },
    });
  return {
    clock,
    sent,
    kv,
    pings: () => pings,
    set: (s: Snapshot) => {
      current = s;
    },
    make,
  };
}

const overdue = () => snap({ books: [book({ lastMarkPeriodEnd: NOW_S - 6000 })] });

describe("AlertService", () => {
  test("healthy: nothing sent, dead-man's switch pinged, state persisted", async () => {
    const h = harness();
    const svc = h.make();
    const r = await svc.tick();
    expect(r.conditions).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.pings()).toBe(1);
    expect(h.kv.has(STATE_KEY)).toBe(true);
    expect(h.kv.has(MEMORY_KEY)).toBe(true);
  });

  test("a condition is sent once, then once resolved", async () => {
    const h = harness();
    const svc = h.make();
    h.set(overdue());
    await svc.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.subject).toContain("[BookRunner testnet] 1 firing: mark_overdue");
    for (let i = 1; i <= 5; i++) {
      h.clock.ms = NOW + i * 60_000;
      await svc.tick();
    }
    expect(h.sent).toHaveLength(1);
    h.set(snap());
    for (let i = 6; i <= 9; i++) {
      h.clock.ms = NOW + i * 60_000;
      await svc.tick();
    }
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.text).toContain("RESOLVED mark_overdue");
  });

  test("a restart (new instance, same store) does not re-send", async () => {
    const h = harness();
    h.set(overdue());
    await h.make().tick();
    h.clock.ms += 120_000;
    await h.make().tick();
    expect(h.sent).toHaveLength(1);
  });

  test("failed delivery is retried on a later pass (nothing lost)", async () => {
    const h = harness({ failDelivery: true });
    h.set(overdue());
    const svc = h.make();
    await svc.tick();
    const st = JSON.parse(h.kv.get(STATE_KEY)!) as { outbox: unknown[] };
    expect(st.outbox).toHaveLength(1);
  });

  test("a burst of conditions is one message", async () => {
    const h = harness();
    h.set(snap({ books: [book({ lastMarkPeriodEnd: NOW_S - 6000, risk: null, venueReportAsOf: null })], api: { ok: false, httpStatus: null, db: null, redis: null, error: "down" } }));
    const svc = h.make();
    await svc.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain("mark_overdue");
    // risk_stale / venue_report_stale / api_health have forSec: they follow in one later message
    h.clock.ms += 180_000;
    await svc.tick();
    expect(h.sent).toHaveLength(2);
    for (const r of ["risk_stale", "venue_report_stale", "api_health"]) expect(h.sent[1]!.text).toContain(r);
  });

  test("no channel: logged only, still marked as handled", async () => {
    const h = harness({ channels: [] });
    h.set(overdue());
    const r = await h.make().tick();
    expect(r.state.outbox).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test("daily digest at the configured hour", async () => {
    const h = harness({ delivery: { digestHourUtc: 12 } });
    const svc = h.make();
    await svc.tick();
    expect(h.sent.map((m) => m.subject)).toEqual(["[BookRunner testnet] daily digest: all clear"]);
    h.clock.ms += 3_600_000;
    await svc.tick();
    expect(h.sent).toHaveLength(1);
  });

  test("starts from empty memory when the store has none", () => {
    expect(emptyMemory()).toEqual({ rpcSamples: [], buybackSamples: [], markIntervalSec: null });
  });
});
