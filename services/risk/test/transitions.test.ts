import { describe, expect, test } from "bun:test";
import type { LimitsSnapshot } from "@bookrunner/shared";
import { decide, isJournalComplete, newKillJournal, primaryReason } from "../src/domain/transitions";
import { type KillStep, type MonitorState, initialMonitorState } from "../src/types";
import { T0 } from "./fakes";

const snap = (state: LimitsSnapshot["state"], breaches: string[] = []): LimitsSnapshot => ({
  inventoryUtil: 0.5,
  skewUtil: 0,
  hedgeRatioBps: 8000,
  drawdownBps: 0,
  offHours: false,
  state,
  breaches,
});

const step = (state: MonitorState, s: LimitsSnapshot, killedOnChain = false, nowSec = T0, killMode: "enforce" | "alert" = "enforce", confirmTicks = 2) =>
  decide({ bookId: 1, state, snapshot: s, killedOnChain, nowSec, confirmTicks, killMode });

describe("breach confirmation and episodes", () => {
  test("first breach tick opens an unconfirmed episode; second confirms: limit.breached then kill", () => {
    const a = step(initialMonitorState(), snap("breach", ["INVENTORY"]));
    expect(a.effects).toEqual([]);
    expect(a.next.episode).toMatchObject({ id: `1-${T0}`, confirmed: false });
    expect(a.next.breachStreak).toBe(1);

    const b = step(a.next, snap("breach", ["INVENTORY", "SKEW"]), false, T0 + 2);
    expect(b.effects.map((e) => e.kind)).toEqual(["emit_breach", "run_kill"]);
    expect(b.next.episode).toMatchObject({ id: `1-${T0}`, confirmed: true, breaches: ["INVENTORY", "SKEW"] });
    expect(b.next.kill).toMatchObject({ episodeId: `1-${T0}`, mode: "breach", reason: "INVENTORY", done: [] });
  });

  test("confirmTicks=1 acts on the first observation", () => {
    const a = step(initialMonitorState(), snap("breach", ["DRAWDOWN"]), false, T0, "enforce", 1);
    expect(a.effects.map((e) => e.kind)).toEqual(["emit_breach", "run_kill"]);
  });

  test("a single glitch tick does not confirm; the streak resets", () => {
    const a = step(initialMonitorState(), snap("breach", ["INVENTORY"]));
    const b = step(a.next, snap("ok"));
    expect(b.next.episode).toBeNull();
    expect(b.next.breachStreak).toBe(0);
    const c = step(b.next, snap("breach", ["INVENTORY"]), false, T0 + 4);
    expect(c.effects).toEqual([]);
    expect(c.next.episode?.id).toBe(`1-${T0 + 4}`);
  });

  test("limit.breached is retried until notified, never re-emitted after", () => {
    const a = step(initialMonitorState(), snap("breach", ["SKEW"]), false, T0, "alert", 1);
    expect(a.effects.map((e) => e.kind)).toEqual(["emit_breach"]);
    const b = step(a.next, snap("breach", ["SKEW"]), false, T0 + 2, "alert", 1);
    expect(b.effects.map((e) => e.kind)).toEqual(["emit_breach"]); // not yet notified
    const notified: MonitorState = { ...b.next, episode: b.next.episode ? { ...b.next.episode, notified: true } : null };
    const c = step(notified, snap("breach", ["SKEW"]), false, T0 + 4, "alert", 1);
    expect(c.effects).toEqual([]);
  });

  test("alert mode never opens a kill journal", () => {
    const a = step(initialMonitorState(), snap("breach", ["INVENTORY"]), false, T0, "alert", 1);
    expect(a.next.kill).toBeNull();
    expect(a.effects.some((e) => e.kind === "run_kill")).toBe(false);
  });

  test("kill reason priority", () => {
    expect(primaryReason(["SKEW", "DRAWDOWN"])).toBe("DRAWDOWN");
    expect(primaryReason(["HEDGE_BAND", "WIDTH"])).toBe("WIDTH");
    expect(primaryReason([])).toBe("RISK");
  });
});

describe("kill journal lifecycle", () => {
  const withJournal = (done: KillStep[]): MonitorState => ({
    ...initialMonitorState(),
    episode: { id: "1-1", since: 1, breaches: ["INVENTORY"], confirmed: true, notified: true },
    kill: { ...newKillJournal({ id: "1-1", breaches: ["INVENTORY"] }, {}, 1), done },
  });

  test("an incomplete journal is resumed even if the breach cleared", () => {
    const r = step(withJournal(["broadcast", "cancel_all"]), snap("ok"));
    expect(r.effects.map((e) => e.kind)).toEqual(["run_kill"]);
  });

  test("killed on-chain with an incomplete journal: finish it (record steps)", () => {
    const r = step(withJournal(["broadcast", "cancel_all", "mandate_kill"]), snap("killed"), true);
    expect(r.effects.map((e) => e.kind)).toEqual(["run_kill"]);
  });

  test("killed on-chain, no journal, not handled: verify the follow-up", () => {
    const r = step(initialMonitorState(), snap("killed"), true);
    expect(r.effects.map((e) => e.kind)).toEqual(["check_kill_followup"]);
  });

  test("killed on-chain and handled: nothing to do (never re-run)", () => {
    const r = step({ ...initialMonitorState(), handledKill: "0xabc" }, snap("killed"), true);
    expect(r.effects).toEqual([]);
  });

  test("re-mandate (killed -> not killed) clears the handled marker and a complete journal", () => {
    const complete = withJournal([
      "broadcast",
      "cancel_all",
      "reduce_only",
      "flatten",
      "revoke_venue_key",
      "mandate_kill",
      "record_kill_event",
      "record_receipt",
      "record_event",
    ]);
    expect(complete.kill && isJournalComplete(complete.kill)).toBe(true);
    const r = step({ ...complete, handledKill: "0xabc" }, snap("ok"));
    expect(r.next.kill).toBeNull();
    expect(r.next.handledKill).toBeNull();
    expect(r.next.episode).toBeNull();
  });
});
