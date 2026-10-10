import { RECEIPT_KIND, payloadHash } from "@bookrunner/shared";
import { type Hex, zeroHash } from "viem";
import type { CharterServiceClient } from "../src/deps";
import type { ApiDeps } from "../src/deps";
import { type CharterDraftInput, charterDraftSchema, charterToJson, draftToCharter } from "../src/domain/charter";
import { MemoryKv } from "../src/kv";
import { createCaller } from "../src/router";
import { A, FakeChain, FakeReadModel, FakeWebhookStore, fakeDeployment, silentLog } from "./fakes";

export const NOW = Date.UTC(2026, 9, 2, 12, 0, 0); // 2026-10-02T12:00:00Z (multiple of 300s)
export const SPONSOR = A(0x77);
export const ALICE = A(0xa11ce);
export const BOOK = {
  book: A(0xb1),
  senior: A(0xb2),
  junior: A(0xb3),
  vault: A(0xb4),
  mandate: A(0xb5),
  router: A(0xb6),
  desk: A(0xb7),
  adapter: A(0xb8),
};

export function sampleDraft(over: Partial<CharterDraftInput> = {}): CharterDraftInput {
  return {
    sponsor: SPONSOR,
    underlying: { ticker: "NVDA" },
    venue: "orderly",
    oracle: "attested",
    sessions: "24x5",
    ifTargetUsd: "30000",
    mmInventoryUsd: "75000",
    mandate: {
      maxInventoryUsd: "50000",
      maxSkewBps: 25,
      minQuoteWidthBps: 8,
      maxHedgeLeverage: 1,
      hedgeRatioMinBps: 5000,
      hedgeRatioMaxBps: 12000,
      noNewRiskOffHours: true,
      killAtDrawdownBps: -800,
    },
    seniorHurdleBps: 6000,
    seniorCapBps: 7000,
    subscriptionWindowSeconds: 600,
    juniorNoticeSeconds: 900,
    perWalletCapUsd: "250000",
    symbol: "PERP_NVDA_USDC",
    takerFeeBps: 0,
    makerFeeBps: 0,
    meta: { name: "NVDA perp book" },
    ...over,
  };
}

export const sampleCharter = () => draftToCharter(charterDraftSchema.parse(sampleDraft()), { stockTokens: fakeDeployment().stockTokens }).charter;

export interface World {
  deps: ApiDeps;
  data: FakeReadModel;
  store: FakeWebhookStore;
  kv: MemoryKv;
  chain: FakeChain;
  setChain(on: boolean): void;
  caller: ReturnType<typeof createCaller>;
  now: { ms: number };
}

export function makeWorld(opts: { chain?: boolean; charterService?: CharterServiceClient | null } = {}): World {
  const now = { ms: NOW };
  const data = new FakeReadModel();
  const store = new FakeWebhookStore(() => now.ms);
  const kv = new MemoryKv(() => now.ms);
  const chain = new FakeChain();
  let chainOn = opts.chain ?? true;
  const deps: ApiDeps = {
    settings: { chainId: 31337, markIntervalSeconds: 300, receiptsIntervalSeconds: 60, maxPriceAgeSeconds: 300 },
    log: silentLog,
    data,
    webhooks: store,
    kv,
    chain: () => (chainOn ? chain : null),
    charterService: opts.charterService ?? null,
    now: () => now.ms,
  };
  return {
    deps,
    data,
    store,
    kv,
    chain,
    now,
    setChain: (on) => {
      chainOn = on;
    },
    caller: createCaller({ deps }),
  };
}

const at = (secOffset: number) => new Date(NOW + secOffset * 1000);

