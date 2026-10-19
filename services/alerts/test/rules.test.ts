import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import {
  apiHealth,
  backup,
  balances,
  builderPricePush,
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
  engineLossBudget,
  engineLossBudgetUnreadable,
  rpc,
  venueIfAccount,
  venueReportAge,
  venueListing,
  venueSymbol,
} from "../src/rules";
import { BUILDER_FEED_STATUS_TTL_SEC, type BuilderFeedStatusMsg, KEYS, VENUE_SYMBOL_ISSUES_TTL_SEC } from "@bookrunner/shared/queues";
import { collect, emptyMemory, oracleDown, parseIfAccounts } from "../src/collect";
import { loadConfig } from "../src/config";
import type { VenueMarketMsg } from "@bookrunner/shared/venueMarket";
import type { BuilderFeedSnap, VenueOpsSnap, OracleConfirmSnap, OracleProbe, OracleSourceSnap } from "../src/types";
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

describe("insurance-fund account (ops-venue ORDERLY_IF_MODE, VERIFY O10)", () => {
  const ks = (cs: ReturnType<typeof venueIfAccount>) => cs.map((x) => [x.key, x.severity]);
  const mismatch = { issue: "mismatch" as const, detail: "ORDERLY_IF_MODE=builder but the adapter's IF account is the OrderlyIFAccount", accountId: "0xaa", since: null };
  const pending = { issue: "key_pending" as const, detail: "the operator (wallet 0xE0A) must register ops-venue's IF key for 0xaa", accountId: "0xaa", since: NOW - 3_600_000 };

  test("venue_if_account: mismatch warning in Subscription, critical Live / Retiring; key_pending warning; Cancelled / Retired quiet", () => {
    expect(ks(venueIfAccount(snap({ books: [book({ state: "Subscription", ifAccountIssue: mismatch })] }), rules()))).toEqual([["venue_if_account:3", "warning"]]);
    expect(ks(venueIfAccount(snap({ books: [book({ ifAccountIssue: mismatch })] }), rules()))).toEqual([["venue_if_account:3", "critical"]]);
    expect(ks(venueIfAccount(snap({ books: [book({ state: "Retiring", ifAccountIssue: mismatch })] }), rules()))).toEqual([["venue_if_account:3", "critical"]]);
    const p = venueIfAccount(snap({ books: [book({ ifAccountIssue: pending })] }), rules());
    expect(ks(p)).toEqual([["venue_if_account:3", "warning"]]);
    expect(p[0]?.summary).toContain("waits 60m");
    for (const state of ["Cancelled", "Retired"]) expect(venueIfAccount(snap({ books: [book({ state, ifAccountIssue: mismatch })] }), rules())).toEqual([]);
    expect(venueIfAccount(snap({ books: [book({ venue: "pool_engine", ifAccountIssue: mismatch })] }), rules())).toEqual([]);
    expect(venueIfAccount(snap({ books: [book()] }), rules())).toEqual([]);
  });

  test("venue_if_operator_pending: warning, critical after 6 h; withdraw vs return wording", () => {
    const w = (step: "withdraw" | "return", ageMs: number) => ({ nonce: "4", step, amount: "10000000000", owner: "0xE0A", adapter: "0xAD", since: NOW - ageMs });
    const a = venueIfAccount(snap({ books: [book({ ifOperatorWaits: [w("withdraw", 600_000)] })] }), rules());
    expect(ks(a)).toEqual([["venue_if_operator_pending:3:4", "warning"]]);
    expect(a[0]?.summary).toContain("withdraw it promptly on Orderly from the builder IF account (wallet 0xE0A;");
    expect(a[0]?.summary).toContain("then transfer it to the adapter 0xAD");
    expect(a[0]?.summary).toContain("10,000 USD");
    const r = venueIfAccount(snap({ books: [book({ ifOperatorWaits: [w("return", 21_600_000)] })] }), rules());
    expect(ks(r)).toEqual([["venue_if_operator_pending:3:4", "critical"]]);
    expect(r[0]?.summary).toContain("transfer it (one transfer, the full amount) to the adapter 0xAD");
    // a Retired (or Cancelled) book keeps alerting while its last IF payout is unreturned
    for (const state of ["Retired", "Cancelled"]) {
      const ret = venueIfAccount(snap({ books: [book({ state, ifOperatorWaits: [w("return", 21_600_000)] })] }), rules());
      expect(ks(ret)).toEqual([["venue_if_operator_pending:3:4", "critical"]]);
      expect(ret[0]?.summary).toContain(`(state ${state})`);
    }
  });

  test("written off from NAV: critical at once; unadopted withdrawal and IF equity drop: critical; prior_equity critical, reassign warning", () => {
    const wo = venueIfAccount(snap({ books: [book({ ifOperatorWaits: [{ nonce: "4", step: "return", amount: "1000000", owner: "0xE0A", adapter: "0xAD", since: NOW - 60_000, writtenOffAt: NOW - 1_000 }] })] }), rules());
    expect(ks(wo)).toEqual([["venue_if_operator_pending:3:4", "critical"]]);
    expect(wo[0]?.summary).toContain("WRITTEN OFF from NAV");
    const u = venueIfAccount(snap({ books: [book({ ifUnadopted: [{ id: "90", amount: "7000000", status: "COMPLETED", createdAt: 1 }] })] }), rules());
    expect(ks(u)).toEqual([["venue_if_unadopted_withdrawal:3:90", "critical"]]);
    expect(u[0]?.summary).toContain("without any on-chain request");
    const d = venueIfAccount(snap({ books: [book({ ifEquityDrop: { expectedUsd: "30000000000", venueUsd: "25000000000", at: NOW } })] }), rules());
    expect(ks(d)).toEqual([["venue_if_equity_drop:3", "critical"]]);
    expect(d[0]?.summary).toContain("25,000 USD is below the adapter's insurance 30,000 USD");
    expect(ks(venueIfAccount(snap({ books: [book({ ifAccountIssue: { issue: "prior_equity", detail: "held 3", accountId: "0xaa", since: NOW } })] }), rules()))).toEqual([["venue_if_account:3", "critical"]]);
    expect(ks(venueIfAccount(snap({ books: [book({ ifAccountIssue: { issue: "reassign", detail: "re-assign", accountId: "0xaa", since: NOW } })] }), rules()))).toEqual([["venue_if_account:3", "warning"]]);
  });

  test("payout step (confirmed on-chain, Orderly not visibly paid): published until back or written off; failed sagas alert (IF critical, any state)", () => {
    const p = venueIfAccount(snap({ books: [book({ ifOperatorWaits: [{ nonce: "5", step: "payout", amount: "3000000000", owner: "0xE0A", adapter: "0xAD", since: NOW - 600_000 }] })] }), rules());
    expect(ks(p)).toEqual([["venue_if_operator_pending:3:5", "warning"]]);
    expect(p[0]?.summary).toContain("confirmed on-chain 10m ago and is not back on the adapter");
    expect(p[0]?.summary).toContain("written off from NAV after");
    const wo = venueIfAccount(snap({ books: [book({ ifOperatorWaits: [{ nonce: "5", step: "payout", amount: "1", owner: "0xE0A", adapter: "0xAD", since: NOW - 600_000, writtenOffAt: NOW }] })] }), rules());
    expect(ks(wo)).toEqual([["venue_if_operator_pending:3:5", "critical"]]);
    const f = (account: number, state = "Live") => venueIfAccount(snap({ books: [book({ state, failedWithdrawals: [{ nonce: "9", account, amount: "1000000", error: "venue down", at: NOW }] })] }), rules());
    expect(ks(f(0))).toEqual([["venue_withdraw_failed:3:9", "critical"]]);
    expect(ks(f(1))).toEqual([["venue_withdraw_failed:3:9", "warning"]]);
    expect(ks(f(0, "Retired"))).toEqual([["venue_withdraw_failed:3:9", "critical"]]);
    expect(f(0)[0]?.summary).toContain("insurance-fund withdrawal #9 (1 USD) FAILED in ops-venue (venue down)");
    const parsed = parseIfAccounts(JSON.stringify({ failedWithdrawals: [{ bookId: 3, nonce: "9", account: 0, amount: "1", error: "x", at: 5 }, { bookId: 3 }], ifOperatorWaits: [{ bookId: 3, nonce: "5", step: "payout", amount: "1", owner: "o", adapter: "a", since: 1 }] }));
    expect(parsed.failed.get(3)).toEqual([{ nonce: "9", account: 0, amount: "1", error: "x", at: 5 }]);
    expect(parsed.waits.get(3)?.[0]?.step).toBe("payout");
  });

  test("venue_market_restricted POST_ONLY text follows AGENT_VENUE_POST_ONLY_QUOTE when set", () => {
    const live = { ts: NOW, mode: "live" as const, builderPush: true, listingMode: "manual" as const };
    const m = { symbol: "PERP_NVDA_USDC_bookrunner", bookIds: [3], phase: "listed" as const, venueStatus: "POST_ONLY", openForRisk: false, everListed: true, since: NOW, checkedAt: NOW, failures: 0, error: null };
    const text = (c: ReturnType<typeof rules>) => venueListing(snap({ venueOps: live, books: [book({ venueMarket: m })] }), c)[0]?.summary ?? "";
    expect(text(rules())).toContain("maker-only");
    expect(text(rules({ venuePostOnlyQuote: false }))).toContain("reduce-only");
    expect(text(rules({ venuePostOnlyQuote: false }))).not.toContain("maker-only");
    expect(loadConfig({ NETWORK: "testnet", CHAIN_ID: "46630", AGENT_VENUE_POST_ONLY_QUOTE: "false" }).rules.venuePostOnlyQuote).toBe(false);
    expect(loadConfig({ NETWORK: "testnet", CHAIN_ID: "46630" }).rules.venuePostOnlyQuote).toBeUndefined();
  });

  test("parseIfAccounts: per book, malformed entries dropped", () => {
    const raw = JSON.stringify({
      ifAccounts: [{ bookId: 3, accountId: "0xaa", binding: "builder", issue: "key_pending", detail: "d", since: 5 }, { bookId: 4, issue: "weird", detail: "x" }, null],
      ifOperatorWaits: [{ bookId: 3, nonce: "1", step: "return", amount: "5", owner: "0xE", adapter: "0xA", since: 9 }, { bookId: 3, step: "withdraw" }],
    });
    const p = parseIfAccounts(raw);
    expect([...p.issues]).toEqual([[3, { issue: "key_pending", detail: "d", accountId: "0xaa", since: 5 }]]);
    expect(p.waits.get(3)).toEqual([{ nonce: "1", step: "return", amount: "5", owner: "0xE", adapter: "0xA", since: 9, writtenOffAt: null }]);
    const more = parseIfAccounts(
      JSON.stringify({
        ifAccounts: [{ bookId: 3, accountId: "0xaa", issue: "reassign", detail: "r" }, { bookId: 3, accountId: "0xaa", issue: "mismatch", detail: "m" }],
        ifUnadopted: [{ bookId: 3, accountId: "0xaa", id: "90", amount: "7", status: "COMPLETED", createdAt: 5 }, { bookId: 3 }],
        ifEquityDrops: [{ bookId: 3, accountId: "0xaa", expectedUsd: "2", venueUsd: "1", at: 7 }, { bookId: 4 }],
        ifOperatorWaits: [{ bookId: 3, nonce: "1", step: "return", amount: "5", owner: "0xE", adapter: "0xA", since: 9, writtenOffAt: 10 }],
      }),
    );
    expect(more.issues.get(3)?.issue).toBe("mismatch"); // a mismatch outranks a notice
    expect(more.unadopted.get(3)).toEqual([{ id: "90", amount: "7", status: "COMPLETED", createdAt: 5 }]);
    expect([...more.drops]).toEqual([[3, { expectedUsd: "2", venueUsd: "1", at: 7 }]]);
    expect(more.waits.get(3)?.[0]?.writtenOffAt).toBe(10);
    expect(parseIfAccounts("{bad").issues.size).toBe(0);
    expect(parseIfAccounts(null).waits.size).toBe(0);
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

  test("venue_symbol_unmapped: an Orderly book ops-venue tracks without listing / trading (VERIFY O19)", () => {
    const c = venueSymbol(snap({ books: [book({ venueSymbolError: 'charter symbol "NVDA-PERP" is not an Orderly perp symbol' })] }), rules());
    expect(c.map((x) => [x.key, x.severity])).toEqual([["venue_symbol_unmapped:3", "critical"]]);
    expect(c[0]?.summary).toMatch(/NVDA-PERP.*withdrawals still run/);
    expect(venueSymbol(snap({ books: [book({ venueSymbolError: null })] }), rules())).toEqual([]);
    expect(venueSymbol(snap({ books: [book()] }), rules())).toEqual([]);
    // a Retired / Cancelled book has nothing left on the venue
    for (const state of ["Retired", "Cancelled"]) expect(venueSymbol(snap({ books: [book({ state, venueSymbolError: "no market" })] }), rules())).toEqual([]);
    expect(keys(venueSymbol(snap({ books: [book({ state: "Retiring", venueSymbolError: "no market" })] }), rules()))).toEqual(["venue_symbol_unmapped:3"]);
  });

  describe("Orderly market state (ops-venue listing check, VERIFY O20)", () => {
    const manual = { ts: NOW, mode: "live" as const, builderPush: true, listingMode: "manual" as const };
    const apiLive = { ...manual, listingMode: "api" as const };
    const apiMock = { ...apiLive, mode: "mock" as const };
    const mk = (over: Partial<VenueMarketMsg> = {}): VenueMarketMsg => ({ symbol: "PERP_NVDA_USDC_bookrunner", bookIds: [3], phase: "awaiting", venueStatus: null, openForRisk: false, everListed: false, since: NOW - 600_000, checkedAt: NOW, failures: 0, error: null, ...over });
    const run = (ops: VenueOpsSnap | null, b: Partial<ReturnType<typeof book>>) => venueListing(snap({ venueOps: ops, books: [book(b)] }), rules());
    const ks = (cs: ReturnType<typeof venueListing>) => cs.map((x) => [x.key, x.severity]);

    test("venue_listing_pending (manual): warning in Subscription / Retiring and during the Live grace, critical after it", () => {
      expect(ks(run(manual, { state: "Subscription", venueMarket: mk() }))).toEqual([["venue_listing_pending:3", "warning"]]);
      expect(ks(run(manual, { state: "Retiring", venueMarket: mk() }))).toEqual([["venue_listing_pending:3", "warning"]]);
      // Live for 10 min (< 30 min grace): warning; the grace counts from going Live, not from the first not-listed check
      expect(ks(run(manual, { liveSince: NOW_S - 600, venueMarket: mk({ since: NOW - 86_400_000 }) }))).toEqual([["venue_listing_pending:3", "warning"]]);
      const crit = run(manual, { liveSince: NOW_S - 1_801, venueMarket: mk() });
      expect(ks(crit)).toEqual([["venue_listing_pending:3", "critical"]]);
      expect(crit[0]?.summary).toMatch(/PERP_NVDA_USDC_bookrunner awaiting listing in Orderly One for 10m \(not on \/v1\/public\/info\)/);
      expect(crit[0]?.summary).toContain("with no market");
      expect(ks(run(manual, { liveSince: NOW_S - 1_000, venueMarket: mk() }))).toEqual([["venue_listing_pending:3", "warning"]]);
      expect(run(manual, { state: "Subscription", venueMarket: mk({ venueStatus: "PENDING" }) })[0]?.summary).toContain("Orderly status PENDING");
      expect(ks(run(manual, { liveSince: NOW_S - 7_200, venueMarket: mk() }))).toEqual([["venue_listing_pending:3", "critical"]]);
      for (const state of ["Retired", "Cancelled"]) expect(run(manual, { state, venueMarket: mk() })).toEqual([]);
      expect(run(null, { venueMarket: mk() })).toEqual([]);
      expect(run(manual, { venueMarket: null })).toEqual([]);
    });

    test("venue_listing_pending (api mode): only ORDERLY_MODE=live and a Live book; never api + mock (devnet)", () => {
      expect(ks(run(apiLive, { liveSince: NOW_S - 7_200, venueMarket: mk({ venueStatus: "PENDING" }) }))).toEqual([["venue_listing_pending:3", "critical"]]);
      expect(run(apiLive, { liveSince: NOW_S - 7_200, venueMarket: mk() })[0]?.summary).toContain("not launched on Orderly (listing API)");
      expect(run(apiLive, { state: "Subscription", venueMarket: mk() })).toEqual([]);
      expect(run(apiMock, { liveSince: NOW_S - 7_200, venueMarket: mk({ venueStatus: "PENDING" }) })).toEqual([]);
    });

    test("venue_market_restricted: listed but not open; DELISTING / DELISTED on a Live book critical, Retiring quiet", () => {
      const listed = (venueStatus: string) => mk({ phase: "listed", venueStatus, everListed: true, openForRisk: false });
      expect(ks(run(manual, { venueMarket: listed("REDUCE_ONLY") }))).toEqual([["venue_market_restricted:3", "warning"]]);
      expect(ks(run(apiMock, { venueMarket: listed("REDUCE_ONLY") }))).toEqual([["venue_market_restricted:3", "warning"]]); // any mode
      expect(ks(run(manual, { venueMarket: listed("DELISTING") }))).toEqual([["venue_market_restricted:3", "critical"]]);
      expect(ks(run(manual, { venueMarket: listed("DELISTED") }))).toEqual([["venue_market_restricted:3", "critical"]]);
      expect(ks(run(manual, { venueMarket: listed("POST_ONLY") }))).toEqual([["venue_market_restricted:3", "warning"]]);
      expect(ks(run(manual, { venueMarket: listed("HALTED") }))).toEqual([["venue_market_restricted:3", "warning"]]); // undocumented
      expect(run(manual, { venueMarket: listed("DELISTING") })[0]?.summary).toContain("being delisted");
      expect(run(manual, { state: "Retiring", venueMarket: listed("DELISTED") })).toEqual([]);
      expect(ks(run(manual, { state: "Subscription", venueMarket: listed("REDUCE_ONLY") }))).toEqual([["venue_market_restricted:3", "warning"]]);
      expect(run(manual, { state: "Subscription", venueMarket: listed("POST_ONLY") })).toEqual([]); // launch phase
      // POST_ONLY in live mode: the agent quotes maker-only (AGENT_VENUE_POST_ONLY_QUOTE default), never "reduce-only"
      const po = run(manual, { venueMarket: listed("POST_ONLY") })[0]?.summary ?? "";
      expect(po).toContain("maker-only");
      expect(po).not.toContain("reduce-only");
      expect(run(apiMock, { venueMarket: listed("POST_ONLY") })[0]?.summary).toContain("reduce-only"); // mock default: reduce-only
      expect(run(manual, { venueMarket: listed("REDUCE_ONLY") })[0]?.summary).toContain("reduce-only");
      expect(run(manual, { venueMarket: mk({ phase: "listed", venueStatus: "ACTIVE", everListed: true, openForRisk: true }) })).toEqual([]);
    });

    test("venue_market_missing: was listed, now absent; Live critical, Retiring a one-off warning", () => {
      const missing = mk({ phase: "missing", everListed: true, venueStatus: null });
      const live = run(manual, { venueMarket: missing });
      expect(ks(live)).toEqual([["venue_market_missing:3", "critical"]]);
      expect(live[0]?.summary).not.toContain("awaiting");
      const ret = run(manual, { state: "Retiring", venueMarket: missing });
      expect(ks(ret)).toEqual([["venue_market_missing:3", "warning"]]);
      expect(ret[0]?.notifyResolve).toBe(false);
      expect(run(manual, { state: "Retired", venueMarket: missing })).toEqual([]);
    });

    test("venue_listing_check: N consecutive failures warn (the last known state stays)", () => {
      expect(run(manual, { venueMarket: mk({ phase: "unknown", failures: 4, error: "timed out" }) })).toEqual([]);
      const c = run(manual, { venueMarket: mk({ phase: "unknown", failures: 5, error: "timed out" }) });
      expect(ks(c)).toEqual([["venue_listing_check:3", "warning"]]);
      expect(c[0]?.summary).toContain("failed 5 times in a row (timed out)");
      expect(loadConfig({}).rules.listingCheckFailures).toBe(5);
      expect(loadConfig({}).rules.listingLiveGraceSec).toBe(1800);
    });

    test("venue_delist_pending: an IF withdrawal waiting for the admin's delisting; critical after 6 h", () => {
      const listed = mk({ phase: "listed", venueStatus: "ACTIVE", everListed: true, openForRisk: true });
      expect(ks(run(manual, { state: "Retiring", venueMarket: listed, delistWaitSince: NOW - 600_000 }))).toEqual([["venue_delist_pending:3", "warning"]]);
      expect(ks(run(manual, { state: "Retiring", venueMarket: listed, delistWaitSince: NOW - 21_600_000 }))).toEqual([["venue_delist_pending:3", "critical"]]);
      expect(run(manual, { state: "Retired", delistWaitSince: NOW - 21_600_000 })).toEqual([]);
    });
  });
});

describe("builder_price_push (live Orderly builder prices, VERIFY O18)", () => {
  const sym = (over: Record<string, unknown> = {}) => ({ symbol: "PERP_NVDA_USDC_bookrunner", bookIds: [3], state: "pushing", lastPushAt: NOW, failingSince: null, error: null, preListing: false, ...over });
  const feed = (symbols: ReturnType<typeof sym>[], ts = NOW) => ({ ts, socket: { state: "ready", lastError: null }, symbols }) as BuilderFeedSnap;
  const liveOps = { ts: NOW, mode: "live" as const, builderPush: true, listingMode: "manual" as const };
  test("a symbol failing >= 30 s in session is critical; shorter, held or pushing is quiet", () => {
    const c = builderPricePush(snap({ builderFeed: feed([sym({ state: "disconnected", failingSince: NOW - 31_000, error: "auth failed" })]) }), rules());
    expect(c.map((x) => [x.key, x.severity])).toEqual([["builder_price_push:PERP_NVDA_USDC_bookrunner", "critical"]]);
    expect(c[0]!.summary).toMatch(/book 3.*31s.*disconnected: auth failed.*reduce-only/);
    expect(builderPricePush(snap({ builderFeed: feed([sym({ state: "stale", failingSince: NOW - 29_000 })]) }), rules())).toEqual([]);
    expect(builderPricePush(snap({ builderFeed: feed([sym({ state: "held" }), sym()]) }), rules())).toEqual([]);
    expect(builderPricePush(snap({ builderFeed: null }), rules())).toEqual([]);
    expect(builderPricePush(snap(), rules())).toEqual([]);
  });
  test("books still in Subscription (preListing) are not paged", () => {
    expect(builderPricePush(snap({ builderFeed: feed([sym({ state: "rejected", failingSince: NOW - 300_000, preListing: true })]) }), rules())).toEqual([]);
  });
  test("the span stops at ops-venue's status time; a status that stopped updating alerts on its own", () => {
    const old = feed([sym({ state: "stale", failingSince: NOW - 100_000 })], NOW - 90_000); // failing 10 s when last written
    expect(builderPricePush(snap({ builderFeed: old }), rules()).map((x) => x.key)).toEqual(["builder_price_push_status"]);
    expect(builderPricePush(snap({ builderFeed: feed([sym()], NOW - 59_000) }), rules())).toEqual([]);
  });
  test("missing status: critical only when ops-venue reports live mode with the push on and an Orderly book is live", () => {
    expect(builderPricePush(snap({ builderFeed: null, venueOps: liveOps }), rules()).map((x) => [x.key, x.severity])).toEqual([["builder_price_push_status", "critical"]]);
    expect(builderPricePush(snap({ builderFeed: null, venueOps: { ...liveOps, builderPush: false } }), rules())).toEqual([]);
    expect(builderPricePush(snap({ builderFeed: null, venueOps: { ...liveOps, mode: "mock" } }), rules())).toEqual([]);
    expect(builderPricePush(snap({ builderFeed: null, venueOps: liveOps, books: [book({ state: "Subscription" })] }), rules())).toEqual([]);
    expect(builderPricePush(snap({ builderFeed: null, venueOps: null }), rules())).toEqual([]);
  });
  test("ALERT_BUILDER_PUSH_FAIL_SECONDS", () => {
    expect(loadConfig({}).rules.builderPushFailSec).toBe(30);
    const c = builderPricePush(snap({ builderFeed: feed([sym({ state: "stale", failingSince: NOW - 31_000 })]) }), rules({ builderPushFailSec: 60 }));
    expect(c).toEqual([]);
  });

  // Through the real key lifetimes: ops-venue writes the status / issues with their shared TTLs into a TTL-honouring
  // store; collect() reads it back at later times (no hand-built snapshot).
  test("through Redis TTLs: a stalled push loop alerts while its status lives, a stopped one as a missing status", async () => {
    let clock = NOW;
    const store = new Map<string, { v: string; exp: number }>();
    const set = (k: string, v: unknown, ttlSec: number) => store.set(k, { v: JSON.stringify(v), exp: clock + ttlSec * 1000 });
    const get = (k: string) => {
      const e = store.get(k);
      return e && e.exp > clock ? e.v : null;
    };
    const kv = { get: async (k: string) => get(k), mget: async (ks: string[]) => ks.map(get) };
    const db = {
      books: async () => [{ id: 3, name: "NVDA", symbol: "PERP_NVDA_USDC", state: "Live", venue: 0, subscriptionEnds: new Date(NOW - 86_400_000) }],
      latestMarkPeriodEnds: async () => [],
      killsSince: async () => [],
      cursors: async () => [],
    };
    const chain = { head: async () => ({ number: 1, timestamp: clock / 1000 }), balance: async () => 0n, buybackPending: async () => null, markInterval: async () => 3600 };
    const fetchOk = (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch;
    const settings = { network: "testnet", chainId: 46630, apiUrl: "http://api", markIntervalSec: 3600, roles: [], rpcWindowSec: 900 };
    const statusMsg = (ts: number): BuilderFeedStatusMsg => ({
      v: 1,
      ts,
      intervalMs: 1000,
      maxAgeMs: 10_000,
      socket: { state: "ready", lastError: null, host: "ws-oracle.orderly.org" },
      symbols: [{ symbol: "PERP_NVDA_USDC_bookrunner", base: "NVDA", bookIds: [3], state: "pushing", lastPushAt: ts, price: 190, failingSince: null, error: null, preListing: false }],
    });
    const issues = (ts: number) => ({ v: 1, ts, mode: "live", builderPush: true, books: [] });
    const evalAt = async (t: number) => {
      clock = t;
      const { snapshot } = await collect({ db, kv, chain, fetch: fetchOk, now: () => clock }, settings, emptyMemory(), 86_400);
      return builderPricePush(snapshot, rules()).map((x) => x.key);
    };
    // healthy: both written now
    set(KEYS.builderFeedStatus, statusMsg(NOW), BUILDER_FEED_STATUS_TTL_SEC);
    set(KEYS.venueSymbolIssues, issues(NOW), VENUE_SYMBOL_ISSUES_TTL_SEC);
    expect(await evalAt(NOW)).toEqual([]);
    // the push loop stalls (no status write) while the book poll keeps going: 90 s later the old status still exists
    clock = NOW + 85_000;
    set(KEYS.venueSymbolIssues, issues(clock), VENUE_SYMBOL_ISSUES_TTL_SEC);
    expect(await evalAt(NOW + 90_000)).toEqual(["builder_price_push_status"]);
    // past the status TTL the key is gone: the missing-status branch takes over (issues refreshed by the book poll)
    clock = NOW + BUILDER_FEED_STATUS_TTL_SEC * 1000 - 5_000;
    set(KEYS.venueSymbolIssues, issues(clock), VENUE_SYMBOL_ISSUES_TTL_SEC);
    expect(await evalAt(NOW + BUILDER_FEED_STATUS_TTL_SEC * 1000 + 1)).toEqual(["builder_price_push_status"]);
    expect(get(KEYS.builderFeedStatus)).toBeNull();
    expect(BUILDER_FEED_STATUS_TTL_SEC).toBeGreaterThan(rules().builderPushFailSec + 30);
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

describe("engine_loss_budget (Task 7: the engine pool spent its per-period loss budget)", () => {
  const lb = { blocked: true, lossUsd: 9000.5, budgetUsd: 8000, budgetBps: 800, period: 7 };
  const engineBook = (over: Partial<NonNullable<ReturnType<typeof book>["risk"]>> = {}, state = "Live") =>
    book({ venue: "pool_engine", state, risk: { ...book().risk!, lossBudget: lb, ...over } });
  test("blocked = critical with the loss and the budget", () => {
    const c = engineLossBudget(snap({ books: [engineBook()] }), rules());
    expect(keys(c)).toEqual(["engine_loss_budget:3"]);
    expect(c[0]!.severity).toBe("critical");
    expect(c[0]!.summary).toContain("$9,000.50");
    expect(c[0]!.summary).toContain("$8,000.00 (800 bps)");
  });
  test("within budget, no reading, or an ended book: nothing", () => {
    expect(engineLossBudget(snap({ books: [engineBook({ lossBudget: { ...lb, blocked: false } })] }), rules())).toEqual([]);
    expect(engineLossBudget(snap({ books: [book()] }), rules())).toEqual([]);
    expect(engineLossBudget(snap({ books: [engineBook({}, "Retired")] }), rules())).toEqual([]);
    expect(engineLossBudget(snap({ books: null }), rules())).toEqual([]);
  });
  test("registered in RULES (can be disabled)", () => {
    const s = snap({ books: [engineBook()] });
    expect(evaluate(s, rules()).map((c) => c.key)).toContain("engine_loss_budget:3");
    expect(evaluate(s, rules({ disabled: new Set(["engine_loss_budget"]) })).map((c) => c.key)).not.toContain("engine_loss_budget:3");
  });
});

describe("engine_loss_budget_unreadable (Task 7c, 7a review M-6: risk cannot read an engine book's loss budget)", () => {
  const engine = (over: Partial<NonNullable<ReturnType<typeof book>["risk"]>> = {}, state = "Live") =>
    book({ venue: "pool_engine", state, risk: { ...book().risk!, lossBudgetUnreadable: true, ...over } });
  test("an engine book whose risk state carries meta.lossBudget = null: warning after ALERT_LOSS_BUDGET_UNREADABLE_SECONDS", () => {
    const c = engineLossBudgetUnreadable(snap({ books: [engine()] }), rules());
    expect(keys(c)).toEqual(["engine_loss_budget_unreadable:3"]);
    expect(c[0]!.severity).toBe("warning");
    expect(c[0]!.forSec).toBe(300); // hysteresis: a failed read or two never fires; the dedupe's clear window resolves it
    expect(c[0]!.summary).toContain("engine_loss_budget cannot fire");
    expect(engineLossBudgetUnreadable(snap({ books: [engine()] }), rules({ lossBudgetUnreadableSec: 900 }))[0]!.forSec).toBe(900);
  });
  test("readable, Orderly (always null), not markable, killed, stale risk state (risk_stale covers it) or no risk state: quiet", () => {
    expect(engineLossBudgetUnreadable(snap({ books: [engine({ lossBudgetUnreadable: undefined })] }), rules())).toEqual([]);
    expect(engineLossBudgetUnreadable(snap({ books: [book({ risk: { ...book().risk!, lossBudgetUnreadable: true } })] }), rules())).toEqual([]);
    for (const state of ["Subscription", "Cancelled", "Retired"]) expect(engineLossBudgetUnreadable(snap({ books: [engine({}, state)] }), rules())).toEqual([]);
    expect(keys(engineLossBudgetUnreadable(snap({ books: [engine({}, "Retiring")] }), rules()))).toEqual(["engine_loss_budget_unreadable:3"]);
    expect(engineLossBudgetUnreadable(snap({ books: [engine({ killed: true })] }), rules())).toEqual([]);
    expect(engineLossBudgetUnreadable(snap({ books: [engine({ ts: NOW - 301_000 })] }), rules())).toEqual([]);
    expect(engineLossBudgetUnreadable(snap({ books: [engine({ ts: null })] }), rules())).toEqual([]);
    expect(engineLossBudgetUnreadable(snap({ books: [book({ venue: "pool_engine", risk: null })] }), rules())).toEqual([]);
    expect(engineLossBudgetUnreadable(snap({ books: null }), rules())).toEqual([]);
  });
  test("registered in RULES (can be disabled); ALERT_LOSS_BUDGET_UNREADABLE_SECONDS", () => {
    const s = snap({ books: [engine()] });
    expect(evaluate(s, rules()).map((c) => c.key)).toContain("engine_loss_budget_unreadable:3");
    expect(evaluate(s, rules({ disabled: new Set(["engine_loss_budget_unreadable"]) })).map((c) => c.key)).not.toContain("engine_loss_budget_unreadable:3");
    expect(loadConfig({ NETWORK: "testnet", ALERT_LOSS_BUDGET_UNREADABLE_SECONDS: "120" }).rules.lossBudgetUnreadableSec).toBe(120);
    expect(rules().lossBudgetUnreadableSec).toBe(300);
  });
});
