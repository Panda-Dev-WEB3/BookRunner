import { describe, expect, test } from "bun:test";
import { type ChainPort, type DbPort, type PoolRead, collect, emptyMemory, readPool } from "../src/collect";
import { loadConfig } from "../src/config";
import { evaluate } from "../src/rules";
import { POOL_RULES, poolEpochInGrace, poolEpochOverdue, poolFirstLossLow, poolMarketDebt, poolUtilisation } from "../src/rules-pool";
import type { Condition, PoolSnap } from "../src/types";
import { NOW, NOW_S, NVDA_MKT, TSLA_MKT, book, pool, poolBook, rules, snap } from "./fixtures";

const ks = (cs: Condition[]) => cs.map((c) => [c.key, c.severity]);
const poolKeys = (cs: Condition[]) => cs.filter((c) => c.rule.startsWith("pool_")).map((c) => c.key);

describe("absent / unreadable pool", () => {
  test("the healthy pool fixture raises nothing", () => {
    for (const rule of Object.values(POOL_RULES)) expect(rule(snap(), rules())).toEqual([]);
  });
  test("no insurancePool in the deployment (null) or a failed read (undefined): every pool rule is quiet", () => {
    const bad = pool({ utilisationBps: 9900, firstLossBps: 0, firstLossUsd: 0, procEndsAt: NOW_S - 200_000, pendingShares: 5 });
    expect(poolKeys(evaluate(snap({ pool: bad }), rules())).length).toBeGreaterThan(0);
    for (const p of [null, undefined]) {
      expect(poolKeys(evaluate(snap({ pool: p }), rules()))).toEqual([]);
      const { pool: _drop, ...rest } = snap();
      expect(poolKeys(evaluate(rest as ReturnType<typeof snap>, rules()))).toEqual([]);
    }
  });
});

describe("pool_utilisation", () => {
  test("at the threshold quiet; above it warning (forSec 300); at the critical level critical", () => {
    expect(poolUtilisation(snap({ pool: pool({ utilisationBps: 9000 }) }), rules())).toEqual([]);
    const w = poolUtilisation(snap({ pool: pool({ utilisationBps: 9001, claimsUsd: 900_100, freeLiquidityUsd: 99_900 }) }), rules());
    expect(ks(w)).toEqual([["pool_utilisation", "warning"]]);
    expect(w[0]!.forSec).toBe(300);
    expect(w[0]!.summary).toContain("90.0%");
    expect(w[0]!.summary).toContain("$99,900.00");
    expect(ks(poolUtilisation(snap({ pool: pool({ utilisationBps: 9800 }) }), rules()))).toEqual([["pool_utilisation", "critical"]]);
  });
  test("an empty pool (poolAssets 0) is quiet; thresholds from env", () => {
    expect(poolUtilisation(snap({ pool: pool({ poolAssetsUsd: 0, utilisationBps: 9999 }) }), rules())).toEqual([]);
    const c = loadConfig({ NETWORK: "testnet", ALERT_POOL_UTILISATION_BPS: "8000", ALERT_POOL_UTILISATION_CRITICAL_BPS: "9000" }).rules;
    expect(ks(poolUtilisation(snap({ pool: pool({ utilisationBps: 8500 }) }), c))).toEqual([["pool_utilisation", "warning"]]);
    expect(rules().poolUtilisationBps).toBe(9000);
    expect(rules().poolUtilisationCriticalBps).toBe(9800);
  });
});

