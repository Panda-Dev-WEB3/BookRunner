// risk.state, settlements.list, receipts.list/root/proof, oracle.prices + oracle.signed, events.recent
import { KEYS } from "@bookrunner/shared/queues";
import { z } from "zod";
import type { MarkRow, OraclePriceRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { receiptListView } from "../domain/activity";
import { limitsRowToView, type OraclePriceView, parseOraclePrice, parseRiskState } from "../domain/live";
import { ORACLE_BUNDLE_KEY, signedBundleView } from "../domain/lowgas";
import { type PeriodRoots, hourTreeFor, receiptCaches } from "../domain/receiptCache";
import { RECEIPT_KIND_NAMES, buildReceiptProof, hourTreeOf, periodBounds, receiptsRootOf } from "../domain/receipts";
import { dbUsdStr, unixSec } from "../format";
import { parseJson } from "../kv";
import { notFound, publicProcedure, router, softChain } from "../trpc";
import { bookIdInput, cursorInput, intLike, limitInput, loadBook, markInterval, paged, timeInput } from "./common";

const RISK_STALE_MS = 60_000;

export const riskRouter = router({
  state: publicProcedure.input(z.object({ bookId: bookIdInput })).query(async ({ ctx: { deps }, input }) => {
    const b = await loadBook(deps, input.bookId);
    const [raw, latestRows, kills] = await Promise.all([
      deps.kv.get(KEYS.riskState(b.id)),
      deps.data.latestLimits([b.id]),
      deps.data.recentKills(b.id, 10),
    ]);
    const live = parseRiskState(parseJson(raw));
    const latest = latestRows[0] ? limitsRowToView(latestRows[0]) : null;
    const liveAt = live?.ts ? Date.parse(live.ts) : null;
    return {
      bookId: b.id,
      state: live?.state ?? latest?.state ?? "unknown",
      live,
      liveStale: live ? liveAt === null || deps.now() - liveAt > RISK_STALE_MS : null,
      latest,
      kills: kills.map((k) => ({ id: k.id, ts: k.ts.toISOString(), reason: k.reason, breaches: k.breaches, actions: k.actions, txHashes: k.txHashes })),
    };
  }),
});

export const settlementsRouter = router({
  list: publicProcedure
    .input(z.object({ bookId: bookIdInput, limit: limitInput(50, 500), cursor: cursorInput }))
    .query(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const rows = await deps.data.listSettlements(b.id, { limit: input.limit, beforeId: input.cursor });
      const items = rows.map((s) => ({
        id: s.id,
        bookId: s.bookId,
        ts: s.ts.toISOString(),
        period: s.period,
        source: s.source,
        grossUsd: dbUsdStr(s.grossUsd) ?? "0.000000",
        expensesUsd: dbUsdStr(s.expensesUsd) ?? "0.000000",
        carryUsd: dbUsdStr(s.carryUsd) ?? "0.000000",
        seniorUsd: dbUsdStr(s.seniorUsd) ?? "0.000000",
        juniorUsd: dbUsdStr(s.juniorUsd) ?? "0.000000",
        /** 2026-10: insurance pool premium paid before the split (pool-funded books; gross = premium + the rest) */
        premiumUsd: dbUsdStr(s.premiumUsd) ?? "0.000000",
        txHash: s.txHash,
        logIndex: s.logIndex,
      }));
      return { ...paged(items, input.limit, (i) => i.id), bookId: b.id };
    }),
});

const floorTo = (d: Date, sec: number) => new Date(Math.floor(d.getTime() / 1000 / sec) * sec * 1000);

/**
 * Hourly roots committed by a mark. Convention (ARCHITECTURE §4 mark): hours with
 * periodEnd - markInterval <= hourStart < periodEnd. VERIFY with services/mark: if its root was built
 * over the hours since the previous mark instead, that window is used when it matches the mark.
 * A window that matches the mark's receiptsRoot is cached per mark (M-4): the mark row and the hourly roots
 * it committed to do not change.
 */