/** Book #1 (NVDA, Orderly) with charter #1, three marks, limits and settlements. */
export function seedBook(w: World, opts: { state?: string; subscriptionEndsIn?: number } = {}) {
  const c = sampleCharter();
  w.data.charters.push({
    id: 1,
    sponsor: SPONSOR.toLowerCase(),
    structJson: charterToJson(c),
    status: "Approved",
    juryCid: "bafkreiexample",
    decidedAt: at(-7200),
    bondTx: "0xbond",
    underlying: c.underlying,
    symbol: "PERP_NVDA_USDC",
    venue: 0,
    feeUsd: "5000.000000",
    bondBkrn: "100000000000000000000000",
    filedAt: at(-86_400),
    bookAddr: BOOK.book.toLowerCase(),
    meta: { name: "NVDA perp book" },
    updatedAt: at(-7200),
  });
  const state = opts.state ?? "Live";
  w.data.books.push({
    id: 1,
    charterId: 1,
    seniorAddr: BOOK.senior.toLowerCase(),
    juniorAddr: BOOK.junior.toLowerCase(),
    vaultAddr: BOOK.vault.toLowerCase(),
    venue: 0,
    symbol: "PERP_NVDA_USDC",
    createdAt: at(-7200),
    bookAddr: BOOK.book.toLowerCase(),
    mandateAddr: BOOK.mandate.toLowerCase(),
    routerAddr: BOOK.router.toLowerCase(),
    deskAddr: BOOK.desk.toLowerCase(),
    adapterAddr: BOOK.adapter.toLowerCase(),
    underlying: c.underlying,
    name: "NVDA perp book",
    state,
    subscriptionEnds: at(opts.subscriptionEndsIn ?? -3600),
    seniorNav: "70100.000000",
    juniorNav: "30200.000000",
    navUsd: "100300.000000",
    lastMarkId: 3,
    updatedAt: at(-300),
  });
  for (let i = 1; i <= 3; i++) {
    const periodEnd = at(-300 * (4 - i)); // -900, -600, -300
    w.data.marks.push({
      id: i,
      bookId: 1,
      periodEnd,
      navUsd: `${100000 + 100 * i}.000000`,
      seniorNav: `${70000 + 50 * i}.000000`,
      juniorNav: `${30000 + 50 * i}.000000`,
      pnlJson: { bookId: "1", tranches: { seniorPrice: "1000000000000000000", juniorPrice: "1010000000000000000" } },
      receiptsRoot: zeroHash,
      txHash: `0xmark${i}`,
      inventoryRoot: zeroHash,
      pnlJsonHash: zeroHash,
      deployedValueUsd: "100000.000000",
      flowNonce: 2,
      signer: A(0x51).toLowerCase(),
      signature: "0xsig",
      appliedTx: `0xapply${i}`,
      seniorPrice: 1.0 + i / 1000,
      juniorPrice: 1.0 + i / 100,
      pnlUsd: "100.000000",
      committedAt: new Date(periodEnd.getTime() + 30_000),
    });
  }
  w.data.limits.push(
    { bookId: 1, ts: at(-120), inventoryUtil: 0.4, skewUtil: 0.2, hedgeRatio: 8000, drawdownBps: -10, state: "ok", offHours: false, breaches: [], netExposureUsd: -20000, liveNavUsd: 100250 },
    { bookId: 1, ts: at(-60), inventoryUtil: 0.95, skewUtil: 0.3, hedgeRatio: 7000, drawdownBps: -20, state: "warn", offHours: false, breaches: [], netExposureUsd: -47500, liveNavUsd: 100200 },
  );
  w.data.settlements.push({
    id: 10,
    bookId: 1,
    ts: at(-300),
    source: "distribution",
    grossUsd: "100.000000",
    expensesUsd: "1.000000",
    carryUsd: "9.900000",
    seniorUsd: "53.460000",
    juniorUsd: "35.640000",
    period: Math.floor(NOW / 1000 / 300) - 1,
    txHash: "0xdist",
    logIndex: 0,
  });
  w.chain.books.set(BOOK.book.toLowerCase(), {
    state: state === "Subscription" ? 0 : state === "Cancelled" ? 1 : 2,
    subscriptionEnds: Math.floor(at(opts.subscriptionEndsIn ?? -3600).getTime() / 1000),
    seniorPriceWad: 1_003_000_000_000_000_000n,
    juniorPriceWad: 1_030_000_000_000_000_000n,
    seniorNav: 70_150_000_000n,
    juniorNav: 30_150_000_000n,
    lastMarkId: 3,
  });
  w.chain.mandates.set(BOOK.mandate.toLowerCase(), { mandate: c.mandate, killed: false, killReason: zeroHash, activeKeys: [] });
  return c;
}