describe("pool epochs (pool_epoch_overdue / pool_epoch_in_grace)", () => {
  const END = NOW_S - 3_600; // the epoch ended 1 h ago
  /** an ended epoch holding 100 withdrawal shares */
  const queued = (over: Partial<PoolSnap> = {}) => pool({ procEndsAt: END, pendingShares: 100, epoch: { withdrawShares: 100, depositUsd: 0, processed: false }, ...over });
  const both = (p: PoolSnap) => [...poolEpochInGrace(snap({ pool: p }), rules()), ...poolEpochOverdue(snap({ pool: p }), rules())];
  const endedAgo = (sec: number, over: Partial<PoolSnap> = {}) => queued({ procEndsAt: NOW_S - sec, ...over });
  const stale = (sec: number, over: Partial<PoolSnap> = {}) =>
    endedAgo(sec, { staleBooks: 1, books: [poolBook({ lastMarkAt: NOW_S - sec - 100 }), poolBook({ bookId: 4, lastMarkAt: NOW_S })], activeBookIds: [3, 4], ...over });

  test("nothing queued (an idle queue skips epochs by itself) or the epoch not ended: quiet", () => {
    expect(both(pool({ procEndsAt: NOW_S - 300_000 }))).toEqual([]);
    expect(both(queued({ procEndsAt: NOW_S + 60 }))).toEqual([]);
    expect(both(queued({ procEndsAt: NOW_S }))).toEqual([]); // ended now: within the threshold
  });

  test("every book marked: overdue warning past 2 h, critical once past procEndsAt + processGrace", () => {
    expect(both(endedAgo(7_200))).toEqual([]);
    const w = both(endedAgo(7_201));
    expect(ks(w)).toEqual([["pool_epoch_overdue:5", "warning"]]);
    expect(w[0]!.summary).toContain("100 withdrawal shares");
    expect(w[0]!.summary).toContain("open to anyone");
    expect(ks(both(endedAgo(86_399)))).toEqual([["pool_epoch_overdue:5", "warning"]]);
    expect(ks(both(endedAgo(86_400)))).toEqual([["pool_epoch_overdue:5", "critical"]]);
    // deposits only, or unfilled withdrawals of an older epoch, count as queued too
    expect(ks(both(endedAgo(7_201, { pendingShares: 0, depositsPendingUsd: 500, epoch: { withdrawShares: 0, depositUsd: 500, processed: false } })))).toEqual([["pool_epoch_overdue:5", "warning"]]);
    const fill = both(endedAgo(7_201, { pendingShares: 3, fillEpoch: 4, epoch: { withdrawShares: 0, depositUsd: 0, processed: false } }));
    expect(fill[0]!.summary).toContain("unfilled withdrawals from epoch 4");
  });

  test("books not marked since the end: in_grace warning (after the mark grace) naming them; overdue suppressed until the grace ends", () => {
    expect(both(stale(899))).toEqual([]); // testnet mark grace 900 s
    const g = both(stale(3_600));
    expect(ks(g)).toEqual([["pool_epoch_in_grace:5", "warning"]]);
    expect(g[0]!.summary).toContain("1 active book(s) have not marked since its end");
    expect(g[0]!.summary).toContain("book 3 NVDA");
    expect(g[0]!.summary).not.toContain("book 4");
    // long past the overdue threshold but still in grace: one warning, never two pages for the same epoch
    expect(ks(both(stale(80_000)))).toEqual([["pool_epoch_in_grace:5", "warning"]]);
  });

  test("grace boundary: one second before the grace end in_grace, at it overdue critical (processable by anyone)", () => {
    expect(ks(both(stale(86_399)))).toEqual([["pool_epoch_in_grace:5", "warning"]]);
    const c = both(stale(86_400));
    expect(ks(c)).toEqual([["pool_epoch_overdue:5", "critical"]]);
    expect(c[0]!.summary).toContain("anyone can process it (stale)");
    // a shorter on-chain grace (1 h) moves the boundary
    expect(ks(both(stale(3_600, { processGraceSec: 3_600 })))).toEqual([["pool_epoch_overdue:5", "critical"]]);
    expect(ks(both(stale(3_599, { processGraceSec: 3_600 })))).toEqual([["pool_epoch_in_grace:5", "warning"]]);
  });

  test("staleBooks unreadable: no in_grace; overdue warning past 2 h, critical after the grace", () => {
    expect(both(stale(3_600, { staleBooks: null }))).toEqual([]);
    expect(ks(both(stale(7_201, { staleBooks: null })))).toEqual([["pool_epoch_overdue:5", "warning"]]);
    expect(ks(both(stale(86_400, { staleBooks: null })))).toEqual([["pool_epoch_overdue:5", "critical"]]);
  });

  test("the oldest epoch empty, requests only in later epochs: not gated, overdue capped at warning", () => {
    const empty = { staleBooks: 2, epoch: { withdrawShares: 0, depositUsd: 0, processed: false } };
    expect(both(endedAgo(3_600, empty))).toEqual([]);
    const w = both(endedAgo(200_000, empty));
    expect(ks(w)).toEqual([["pool_epoch_overdue:5", "warning"]]);
    expect(w[0]!.summary).toContain("nothing in it, but later epochs hold 100 withdrawal shares");
  });

  test("ALERT_POOL_EPOCH_OVERDUE_SECONDS / ALERT_POOL_GRACE_WARN_SECONDS; per-network grace default", () => {
    const c = loadConfig({ NETWORK: "testnet", ALERT_POOL_EPOCH_OVERDUE_SECONDS: "600", ALERT_POOL_GRACE_WARN_SECONDS: "60" }).rules;
    expect(ks(poolEpochOverdue(snap({ pool: endedAgo(601) }), c))).toEqual([["pool_epoch_overdue:5", "warning"]]);
    expect(ks(poolEpochInGrace(snap({ pool: stale(61) }), c))).toEqual([["pool_epoch_in_grace:5", "warning"]]);
    expect(rules().poolEpochOverdueSec).toBe(7_200);
    expect(rules().poolGraceWarnSec).toBe(900);
    expect(loadConfig({ NETWORK: "mainnet" }).rules.poolGraceWarnSec).toBe(3_600);
  });
});

