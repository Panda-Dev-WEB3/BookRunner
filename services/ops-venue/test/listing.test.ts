// ORDERLY_LISTING_MODE (docs/VERIFY.md O20): manual = the admin lists each market in Orderly One, ops-venue never calls a
// listing / symbol-status endpoint and follows the market on /v1/public/info (backoff, per symbol, timeout, bounded
// concurrency); api = today's createSymbol. In both modes a book whose market is not listed never blocks another book.
// Phases: unknown -> awaiting -> listed (open or restricted) -> missing (never back to awaiting).
import { describe, expect, test } from "bun:test";
import { ACCOUNT, type Logger, parseVenueMarkets, type VenueSymbolIssuesMsg, venueMarketGate } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { builderFeedTargets } from "../src/builderOracle/feed";
import { OrderlyBuilderClient } from "../src/client";
import { loadOpsEnv, resolveListingMode } from "../src/config";
import { keyFromSecret } from "../src/orderly/auth";
import type { FetchLike } from "../src/orderly/http";
import { OrderlyHttpError } from "../src/orderly/http";
import type { OpsContext, TrackedBook } from "../src/worker/context";
import { type ListingInfo, listingPhase, ListingTracker } from "../src/worker/listing";
import { OpsService } from "../src/worker/service";
import { ADAPTER, BUILDER_ID, IF_ID, makeCtx, MM_ID, OPS, provisioner, setupWithdraw, SYMBOL, trackedBook } from "./helpers";

const TSLA = "PERP_TSLA_USDC";
const ADAPTER2 = "0x00000000000000000000000000000000000b0b01" as Address;
const IF2 = `0x${"c3".repeat(32)}` as Hex;
const MM2 = `0x${"d4".repeat(32)}` as Hex;

function tslaBook(): TrackedBook {
  return { ...trackedBook(), bookId: 2, book: "0x00000000000000000000000000000000000b0b00", adapter: ADAPTER2, mandate: "0x00000000000000000000000000000000000b0b02", charterSymbol: TSLA, symbol: TSLA, baseAsset: "TSLA", accounts: { if: IF2, mm: MM2 }, owners: { if: ADAPTER2, mm: ADAPTER2 } };
}

/** Logger capturing (level, msg) pairs. */
function captureLog() {
  const lines: Array<{ level: string; msg: string; o: Record<string, unknown> }> = [];
  const at = (level: string) => (o: Record<string, unknown> | string, msg?: string) => {
    lines.push({ level, msg: typeof o === "string" ? o : (msg ?? ""), o: typeof o === "string" ? {} : o });
  };
  const log = { trace: at("trace"), debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), fatal: at("fatal"), child: () => log } as unknown as Logger;
  return { log, lines };
}

/** Two Orderly books (NVDA = book 1, TSLA = book 2) with their own venue accounts; status messages captured. */
async function twoBooks(listingMode: "api" | "manual", o: { createFails?: string } = {}) {
  let now = 1_800_000_000_000;
  const t = await makeCtx({ listingMode, now: () => now });
  t.chain.books = [trackedBook(), tslaBook()];
  t.chain.accountIds = async (adapter?: Address) => (adapter?.toLowerCase() === ADAPTER2.toLowerCase() ? { if: IF2, mm: MM2 } : { if: IF_ID, mm: MM_ID });
  const statuses: VenueSymbolIssuesMsg[] = [];
  t.ctx.status = { venueSymbolIssues: async (m) => void statuses.push(m) };
  const cap = captureLog();
  t.ctx.log = cap.log;
  const calls = { createSymbol: [] as string[], setSymbolStatus: [] as string[], listingStatus: [] as string[] };
  const b = t.builder;
  const create = b.createSymbol.bind(b);
  const setStatus = b.setSymbolStatus.bind(b);
  const listing = b.listingStatus.bind(b);
  b.createSymbol = async (p) => {
    calls.createSymbol.push(p.symbol);
    if (p.symbol === o.createFails) throw new OrderlyHttpError(400, -1000, "POST /v1/builder/symbol: listing rejected", "/v1/builder/symbol");
    return create(p);
  };
  b.setSymbolStatus = async (s, st) => {
    calls.setSymbolStatus.push(`${s}:${st}`);
    return setStatus(s, st);
  };
  b.listingStatus = async (s) => {
    calls.listingStatus.push(s);
    return listing(s);
  };
  const svc = new OpsService(t.ctx, await provisioner(t));
  /** The admin lists the market in Orderly One (mock: symbol + IF account, IF funded above the requirement -> ACTIVE). */
  const adminLists = (symbol: string, ifAccount: Hex) => {
    t.mock.venue.createSymbol({ symbol, ifAccountId: ifAccount });
    t.mock.venue.credit(ifAccount, 200_000_000);
  };
  const last = () => statuses.at(-1) as VenueSymbolIssuesMsg;
  const market = (symbol: string) => (last().markets ?? []).find((m) => m.symbol === symbol);
  return { ...t, svc, calls, statuses, adminLists, logs: cap.lines, advance: (ms: number) => (now += ms), last, market };
}