async function periodRootsFor(deps: ApiDeps, mark: MarkRow, interval: number): Promise<PeriodRoots> {
  const cache = receiptCaches(deps).periods;
  const key = `${mark.id}:${mark.bookId}:${mark.periodEnd.getTime()}:${mark.receiptsRoot.toLowerCase()}:${interval}`;
  const hit = cache.get(key, deps.now());
  if (hit) return hit;
  const matched = (p: PeriodRoots) => {
    cache.set(key, p, Math.max(1, p.roots.length));
    return p;
  };
  const same = (t: PeriodRoots) => t.tree.root.toLowerCase() === mark.receiptsRoot.toLowerCase();
  const from = periodBounds(mark.periodEnd, interval).from;
  const roots = await deps.data.receiptRootsBetween(mark.bookId, from, mark.periodEnd);
  const main: PeriodRoots = { from, roots, tree: receiptsRootOf(roots) };
  if (same(main)) return matched(main);
  const [prev] = await deps.data.listMarks(mark.bookId, { limit: 1, to: new Date(mark.periodEnd.getTime() - 1) });
  if (prev && prev.periodEnd.getTime() !== from.getTime()) {
    const alt = await deps.data.receiptRootsBetween(mark.bookId, prev.periodEnd, mark.periodEnd);
    const altPeriod: PeriodRoots = { from: prev.periodEnd, roots: alt, tree: receiptsRootOf(alt) };
    if (same(altPeriod)) return matched(altPeriod);
  }
  return main;
}

const KIND_BY_NAME = new Map(Object.entries(RECEIPT_KIND_NAMES).map(([k, name]) => [name, Number(k)]));
/** Receipt kind as its number (0 quote, 1 fill, 2 hedge, 3 decision) or its name. */
const kindInput = z.union([intLike(0, 3), z.enum(["quote", "fill", "hedge", "decision"]).transform((n) => KIND_BY_NAME.get(n) as number)]);

export const receiptsRouter = router({
  /** Receipt leaves of a book, newest first (ids to pass to receipts.proof). */
  list: publicProcedure
    .input(z.object({ bookId: bookIdInput, limit: limitInput(50, 200), cursor: cursorInput, kind: kindInput.optional() }))
    .query(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const rows = await deps.data.listReceipts(b.id, { limit: input.limit, beforeId: input.cursor, kind: input.kind });
      return { ...paged(rows.map(receiptListView), input.limit, (i) => i.id), bookId: b.id };
    }),


  /** Hourly root of a book-hour, or the receipts root of a mark with its hourly leaves. */
  root: publicProcedure
    .input(z.union([z.object({ markId: intLike(1) }), z.object({ bookId: bookIdInput, hourStart: timeInput })]))
    .query(async ({ ctx: { deps }, input }) => {
      if ("markId" in input) {
        const mark = await deps.data.getMark(input.markId);
        if (!mark) return notFound(`mark ${input.markId}`);
        const interval = await markInterval(deps);
        const { from, roots, tree } = await periodRootsFor(deps, mark, interval);
        return {
          kind: "mark" as const,
          markId: mark.id,
          bookId: mark.bookId,
          periodStart: unixSec(from),
          periodEnd: unixSec(mark.periodEnd),
          receiptsRoot: mark.receiptsRoot,
          inventoryRoot: mark.inventoryRoot,
          computedRoot: tree.root,
          matches: tree.root.toLowerCase() === mark.receiptsRoot.toLowerCase(),
          hours: roots.map((r) => ({ hourStart: unixSec(r.hourStart), root: r.root, leafCount: r.leafCount })),
        };
      }
      const b = await loadBook(deps, input.bookId);
      const hourStart = floorTo(input.hourStart, deps.settings.receiptsIntervalSeconds);
      const row = await deps.data.receiptRoot(b.id, hourStart);
      const { tree } = (await hourTreeFor(deps, b.id, hourStart, row)).hour;
      if (!row && tree.count === 0) return notFound(`receipts for book ${input.bookId} at ${hourStart.toISOString()}`);
      return {
        kind: "hour" as const,
        bookId: input.bookId,
        hourStart: unixSec(hourStart),
        root: row?.root ?? tree.root,
        leafCount: row?.leafCount ?? tree.count,
        computedRoot: tree.root,
        computed: !row,
        matches: row ? row.root.toLowerCase() === tree.root.toLowerCase() : null,
        createdAt: row ? row.createdAt.toISOString() : null,
      };
    }),

  /** Leaf + hourly proof + period proof (against the mark's receiptsRoot) for one receipt. */
  proof: publicProcedure.input(z.object({ receiptId: intLike(1) })).query(async ({ ctx: { deps }, input }) => {
    const receipt = await deps.data.getReceipt(input.receiptId);
    if (!receipt) return notFound(`receipt ${input.receiptId}`);
    const interval = await markInterval(deps);
    const [storedHourRoot, covering] = await Promise.all([
      deps.data.receiptRoot(receipt.bookId, receipt.hourStart),
      deps.data.markCovering(receipt.bookId, receipt.hourStart),
    ]);
    // The hour's tree: cached once its root is committed (M-4), rebuilt when it lacks this receipt.
    const loaded = await hourTreeFor(deps, receipt.bookId, receipt.hourStart, storedHourRoot, receipt.id);
    let hour = loaded.hour;
    if (!hour.ids.has(receipt.id)) {
      // not among its hour's leaves (written meanwhile): prove it against those leaves plus itself, uncached
      const rows = loaded.rows ?? (await deps.data.receiptsInHour(receipt.bookId, receipt.hourStart));
      hour = hourTreeOf([...rows.filter((x) => x.id !== receipt.id), receipt], false);
    }
    // Only a mark whose period window contains the hour commits to it.
    const period = covering ? await periodRootsFor(deps, covering, interval) : null;
    const mark = covering && period && period.from.getTime() <= receipt.hourStart.getTime() ? covering : null;
    return buildReceiptProof({ receipt, hour, storedHourRoot, mark, periodRoots: mark && period ? period.roots : [], periodTree: mark && period ? period.tree : undefined });
  }),
});