describe("pool_market_debt / pool_debt_written_off / pool_book_unrepaid", () => {
  const run = (p: PoolSnap, over = {}) => poolMarketDebt(snap({ pool: p }), rules(over));

  test("a market with no debt (claim == allocation) is quiet", () => {
    expect(run(pool())).toEqual([]);
    expect(run(pool({ books: [poolBook(), poolBook({ bookId: 4, market: TSLA_MKT, claimUsd: 30_000 })] }))).toEqual([]);
  });

  test("active books' marked-down debt: warning per market, labelled by the snapshot's ticker; critical at 5% of pool assets", () => {
    const p = pool({ books: [poolBook({ claimUsd: 25_000, lossFirstLossUsd: 5_000 }), poolBook({ bookId: 5, allocationUsd: 20_000, claimUsd: 19_000, lossFirstLossUsd: 1_000 })] });
    const w = run(p);
    expect(ks(w)).toEqual([[`pool_market_debt:${NVDA_MKT}`, "warning"]]);
    expect(w[0]!.summary).toContain("market NVDA: provisional loss of $6,000.00 of IF debt on 2 active exhausted book(s)");
    expect(w[0]!.summary).toContain("final only at retirement");
    expect(w[0]!.summary).toContain("book 3 NVDA $5,000.00 of $30,000.00");
    expect(w[0]!.summary).toContain("book 5 $1,000.00"); // not in the books snapshot: id only
    expect(w[0]!.summary).toContain("first-loss slice $6,000.00");
    const c = run(pool({ books: [poolBook({ allocationUsd: 80_000, claimUsd: 30_000 })] }));
    expect(ks(c)).toEqual([[`pool_market_debt:${NVDA_MKT}`, "critical"]]);
    expect(ks(run(pool({ books: [poolBook({ allocationUsd: 80_000, claimUsd: 30_000 })] }), { poolMarketDebtCriticalBps: 600 }))).toEqual([[`pool_market_debt:${NVDA_MKT}`, "warning"]]);
  });

  test("a market no snapshot book is on: labelled with the bytes32 hex", () => {
    const w = poolMarketDebt(snap({ books: [book()], pool: pool({ books: [poolBook({ bookId: 9, market: TSLA_MKT, claimUsd: 29_000 })] }) }), rules());
    expect(ks(w)).toEqual([[`pool_market_debt:${TSLA_MKT}`, "warning"]]);
    expect(w[0]!.summary).toContain(`market ${TSLA_MKT}:`);
    expect(poolMarketDebt(snap({ books: null, pool: pool({ books: [poolBook({ claimUsd: 29_000 })] }) }), rules())[0]!.summary).toContain(`market ${NVDA_MKT}:`);
  });

  test("a retired book's write-off: one-off critical while the final mark is younger than 7 d; it never keeps the market alert firing", () => {
    const retired = poolBook({ active: false, claimUsd: 0, allocationUsd: 12_000, lossFirstLossUsd: 12_000, lastMarkAt: NOW_S - 3_600 });
    const c = run(pool({ books: [retired] }));
    expect(ks(c)).toEqual([["pool_debt_written_off:3", "critical"]]);
    expect(c[0]!.notifyResolve).toBe(false);
    expect(c[0]!.summary).toContain("book 3 NVDA retired with $12,000.00");
    expect(run(pool({ books: [{ ...retired, lastMarkAt: NOW_S - 604_801 }] }))).toEqual([]);
    // with active debt on the same market, the write-off is quoted in the market alert
    const m = run(pool({ books: [{ ...retired, lastMarkAt: NOW_S - 700_000 }, poolBook({ bookId: 4, claimUsd: 29_000 })] }));
    expect(ks(m)).toEqual([[`pool_market_debt:${NVDA_MKT}`, "warning"]]);
    expect(m[0]!.summary).toContain("$12,000.00 written off for good on retired books");
  });

  test("a retired book still owing its claim: warning 6 h after its final mark", () => {
    const owed = poolBook({ active: false, claimUsd: 30_000, lastMarkAt: NOW_S - 21_600 });
    expect(run(pool({ books: [owed] }))).toEqual([]);
    const w = run(pool({ books: [{ ...owed, lastMarkAt: NOW_S - 21_601 }] }));
    expect(ks(w)).toEqual([["pool_book_unrepaid:3", "warning"]]);
    expect(w[0]!.summary).toContain("still owes the insurance pool $30,000.00");
    expect(w[0]!.summary).toContain("Book.settleInsurance()");
    expect(ks(run(pool({ books: [{ ...owed, lastMarkAt: NOW_S - 3_600 }] }), { poolUnrepaidSec: 600 }))).toEqual([["pool_book_unrepaid:3", "warning"]]);
  });
});