/** Bare tracker over a scripted listingStatus (manual clock): the schedule without the books loop. */
function bareTracker(answer: (symbol: string) => Promise<{ listed: boolean; status: string | null }>, schedule: Partial<ConstructorParameters<typeof ListingTracker>[1]> = {}, everListed?: OpsContext["everListed"]) {
  let now = 0;
  const calls: Array<{ symbol: string; at: number }> = [];
  const cap = captureLog();
  const ctx = {
    settings: { mode: "live", brokerId: "bookrunner", listingMode: "manual" },
    builder: {
      listingStatus: async (s: string) => {
        calls.push({ symbol: s, at: now });
        return answer(s);
      },
    },
    log: cap.log,
    now: () => now,
    ...(everListed ? { everListed } : {}),
  } as unknown as OpsContext;
  const tr = new ListingTracker(ctx, schedule);
  const book = (bookId: number, symbol: string, state: TrackedBook["state"] = "Live") => ({ ...trackedBook(state), bookId, symbol });
  return { tr, calls, logs: cap.lines, book, set: (t: number) => (now = t), at: () => now };
}

describe("config", () => {
  test("ORDERLY_LISTING_MODE: api in mock mode, manual in live mode unless set; re-check / timeout / ceiling bounds", () => {
    expect(resolveListingMode(loadOpsEnv({ ORDERLY_MODE: "mock" }))).toBe("api");
    expect(resolveListingMode(loadOpsEnv({ ORDERLY_MODE: "live", ORDERLY_BASE_URL: "https://testnet-api.orderly.org" }))).toBe("manual");
    expect(resolveListingMode(loadOpsEnv({ ORDERLY_MODE: "live", ORDERLY_BASE_URL: "https://testnet-api.orderly.org", ORDERLY_LISTING_MODE: "api" }))).toBe("api");
    expect(resolveListingMode(loadOpsEnv({ ORDERLY_MODE: "mock", ORDERLY_LISTING_MODE: "manual" }))).toBe("manual");
    expect(() => loadOpsEnv({ ORDERLY_LISTING_MODE: "dashboard" })).toThrow();
    expect(() => loadOpsEnv({ OPS_LISTING_RECHECK_MS: "60000", OPS_LISTING_RECHECK_MAX_MS: "30000" })).toThrow("OPS_LISTING_RECHECK_MAX_MS");
    const e = loadOpsEnv({});
    expect([e.OPS_LISTING_CHECK_TIMEOUT_MS, e.OPS_LISTING_CHECK_CONCURRENCY, e.OPS_DELIST_WAIT_MAX_MS]).toEqual([5_000, 4, 86_400_000]);
  });
});

