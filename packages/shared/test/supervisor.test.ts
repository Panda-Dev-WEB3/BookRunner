// Supervisor heartbeat (scripts/dev.ts -> Redis -> services/alerts).
import { describe, expect, test } from "bun:test";
import { SUPERVISOR_EXIT_HISTORY_MS, newProc, parseSupervisorStatus, recordExit, recordStart, supervisorStatus } from "../src/supervisor";

const T = 1_800_000_000_000;

describe("supervisor status", () => {
  test("exit -> backoff -> start keeps the exit history", () => {
    let p = newProc("mark", T);
    p = recordExit(p, 1, T + 1000, true);
    expect(p).toMatchObject({ state: "backoff", exits: 1, recentExits: [T + 1000], lastExitCode: 1 });
    p = recordStart(p, T + 3000);
    expect(p).toMatchObject({ state: "running", startedAt: T + 3000, exits: 1 });
    expect(recordExit(p, 137, T + 5000, false).state).toBe("exited");
  });

  test("old exits are dropped from the history", () => {
    let p = recordExit(newProc("risk", T), 1, T, true);
    p = recordExit(p, 1, T + SUPERVISOR_EXIT_HISTORY_MS + 1, true);
    expect(p.recentExits).toEqual([T + SUPERVISOR_EXIT_HISTORY_MS + 1]);
    expect(p.exits).toBe(2);
  });

  test("round-trips through JSON; garbage is null", () => {
    const s = supervisorStatus("testnet", T, [newProc("api", T), newProc("launch", T, true)], T + 10);
    expect(parseSupervisorStatus(JSON.stringify(s))).toEqual(s);
    expect(parseSupervisorStatus("nope")).toBeNull();
    expect(parseSupervisorStatus(JSON.stringify({ v: 2 }))).toBeNull();
    expect(parseSupervisorStatus(null)).toBeNull();
  });
});
