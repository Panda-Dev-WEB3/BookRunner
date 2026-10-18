// ORDERLY_LISTING_MODE (docs/VERIFY.md O20): manual = the admin lists each market in Orderly One, ops-venue never calls a
// listing / symbol-status endpoint and waits for the market on /v1/public/info (backoff, per symbol); api = today's
// createSymbol. In both modes a book whose market is not listed never blocks another book.
import { describe, expect, test } from "bun:test";
import { ACCOUNT, type VenueSymbolIssuesMsg } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { builderFeedTargets } from "../src/builderOracle/feed";
import { loadOpsEnv, resolveListingMode } from "../src/config";
import { OrderlyHttpError } from "../src/orderly/http";
import type { TrackedBook } from "../src/worker/context";
import { listingPhase } from "../src/worker/listing";
import { OpsService } from "../src/worker/service";
import { ADAPTER, IF_ID, makeCtx, MM_ID, provisioner, setupWithdraw, SYMBOL, trackedBook } from "./helpers";

const TSLA = "PERP_TSLA_USDC";
const ADAPTER2 = "0x00000000000000000000000000000000000b0b01" as Address;
const IF2 = `0x${"c3".repeat(32)}` as Hex;
const MM2 = `0x${"d4".repeat(32)}` as Hex;

function tslaBook(): TrackedBook {
  return { ...trackedBook(), bookId: 2, book: "0x00000000000000000000000000000000000b0b00", adapter: ADAPTER2, mandate: "0x00000000000000000000000000000000000b0b02", charterSymbol: TSLA, symbol: TSLA, baseAsset: "TSLA", accounts: { if: IF2, mm: MM2 }, owners: { if: ADAPTER2, mm: ADAPTER2 } };
}

/** Two Orderly books (NVDA = book 1, TSLA = book 2) with their own venue accounts; status messages captured. */
async function twoBooks(listingMode: "api" | "manual", o: { createFails?: string } = {}) {
  let now = 1_800_000_000_000;
  const t = await makeCtx({ listingMode, now: () => now });
  t.chain.books = [trackedBook(), tslaBook()];
  t.chain.accountIds = async (adapter?: Address) => (adapter?.toLowerCase() === ADAPTER2.toLowerCase() ? { if: IF2, mm: MM2 } : { if: IF_ID, mm: MM_ID });
  const statuses: VenueSymbolIssuesMsg[] = [];
  t.ctx.status = { venueSymbolIssues: async (m) => void statuses.push(m) };
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
  return { ...t, svc, calls, statuses, adminLists, advance: (ms: number) => (now += ms), last: () => statuses.at(-1) as VenueSymbolIssuesMsg };
}

describe("config", () => {
  test("ORDERLY_LISTING_MODE: api in mock mode, manual in live mode unless set; re-check bounds", () => {
    expect(resolveListingMode(loadOpsEnv({ ORDERLY_MODE: "mock" }))).toBe("api");
    expect(resolveListingMode(loadOpsEnv({ ORDERLY_MODE: "live" }))).toBe("manual");
    expect(resolveListingMode(loadOpsEnv({ ORDERLY_MODE: "live", ORDERLY_LISTING_MODE: "api" }))).toBe("api");
    expect(resolveListingMode(loadOpsEnv({ ORDERLY_MODE: "mock", ORDERLY_LISTING_MODE: "manual" }))).toBe("manual");
    expect(() => loadOpsEnv({ ORDERLY_LISTING_MODE: "dashboard" })).toThrow();
    expect(() => loadOpsEnv({ OPS_LISTING_RECHECK_MS: "60000", OPS_LISTING_RECHECK_MAX_MS: "30000" })).toThrow("OPS_LISTING_RECHECK_MAX_MS");
  });
});