describe("pool_first_loss_low", () => {
  test("at target quiet; below it warning (forSec 300); empty slice with claims critical; empty pool quiet", () => {
    expect(poolFirstLossLow(snap({ pool: pool({ firstLossBps: 1000 }) }), rules())).toEqual([]);
    const w = poolFirstLossLow(snap({ pool: pool({ firstLossBps: 999, firstLossUsd: 99_900 }) }), rules());
    expect(ks(w)).toEqual([["pool_first_loss_low", "warning"]]);
    expect(w[0]!.forSec).toBe(300);
    expect(w[0]!.summary).toContain("(target 10.0%)");
    const c = poolFirstLossLow(snap({ pool: pool({ firstLossBps: 0, firstLossUsd: 0 }) }), rules());
    expect(ks(c)).toEqual([["pool_first_loss_low", "critical"]]);
    expect(c[0]!.summary).toContain("EMPTY with $300,000.00 of claims outstanding");
    expect(ks(poolFirstLossLow(snap({ pool: pool({ firstLossBps: 0, firstLossUsd: 0, claimsUsd: 0 }) }), rules()))).toEqual([["pool_first_loss_low", "warning"]]);
    expect(poolFirstLossLow(snap({ pool: pool({ poolAssetsUsd: 0, firstLossBps: 0, firstLossUsd: 0 }) }), rules())).toEqual([]);
  });
});

