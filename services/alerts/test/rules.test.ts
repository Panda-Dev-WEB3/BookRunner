import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import {
  apiHealth,
  backup,
  balances,
  buyback,
  buybackStuck,
  evaluate,
  indexerLag,
  infra,
  killEvents,
  killJournal,
  markOverdue,
  processes,
  riskStale,
  riskState,
  rpc,
  venueReportAge,
} from "../src/rules";
import { NOW, NOW_S, book, rules, snap, supervisor } from "./fixtures";

const keys = (cs: Array<{ key: string }>) => cs.map((c) => c.key);

describe("healthy snapshot", () => {
  test("no rule fires", () => {
    expect(evaluate(snap(), rules())).toEqual([]);
  });
});

describe("mark_overdue", () => {
  test("within interval + grace: quiet (testnet 3600 s + 900 s)", () => {
    expect(markOverdue(snap({ books: [book({ lastMarkPeriodEnd: NOW_S - 4_500 })] }), rules())).toEqual([]);
  });
  test("past interval + grace: warning, then critical after a whole extra period", () => {
    const w = markOverdue(snap({ books: [book({ lastMarkPeriodEnd: NOW_S - 4_501 })] }), rules());
    expect(keys(w)).toEqual(["mark_overdue:3"]);
    expect(w[0]!.severity).toBe("warning");
    expect(w[0]!.summary).toContain("book 3 NVDA");
    const c = markOverdue(snap({ books: [book({ lastMarkPeriodEnd: NOW_S - 8_200 })] }), rules());
    expect(c[0]!.severity).toBe("critical");
  });
  test("never marked: measured from when the book went live", () => {
    expect(markOverdue(snap({ books: [book({ lastMarkPeriodEnd: null, liveSince: NOW_S - 600 })] }), rules())).toEqual([]);
    expect(keys(markOverdue(snap({ books: [book({ lastMarkPeriodEnd: null, liveSince: NOW_S - 5_000 })] }), rules()))).toEqual(["mark_overdue:3"]);
  });
  test("books that are not marked (Subscription, Retired, Cancelled) never alert", () => {
    for (const state of ["Subscription", "Retired", "Cancelled"]) expect(markOverdue(snap({ books: [book({ state, lastMarkPeriodEnd: NOW_S - 100_000 })] }), rules())).toEqual([]);
  });
  test("per-network grace and the on-chain interval (mainnet: daily + 1 h)", () => {
    const s = snap({ markIntervalSec: 86_400, books: [book({ lastMarkPeriodEnd: NOW_S - 86_400 - 3_000 })] });
    expect(markOverdue(s, rules({ markGraceSec: 3600 }))).toEqual([]);
    expect(keys(markOverdue(s, rules({ markGraceSec: 900 })))).toEqual(["mark_overdue:3"]);
  });
  test("DB unreadable: skipped (infra rule reports it)", () => {
    expect(markOverdue(snap({ books: null }), rules())).toEqual([]);
  });
});

