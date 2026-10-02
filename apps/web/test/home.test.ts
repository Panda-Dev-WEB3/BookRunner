import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { faqItems } from "../src/components/home/faqContent";
import { type HomeBook, depositHeadline, depositOpen, depositStatus, fmtDayUtc, marketInfo, roundFill, sharePct, summarizeBooks, trancheSplit } from "../src/components/home/model";
import { isGlossaryId } from "../src/lib/glossary";
import type { TopUpRound } from "../src/lib/topup";

const schedule = (nextPeriodEnd: number, status = "scheduled") => ({ nextPeriodEnd, intervalSeconds: 3600, cadence: "hourly", status });

const book = (over: Partial<HomeBook> & Pick<HomeBook, "bookId" | "symbol">): HomeBook => ({
  venue: "orderly",
  state: "Live",
  navUsd: "100000.000000",
  seniorNavUsd: "70000.000000",
  juniorNavUsd: "30000.000000",
  subscriptionEnds: "2026-10-02T13:41:32.000Z",
  lastMark: { committedAt: "2026-10-02T17:00:37.000Z" },
  markSchedule: schedule(1_790_964_000),
  ...over,
});

describe("summarizeBooks", () => {
  test("sums marked NAV exactly and counts live books in book order", () => {
    const s = summarizeBooks([
      book({ bookId: 3, symbol: "RHX5-PERP", venue: "pool_engine", navUsd: "130302.312290", seniorNavUsd: "91048.565287", juniorNavUsd: "39253.747003" }),
      book({ bookId: 1, symbol: "PERP_NVDA_USDC", navUsd: "105579.387613", seniorNavUsd: "73518.963306", juniorNavUsd: "32060.424307" }),
      book({ bookId: 2, symbol: "PERP_TSLA_USDC", state: "Subscription", navUsd: null, seniorNavUsd: null, juniorNavUsd: null, lastMark: null }),
    ]);
    expect(s.total).toBe(3);
    expect(s.live).toBe(2);
    expect(s.liveTickers).toEqual(["NVDA", "RHX5"]);
    expect(s.navRaw).toBe(235_881_699_903n);
    expect(s.seniorRaw).toBe(164_567_528_593n);
    expect(s.juniorRaw).toBe(71_314_171_310n);
    expect(s.hasNav).toBe(true);
  });

  test("latest mark is the newest commit; next mark the soonest among marked books", () => {
    const s = summarizeBooks([
      book({ bookId: 1, symbol: "PERP_NVDA_USDC", lastMark: { committedAt: "2026-10-02T17:00:37.000Z" }, markSchedule: schedule(1_790_967_600) }),
      book({ bookId: 2, symbol: "PERP_TSLA_USDC", lastMark: { committedAt: "2026-10-02T17:01:03.000Z" }, markSchedule: schedule(1_790_964_000, "due") }),
      // a subscription book is not marked yet: its schedule is ignored
      book({ bookId: 4, symbol: "PERP_AAPL_USDC", state: "Subscription", lastMark: null, markSchedule: schedule(1_790_000_000) }),
    ]);
    expect(s.latestMarkAt).toBe("2026-10-02T17:01:03.000Z");
    expect(s.nextMark).toEqual({ nextPeriodEnd: 1_790_964_000, cadence: "hourly", intervalSeconds: 3600, status: "due" });
  });

  test("empty and unmarked lists", () => {
    const s = summarizeBooks([]);
    expect(s).toMatchObject({ total: 0, live: 0, navRaw: 0n, hasNav: false, latestMarkAt: null, nextMark: null });
    const u = summarizeBooks([book({ bookId: 1, symbol: "X", navUsd: null, lastMark: { committedAt: null } })]);
    expect(u.hasNav).toBe(false);
    expect(u.latestMarkAt).toBeNull();
  });
});

describe("tranche split", () => {
  test("fractions of the sum", () => {
    const s = trancheSplit(70n, 30n);
    expect(s?.senior).toBe(0.7);
    expect(s?.junior).toBeCloseTo(0.3, 10);
    expect(trancheSplit(0n, 0n)).toBeNull();
    expect(trancheSplit(0n, 5n)).toEqual({ senior: 0, junior: 1 });
    expect(trancheSplit(-5n, 5n)).toEqual({ senior: 0, junior: 1 });
  });

  test("percent labels never hide a non-zero share", () => {
    expect(sharePct(0.7)).toBe("70%");
    expect(sharePct(0.004)).toBe("<1%");
    expect(sharePct(0.996)).toBe(">99%");
    expect(sharePct(1)).toBe("100%");
    expect(sharePct(0)).toBe("0%");
    expect(sharePct(Number.NaN)).toBe("0%");
  });
});

describe("marketInfo", () => {
  test("describes the launch markets", () => {
    expect(marketInfo("PERP_NVDA_USDC")).toMatchObject({ ticker: "NVDA", kind: "stock" });
    expect(marketInfo("PERP_TSLA_USDC")).toMatchObject({ ticker: "TSLA", kind: "stock" });
    const idx = marketInfo("RHX5-PERP");
    expect(idx.kind).toBe("index");
    expect(idx.components).toEqual(["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"]);
  });

  test("falls back for unknown markets, and every description passes the copy rules", () => {
    const m = marketInfo("PERP_AAPL_USDC");
    expect(m).toMatchObject({ ticker: "AAPL", kind: "other", name: "AAPL perp" });
    for (const s of ["PERP_NVDA_USDC", "PERP_TSLA_USDC", "RHX5-PERP", "PERP_AAPL_USDC"]) {
      const info = marketInfo(s);
      expect(checkCopy(`${info.name}\n${info.blurb}`)).toEqual([]);
    }
  });
});