describe("listing phase (GET /v1/public/info/{symbol})", () => {
  test("absent, NEW and PENDING are awaiting; launched statuses and unknown ones are listed", () => {
    expect(listingPhase({ listed: false, status: null })).toBe("awaiting");
    expect(listingPhase({ listed: true, status: "NEW" })).toBe("awaiting");
    expect(listingPhase({ listed: true, status: "pending" })).toBe("awaiting");
    for (const s of ["POST_ONLY", "ACTIVE", "REDUCE_ONLY", "DELISTING", "DELISTED", "SOMETHING_NEW"]) expect(listingPhase({ listed: true, status: s })).toBe("listed");
    expect(listingPhase({ listed: true, status: null })).toBe("listed"); // a row without status (older API / docs schema)
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
    const [b1, b2] = [t.svc.registry.get(1), t.svc.registry.get(2)];
    expect(b1?.listing).toMatchObject({ phase: "listed", venueStatus: "ACTIVE", error: null });
    expect(b2?.listing).toMatchObject({ phase: "awaiting", venueStatus: "NEW", error: null });
    // both books are provisioned for every other duty (accounts, keys)
    for (const id of [1, 2]) {
      expect((await t.store.venueAccounts(id)).map((r) => [r.kind, r.status]).sort()).toEqual([
        ["builder", "active"],
        ["if", "active"],
        ["mm", "active"],
      ]);
      expect(t.keys.loadBook(id)?.trade?.registeredAt).toBeTruthy();
    }
    expect(t.last()).toMatchObject({ listingMode: "manual", awaitingListing: [{ bookId: 2, symbol: TSLA, venueStatus: "NEW", error: null }] });

    // the admin lists TSLA: picked up at the next due re-check
    t.adminLists(TSLA, IF2);
    t.advance(15_000);
    await t.svc.syncBooks();
    expect(t.svc.registry.get(2)?.listing).toMatchObject({ phase: "listed", venueStatus: "ACTIVE" });
    expect(t.last().awaitingListing).toEqual([]);
    expect(t.calls.createSymbol).toEqual([]);
  });

  test("not-listed re-checks back off (15 s doubling to the cap); a listed market is re-checked at the cap", async () => {
    const t = await twoBooks("manual");
    t.adminLists(SYMBOL, IF_ID);
    const checks = (s: string) => t.calls.listingStatus.filter((x) => x === s).length;
    await t.svc.syncBooks(); // provisioning forces one check per book
    expect([checks(SYMBOL), checks(TSLA)]).toEqual([1, 1]);
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      t.advance(5_000); // book poll
      await t.svc.syncBooks();
      seen.push(checks(TSLA));
    }
    // TSLA: 0, then due at +15 s, +45 s (+30), +105 s (+60), next +225 s (+120): 4 checks in 200 s; NVDA (listed): next at +300 s
    expect(checks(TSLA)).toBe(4);
    expect(checks(SYMBOL)).toBe(1);
    expect(seen.indexOf(2)).toBe(2); // the 3rd poll (+15 s)
    for (let i = 0; i < 21; i++) {
      t.advance(5_000);
      await t.svc.syncBooks();
    }
    expect(checks(SYMBOL)).toBe(2); // +305 s: the listed market's slow re-check
    expect(checks(TSLA)).toBe(5); // +225 s, then capped (next +525 s)
  });

  test("a failing check keeps the phase, is retried with backoff and does not stop the other symbol", async () => {
    const t = await twoBooks("manual");
    t.adminLists(SYMBOL, IF_ID);
    const real = t.builder.listingStatus;
    t.builder.listingStatus = async (s) => {
      if (s === TSLA) throw new OrderlyHttpError(0, null, "network error: boom", "/v1/public/info");
      return real(s);
    };
    await t.svc.syncBooks();
    expect(t.svc.registry.get(1)?.listing?.phase).toBe("listed");
    expect(t.svc.registry.get(2)?.listing ?? null).toBeNull(); // never checked successfully: unknown
    expect(t.last().awaitingListing).toEqual([]); // unknown is not reported as awaiting
    t.builder.listingStatus = real;
    t.advance(15_000);
    await t.svc.syncBooks();
    expect(t.svc.registry.get(2)?.listing).toMatchObject({ phase: "awaiting", venueStatus: "NEW" });
  });

  test("retiring book: no REDUCE_ONLY call (Orderly One + the mandate's reduce-only)", async () => {
    const t = await twoBooks("manual");
    t.adminLists(SYMBOL, IF_ID);
    t.chain.states.set(trackedBook().book.toLowerCase(), "Retiring");
    await t.svc.syncBooks();
    expect(t.svc.registry.get(1)?.state).toBe("Retiring");
    expect(t.calls.setSymbolStatus).toEqual([]);
    expect(t.mock.venue.symbolStatus(t.mock.venue.requireSymbol(SYMBOL))).toBe("ACTIVE");
  });

  test("retiring IF withdrawal locked by the listed market waits for the admin's delisting (no DELISTED call, no attempt burnt)", async () => {
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
    expect(s0?.stage).not.toBe("failed");
    t.mock.venue.setSymbolStatus(SYMBOL, "DELISTED"); // the admin, in Orderly One
    await t.wp.processNonce(1, s0?.nonce as string);
    expect(Object.values(t.sagas.get().withdrawals)[0]?.stage).toBe("swept");
    expect(delists).toEqual([]);
  });
});

describe("ORDERLY_LISTING_MODE=api (default in mock mode)", () => {
  test("createSymbol per book; one book's rejected listing does not block another and is retried", async () => {
    const t = await twoBooks("api", { createFails: TSLA });
    await t.svc.syncBooks();
    expect(t.mock.venue.symbols.has(SYMBOL)).toBe(true);
    expect(t.mock.venue.symbols.has(TSLA)).toBe(false);
    expect(t.calls.createSymbol).toContain(TSLA);
    expect(t.svc.registry.get(1)?.listing?.phase).toBeDefined(); // tracked in api mode too (builder push gate)
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
  const book = (bookId: number, state: TrackedBook["state"], listing?: TrackedBook["listing"]) => ({ bookId, symbol: SYMBOL, state, venueSymbolError: null, ...(listing !== undefined ? { listing } : {}) });
  const L = (phase: "awaiting" | "listed") => ({ phase, venueStatus: phase === "listed" ? "ACTIVE" : null, since: 0, checkedAt: 0, error: null });
  test("the listing check decides once there is one; before it, a book in Subscription is preListing", () => {
    expect(builderFeedTargets([book(1, "Live", L("awaiting"))])[0]?.preListing).toBe(true); // Live but not listed: not paged
    expect(builderFeedTargets([book(1, "Subscription", L("listed"))])[0]?.preListing).toBe(false); // listed: must be fed
    expect(builderFeedTargets([book(1, "Subscription")])[0]?.preListing).toBe(true);
    expect(builderFeedTargets([book(1, "Live", null)])[0]?.preListing).toBe(false);
    expect(builderFeedTargets([book(1, "Subscription", L("awaiting")), book(2, "Live", L("listed"))])[0]?.preListing).toBe(false);
  });
});