describe("listing phase (GET /v1/public/info/{symbol})", () => {
  test("never listed: absent / NEW / PENDING = awaiting; launched or undocumented = listed", () => {
    expect(listingPhase({ listed: false, status: null })).toBe("awaiting");
    expect(listingPhase({ listed: true, status: "NEW" })).toBe("awaiting");
    expect(listingPhase({ listed: true, status: "pending" })).toBe("awaiting");
    for (const s of ["POST_ONLY", "ACTIVE", "REDUCE_ONLY", "DELISTING", "DELISTED", "SOMETHING_NEW"]) expect(listingPhase({ listed: true, status: s })).toBe("listed");
    expect(listingPhase({ listed: true, status: null })).toBe("listed"); // a row without status (docs schema)
  });
  test("seen listed before: absent = missing (never awaiting again); a NEW / PENDING row stays listed (restricted)", () => {
    expect(listingPhase({ listed: false, status: null }, true)).toBe("missing");
    expect(listingPhase({ listed: true, status: "PENDING" }, true)).toBe("listed");
  });
});

describe("ListingTracker schedule (manual clock, no books loop)", () => {
  test("not listed: 15 s doubling to the 5 min cap; a listed open market every 5 min", async () => {
    let listed = false;
    const h = bareTracker(async () => ({ listed, status: listed ? "ACTIVE" : null }));
    const books = [h.book(1, "PERP_A_USDC_bookrunner")];
    for (let t = 0; t <= 800_000; t += 1_000) {
      h.set(t);
      await h.tr.check(books);
    }
    expect(h.calls.map((c) => c.at / 1000)).toEqual([0, 15, 45, 105, 225, 465, 765]);
    listed = true;
    h.calls.length = 0;
    for (let t = 801_000; t <= 1_800_000; t += 1_000) {
      h.set(t);
      await h.tr.check(books);
    }
    // due at 1065 (765 + 300): listed -> every 300 s
    expect(h.calls.map((c) => c.at / 1000)).toEqual([1065, 1365, 1665]);
  });

  test("everListed survives a restart (persisted): a delisted market stays missing, never awaiting again", async () => {
    const saved = new Set<string>();
    const store = { load: async () => [...saved], add: async (s: string) => void saved.add(s) };
    let listed = true;
    const sym = "PERP_A_USDC_bookrunner";
    const a = bareTracker(async () => ({ listed, status: listed ? "ACTIVE" : null }), {}, store);
    const booksA = [a.book(1, sym)];
    await a.tr.check(booksA);
    expect(booksA[0]?.listing).toMatchObject({ phase: "listed", everListed: true });
    expect([...saved]).toEqual([sym]);
    // ops-venue restarts (a fresh tracker, empty memory) while Orderly no longer lists the market
    listed = false;
    const b = bareTracker(async () => ({ listed, status: null }), {}, store);
    const booksB = [b.book(1, sym)];
    await b.tr.check(booksB);
    expect(booksB[0]?.listing).toMatchObject({ phase: "missing", everListed: true });
    // without the persisted set it would read "awaiting" (the bug)
    const c = bareTracker(async () => ({ listed: false, status: null }));
    const booksC = [c.book(1, sym)];
    await c.tr.check(booksC);
    expect(booksC[0]?.listing?.phase).toBe("awaiting");
    // an unreadable store: memory only, retried at the next check
    let fail = true;
    const flaky = { load: async () => (fail ? Promise.reject(new Error("redis down")) : [sym]), add: async () => {} };
    const d = bareTracker(async () => ({ listed: false, status: null }), { recheckMs: 1 }, flaky);
    const booksD = [d.book(1, sym)];
    await d.tr.check(booksD);
    expect(booksD[0]?.listing?.phase).toBe("awaiting");
    fail = false;
    d.set(10_000);
    await d.tr.check(booksD);
    expect(booksD[0]?.listing?.phase).toBe("missing");
  });

  test("forced checks (provisioning, create_symbol) do not inflate the backoff", async () => {
    const h = bareTracker(async () => ({ listed: false, status: null }));
    const books = [h.book(1, "PERP_A_USDC_bookrunner")];
    await h.tr.check(books); // t=0: next +15, delay 30
    for (const t of [5_000, 6_000, 7_000]) {
      h.set(t);
      await h.tr.check(books, true);
    }
    for (let t = 8_000; t <= 200_000; t += 1_000) {
      h.set(t);
      await h.tr.check(books);
    }
    // forced at 5, 6, 7 s re-arm the current 30 s delay without doubling it (inflated it would be 240 s after three):
    // next scheduled 37 s, then the doubling resumes: 67 (+30), 127 (+60)
    expect(h.calls.map((c) => c.at / 1000)).toEqual([0, 5, 6, 7, 37, 67, 127]);
  });

  test("a hung check times out and never holds up another symbol (bounded concurrency)", async () => {
    const h = bareTracker((s) => (s === "PERP_HANG_USDC_bookrunner" ? new Promise(() => {}) : Promise.resolve({ listed: true, status: "ACTIVE" })), { timeoutMs: 50, concurrency: 1 });
    const books = [h.book(1, "PERP_HANG_USDC_bookrunner"), h.book(2, "PERP_OK_USDC_bookrunner")];
    const t0 = Date.now();
    await h.tr.check(books);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(books[0]?.listing).toMatchObject({ phase: "unknown", failures: 1, error: "listing check timed out after 50 ms" });
    expect(books[1]?.listing).toMatchObject({ phase: "listed", venueStatus: "ACTIVE", openForRisk: true });
  });

  test("first-check failures are counted (published for alerts / health), the last known state is kept", async () => {
    let fail = true;
    const h = bareTracker(async () => {
      if (fail) throw new OrderlyHttpError(502, null, "GET /v1/public/info: HTTP 502", "/v1/public/info");
      return { listed: true, status: "ACTIVE" };
    });
    const books = [h.book(1, "PERP_A_USDC_bookrunner")];
    for (let t = 0; t <= 120_000; t += 1_000) {
      h.set(t);
      await h.tr.check(books);
    }
    expect(books[0]?.listing).toMatchObject({ phase: "unknown", failures: 4, checkedAt: null }); // 0, 15, 45, 105
    expect(h.logs.filter((l) => l.msg.startsWith("Orderly listing check failed") && l.level === "warn").length).toBe(1); // first, then every 10th
    fail = false;
    h.set(400_000);
    await h.tr.check(books);
    expect(books[0]?.listing).toMatchObject({ phase: "listed", failures: 0, error: null, everListed: true });
    fail = true;
    h.set(800_000);
    await h.tr.check(books);
    expect(books[0]?.listing).toMatchObject({ phase: "listed", venueStatus: "ACTIVE", failures: 1, error: "GET /v1/public/info: HTTP 502" });
  });

  test("an undocumented status warns once and is listed but not open for new risk", async () => {
    const h = bareTracker(async () => ({ listed: true, status: "HALTED" }));
    const books = [h.book(1, "PERP_A_USDC_bookrunner")];
    for (let t = 0; t <= 400_000; t += 5_000) {
      h.set(t);
      await h.tr.check(books);
    }
    expect(h.calls.length).toBeGreaterThan(3);
    expect(h.logs.filter((l) => l.msg.includes("not in the documented set")).length).toBe(1);
    expect(books[0]?.listing).toMatchObject({ phase: "listed", venueStatus: "HALTED", openForRisk: false });
  });
});

