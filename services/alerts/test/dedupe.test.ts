import { describe, expect, test } from "bun:test";
import {
  type AlertState,
  OUTBOX_MAX,
  canSend,
  digestDue,
  emptyState,
  firing,
  markDigest,
  markSent,
  parseState,
  requeue,
  step,
  takeOutbox,
} from "../src/dedupe";
import type { Condition } from "../src/types";

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const S = 1000;
const cond = (over: Partial<Condition> = {}): Condition => ({ key: "mark_overdue:3", rule: "mark_overdue", severity: "warning", summary: "late", ...over });
const opts = { clearSec: 120 };

/** Runs passes (one list of active conditions per pass, `every` ms apart) and returns all notice kinds. */
function run(passes: Condition[][], every = 60 * S, start: AlertState = emptyState()) {
  let st = start;
  const kinds: string[] = [];
  passes.forEach((active, i) => {
    const r = step(st, active, T0 + i * every, opts);
    st = r.state;
    kinds.push(...r.notices.map((n) => `${n.kind}:${n.key}`));
  });
  return { st, kinds };
}

describe("dedupe state machine", () => {
  test("one notification per condition until it clears, then one resolved", () => {
    const c = cond();
    const { st, kinds } = run([[c], [c], [c], [], [], [], []]);
    expect(kinds).toEqual(["firing:mark_overdue:3", "resolved:mark_overdue:3"]);
    expect(st.tracked).toEqual({});
  });

  test("resolved only after it stayed clear for clearSec (flapping is absorbed)", () => {
    const c = cond();
    // active, clear 60 s, active again, clear for good
    const { kinds } = run([[c], [], [c], [], [], []]);
    expect(kinds).toEqual(["firing:mark_overdue:3", "resolved:mark_overdue:3"]);
  });

  test("resolved message carries how long it fired", () => {
    let st = step(emptyState(), [cond()], T0, opts).state;
    st = step(st, [], T0 + 600 * S, opts).state;
    const r = step(st, [], T0 + 720 * S, opts);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.kind).toBe("resolved");
    expect(r.notices[0]!.firedForMs).toBe(720 * S);
  });

  test("forSec: pending until it held long enough; a shorter blip is never notified", () => {
    const c = cond({ key: "api_health", rule: "api_health", forSec: 120 });
    expect(run([[c], [c], []]).kinds).toEqual([]); // 60 s active only
    expect(run([[c], [c], [c]]).kinds).toEqual(["firing:api_health"]); // 120 s active
  });

  test("escalation warning -> critical is notified once; de-escalation is silent", () => {
    const w = cond();
    const c = cond({ severity: "critical", summary: "very late" });
    const { kinds, st } = run([[w], [c], [c], [w]]);
    expect(kinds).toEqual(["firing:mark_overdue:3", "escalated:mark_overdue:3"]);
    expect(st.tracked["mark_overdue:3"]!.severity).toBe("warning");
  });

  test("one-off events (notifyResolve false) age out without a resolved message", () => {
    const k = cond({ key: "kill_event:9", rule: "kill_event", severity: "critical", notifyResolve: false });
    expect(run([[k], [k], [], [], [], []]).kinds).toEqual(["firing:kill_event:9"]);
  });

  test("independent keys are tracked independently", () => {
    const a = cond();
    const b = cond({ key: "risk_breach:3", rule: "risk_breach", severity: "critical" });
    const { kinds } = run([[a], [a, b], [b], [b], [b], [b]]);
    expect(kinds).toEqual(["firing:mark_overdue:3", "firing:risk_breach:3", "resolved:mark_overdue:3"]);
  });

  test("the outbox collects every notice; history keeps 24 h", () => {
    const { st } = run([[cond()], [], []], 200 * S);
    expect(st.outbox.map((n) => n.kind)).toEqual(["firing", "resolved"]);
    const later = step(st, [], T0 + 2 * 86_400 * S, opts).state;
    expect(later.history).toEqual([]);
  });

  test("the outbox is bounded", () => {
    let st = emptyState();
    for (let i = 0; i < OUTBOX_MAX + 50; i++) st = step(st, [cond({ key: `k${i}` })], T0 + i, { clearSec: 1e9 }).state;
    expect(st.outbox).toHaveLength(OUTBOX_MAX);
    expect(st.outbox[st.outbox.length - 1]!.key).toBe(`k${OUTBOX_MAX + 49}`);
  });

  test("firing() lists notified conditions, critical first", () => {
    const st = run([[cond(), cond({ key: "x", rule: "x", severity: "critical" }), cond({ key: "p", rule: "p", forSec: 600 })]]).st;
    expect(firing(st).map((t) => t.key)).toEqual(["x", "mark_overdue:3"]);
  });
});

describe("rate limit", () => {
  const rl = { minIntervalSec: 60, maxPerHour: 3 };
  const withOutbox = (st: AlertState) => step(st, [cond({ key: `k${Math.random()}` })], T0, opts).state;

  test("nothing to send with an empty outbox", () => {
    expect(canSend(emptyState(), T0, rl)).toBe(false);
  });

  test("min interval between messages, then the whole outbox goes as one batch", () => {
    let st = withOutbox(emptyState());
    expect(canSend(st, T0, rl)).toBe(true);
    const { batch, state } = takeOutbox(st);
    expect(batch).toHaveLength(1);
    st = markSent(state, T0);
    st = withOutbox(withOutbox(st));
    expect(canSend(st, T0 + 30 * S, rl)).toBe(false);
    expect(canSend(st, T0 + 60 * S, rl)).toBe(true);
    expect(takeOutbox(st).batch).toHaveLength(2);
  });

  test("hourly budget", () => {
    let st = emptyState();
    for (let i = 0; i < 3; i++) st = markSent(st, T0 + i * 120 * S);
    st = withOutbox(st);
    expect(canSend(st, T0 + 10 * 60 * S, rl)).toBe(false);
    expect(canSend(st, T0 + 61 * 60 * S, rl)).toBe(true);
  });

  test("a failed delivery is requeued in front of newer notices", () => {
    const st = withOutbox(emptyState());
    const { batch, state } = takeOutbox(st);
    const newer = withOutbox(state);
    const back = requeue(newer, batch);
    expect(back.outbox[0]).toEqual(batch[0]!);
    expect(back.outbox).toHaveLength(2);
  });
});

describe("digest + persistence", () => {
  test("due once per UTC day from the configured hour", () => {
    const st = emptyState();
    expect(digestDue(st, Date.UTC(2026, 9, 10, 7, 59), 8)).toBe(false);
    expect(digestDue(st, Date.UTC(2026, 9, 10, 8, 0), 8)).toBe(true);
    const done = markDigest(st, Date.UTC(2026, 9, 10, 8, 0));
    expect(digestDue(done, Date.UTC(2026, 9, 10, 23, 0), 8)).toBe(false);
    expect(digestDue(done, Date.UTC(2026, 9, 11, 8, 1), 8)).toBe(true);
    expect(digestDue(st, T0, null)).toBe(false);
  });

  test("state round-trips through JSON; garbage restores empty", () => {
    const st = run([[cond()]]).st;
    expect(parseState(JSON.stringify(st))).toEqual(st);
    expect(parseState("not json")).toEqual(emptyState());
    expect(parseState(JSON.stringify({ v: 2 }))).toEqual(emptyState());
    expect(parseState(null)).toEqual(emptyState());
  });

  test("a restart with the persisted state does not re-notify", () => {
    const c = cond();
    const st = parseState(JSON.stringify(run([[c]]).st));
    expect(step(st, [c], T0 + 60 * S, opts).notices).toEqual([]);
  });
});
