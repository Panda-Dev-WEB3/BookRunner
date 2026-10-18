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
  oracle,
  processes,
  riskStale,
  riskState,
  rpc,
  venueReportAge,
} from "../src/rules";
import { oracleDown } from "../src/collect";
import { loadConfig } from "../src/config";
import type { OracleConfirmSnap, OracleProbe, OracleSourceSnap } from "../src/types";
import { NOW, NOW_S, book, confirmOracle, rules, snap, supervisor } from "./fixtures";

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

describe("oracle sources", () => {
  const failing = (sinceMs: number, over: Partial<OracleSourceSnap> = {}): OracleSourceSnap => ({
    name: "pyth",
    kind: "pyth",
    role: "median",
    lastOkAt: NOW - 3_600_000,
    failingSince: NOW - sinceMs,
    failingTickers: ["NVDA", "TSLA"],
    lastError: "HTTP 401",
    ...over,
  });
  const withSources = (sources: OracleSourceSnap[], minSourcesProblem: string | null = null, unpublished: Array<{ priceId: string; since: number; reason: string }> = []) =>
    snap({ oracle: { ok: true, error: null, policy: "median", confirmBps: null, primaryLagBps: null, sources, confirm: [], minSourcesProblem, unpublished } });

  test("median: a lingering one-tick blip (lastErrorAt at the blip) does not age into an alert", () => {
    expect(oracle(withSources([failing(70_000, { lastErrorAt: NOW - 70_000 })]), rules())).toEqual([]);
    expect(keys(oracle(withSources([failing(70_000, { lastErrorAt: NOW })]), rules()))).toEqual(["oracle_source_failing:pyth"]);
  });

  test("any live source failing in-session tickers for more than 60 s alerts; two on the same ticker is critical", () => {
    expect(oracle(snap(), rules())).toEqual([]);
    expect(oracle(withSources([failing(59_000)]), rules())).toEqual([]);
    const c = oracle(withSources([failing(61_000)]), rules());
    expect(keys(c)).toEqual(["oracle_source_failing:pyth"]);
    expect(c[0]!.severity).toBe("warning");
    expect(c[0]!.summary).toBe(
      "oracle source pyth (pyth) failing for 61s on NVDA, TSLA (HTTP 401; last ok 2026-10-10T11:00:00.000Z): prices continue from the remaining sources while they agree, with no spare left",
    );
    const two = oracle(withSources([failing(61_000), failing(120_000, { name: "vendor", kind: "http", lastError: "timeout", failingTickers: ["TSLA"] })]), rules());
    expect(keys(two)).toEqual(["oracle_source_failing:pyth", "oracle_source_failing:vendor"]);
    expect(two.map((x) => x.severity)).toEqual(["critical", "critical"]);
    expect(two[1]!.summary).toContain("another source fails on TSLA too: below 2 sources no price is published");
    // two sources failing on DIFFERENT tickers: every ticker still has two sources -> warnings
    const apart = oracle(withSources([failing(61_000, { failingTickers: ["NVDA"] }), failing(61_000, { name: "vendor", kind: "http", failingTickers: ["TSLA"] })]), rules());
    expect(apart.map((x) => x.severity)).toEqual(["warning", "warning"]);
    expect(keys(oracle(withSources([failing(30_000)]), rules({ oracleSourceFailSec: 20 })))).toEqual(["oracle_source_failing:pyth"]);
  });

  test("a ticker without a publishable price in session for > 2 min is critical unless two failing sources explain it", () => {
    const u = (sinceMs: number) => [{ priceId: "AAPL", since: NOW - sinceMs, reason: "sources disagree: chainlink and vendor are 180.0 bps apart (limit 150)" }];
    expect(oracle(withSources([], null, u(119_000)), rules())).toEqual([]);
    const c = oracle(withSources([], null, u(121_000)), rules());
    expect(keys(c)).toEqual(["oracle_price_missing:AAPL"]);
    expect(c[0]).toMatchObject({ severity: "critical" });
    expect(c[0]!.summary).toBe(
      "oracle: no publishable price for AAPL for 2m in session (sources disagree: chainlink and vendor are 180.0 bps apart (limit 150)); after maxPriceAge valuations and liquidations revert",
    );
    // one failing source on that ticker does not explain it (the other two should carry it): still alerted
    expect(keys(oracle(withSources([failing(61_000, { failingTickers: ["AAPL"] })], null, u(121_000)), rules()))).toEqual([
      "oracle_source_failing:pyth",
      "oracle_price_missing:AAPL",
    ]);
    // two failing sources on it: the (critical) source alerts already say why
    const both = [failing(61_000, { failingTickers: ["AAPL"] }), failing(61_000, { name: "vendor", kind: "http", failingTickers: ["AAPL"] })];
    expect(keys(oracle(withSources(both, null, u(121_000)), rules()))).toEqual(["oracle_source_failing:pyth", "oracle_source_failing:vendor"]);
    expect(loadConfig({ NETWORK: "mainnet", CHAIN_ID: "4663" }).rules.oraclePriceMissingSec).toBe(120);
  });

  test("unreachable oracle, the on-chain minimum, and off by profile", () => {
    expect(keys(oracle(snap({ oracle: oracleDown("ECONNREFUSED") }), rules()))).toEqual(["oracle_health"]);
    expect(keys(oracle(snap({ oracle: confirmOracle({ ok: false, error: "timeout" }) }), rules()))).toEqual(["oracle_health"]);
    expect(keys(oracle(withSources([], "AttestedOracle.minSources()=3 > 2 configured live sources"), rules()))).toEqual(["oracle_min_sources"]);
    expect(oracle(withSources([failing(600_000)]), rules({ oracleExpected: false }))).toEqual([]);
    expect(oracle(snap({ oracle: null }), rules())).toEqual([]);
    // devnet: off by default; testnet / mainnet: on, 60 s
    expect(loadConfig({ NETWORK: "devnet" }).rules.oracleExpected).toBe(false);
    expect(loadConfig({ NETWORK: "mainnet", CHAIN_ID: "4663" }).rules).toMatchObject({ oracleExpected: true, oracleSourceFailSec: 60 });
    expect(loadConfig({ NETWORK: "testnet", CHAIN_ID: "46630" }).oracleUrl).toBe("http://127.0.0.1:4410");
  });
});