describe("ORDERLY_LISTING_MODE=manual", () => {
  test("never calls createSymbol / setSymbolStatus; a book awaiting its listing does not block a listed one", async () => {
    const t = await twoBooks("manual");
    t.adminLists(SYMBOL, IF_ID); // NVDA listed in Orderly One, TSLA not yet
    await t.svc.syncBooks();
    expect(t.calls.createSymbol).toEqual([]);
    expect(t.calls.setSymbolStatus).toEqual([]);
    expect(t.mock.venue.symbols.has(TSLA)).toBe(false); // nothing created on the venue
    expect(t.svc.registry.get(1)?.listing).toMatchObject({ phase: "listed", venueStatus: "ACTIVE", openForRisk: true, error: null });
    expect(t.svc.registry.get(2)?.listing).toMatchObject({ phase: "awaiting", venueStatus: "NEW", openForRisk: false, error: null });
    // both books are provisioned for every other duty (accounts, keys)
    for (const id of [1, 2]) {
      expect((await t.store.venueAccounts(id)).map((r) => [r.kind, r.status]).sort()).toEqual([
        ["builder", "active"],
        ["if", "active"],
        ["mm", "active"],
      ]);
      expect(t.keys.loadBook(id)?.trade?.registeredAt).toBeTruthy();
    }
    expect(t.last().listingMode).toBe("manual");
    expect(t.market(SYMBOL)).toMatchObject({ bookIds: [1], phase: "listed", openForRisk: true });
    expect(t.market(TSLA)).toMatchObject({ bookIds: [2], phase: "awaiting", venueStatus: "NEW", failures: 0 });
    expect(venueMarketGate(parseVenueMarkets(t.last()), 2)).toEqual({ reason: "VENUE_NOT_LISTED", symbol: TSLA });
    expect(venueMarketGate(parseVenueMarkets(t.last()), 1)).toBeNull();

    // the admin lists TSLA: picked up at the next due re-check
    t.adminLists(TSLA, IF2);
    t.advance(15_000);
    await t.svc.syncBooks();
    expect(t.svc.registry.get(2)?.listing).toMatchObject({ phase: "listed", venueStatus: "ACTIVE" });
    expect(t.market(TSLA)?.openForRisk).toBe(true);
    expect(t.calls.createSymbol).toEqual([]);
  });

  test("a listed market that disappears is missing (not awaiting), keeps the push paged, and comes back as listed", async () => {
    const t = await twoBooks("manual");
    t.adminLists(SYMBOL, IF_ID);
    await t.svc.syncBooks();
    expect(t.market(SYMBOL)?.phase).toBe("listed");
    t.mock.venue.symbols.delete(SYMBOL); // gone from /v1/public/info (mock: unknown symbol -> NEW row; live: no data)
    t.mock.venue.infoView = ((orig) => (s: string) => (s === SYMBOL ? ({ success: true } as unknown as ReturnType<typeof orig>) : orig(s)))(t.mock.venue.infoView.bind(t.mock.venue));
    for (let i = 0; i < 3; i++) {
      t.advance(300_000);
      await t.svc.syncBooks();
      expect(t.market(SYMBOL)).toMatchObject({ phase: "missing", everListed: true, openForRisk: false });
    }
    const b1 = t.svc.registry.get(1) as TrackedBook;
    expect(builderFeedTargets([b1])[0]?.preListing).toBe(false); // builder_price_push still pages
    expect(venueMarketGate(parseVenueMarkets(t.last()), 1)?.reason).toBe("VENUE_MARKET_MISSING");
    expect(t.logs.some((l) => l.level === "error" && l.msg.includes("MISSING"))).toBe(true);
    t.mock.venue.infoView = Object.getPrototypeOf(t.mock.venue).infoView.bind(t.mock.venue);
    t.adminLists(SYMBOL, IF_ID);
    t.advance(300_000);
    await t.svc.syncBooks();
    expect(t.market(SYMBOL)).toMatchObject({ phase: "listed", openForRisk: true });
  });

  test("retiring book: no REDUCE_ONLY call (Orderly One; the agent is reduce-only on our side)", async () => {
    const t = await twoBooks("manual");
    t.adminLists(SYMBOL, IF_ID);
    t.chain.states.set(trackedBook().book.toLowerCase(), "Retiring");
    await t.svc.syncBooks();
    expect(t.svc.registry.get(1)?.state).toBe("Retiring");
    expect(t.calls.setSymbolStatus).toEqual([]);
    expect(t.mock.venue.symbolStatus(t.mock.venue.requireSymbol(SYMBOL))).toBe("ACTIVE");
  });

  test("create_symbol job: forced check, listing fields, no listing call", async () => {
    const t = await twoBooks("manual");
    t.adminLists(SYMBOL, IF_ID);
    await t.svc.syncBooks();
    const r = await t.svc.handleJob({ kind: "create_symbol", bookId: 1 });
    expect(r).toEqual({ bookId: 1, symbol: SYMBOL, listed: true, listingMode: "manual", listing: "listed", venueStatus: "ACTIVE", openForRisk: true });
    expect(await t.svc.handleJob({ kind: "create_symbol", bookId: 2 })).toMatchObject({ listing: "awaiting", venueStatus: "NEW", openForRisk: false });
    expect(t.calls.createSymbol).toEqual([]);
  });

  test("retiring IF withdrawal locked by the listed market: waits for the admin's delisting (persisted, published, no DELISTED call, no attempt burnt)", async () => {
    const t = await setupWithdraw("Retiring");
    t.ctx.settings.listingMode = "manual";
    const delists: string[] = [];
    const setStatus = t.builder.setSymbolStatus.bind(t.builder);
    t.builder.setSymbolStatus = async (s, st) => {
      delists.push(`${s}:${st}`);
      return setStatus(s, st);
    };
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, 25_000_000_000n);
    await t.wp.onRequested(req);
    await t.wp.processAll();
    await t.wp.processAll(); // inside the 60 s wait: not re-run
    const s0 = Object.values(t.sagas.get().withdrawals)[0];
    expect(delists).toEqual([]);
    expect(s0?.attempts ?? 0).toBe(0);
    expect(s0?.stage).toBe("detected");
    expect(typeof s0?.delistWaitSince).toBe("number"); // persisted in the saga store (survives a restart)
    expect(t.wp.delistWaits()).toEqual([{ bookId: 1, symbol: SYMBOL, since: s0?.delistWaitSince as number }]);
    t.mock.venue.setSymbolStatus(SYMBOL, "DELISTED"); // the admin, in Orderly One
    await t.wp.processNonce(1, s0?.nonce as string);
    expect(Object.values(t.sagas.get().withdrawals)[0]?.stage).toBe("swept");
    expect(t.wp.delistWaits()).toEqual([]);
    expect(delists).toEqual([]);
  });

  test("past the delisting ceiling the venue error counts as an attempt again", async () => {
    const t = await setupWithdraw("Retiring");
    let now = Date.now();
    t.ctx.now = () => now;
    t.ctx.settings.listingMode = "manual";
    t.ctx.settings.delistWaitMaxMs = 120_000;
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, 25_000_000_000n);
    await t.wp.onRequested(req);
    await t.wp.processAll();
    const nonce = Object.values(t.sagas.get().withdrawals)[0]?.nonce as string;
    now += 61_000;
    await t.wp.processNonce(1, nonce);
    expect(Object.values(t.sagas.get().withdrawals)[0]?.attempts).toBe(0);
    now += 120_000;
    await t.wp.processNonce(1, nonce);
    const s = Object.values(t.sagas.get().withdrawals)[0];
    expect(s?.attempts).toBe(1);
    expect(s?.stage).toBe("detected");
  });
});

