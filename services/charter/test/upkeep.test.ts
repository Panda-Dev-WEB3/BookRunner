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
