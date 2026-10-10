// Supervisor heartbeat: scripts/dev.ts (the process supervisor of the whole stack) publishes the state of
// every child it runs to Redis (SUPERVISOR_STATUS_KEY, short TTL, refreshed every few seconds and on every
// exit / restart). services/alerts reads it to detect exited and crash-looping services, so alerting never
// needs the log file. Pure helpers here; the Redis write itself lives in dev.ts.

export const SUPERVISOR_STATUS_KEY = "bkrn:supervisor:status";
/** dev.ts refreshes the key this often ... */
export const SUPERVISOR_PUBLISH_MS = 15_000;
/** ... and it expires after this long (a dead supervisor = a missing key). */
export const SUPERVISOR_TTL_MS = 90_000;
/** Exits older than this are dropped from a process's history. */
export const SUPERVISOR_EXIT_HISTORY_MS = 3_600_000;

export type SupervisedState = "running" | "backoff" | "exited";

export interface SupervisedProc {
  name: string;
  state: SupervisedState;
  /** unix ms of the current (or last) start */
  startedAt: number;
  /** exits since the supervisor started */
  exits: number;
  /** unix ms of the exits within SUPERVISOR_EXIT_HISTORY_MS, oldest first */
  recentExits: number[];
  lastExitCode: number | null;
  lastExitAt: number | null;
  /** one-shot jobs (launch) exit by design */
  oneShot: boolean;
}

export interface SupervisorStatus {
  v: 1;
  /** unix ms of this snapshot */
  ts: number;
  network: string;
  /** unix ms the supervisor started */
  startedAt: number;
  procs: SupervisedProc[];
}

export function newProc(name: string, now: number, oneShot = false): SupervisedProc {
  return { name, state: "running", startedAt: now, exits: 0, recentExits: [], lastExitCode: null, lastExitAt: null, oneShot };
}

/** Records an exit; `restarting` = the supervisor will start it again (backoff) rather than leave it down. */
export function recordExit(p: SupervisedProc, code: number | null, now: number, restarting: boolean): SupervisedProc {
  return {
    ...p,
    state: restarting ? "backoff" : "exited",
    exits: p.exits + 1,
    recentExits: [...p.recentExits.filter((t) => now - t < SUPERVISOR_EXIT_HISTORY_MS), now],
    lastExitCode: code,
    lastExitAt: now,
  };
}

export function recordStart(p: SupervisedProc, now: number): SupervisedProc {
  return { ...p, state: "running", startedAt: now };
}

export function supervisorStatus(network: string, startedAt: number, procs: Iterable<SupervisedProc>, now: number): SupervisorStatus {
  return {
    v: 1,
    ts: now,
    network,
    startedAt,
    procs: [...procs].map((p) => ({ ...p, recentExits: p.recentExits.filter((t) => now - t < SUPERVISOR_EXIT_HISTORY_MS) })),
  };
}

/** Tolerant parse of the Redis value (null when absent or not a v1 status). */
export function parseSupervisorStatus(raw: string | null | undefined): SupervisorStatus | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<SupervisorStatus>;
    if (o?.v !== 1 || typeof o.ts !== "number" || !Array.isArray(o.procs)) return null;
    return o as SupervisorStatus;
  } catch {
    return null;
  }
}