describe("restricted markets end to end (testnet-like /v1/public/info rows -> published state -> agent gate)", () => {
  // shapes as served by testnet-api.orderly.org on 2026-10-18 (PERP_BTC_USDC_testgg REDUCE_ONLY, PERP_ETH_USDC_testgg
  // DELISTING), with our broker's symbols
  const row = (symbol: string, status: string) => ({ success: true, data: { symbol, display_symbol_name: symbol, broker_id: "bookrunner", quote_min: 0, quote_max: 100000, quote_tick: 0.1, base_min: 0.00001, base_tick: 0.00001, min_notional: 10, status, is_pretge: false }, timestamp: 1 });
  async function liveListing(rows: Record<string, unknown>) {
    const fetch: FetchLike = async (input) => {
      const path = new URL(input).pathname;
      const body = rows[path] ?? { success: true, timestamp: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new OrderlyBuilderClient({
      baseUrl: "https://testnet-api.orderly.org",
      mode: "live",
      brokerId: "bookrunner",
      chainId: 46630,
      builderAccountId: BUILDER_ID,
      builderKey: await keyFromSecret(new Uint8Array(32).fill(7)),
      signer: OPS,
      fetch,
      sleep: async () => {},
    });
    return (s: string) => client.listingStatus(s);
  }

  test("REDUCE_ONLY / DELISTING / POST_ONLY / ACTIVE / absent rows", async () => {
    const t = await twoBooks("manual");
    const NV = SYMBOL;
    for (const [status, gate, open] of [
      ["REDUCE_ONLY", "VENUE_REDUCE_ONLY", false],
      ["DELISTING", "VENUE_DELISTING", false],
      ["POST_ONLY", "VENUE_POST_ONLY", false],
      ["ACTIVE", null, true],
    ] as const) {
      t.builder.listingStatus = await liveListing({ [`/v1/public/info/${NV}`]: row(NV, status) });
      t.advance(300_000);
      await t.svc.syncBooks();
      expect(t.market(NV)).toMatchObject({ phase: "listed", venueStatus: status, openForRisk: open, everListed: true });
      expect(t.market(TSLA)).toMatchObject({ phase: "awaiting", venueStatus: null }); // absent: 200 without data
      expect(venueMarketGate(parseVenueMarkets(t.last()), 1)?.reason ?? null).toBe(gate);
      expect(venueMarketGate(parseVenueMarkets(t.last()), 2)?.reason).toBe("VENUE_NOT_LISTED");
    }
    expect(venueMarketGate(parseVenueMarkets(t.last()), 1, { allowPostOnly: true })).toBeNull();
    expect(t.logs.some((l) => l.level === "warn" && l.msg.includes("not open for new risk"))).toBe(true);
    expect(t.calls.createSymbol).toEqual([]);
  });
});

describe("ORDERLY_LISTING_MODE=api (default in mock mode)", () => {
  test("createSymbol per book; one book's rejected listing does not block another and is retried", async () => {
    const t = await twoBooks("api", { createFails: TSLA });
    await t.svc.syncBooks();
    expect(t.mock.venue.symbols.has(SYMBOL)).toBe(true);
    expect(t.mock.venue.symbols.has(TSLA)).toBe(false);
    expect(t.calls.createSymbol).toContain(TSLA);
    expect(t.svc.registry.get(1)?.listing?.phase).toBeDefined(); // tracked in api mode too (push gate, alerts)
    expect(t.last().listingMode).toBe("api");
    const before = t.calls.createSymbol.filter((s) => s === TSLA).length;
    await t.svc.syncBooks(); // the failed book is retried every pass
    expect(t.calls.createSymbol.filter((s) => s === TSLA).length).toBeGreaterThan(before);
  });

  test("retiring book: REDUCE_ONLY through the listing API (today's behaviour)", async () => {
    const t = await twoBooks("api");
    await t.svc.syncBooks();
    t.chain.states.set(trackedBook().book.toLowerCase(), "Retiring");
    await t.svc.syncBooks();
    expect(t.calls.setSymbolStatus).toEqual([`${SYMBOL}:REDUCE_ONLY`]);
  });
});

describe("builder price push gate (preListing)", () => {
  const book = (bookId: number, state: TrackedBook["state"], listing?: ListingInfo | null) => ({ bookId, symbol: SYMBOL, state, venueSymbolError: null, ...(listing !== undefined ? { listing } : {}) });
  const L = (phase: ListingInfo["phase"], venueStatus: string | null = phase === "listed" ? "ACTIVE" : null): ListingInfo => ({ phase, venueStatus, openForRisk: phase === "listed" && venueStatus === "ACTIVE", everListed: phase === "listed" || phase === "missing", since: 0, checkedAt: 0, failures: 0, error: null });
  test("only a never-listed market is preListing; missing / restricted page; without a check, Subscription decides", () => {
    expect(builderFeedTargets([book(1, "Live", L("awaiting"))])[0]?.preListing).toBe(true);
    expect(builderFeedTargets([book(1, "Subscription", L("listed"))])[0]?.preListing).toBe(false);
    expect(builderFeedTargets([book(1, "Live", L("missing"))])[0]?.preListing).toBe(false);
    expect(builderFeedTargets([book(1, "Live", L("listed", "REDUCE_ONLY"))])[0]?.preListing).toBe(false);
    expect(builderFeedTargets([book(1, "Subscription")])[0]?.preListing).toBe(true);
    expect(builderFeedTargets([book(1, "Subscription", L("unknown"))])[0]?.preListing).toBe(true);
    expect(builderFeedTargets([book(1, "Live", L("unknown"))])[0]?.preListing).toBe(false);
    expect(builderFeedTargets([book(1, "Live", null)])[0]?.preListing).toBe(false);
    expect(builderFeedTargets([book(1, "Subscription", L("awaiting")), book(2, "Live", L("listed"))])[0]?.preListing).toBe(false);
  });
});