/** Receipts for book 1 in two receipt hours inside mark #3's period. */
export function seedReceipts(w: World) {
  const hour0 = at(-600); // [NOW-600, NOW-540) belongs to mark #3 (periodEnd NOW-300, period start NOW-600)
  const hour1 = at(-540);
  let id = 100;
  const add = (hourStart: Date, kind: number, tsOff: number, payload: unknown) =>
    w.data.receipts.push({ id: id++, bookId: 1, kind, ts: new Date(hourStart.getTime() + tsOff * 1000), payload, payloadHash: payloadHash(payload), hourStart });
  add(hour0, RECEIPT_KIND.QUOTE, 1, { bid: 189.9, ask: 190.1, size: 10 });
  add(hour0, RECEIPT_KIND.FILL, 5, { side: "buy", qty: 1, px: 190 });
  add(hour0, RECEIPT_KIND.HEDGE, 30, { asset: "NVDA", qtyRaw: "1000000000000000000" });
  add(hour1, RECEIPT_KIND.DECISION, 2, { state: "ok" });
  return { hour0, hour1 };
}

export const HEX32 = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

/**
 * Fills + hedges of book 1 with their receipt leaves, written the way the producers do (the fill
 * receipt payload carries venueTradeId, the hedge receipt payload carries txHash). Fill t-3 and
 * hedge #2 have no receipt; book 2 rows must never leak into book 1 feeds.
 */
export function seedActivity(w: World) {
  const interval = w.deps.settings.receiptsIntervalSeconds;
  const hourOf = (d: Date) => new Date(Math.floor(d.getTime() / 1000 / interval) * interval * 1000);
  let rid = 900;
  const receipt = (kind: number, ts: Date, payload: Record<string, unknown>) => {
    const tsSec = new Date(Math.floor(ts.getTime() / 1000) * 1000);
    const row = { id: rid++, bookId: 1, kind, ts: tsSec, payload, payloadHash: payloadHash(payload), hourStart: hourOf(tsSec) };
    w.data.receipts.push(row);
    return row.id;
  };
  const fill = (venueTradeId: string, secOffset: number, side: "buy" | "sell", withReceipt = true, bookId = 1) => {
    const ts = at(secOffset);
    w.data.fills.push({ bookId, ts, side, qty: 2, px: 190.5, feeUsd: 0.04, venueTradeId, maker: side === "buy", trader: null });
    if (!withReceipt || bookId !== 1) return null;
    return receipt(RECEIPT_KIND.FILL, ts, { type: "fill", bookId, ts: ts.getTime(), side, qty: 2, px: 190.5, feeUsd: 0.04, venueTradeId, maker: side === "buy" });
  };
  const f1 = fill("t-1", -200, "buy");
  const f2 = fill("t-2", -100, "sell");
  fill("t-3", -50, "buy", false);
  const f4 = fill("t-4", -100, "buy"); // same ts as t-2: keyset tie-break on venueTradeId
  fill("t-9", -10, "buy", true, 2);

  const hedge = (id: number, secOffset: number, qtyRaw: string, txHash: string, bookId = 1) => {
    const ts = at(secOffset);
    w.data.hedges.push({ id, bookId, ts, asset: A(0x1001).toLowerCase(), qtyRaw, px: 190.4, mult: 1, txHash, venue: "UNIV3", valueUsd: "380.8" });
  };
  hedge(1, -180, "2000000000000000000", "0xaaa1");
  hedge(2, -90, "-1000000000000000000", "0xaaa2");
  hedge(3, -30, "500000000000000000", "0xaaa3", 2);
  // hash case differs from the row: the link is case-insensitive
  const h1 = receipt(RECEIPT_KIND.HEDGE, at(-179), { type: "hedge", bookId: 1, action: "buy", token: A(0x1001).toLowerCase(), venue: "UNIV3", qtyRaw: "2000000000000000000", txHash: "0xAAA1" });
  return { f1: f1!, f2: f2!, f4: f4!, h1 };
}