describe("risk_state / kill journal / kill events / risk_stale", () => {
  const risk = (r: Partial<NonNullable<ReturnType<typeof book>["risk"]>>) => book({ risk: { ...book().risk!, ...r } });
  test("breach = critical with the breached limits", () => {
    const c = riskState(snap({ books: [risk({ state: "breach", breaches: ["INVENTORY", "DRAWDOWN"] })] }), rules());
    expect(keys(c)).toEqual(["risk_breach:3"]);
    expect(c[0]!.severity).toBe("critical");
    expect(c[0]!.summary).toContain("INVENTORY, DRAWDOWN");
  });
  test("killed mandate (state or meta flag) = mandate_killed, not a breach", () => {
    expect(keys(riskState(snap({ books: [risk({ state: "killed" })] }), rules()))).toEqual(["mandate_killed:3"]);
    expect(keys(riskState(snap({ books: [risk({ state: "breach", killed: true, killReason: "HEDGE_BAND" })] }), rules()))).toEqual(["mandate_killed:3"]);
  });
  test("warn / reduce_only only with ALERT_RISK_WARN", () => {
    const s = snap({ books: [risk({ state: "warn" })] });
    expect(riskState(s, rules())).toEqual([]);
    expect(keys(riskState(s, rules({ riskWarn: true })))).toEqual(["risk_warn:3"]);
  });
  test("open kill journal: in progress (one-off), then stuck when a step failed or it runs long", () => {
    const j = { episodeId: "e1", mode: "breach", startedAt: NOW_S - 30, reason: "DRAWDOWN", done: ["cancel_all"], failed: {} };
    const running = killJournal(snap({ books: [risk({ journal: j })] }), rules());
    expect(keys(running)).toEqual(["kill_in_progress:3:e1"]);
    expect(running[0]!.notifyResolve).toBe(false);
    expect(keys(killJournal(snap({ books: [risk({ journal: { ...j, failed: { flatten: 2 } } })] }), rules()))).toEqual(["kill_stuck:3:e1"]);
    expect(keys(killJournal(snap({ books: [risk({ journal: { ...j, startedAt: NOW_S - 700 } })] }), rules()))).toEqual(["kill_stuck:3:e1"]);
  });
  test("each kill_events row is one one-off alert", () => {
    const c = killEvents(snap({ kills: [{ id: 9, bookId: 3, ts: NOW - 1000, reason: "HEDGE_BAND", breaches: ["HEDGE_BAND"] }] }), rules());
    expect(keys(c)).toEqual(["kill_event:9"]);
    expect(c[0]!.notifyResolve).toBe(false);
    expect(c[0]!.summary).toContain("book 3 NVDA");
  });
  test("risk state missing or older than the limit on a live book", () => {
    expect(keys(riskStale(snap({ books: [book({ risk: null })] }), rules()))).toEqual(["risk_stale:3"]);
    expect(keys(riskStale(snap({ books: [risk({ ts: NOW - 301_000 })] }), rules()))).toEqual(["risk_stale:3"]);
    expect(riskStale(snap({ books: [risk({ ts: NOW - 299_000 })] }), rules())).toEqual([]);
    expect(riskStale(snap({ books: [book({ state: "Subscription", risk: null })] }), rules())).toEqual([]);
  });
});

describe("venue_report_stale", () => {
  test("orderly live book: too old or missing", () => {
    expect(keys(venueReportAge(snap({ books: [book({ venueReportAsOf: NOW_S - 901 })] }), rules()))).toEqual(["venue_report_stale:3"]);
    expect(keys(venueReportAge(snap({ books: [book({ venueReportAsOf: null })] }), rules()))).toEqual(["venue_report_stale:3"]);
    expect(venueReportAge(snap({ books: [book({ venueReportAsOf: NOW_S - 899 })] }), rules())).toEqual([]);
  });
  test("pool-engine books have no venue report", () => {
    expect(venueReportAge(snap({ books: [book({ venue: "pool_engine", venueReportAsOf: null })] }), rules())).toEqual([]);
  });
});

describe("processes (supervisor heartbeat)", () => {
  const proc = (p: Partial<ReturnType<typeof supervisor>["procs"][number]>) => supervisor({ procs: [{ ...supervisor().procs[0]!, ...p }] });
  test("no heartbeat: supervisor_missing; Redis unreadable (undefined): nothing here", () => {
    expect(keys(processes(snap({ supervisor: null }), rules()))).toEqual(["supervisor_missing"]);
    expect(processes(snap({ supervisor: undefined }), rules())).toEqual([]);
  });
  test("stale heartbeat (> 90 s)", () => {
    expect(keys(processes(snap({ supervisor: supervisor({ ts: NOW - 120_000 }) }), rules()))).toEqual(["supervisor_missing"]);
  });
  test("a single crash that was restarted: warning process_exit for the exit window", () => {
    const c = processes(snap({ supervisor: proc({ exits: 1, recentExits: [NOW - 60_000], lastExitCode: 1, lastExitAt: NOW - 60_000 }) }), rules());
    expect(keys(c)).toEqual(["process_exit:mark"]);
    expect(c[0]!.severity).toBe("warning");
    expect(processes(snap({ supervisor: proc({ exits: 1, recentExits: [NOW - 700_000], lastExitCode: 1, lastExitAt: NOW - 700_000 }) }), rules())).toEqual([]);
  });
  test("crash loop: >= 3 exits in 15 min = critical", () => {
    const exits = [NOW - 600_000, NOW - 300_000, NOW - 30_000];
    const c = processes(snap({ supervisor: proc({ state: "backoff", exits: 3, recentExits: exits, lastExitCode: 1, lastExitAt: NOW - 30_000 }) }), rules());
    expect(keys(c)).toEqual(["process_crashloop:mark"]);
    expect(c[0]!.severity).toBe("critical");
  });
  test("exited and not restarted: process_down; clean exits and one-shot jobs are fine", () => {
    expect(keys(processes(snap({ supervisor: proc({ state: "exited", exits: 1, recentExits: [NOW - 1000], lastExitCode: 137, lastExitAt: NOW - 1000 }) }), rules()))).toEqual(["process_down:mark"]);
    expect(processes(snap({ supervisor: proc({ state: "exited", exits: 1, recentExits: [NOW - 1000], lastExitCode: 0, lastExitAt: NOW - 1000 }) }), rules())).toEqual([]);
    expect(processes(snap({ supervisor: proc({ name: "launch", oneShot: true, state: "exited", exits: 1, recentExits: [NOW - 1000], lastExitCode: 1 }) }), rules())).toEqual([]);
  });
});