describe("registered in RULES, copy rules", () => {
  test("evaluate runs them; ALERT_DISABLE switches one off", () => {
    const s = snap({ pool: pool({ utilisationBps: 9500 }) });
    expect(evaluate(s, rules()).map((c) => c.key)).toContain("pool_utilisation");
    expect(evaluate(s, rules({ disabled: new Set(["pool_utilisation"]) })).map((c) => c.key)).not.toContain("pool_utilisation");
  });
  test("no summary uses words reserved for user copy", () => {
    const p = pool({
      utilisationBps: 9900,
      firstLossBps: 0,
      firstLossUsd: 0,
      procEndsAt: NOW_S - 3_600,
      pendingShares: 1,
      epoch: { withdrawShares: 1, depositUsd: 0, processed: false },
      staleBooks: 1,
      books: [poolBook({ claimUsd: 1, lastMarkAt: NOW_S - 7_200 }), poolBook({ bookId: 4, active: false, claimUsd: 5, lastMarkAt: NOW_S - 30_000 })],
    });
    const all = [...Object.values(POOL_RULES).flatMap((r) => r(snap({ pool: p }), rules())), ...poolEpochOverdue(snap({ pool: { ...p, staleBooks: 0, procEndsAt: NOW_S - 90_000 } }), rules())];
    expect(new Set(all.map((c) => c.rule))).toEqual(new Set(["pool_utilisation", "pool_epoch_in_grace", "pool_epoch_overdue", "pool_market_debt", "pool_debt_written_off", "pool_book_unrepaid", "pool_first_loss_low"]));
    for (const c of all) expect(c.summary).not.toMatch(/\b(APY|APR|yield|guaranteed|insured|risk-free)\b/i);
  });
});

