// RPC budget: when the indexer steps with a log subscription (src/trigger.ts): a notification -> a step after the
// debounce, retried until the indexed range (head - confirmations) covers it; subscribed + idle -> the safety step;
// down -> INDEXER_POLL_MS, as before; up -> catch up at once.
import { describe, expect, test } from "bun:test";
import { StepTrigger } from "../src/trigger";

const settings = { pollMs: 12_000, safetyMs: 120_000, debounceMs: 1_000 };

describe("StepTrigger", () => {
  test("without a subscription: the normal poll", () => {
    const t = new StepTrigger(settings);
    expect(t.idleDelay(100n)).toBe(12_000);
    expect(t.onState(false)).toBeNull();
    expect(t.idleDelay(100n)).toBe(12_000);
  });

  test("subscribed: catch up when it comes up, then a safety step only", () => {
    const t = new StepTrigger(settings);
    expect(t.onState(true)).toBe(0);
    expect(t.idleDelay(100n)).toBe(120_000);
    // it drops: back to polling
    t.onState(false);
    expect(t.idleDelay(100n)).toBe(12_000);
  });

  test("a notification triggers a step, retried while its block is not confirmed yet", () => {
    const t = new StepTrigger(settings);
    t.onState(true);
    expect(t.onLogs([105n, null, 103n])).toBe(1_000);
    expect(t.idleDelay(104n)).toBe(1_000); // head - confirmations = 104 < 105: not indexed yet
    expect(t.idleDelay(105n)).toBe(120_000); // covered
    expect(t.idleDelay(105n)).toBe(120_000);
    expect(t.onLogs([null])).toBeNull(); // a pending (blockless) log carries no block: nothing to wait for
  });
});