describe("oracle primary-confirm (mainnet: Chainlink signs, DEX TWAP / Pyth confirm)", () => {
  const src = (name: string, failingMs: number | null, failingTickers: string[], over: Partial<OracleSourceSnap> = {}): OracleSourceSnap => ({
    name,
    kind: name === "chainlink" ? "chainlink" : name === "dex-twap" ? "dex" : "pyth",
    role: name === "chainlink" ? "primary" : "confirm",
    lastOkAt: NOW - 3_600_000,
    failingSince: failingMs === null ? null : NOW - failingMs,
    failingTickers,
    lastError: name === "pyth" ? "HTTP 401" : "timeout",
    ...over,
  });
  const cf = (priceId: string, status: OracleConfirmSnap["status"], sinceMs: number | null, over: Partial<OracleConfirmSnap> = {}): OracleConfirmSnap => ({
    priceId,
    status,
    diffBps: status === "diverged" ? 260 : null,
    since: sinceMs === null ? null : NOW - sinceMs,
    checkedAt: NOW - 1_000,
    primaryPrice: 180,
    primaryTs: NOW - 3_600_000,
    lagSince: null,
    confirmers: status === "diverged" ? [{ name: "dex-twap", price: 184.68, diffBps: 260 }] : [],
    ...over,
  });
  const healthySources = () => confirmOracle().sources;
  /** confirm entries default to the healthy ones, with `confirm` replacing those of the same priceId */
  const pc = (over: Partial<OracleProbe> & { confirm?: OracleConfirmSnap[] } = {}) => {
    const base = confirmOracle().confirm.filter((x) => !(over.confirm ?? []).some((y) => y.priceId === x.priceId));
    return snap({ oracle: confirmOracle({ ...over, confirm: [...base, ...(over.confirm ?? [])] }) });
  };
  const withPrimary = (failingMs: number, tickers: string[]) => [src("chainlink", failingMs, tickers), ...healthySources().slice(1)];

  test("hysteresis linger: one failed Chainlink tick then 60 s healthy pages nothing; a sustained failure still does", () => {
    // the oracle keeps failingSince for 60 s after recovery; the latest failed tick (lastErrorAt) is the blip itself
    const blip = [src("chainlink", 60_000, ["NVDA"], { lastErrorAt: NOW - 60_000 }), ...healthySources().slice(1)];
    expect(oracle(pc({ sources: blip }), rules())).toEqual([]);
    // flapping: failed ticks keep coming, the observed span grows past 60 s
    const flapping = [src("chainlink", 61_000, ["NVDA"], { lastErrorAt: NOW - 1_000 }), ...healthySources().slice(1)];
    expect(keys(oracle(pc({ sources: flapping }), rules()))).toEqual(["oracle_source_failing:chainlink"]); // observed span 60 s
    const sustained = [src("chainlink", 61_000, ["NVDA"], { lastErrorAt: NOW }), ...healthySources().slice(1)];
    expect(oracle(pc({ sources: sustained }), rules()).map((c) => [c.key, c.severity])).toEqual([["oracle_source_failing:chainlink", "critical"]]);
    // price missing: a 10 s gap lingering for 60 s is not a 2 min outage; a sustained one is
    const lingering = [{ priceId: "NVDA", since: NOW - 130_000, lastSeenAt: NOW - 120_000, reason: "primary source chainlink has no fresh observation" }];
    expect(oracle(pc({ unpublished: lingering }), rules())).toEqual([]);
    const missing = [{ priceId: "NVDA", since: NOW - 130_000, lastSeenAt: NOW, reason: "primary source chainlink has no fresh observation" }];
    expect(keys(oracle(pc({ unpublished: missing }), rules()))).toEqual(["oracle_price_missing:NVDA"]);
  });

  test("healthy: nothing; config defaults 120 s / 600 s / 3 tickers, env overrides", () => {
    expect(evaluate(pc(), rules())).toEqual([]);
    expect(loadConfig({ NETWORK: "mainnet", CHAIN_ID: "4663" }).rules).toMatchObject({ oracleConfirmDivergenceSec: 120, oracleConfirmUnavailableSec: 600, oracleConfirmCriticalTickers: 3 });
    expect(
      loadConfig({ NETWORK: "mainnet", CHAIN_ID: "4663", ALERT_ORACLE_CONFIRM_DIVERGENCE_SECONDS: "60", ALERT_ORACLE_CONFIRM_UNAVAILABLE_SECONDS: "300", ALERT_ORACLE_CONFIRM_CRITICAL_TICKERS: "2" }).rules,
    ).toMatchObject({ oracleConfirmDivergenceSec: 60, oracleConfirmUnavailableSec: 300, oracleConfirmCriticalTickers: 2 });
  });

  test("the primary failing > 60 s is critical: no price published, the DEX never substitutes", () => {
    expect(oracle(pc({ sources: withPrimary(59_000, ["NVDA"]) }), rules())).toEqual([]);
    const c = oracle(pc({ sources: withPrimary(61_000, ["NVDA", "TSLA"]) }), rules());
    expect(keys(c)).toEqual(["oracle_source_failing:chainlink"]);
    expect(c[0]!.severity).toBe("critical");
    expect(c[0]!.summary).toBe(
      "oracle primary source chainlink (chainlink) failing for 61s on NVDA, TSLA (timeout; last ok 2026-10-10T11:00:00.000Z): no price is published for NVDA, TSLA (Chainlink is the only signing source; the DEX never substitutes); the last signed price ages until StalePrice after maxPriceAge, then valuations and liquidations revert",
    );
  });

  test("a confirm source failing: warning only after max(60 s, 600 s), only on tickers still confirmed otherwise", () => {
    const sources = (ms: number) => [src("chainlink", null, []), src("dex-twap", ms, ["NVDA", "TSLA"]), src("pyth", null, [])];
    // TSLA has no confirmer left: oracle_confirm_unavailable's business (not yet 600 s here)
    const tslaUnavailable = cf("TSLA", "unavailable", 300_000);
    expect(oracle(pc({ sources: sources(599_000), confirm: [tslaUnavailable] }), rules())).toEqual([]); // > 60 s but < 600 s
    const c = oracle(pc({ sources: sources(601_000), confirm: [tslaUnavailable] }), rules());
    expect(keys(c)).toEqual(["oracle_source_failing:dex-twap"]);
    expect(c[0]!.severity).toBe("warning");
    expect(c[0]!.summary).toBe(
      "oracle confirm source dex-twap (dex) failing for 10m on NVDA (timeout; last ok 2026-10-10T11:00:00.000Z): confirm source only: prices continue from Chainlink",
    );
    // every failing ticker is "unavailable": no source condition, the unavailable alert covers it
    const allGone = oracle(pc({ sources: sources(700_000), confirm: [cf("NVDA", "unavailable", 700_000), cf("TSLA", "unavailable", 700_000)] }), rules());
    expect(keys(allGone)).toEqual(["oracle_confirm_unavailable:NVDA", "oracle_confirm_unavailable:TSLA"]);
    // tickers without a Chainlink price (no-primary) are the primary alert's, not the confirm source's
    const noPrimary = oracle(pc({ sources: sources(700_000), confirm: [cf("NVDA", "no-primary", 700_000), cf("TSLA", "no-primary", 700_000)] }), rules());
    expect(keys(noPrimary)).toEqual([]);
  });

  test("two confirm sources failing on one ticker is NOT critical (no median 2-source logic)", () => {
    const sources = [src("chainlink", null, []), src("dex-twap", 700_000, ["NVDA"]), src("pyth", 700_000, ["NVDA"])];
    const c = oracle(pc({ sources, confirm: [cf("NVDA", "unavailable", 700_000)] }), rules());
    expect(keys(c)).toEqual(["oracle_confirm_unavailable:NVDA"]);
    expect(c.map((x) => x.severity)).toEqual(["warning"]);
    expect(c[0]!.summary).toBe(
      "oracle: no confirm source for NVDA for 12m in session: Chainlink is published unconfirmed (failing confirm sources: dex-twap: timeout; pyth: HTTP 401)",
    );
    // same sources, NVDA still confirmed somehow (status ok): two warnings, never critical
    const w = oracle(pc({ sources }), rules());
    expect(w.map((x) => [x.key, x.severity])).toEqual([
      ["oracle_source_failing:dex-twap", "warning"],
      ["oracle_source_failing:pyth", "warning"],
    ]);
  });

  test("divergence: warning after 2 min (not at 1 min), the price stays Chainlink", () => {
    expect(oracle(pc({ confirm: [cf("NVDA", "diverged", 60_000)] }), rules())).toEqual([]);
    expect(oracle(pc({ confirm: [cf("NVDA", "diverged", 119_000)] }), rules())).toEqual([]);
    const c = oracle(pc({ confirm: [cf("NVDA", "diverged", 120_000)] }), rules());
    expect(keys(c)).toEqual(["oracle_confirm_divergence:NVDA"]);
    expect(c[0]!.severity).toBe("warning");
    expect(c[0]!.summary).toBe(
      'oracle: NVDA Chainlink 180 vs dex-twap 184.68 (260 bps): 260 bps apart (limit 200 bps) for 2m in session; the published price is still Chainlink (the DEX never moves it). Check Chainlink lag (0.5% deviation / 24 h heartbeat update rule), the USDG peg, DEX pool manipulation; docs/RUNBOOK.md "Real prices"',
    );
    // no `since`: run length unknown, not alerted
    expect(oracle(pc({ confirm: [cf("NVDA", "diverged", null)] }), rules())).toEqual([]);
    expect(keys(oracle(pc({ confirm: [cf("NVDA", "diverged", 30_000)] }), rules({ oracleConfirmDivergenceSec: 20 })))).toEqual(["oracle_confirm_divergence:NVDA"]);
  });

  test("divergence critical: above 2x confirmBps, or 3 tickers diverged at once", () => {
    const at = (diffBps: number) => oracle(pc({ confirm: [cf("NVDA", "diverged", 130_000, { diffBps })] }), rules())[0]!;
    expect(at(400).severity).toBe("warning");
    expect(at(401).severity).toBe("critical");
    expect(at(401).summary).toContain("(above 2x the 200 bps limit)");
    // the band comes from /health confirmBps
    expect(oracle(pc({ confirmBps: 100, confirm: [cf("NVDA", "diverged", 130_000, { diffBps: 201 })] }), rules())[0]!.severity).toBe("critical");
    const two = oracle(pc({ confirm: [cf("NVDA", "diverged", 130_000), cf("TSLA", "diverged", 130_000)] }), rules());
    expect(two.map((x) => x.severity)).toEqual(["warning", "warning"]);
    // a third one diverged for only 60 s does not count yet
    expect(oracle(pc({ confirm: [cf("NVDA", "diverged", 130_000), cf("TSLA", "diverged", 130_000), cf("AAPL", "diverged", 60_000)] }), rules()).map((x) => x.severity)).toEqual([
      "warning",
      "warning",
    ]);
    const three = oracle(pc({ confirm: [cf("NVDA", "diverged", 130_000), cf("TSLA", "diverged", 130_000), cf("AAPL", "diverged", 125_000)] }), rules());
    expect(three.map((x) => [x.key, x.severity])).toEqual([
      ["oracle_confirm_divergence:NVDA", "critical"],
      ["oracle_confirm_divergence:TSLA", "critical"],
      ["oracle_confirm_divergence:AAPL", "critical"],
    ]);
    expect(three[0]!.summary).toContain("(3 tickers diverged at once)");
    expect(oracle(pc({ confirm: [cf("NVDA", "diverged", 130_000), cf("TSLA", "diverged", 130_000)] }), rules({ oracleConfirmCriticalTickers: 2 })).map((x) => x.severity)).toEqual([
      "critical",
      "critical",
    ]);
  });

  test("unavailable: warning after 10 min in session", () => {
    expect(oracle(pc({ confirm: [cf("NVDA", "unavailable", 599_000)] }), rules())).toEqual([]);
    const c = oracle(pc({ confirm: [cf("NVDA", "unavailable", 600_000)] }), rules());
    expect(keys(c)).toEqual(["oracle_confirm_unavailable:NVDA"]);
    expect(c[0]!.severity).toBe("warning");
    // no failing confirm source reported (e.g. stale observations): no reason suffix
    expect(c[0]!.summary).toBe("oracle: no confirm source for NVDA for 10m in session: Chainlink is published unconfirmed");
  });

  test("oracle_primary_suspect_stale: gap > primaryLagBps for 10 min with no Chainlink round since (warning only)", () => {
    const lag = (lagMs: number | null, roundAgeMs: number, over: Partial<OracleConfirmSnap> = {}) =>
      cf("NVDA", "ok", 3_600_000, { diffBps: 150, lagSince: lagMs === null ? null : NOW - lagMs, primaryTs: NOW - roundAgeMs, confirmers: [{ name: "dex-twap", price: 182.7, diffBps: 150 }], ...over });
    expect(oracle(pc({ confirm: [lag(599_000, 700_000)] }), rules())).toEqual([]); // < 10 min
    const c = oracle(pc({ confirm: [lag(600_000, 700_000)] }), rules());
    expect(keys(c)).toEqual(["oracle_primary_suspect_stale:NVDA"]);
    expect(c[0]!.severity).toBe("warning");
    expect(c[0]!.summary).toContain("NVDA Chainlink 180 (round 12m old) vs dex-twap 182.7 (150 bps): gap above 100 bps for 10m in session with no new Chainlink round");
    // a Chainlink round arrived during the gap: the feed was alive then; the stall clock restarts from that round
    expect(oracle(pc({ confirm: [lag(900_000, 300_000)] }), rules())).toEqual([]);
    // ... and fires again if the gap persists 10 min after that round with no further round
    expect(keys(oracle(pc({ confirm: [lag(1_500_000, 700_000)] }), rules()))).toEqual(["oracle_primary_suspect_stale:NVDA"]);
    // no lag run, or off-hours: nothing
    expect(oracle(pc({ confirm: [lag(null, 9_000_000)] }), rules())).toEqual([]);
    expect(oracle(pc({ confirm: [lag(900_000, 9_000_000, { status: "closed" })] }), rules())).toEqual([]);
    // the duration is configurable; the threshold text follows the oracle's primaryLagBps
    expect(keys(oracle(pc({ confirm: [lag(300_000, 400_000)] }), rules({ oraclePrimaryLagSec: 300 })))).toEqual(["oracle_primary_suspect_stale:NVDA"]);
    expect(oracle(pc({ primaryLagBps: 80, confirm: [lag(600_000, 700_000)] }), rules())[0]!.summary).toContain("gap above 80 bps");
    expect(loadConfig({ NETWORK: "mainnet", CHAIN_ID: "4663" }).rules.oraclePrimaryLagSec).toBe(600);
  });

  test('"closed" (off-hours) and "no-primary" never raise a confirm alert', () => {
    const old = 86_400_000;
    for (const status of ["closed", "no-primary"] as const) {
      expect(oracle(pc({ confirm: [cf("NVDA", status, old, { diffBps: 5000, confirmers: [{ name: "dex-twap", price: 300, diffBps: 5000 }] })] }), rules())).toEqual([]);
      expect(oracle(pc({ confirm: [cf("NVDA", status, null)] }), rules())).toEqual([]);
    }
    // closed tickers do not count toward the 3-ticker critical either
    const mix = oracle(pc({ confirm: [cf("NVDA", "diverged", 130_000), cf("TSLA", "diverged", 130_000), cf("AAPL", "closed", 130_000)] }), rules());
    expect(mix.map((x) => x.severity)).toEqual(["warning", "warning"]);
  });

  test("oracle_price_missing: suppressed by an alerting primary failure, not by a confirm failure", () => {
    const missing = [{ priceId: "NVDA", since: NOW - 121_000, reason: "chainlink: no fresh round" }];
    // primary failing > 60 s on NVDA: the critical source alert already explains it
    expect(keys(oracle(pc({ sources: withPrimary(61_000, ["NVDA"]), unpublished: missing }), rules()))).toEqual(["oracle_source_failing:chainlink"]);
    // primary failing on another ticker only: NVDA is still unexplained
    expect(keys(oracle(pc({ sources: withPrimary(61_000, ["TSLA"]), unpublished: missing }), rules()))).toEqual(["oracle_source_failing:chainlink", "oracle_price_missing:NVDA"]);
    // primary failing for only 30 s (no primary alert yet): price_missing stands
    expect(keys(oracle(pc({ sources: withPrimary(30_000, ["NVDA"]), unpublished: missing }), rules()))).toEqual(["oracle_price_missing:NVDA"]);
    // a confirm source failing on NVDA never explains a missing price
    const dex = [src("chainlink", null, []), src("dex-twap", 700_000, ["NVDA"]), src("pyth", null, [])];
    expect(keys(oracle(pc({ sources: dex, unpublished: missing }), rules()))).toEqual(["oracle_source_failing:dex-twap", "oracle_price_missing:NVDA"]);
  });

  test("oracle_min_sources still reported; ALERT_DISABLE works per condition rule", () => {
    expect(keys(oracle(pc({ minSourcesProblem: "AttestedOracle.minSources()=2 > 1" }), rules()))).toEqual(["oracle_min_sources"]);
    const s = pc({ confirm: [cf("NVDA", "diverged", 130_000), cf("TSLA", "unavailable", 700_000)] });
    expect(keys(evaluate(s, rules()))).toEqual(["oracle_confirm_divergence:NVDA", "oracle_confirm_unavailable:TSLA"]);
    expect(keys(evaluate(s, rules({ disabled: new Set(["oracle_confirm_divergence"]) })))).toEqual(["oracle_confirm_unavailable:TSLA"]);
    expect(keys(evaluate(s, rules({ disabled: new Set(["oracle_confirm_unavailable"]) })))).toEqual(["oracle_confirm_divergence:NVDA"]);
  });

  test("median policy unchanged under the same /health shape (role median, no confirm)", () => {
    const sources = [src("chainlink", 61_000, ["NVDA"], { role: "median" }), src("pyth", 61_000, ["NVDA"], { role: "median" })];
    const c = oracle(snap({ oracle: confirmOracle({ policy: "median", confirmBps: null, sources, confirm: [] }) }), rules());
    expect(c.map((x) => [x.key, x.severity])).toEqual([
      ["oracle_source_failing:chainlink", "critical"],
      ["oracle_source_failing:pyth", "critical"],
    ]);
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
