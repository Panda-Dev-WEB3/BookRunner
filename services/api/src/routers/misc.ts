// risk.state, settlements.list, receipts.root/proof, oracle.prices + oracle.signed, events.recent
import { KEYS } from "@bookrunner/shared/queues";
import { z } from "zod";
import type { MarkRow, OraclePriceRow, ReceiptRootRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { limitsRowToView, type OraclePriceView, parseOraclePrice, parseRiskState } from "../domain/live";
import { ORACLE_BUNDLE_KEY, signedBundleView } from "../domain/lowgas";
import { buildReceiptProof, hourlyTree, periodBounds, receiptsRootOf } from "../domain/receipts";
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
 */
async function periodRootsFor(deps: ApiDeps, mark: MarkRow, interval: number): Promise<{ from: Date; roots: ReceiptRootRow[] }> {
  const from = periodBounds(mark.periodEnd, interval).from;
  const roots = await deps.data.receiptRootsBetween(mark.bookId, from, mark.periodEnd);
  const same = (rs: ReceiptRootRow[]) => receiptsRootOf(rs).root.toLowerCase() === mark.receiptsRoot.toLowerCase();
  if (same(roots)) return { from, roots };
  const [prev] = await deps.data.listMarks(mark.bookId, { limit: 1, to: new Date(mark.periodEnd.getTime() - 1) });
  if (prev && prev.periodEnd.getTime() !== from.getTime()) {
    const alt = await deps.data.receiptRootsBetween(mark.bookId, prev.periodEnd, mark.periodEnd);
    if (same(alt)) return { from: prev.periodEnd, roots: alt };
  }
  return { from, roots };
}

export const receiptsRouter = router({
  /** Hourly root of a book-hour, or the receipts root of a mark with its hourly leaves. */
  root: publicProcedure
    .input(z.union([z.object({ markId: intLike(1) }), z.object({ bookId: bookIdInput, hourStart: timeInput })]))
    .query(async ({ ctx: { deps }, input }) => {
      if ("markId" in input) {
        const mark = await deps.data.getMark(input.markId);
        if (!mark) return notFound(`mark ${input.markId}`);
        const interval = await markInterval(deps);
        const { from, roots } = await periodRootsFor(deps, mark, interval);
        const tree = receiptsRootOf(roots);
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
      const hourStart = floorTo(input.hourStart, deps.settings.receiptsIntervalSeconds);
      const [row, leaves] = await Promise.all([deps.data.receiptRoot(input.bookId, hourStart), deps.data.receiptsInHour(input.bookId, hourStart)]);
      if (!row && leaves.length === 0) return notFound(`receipts for book ${input.bookId} at ${hourStart.toISOString()}`);
      const tree = hourlyTree(leaves);
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
    const [hourRows, storedHourRoot, covering] = await Promise.all([
      deps.data.receiptsInHour(receipt.bookId, receipt.hourStart),
      deps.data.receiptRoot(receipt.bookId, receipt.hourStart),
      deps.data.markCovering(receipt.bookId, receipt.hourStart),
    ]);
    // Only a mark whose period window contains the hour commits to it.
    const period = covering ? await periodRootsFor(deps, covering, interval) : null;
    const mark = covering && period && period.from.getTime() <= receipt.hourStart.getTime() ? covering : null;
    return buildReceiptProof({ receipt, hourRows, storedHourRoot, mark, periodRoots: mark && period ? period.roots : [] });
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