describe("depositStatus", () => {
  const now = 1_790_961_000;
  const round = (over: Partial<TopUpRound> = {}): TopUpRound => ({ bookId: 1, open: true, endsAt: 1_793_491_200, seniorCapacityUsd: 100_000_000_000n, juniorCapacityUsd: 100_000_000_000n, ...over });

  test("open top-up round on a live book", () => {
    const s = depositStatus({ state: "Live" }, round(), now);
    expect(s).toEqual({ kind: "topup", endsAt: 1_793_491_200, seniorCapacity: 100_000_000_000n, juniorCapacity: 100_000_000_000n });
    expect(depositOpen(s)).toBe(true);
    expect(depositHeadline(s)).toBe("Deposits open until 1 Nov 2026");
  });

  test("closed, full, loading and unreadable rounds", () => {
    expect(depositStatus({ state: "Live" }, round({ open: false }), now)).toEqual({ kind: "closed", reason: "no-round" });
    expect(depositStatus({ state: "Live" }, round({ endsAt: now }), now)).toEqual({ kind: "closed", reason: "no-round" });
    expect(depositStatus({ state: "Live" }, round({ seniorCapacityUsd: 0n, juniorCapacityUsd: 0n }), now)).toEqual({ kind: "closed", reason: "full" });
    expect(depositStatus({ state: "Live" }, round({ seniorCapacityUsd: 0n }), now).kind).toBe("topup");
    expect(depositStatus({ state: "Live" }, undefined, now)).toEqual({ kind: "checking" });
    expect(depositStatus({ state: "Live" }, null, now)).toEqual({ kind: "closed", reason: "unknown" });
  });

  test("subscription window and other states", () => {
    const open = depositStatus({ state: "Subscription", subscriptionEnds: "2026-10-03T00:00:00.000Z" }, undefined, now);
    expect(open).toEqual({ kind: "window", endsAt: 1_790_985_600 });
    expect(depositHeadline(open)).toBe("Subscription window open until 3 Oct 2026");
    expect(depositStatus({ state: "Subscription", subscriptionEnds: "2026-10-01T00:00:00.000Z" }, undefined, now)).toEqual({ kind: "closed", reason: "window-ended" });
    expect(depositStatus({ state: "Subscription", subscriptionEnds: null }, undefined, now)).toEqual({ kind: "closed", reason: "window-ended" });
    for (const state of ["Retiring", "Retired", "Cancelled"]) expect(depositStatus({ state }, round(), now)).toEqual({ kind: "closed", reason: "not-live" });
  });

  test("every headline passes the copy rules", () => {
    const all = [
      depositStatus({ state: "Live" }, round(), now),
      depositStatus({ state: "Live" }, undefined, now),
      ...(["full", "no-round", "window-ended", "not-live", "unknown"] as const).map((reason) => ({ kind: "closed" as const, reason })),
      { kind: "window" as const, endsAt: now + 60 },
    ];
    for (const s of all) {
      const h = depositHeadline(s);
      expect(h.length).toBeGreaterThan(0);
      expect(checkCopy(h)).toEqual([]);
    }
  });
});

describe("fmtDayUtc", () => {
  test("formats in UTC", () => {
    expect(fmtDayUtc(1_793_491_200)).toBe("1 Nov 2026");
    expect(fmtDayUtc(0)).toBe("1 Jan 1970");
    expect(fmtDayUtc(Number.NaN)).toBe("—");
  });
});

describe("roundFill", () => {
  test("committed share of a round's capacity, capped, with oversubscription flagged", () => {
    expect(roundFill(25_000_000_000n, 100_000_000_000n)).toEqual({ frac: 0.25, over: false });
    expect(roundFill(0n, 100_000_000_000n)).toEqual({ frac: 0, over: false });
    expect(roundFill(150_000_000_000n, 100_000_000_000n)).toEqual({ frac: 1, over: true });
    expect(roundFill(100_000_000_000n, 100_000_000_000n)).toEqual({ frac: 1, over: false });
    expect(roundFill(5n, 0n)).toBeNull();
  });
});

describe("FAQ", () => {
  const contexts = [
    { testnet: true, chainName: "Robinhood Chain Testnet", chainId: 46630 },
    { testnet: false, chainName: "Robinhood Chain", chainId: 4663 },
  ];
  for (const ctx of contexts) {
    test(`8 to 10 questions, unique ids, copy rules (${ctx.testnet ? "testnet" : "mainnet"})`, () => {
      const items = faqItems(ctx);
      expect(items.length).toBeGreaterThanOrEqual(8);
      expect(items.length).toBeLessThanOrEqual(10);
      expect(new Set(items.map((f) => f.id)).size).toBe(items.length);
      for (const f of items) {
        expect(f.question.endsWith("?")).toBe(true);
        expect(f.answer.length).toBeGreaterThan(0);
        for (const t of f.terms ?? []) expect(isGlossaryId(t)).toBe(true);
        const text = [f.question, ...f.answer, ...(f.links ?? []).map((l) => l.label)];
        for (const line of text) expect(checkCopy(line)).toEqual([]);
      }
    });
  }

  test("covers the questions a newcomer asks first", () => {
    const ids = faqItems(contexts[0]!).map((f) => f.id);
    for (const id of ["perp", "money", "lose", "nav", "withdraw", "testnet", "agent", "bkrn"]) expect(ids).toContain(id);
    expect(faqItems(contexts[1]!).map((f) => f.id)).not.toContain("testnet");
  });
});