describe("balances", () => {
  const bal = (role: string, eth: string | null) => ({ role, address: "0x00000000000000000000000000000000000000aa", wei: eth === null ? null : parseEther(eth) });
  test("role key below its testnet minimum (half the gas-keeper trigger)", () => {
    expect(keys(balances(snap({ balances: [bal("markSigner", "0.0014")] }), rules()))).toEqual(["role_balance_low:markSigner"]);
    expect(balances(snap({ balances: [bal("markSigner", "0.0016")] }), rules())).toEqual([]);
  });
  test("critical below a quarter of the minimum", () => {
    expect(balances(snap({ balances: [bal("markSigner", "0.0001")] }), rules())[0]!.severity).toBe("critical");
  });
  test("unknown roles use the * default; failed reads are ignored", () => {
    expect(keys(balances(snap({ balances: [bal("someRole", "0.0001")] }), rules()))).toEqual(["role_balance_low:someRole"]);
    expect(balances(snap({ balances: [bal("markSigner", null)] }), rules())).toEqual([]);
  });
  test("gas funder: its own threshold (0.1 ETH on testnet)", () => {
    const c = balances(snap({ balances: [bal("funder", "0.05")] }), rules());
    expect(keys(c)).toEqual(["funder_low:funder"]);
    expect(c[0]!.summary).toContain("refills stop");
    expect(balances(snap({ balances: [bal("funder", "0.2")] }), rules())).toEqual([]);
  });
});

describe("rpc", () => {
  const samples = (pattern: number[]) => pattern.map((value, i) => ({ ts: NOW - (pattern.length - i) * 60_000, value }));
  test("error rate >= 50% over >= 4 probes", () => {
    expect(keys(rpc(snap({ rpcSamples: samples([1, 0, 1, 0]) }), rules()))).toEqual(["rpc_errors"]);
    expect(rpc(snap({ rpcSamples: samples([1, 1, 1, 0]) }), rules())).toEqual([]);
    expect(rpc(snap({ rpcSamples: samples([0, 0, 0]) }), rules())).toEqual([]); // too few samples
  });
  test("every probe failing = critical", () => {
    expect(rpc(snap({ rpc: { ok: false, head: null, headTs: null, error: "timeout" }, rpcSamples: samples([0, 0, 0, 0, 0]) }), rules())[0]!.severity).toBe("critical");
  });
  test("lagging head", () => {
    expect(keys(rpc(snap({ rpc: { ok: true, head: 5, headTs: NOW_S - 601, error: null } }), rules()))).toEqual(["rpc_head_lag"]);
    expect(rpc(snap({ rpc: { ok: true, head: 5, headTs: NOW_S - 599, error: null } }), rules())).toEqual([]);
  });
});

describe("indexer_lag", () => {
  test("too many blocks behind the head", () => {
    expect(keys(indexerLag(snap({ indexer: [{ name: "indexer:books", block: 1_000_000 - 5_001, updatedAt: NOW }] }), rules()))).toEqual(["indexer_lag"]);
  });
  test("cursor stopped moving while the head moves", () => {
    expect(keys(indexerLag(snap({ indexer: [{ name: "indexer:books", block: 999_900, updatedAt: NOW - 1_000_000 }] }), rules()))).toEqual(["indexer_lag"]);
    // an idle chain (head == cursor) is not a lag
    expect(indexerLag(snap({ indexer: [{ name: "indexer:books", block: 1_000_000, updatedAt: NOW - 1_000_000 }] }), rules())).toEqual([]);
  });
});

