// Committee upkeep with fakes: seats mirrored, deadline notices, and the tryFinalize sweep over
// Filed charters (approvals already sufficient when the verdict lands, or deferred by newBooksPaused).
import { describe, expect, test } from "bun:test";
import { createLogger } from "@bookrunner/shared";
import type { Address } from "viem";
import type { EventBus } from "../src/adapters/events";
import { type CommitteeChain, type CommitteeStore, syncCommittee } from "../src/committee/upkeep";

const M = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const logger = createLogger("upkeep-test", "silent");

function world(decidable: Set<number>) {
  const calls: number[] = [];
  const chain: CommitteeChain = {
    committee: async () => ({ members: [M(0xa8), M(0xa9), M(0xaa)], bonded: [true, true, true], committeeBondBkrn: 250_000n, committeeWindowSec: 172_800 }),
    tryFinalize: async (id) => {
      calls.push(id);
      if (id === 6) throw new Error("rpc hiccup");
      if (!decidable.has(id)) return { finalized: false, tx: null };
      decidable.delete(id);
      return { finalized: true, tx: `0x${"11".repeat(32)}` };
    },
  };
  const store: CommitteeStore = {
    upsertSeat: async () => {},
    unseatAllExcept: async () => {},
    filedCharters: async () => [
      { id: 4, filedAt: new Date("2026-10-01T00:00:00Z") },
      { id: 5, filedAt: new Date("2026-10-02T00:00:00Z") },
      { id: 6, filedAt: new Date("2026-10-02T00:00:00Z") },
    ],
  };
  const emitted: string[] = [];
  const bus = { emit: async (e: { dedupeKey: string }) => (emitted.push(e.dedupeKey), true) } as unknown as EventBus;
  return { chain, store, bus, calls, emitted };
}

describe("syncCommittee", () => {
  test("sweeps Filed charters with tryFinalize; a decided charter gets no deadline notice", async () => {
    const w = world(new Set([4]));
    // charter 4: filed 47h+ ago, approvals were cast before the verdict -> decided by the sweep
    const now = new Date("2026-10-02T23:30:00Z");
    const r = await syncCommittee({ chain: w.chain, store: w.store, bus: w.bus, warnSec: 6 * 3600, now, logger });
    expect(w.calls).toEqual([4, 5, 6]); // 6 throws: logged, retried next sync, never stops the sweep
    expect(r.finalized).toEqual([4]);
    expect(w.emitted.some((k) => k.endsWith(":4"))).toBe(false);
    // next sync: nothing left to decide
    const again = await syncCommittee({ chain: w.chain, store: w.store, bus: w.bus, warnSec: 6 * 3600, now, logger });
    expect(again.finalized).toEqual([]);
  });
});

describe("deadline notices follow the on-chain decision deadline (audit 2026-10 D)", () => {
  test("a window changed after filing does not move a charter's deadline", async () => {
    const w = world(new Set());
    // the config window was shortened to 24h after charters 5 / 6 were filed with 48h: on-chain they still
    // close at filedAt + 48h (MarketCharter.decisionDeadline), so no window_elapsed notice at +30h
    w.chain.committee = async () => ({ members: [M(0xa8), M(0xa9), M(0xaa)], bonded: [true, true, true], committeeBondBkrn: 250_000n, committeeWindowSec: 86_400 });
    w.chain.decisionDeadline = async (id) => {
      const filed = id === 4 ? "2026-10-01T00:00:00Z" : "2026-10-02T00:00:00Z";
      return Math.floor(new Date(filed).getTime() / 1000) + 172_800;
    };
    const now = new Date("2026-10-03T06:00:00Z");
    await syncCommittee({ chain: w.chain, store: w.store, bus: w.bus, warnSec: 6 * 3600, now, logger });
    expect(w.emitted).toContain("committee.window_elapsed:4"); // 4 closed at 10-03 00:00
    expect(w.emitted.filter((k) => k.endsWith(":5") || k.endsWith(":6"))).toEqual([]); // 5/6 close at 10-04 00:00
  });

  test("falls back to filedAt + the current window when the deadline cannot be read", async () => {
    const w = world(new Set());
    w.chain.decisionDeadline = async () => {
      throw new Error("old MarketCharter without decisionDeadline");
    };
    const now = new Date("2026-10-03T23:00:00Z");
    await syncCommittee({ chain: w.chain, store: w.store, bus: w.bus, warnSec: 6 * 3600, now, logger });
    expect(w.emitted).toContain("committee.window_elapsed:4");
    expect(w.emitted).toContain("committee.deadline_approaching:5");
  });
});