describe("readPool / collect", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const position = (over: Record<string, unknown> = {}) => ({
    book: "0x00000000000000000000000000000000000000c3",
    vault: "0x00000000000000000000000000000000000000c4",
    router: "0x00000000000000000000000000000000000000c5",
    market: NVDA_MKT.toUpperCase().replace("0X", "0x"),
    allocation: 30_000_000_000n,
    claim: 25_000_000_000n,
    lossFirstLoss: 5_000_000_000n,
    lossDepositors: 0n,
    lastMarkAt: BigInt(NOW_S - 600),
    active: true,
    ...over,
  });
  const views: Record<string, (args?: readonly unknown[]) => unknown> = {
    poolAssets: () => 1_000_000_000_000n,
    freeLiquidity: () => 700_000_000_000n,
    claimsTotal: () => 300_000_000_000n,
    firstLossAssets: () => 120_000_000_000n,
    utilisationBps: () => 3000n,
    firstLossBps: () => 1200n,
    params: () => [1200, 3000, 2000, 1000, 604_800, 604_800, 86_400, 0],
    queue: () => [5n, BigInt(NOW_S - 3_600), 5n, 2_500_000_000_000n, 0n],
    ledger: () => [700_000_000_000n, 0n, 1_500_000n, 9n, 0n],
    activeBooks: () => [3n, 7n],
    epochInfo: (a) => (a?.[0] === 5n ? { shares: 2_500_000_000_000n, filledShares: 0n, assets: 0n, depositAssets: 1_500_000n, depositShares: 0n, endsAt: 0n, processed: false } : null),
    staleBooks: (a) => (a?.[0] === BigInt(NOW_S - 3_600) ? 1n : 99n),
    bookPosition: (a) => {
      const id = a?.[0];
      if (id === 3n) return position();
      if (id === 4n) return position({ book: ZERO }); // never allocated
      if (id === 6n) return position({ active: false, claim: 0n, lastMarkAt: BigInt(NOW_S - 86_400) });
      throw new Error(`execution reverted for ${String(id)}`);
    },
  };
  const read: PoolRead = async (fn, args) => {
    const v = views[fn];
    if (!v) throw new Error(`unknown view ${fn}`);
    return v(args);
  };

  test("assembles the views (6dp -> dollars, 12-decimal shares); zero-address and failed positions are dropped", async () => {
    const p = await readPool(read, "0xpool", [3, 4, 6]);
    expect(p).toMatchObject({
      poolAssetsUsd: 1_000_000,
      freeLiquidityUsd: 700_000,
      claimsUsd: 300_000,
      firstLossUsd: 120_000,
      utilisationBps: 3000,
      firstLossBps: 1200,
      firstLossTargetBps: 1000,
      epochLengthSec: 604_800,
      processGraceSec: 86_400,
      procEpoch: 5,
      procEndsAt: NOW_S - 3_600,
      fillEpoch: 5,
      pendingShares: 2.5,
      depositsPendingUsd: 1.5,
      epoch: { withdrawShares: 2.5, depositUsd: 1.5, processed: false },
      staleBooks: 1,
      activeBookIds: [3, 7],
    });
    // 3 (active, also in the snapshot), 6 (retired, only in the snapshot); 4 never allocated; 7's read failed
    expect(p.books.map((b) => [b.bookId, b.active, b.allocationUsd, b.claimUsd, b.market])).toEqual([
      [3, true, 30_000, 25_000, NVDA_MKT],
      [6, false, 30_000, 0, NVDA_MKT],
    ]);
  });

  test("epochInfo / staleBooks failing: null, the rest still read; a core view failing throws", async () => {
    const partial: PoolRead = async (fn, args) => (fn === "epochInfo" || fn === "staleBooks" ? Promise.reject(new Error("timeout")) : read(fn, args));
    const p = await readPool(partial, "0xpool", []);
    expect(p.epoch).toBeNull();
    expect(p.staleBooks).toBeNull();
    expect(p.books.map((b) => b.bookId)).toEqual([3]);
    const broken: PoolRead = async (fn, args) => (fn === "queue" ? Promise.reject(new Error("timeout")) : read(fn, args));
    await expect(readPool(broken, "0xpool", [])).rejects.toThrow("timeout");
  });

  const db: DbPort = {
    books: async () => [{ id: 3, name: "NVDA", symbol: "PERP_NVDA_USDC", state: "Live", venue: 0, subscriptionEnds: new Date(NOW - 86_400_000) }],
    latestMarkPeriodEnds: async () => [],
    killsSince: async () => [],
    cursors: async () => [],
  };
  const kv = { get: async () => null, mget: async (k: string[]) => k.map(() => null) };
  const chain: ChainPort = { head: async () => ({ number: 1, timestamp: NOW_S }), balance: async () => 0n, buybackPending: async () => null, markInterval: async () => 3600 };
  const settings = { network: "testnet", chainId: 46630, apiUrl: "http://api", markIntervalSec: 300, roles: [], rpcWindowSec: 900 };
  const okFetch = (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch;
  const run = (c: ChainPort) => collect({ db, kv, chain: c, fetch: okFetch, now: () => NOW }, settings, emptyMemory(), 86_400).then((r) => r.snapshot.pool);

  test("collect: the snapshot's book ids go to the pool port; no port or no pool = null; a failed read = undefined", async () => {
    let asked: number[] = [];
    expect(await run({ ...chain, pool: async (ids) => ((asked = ids), pool()) })).toEqual(pool());
    expect(asked).toEqual([3]);
    expect(await run(chain)).toBeNull();
    expect(await run({ ...chain, pool: async () => null })).toBeNull();
    expect(await run({ ...chain, pool: async () => Promise.reject(new Error("timeout")) })).toBeUndefined();
  });
});