const dbPriceView = (r: OraclePriceRow, nowMs: number, maxAge: number): OraclePriceView => ({
  priceId: r.priceId,
  price: r.price,
  priceWad: null,
  publishedAt: r.ts.toISOString(),
  held: r.held,
  sourceCount: r.sourceCount,
  stale: nowMs - r.ts.getTime() > maxAge * 1000,
  source: "db",
});

export const oracleRouter = router({
  prices: publicProcedure
    .input(z.object({ priceIds: z.array(z.string().min(1).max(64)).max(100).optional() }).default({}))
    .query(async ({ ctx: { deps }, input }) => {
      const now = deps.now();
      const maxAge = await softChain(deps, "config.maxPriceAge", async (g) => (await g.params()).maxPriceAge, deps.settings.maxPriceAgeSeconds);
      const keys = input.priceIds?.length ? input.priceIds.map((id) => KEYS.oracleLast(id)) : await deps.kv.scan(KEYS.oracleLast("*"), 500);
      const raw = await deps.kv.mget(keys);
      const live = new Map<string, OraclePriceView>();
      for (const r of raw) {
        const v = parseOraclePrice(parseJson(r), now, maxAge);
        if (v) live.set(v.priceId, v);
      }
      const missing = input.priceIds?.filter((id) => !live.has(id));
      if (!input.priceIds || (missing && missing.length)) {
        const rows = await deps.data.latestOraclePrices(missing?.length ? missing : undefined);
        for (const r of rows) if (!live.has(r.priceId)) live.set(r.priceId, dbPriceView(r, now, maxAge));
      }
      return { asOf: new Date(now).toISOString(), maxPriceAgeSeconds: maxAge, prices: [...live.values()].sort((a, b) => a.priceId.localeCompare(b.priceId)) };
    }),

  /**
   * The oracle service's latest SIGNED bundle (pull oracle, docs/LOW_GAS.md §1): the prices consumers carry
   * as `priceData` in their own tx, with each print's age. Mirrors the oracle's GET /prices/signed.
   */
  signed: publicProcedure.query(async ({ ctx: { deps } }) => {
    const now = deps.now();
    const [bundleRaw, keys] = await Promise.all([deps.kv.get(ORACLE_BUNDLE_KEY), deps.kv.scan(KEYS.oracleLast("*"), 500)]);
    const messages = keys.length ? (await deps.kv.mget(keys)).map((r) => parseJson(r)) : [];
    const gw = deps.chain();
    const view = await signedBundleView(parseJson(bundleRaw), messages, now, { chainId: deps.settings.chainId, oracle: gw?.deployment.contracts.oracle ?? null });
    const maxAge = await softChain(deps, "config.maxPriceAge", async (g) => (await g.params()).maxPriceAge, deps.settings.maxPriceAgeSeconds);
    return { ...view, maxPriceAgeSeconds: maxAge, prices: view.prices.map((p) => ({ ...p, stale: p.ageSeconds > maxAge })) };
  }),
});

export const eventsRouter = router({
  recent: publicProcedure
    .input(z.object({ limit: limitInput(50, 200), type: z.string().max(64).optional(), bookId: bookIdInput.optional(), cursor: cursorInput }).default({ limit: 50 }))
    .query(async ({ ctx: { deps }, input }) => {
      const rows = await deps.data.recentEvents({ limit: input.limit, type: input.type, bookId: input.bookId, beforeId: input.cursor });
      const items = rows.map((e) => ({ id: e.id, type: e.type, bookId: e.bookId, createdAt: e.createdAt.toISOString(), data: e.payload }));
      return paged(items, input.limit, (i) => i.id);
    }),
});