describe("buyback", () => {
  const H = 3_600_000;
  test("buybackStuck: grows without a decrease for the whole window", () => {
    const grow = [10, 20, 40, 60, 80].map((v, i) => ({ ts: NOW - (4 - i) * 13 * H, value: v }));
    expect(buybackStuck(grow, NOW, 50, 48 * 3600).stuck).toBe(true);
    expect(buybackStuck(grow, NOW, 100, 48 * 3600).stuck).toBe(false); // below the floor
    // a buyback landed 10 h ago: the run restarts there
    const dropped = [...grow.slice(0, 4), { ts: NOW - 10 * H, value: 5 }, { ts: NOW, value: 70 }];
    expect(buybackStuck(dropped, NOW, 50, 48 * 3600).stuck).toBe(false);
    // flat (no growth) is not stuck: nothing new arrives, nothing to buy
    expect(buybackStuck([{ ts: NOW - 72 * H, value: 60 }, { ts: NOW, value: 60 }], NOW, 50, 48 * 3600).stuck).toBe(false);
  });
  test("rule: growing + absolute cap", () => {
    const grow = [60, 100, 200].map((v, i) => ({ ts: NOW - (2 - i) * 30 * H, value: v }));
    expect(keys(buyback(snap({ buybackSamples: grow }), rules()))).toEqual(["buyback_growing"]);
    expect(keys(buyback(snap({ buybackSamples: [{ ts: NOW, value: 6000 }] }), rules()))).toEqual(["buyback_high"]);
    expect(buyback(snap({ buybackSamples: [] }), rules())).toEqual([]);
  });
});

describe("api_health + infra", () => {
  test("down, wrong body, or a degraded dependency", () => {
    expect(keys(apiHealth(snap({ api: { ok: false, httpStatus: null, db: null, redis: null, error: "ECONNREFUSED" } }), rules()))).toEqual(["api_health"]);
    expect(apiHealth(snap({ api: { ok: true, httpStatus: 200, db: "down", redis: "ready", error: null } }), rules())[0]!.summary).toContain("db down");
    expect(keys(apiHealth(snap({ api: { ok: true, httpStatus: 200, db: "up", redis: "reconnecting", error: null } }), rules()))).toEqual(["api_health"]);
  });
  test("fires only after it persisted (forSec), per config", () => {
    expect(apiHealth(snap({ api: { ok: false, httpStatus: 502, db: null, redis: null, error: null } }), rules({ apiForSec: 300 }))[0]!.forSec).toBe(300);
  });
  test("collection failures", () => {
    expect(keys(infra(snap({ infraErrors: [{ source: "db", error: "x" }, { source: "redis", error: "y" }] }), rules()))).toEqual(["infra_db", "infra_redis"]);
  });
});

describe("backups", () => {
  const ok = { ts: NOW - 3_600_000, ok: true, error: "", offsite: "off", bytes: 1, dir: "/b/x" };
  test("missing, stale (> 26 h), failed, off-site failed", () => {
    expect(keys(backup(snap({ backup: null }), rules()))).toEqual(["backup_missing"]);
    expect(keys(backup(snap({ backup: { ...ok, ts: NOW - 27 * 3_600_000 } }), rules()))).toEqual(["backup_stale"]);
    const failed = backup(snap({ backup: { ...ok, ok: false, error: "pg_dump: connection refused" } }), rules());
    expect(keys(failed)).toEqual(["backup_failed"]);
    expect(failed[0]!.severity).toBe("critical");
    expect(keys(backup(snap({ backup: { ...ok, offsite: "failed" } }), rules()))).toEqual(["backup_offsite_failed"]);
    expect(backup(snap({ backup: ok }), rules())).toEqual([]);
  });
  test("not expected (devnet default) or Redis unreadable: quiet", () => {
    expect(backup(snap({ backup: null }), rules({ backupExpected: false }))).toEqual([]);
    expect(backup(snap({ backup: undefined }), rules())).toEqual([]);
    expect(rules().backupExpected).toBe(true);
  });
});

describe("evaluate", () => {
  test("ALERT_DISABLE switches off a rule group or a single condition rule", () => {
    const s = snap({ books: [book({ risk: null, venueReportAsOf: null })] });
    expect(keys(evaluate(s, rules()))).toEqual(["risk_stale:3", "venue_report_stale:3"]);
    expect(keys(evaluate(s, rules({ disabled: new Set(["venue_report_stale"]) })))).toEqual(["risk_stale:3"]);
  });
});
