import { BOOK_STATE } from "@bookrunner/shared/types";
import { KEYS } from "@bookrunner/shared/queues";
import { z } from "zod";
import type { ReceiptLinkField } from "../data/types";
import type { ApiDeps } from "../deps";
import { decodeFillCursor, encodeFillCursor, fillView, hedgeView, linkKinds, receiptIdsFor } from "../domain/activity";
import { mandateToView } from "../domain/charter";
import { parseQuote, parseRiskState } from "../domain/live";
import { ORACLE_BUNDLE_KEY, markSchedule, signedBundleView, venueReportKey, venueReportView } from "../domain/lowgas";
import { iso, usdStr, wadStr } from "../format";
import { parseJson } from "../kv";
import { publicProcedure, router, softChain } from "../trpc";
import {
  bookIdInput,
  bookSummary,
  charterViewOf,
  cursorInput,
  intLike,
  limitInput,
  limitsViews,
  liveNavs,
  loadBook,
  loadCharterOf,
  markInterval,
  markView,
  paged,
  timeInput,
  venueName,
} from "./common";

const DAY_MS = 86_400_000;
const AGENT_ALIVE_MS = 30_000;

/** Bucket width for a limits window: ~288 buckets (5 min over 24h), at least 60s, at most 2000 buckets. */
export function limitsBucketSeconds(spanMs: number, requested?: number): number {
  const span = Math.max(1, Math.ceil(spanMs / 1000));
  const auto = Math.max(60, Math.ceil(span / 288));
  return Math.max(requested ?? auto, Math.ceil(span / 2000), 1);
}

/** Oracle price id of a book's underlying ("PERP_NVDA_USDC" -> "NVDA", "RHX5-PERP" -> "RHX5"); risk's view wins. */
export function bookPriceId(symbol: string, riskMeta?: Record<string, unknown> | null): string {
  const o = riskMeta?.oracle as { priceId?: unknown } | undefined;
  if (o && typeof o.priceId === "string" && o.priceId) return o.priceId;
  const m = /^PERP_([A-Z0-9.]+)_[A-Z]+$/i.exec(symbol) ?? /^([A-Z0-9.]+)-PERP$/i.exec(symbol);
  return (m?.[1] ?? symbol).toUpperCase();
}

const MARKABLE = new Set(["Live", "Retiring"]);

/** Fills keyset cursor: the `nextCursor` of the previous page ("<unix ms>:<venueTradeId>"). */
const fillCursorInput = z
  .string()
  .max(512)
  .transform((v, ctx) => {
    const c = decodeFillCursor(v);
    if (!c) {
      ctx.addIssue({ code: "custom", message: "invalid cursor (pass the nextCursor of the previous page)" });
      return z.NEVER;
    }
    return c;
  })
  .optional();

/** Receipt ids of feed rows; a failed lookup only drops the Verify links, never the feed. */
async function softReceiptIds(
  deps: ApiDeps,
  bookId: number,
  kind: number,
  field: ReceiptLinkField,
  rows: Array<{ ts: Date; value: string }>,
): Promise<Map<string, number>> {
  try {
    return await receiptIdsFor(deps.data, bookId, kind, field, rows, deps.settings.receiptsIntervalSeconds);
  } catch (err) {
    deps.log.warn({ err, what: `receipt links (${field})` }, "receipt link lookup failed; serving the feed without receipt ids");
    return new Map();
  }
}

export const bookRouter = router({
  list: publicProcedure.query(async ({ ctx: { deps } }) => {
    const books = await deps.data.listBooks();
    const ids = books.map((b) => b.id);
    const [marks, live, limits, interval] = await Promise.all([deps.data.latestMarks(ids), liveNavs(deps, ids), limitsViews(deps, ids), markInterval(deps)]);
    const markBy = new Map(marks.map((m) => [m.bookId, m]));
    const now = deps.now();
    return books.map((b) => {
      const s = bookSummary(b, markBy.get(b.id) ?? null, live.get(b.id) ?? null, limits.get(b.id) ?? null);
      return { ...s, markSchedule: markSchedule(now, interval, s.lastMark?.periodEnd ?? null, MARKABLE.has(s.state)) };
    });
  }),

  /**
   * ops-venue's latest signed venue report (docs/LOW_GAS.md §2): Orderly books only. Relayed on-chain inside
   * the book's mark tx (MarkRegistry.commitAndApply), so between marks the adapter's stored report is older.
   */
  venueReport: publicProcedure.input(z.object({ bookId: bookIdInput })).query(async ({ ctx: { deps }, input }) => {
    const b = await loadBook(deps, input.bookId);
    if (venueName(b.venue) !== "orderly") return { bookId: b.id, applicable: false as const, report: null };
    const report = await venueReportView(parseJson(await deps.kv.get(venueReportKey(b.id))), deps.now()).catch(() => null);
    return { bookId: b.id, applicable: true as const, report };
  }),

  get: publicProcedure.input(z.object({ bookId: bookIdInput })).query(async ({ ctx: { deps }, input }) => {
    const b = await loadBook(deps, input.bookId);
    const [{ row: charterRow, charter }, marks, live, limits, quoteRaw, hbRaw, riskRaw, bundleRaw, reportRaw, interval] = await Promise.all([
      loadCharterOf(deps, b),
      deps.data.latestMarks([b.id]),
      liveNavs(deps, [b.id]),
      limitsViews(deps, [b.id]),
      deps.kv.get(KEYS.agentQuote(b.id)),
      deps.kv.get(KEYS.agentHeartbeat(b.id)),
      deps.kv.get(KEYS.riskState(b.id)),
      deps.kv.get(ORACLE_BUNDLE_KEY),
      venueName(b.venue) === "orderly" ? deps.kv.get(venueReportKey(b.id)) : Promise.resolve(null),
      markInterval(deps),
    ]);
    const mark = marks[0] ?? null;
    const summary = bookSummary(b, mark, live.get(b.id) ?? null, limits.get(b.id) ?? null);
    const [chainBook, chainMandate] = await Promise.all([
      softChain(deps, "book.state", (g) => g.bookState(summary.components.book), null),
      softChain(deps, "mandate.state", (g) => g.mandateState(summary.components.mandate), null),
    ]);
    const hb = hbRaw != null && /^\d+$/.test(hbRaw) ? Number(hbRaw) : null;
    const overlay = chainBook
      ? {
          state: BOOK_STATE[chainBook.state] ?? summary.state,
          seniorNavUsd: usdStr(chainBook.seniorNav),
          juniorNavUsd: usdStr(chainBook.juniorNav),
          seniorSharePrice: wadStr(chainBook.seniorPriceWad),
          juniorSharePrice: wadStr(chainBook.juniorPriceWad),
          subscriptionEnds: chainBook.subscriptionEnds ? new Date(chainBook.subscriptionEnds * 1000).toISOString() : summary.subscriptionEnds,
        }
      : {};
    const mandate = chainMandate ? chainMandate.mandate : (charter?.mandate ?? null);
    // low-gas mode (LOW_GAS §1-§3): the latest signed print of the underlying, the signed venue report, the mark schedule
    const now = deps.now();
    const priceId = bookPriceId(b.symbol, parseRiskState(parseJson(riskRaw))?.meta ?? null);
    const gw = deps.chain();
    let messages: unknown[] = [];
    if (!bundleRaw) messages = [parseJson(await deps.kv.get(KEYS.oracleLast(priceId)))];
    const bundle = await signedBundleView(parseJson(bundleRaw), messages, now, { chainId: deps.settings.chainId, oracle: gw?.deployment.contracts.oracle ?? null }).catch(() => null);
    const signedPrice = bundle?.prices.find((p) => p.priceId === priceId) ?? null;
    const venueReport = reportRaw ? await venueReportView(parseJson(reportRaw), now).catch(() => null) : null;
    const state = (overlay.state ?? summary.state) as string;
    const lastPeriodEnd = summary.lastMark?.periodEnd ?? null;
    return {
      ...summary,
      ...overlay,
      charter: charter ? charterViewOf(deps, charter) : null,
      charterStatus: charterRow?.status ?? null,
      mandate: mandate ? mandateToView(mandate) : null,
      killed: chainMandate?.killed ?? summary.limits?.state === "killed",
      latestMark: mark ? markView(mark) : null,
      quote: parseQuote(parseJson(quoteRaw)),
      agent: { heartbeatAt: hb ? new Date(hb).toISOString() : null, alive: hb !== null && deps.now() - hb < AGENT_ALIVE_MS },
      source: chainBook ? ("chain" as const) : ("db" as const),
      priceId,
      signedPrice,
      venueReport,
      markSchedule: markSchedule(now, interval, lastPeriodEnd, MARKABLE.has(state)),
    };
  }),

  nav: publicProcedure
    .input(z.object({ bookId: bookIdInput, from: timeInput.optional(), to: timeInput.optional(), limit: limitInput(500, 5000) }))
    .query(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const [rows, live] = await Promise.all([
        deps.data.listMarks(b.id, { limit: input.limit, from: input.from, to: input.to }),
        liveNavs(deps, [b.id]),
      ]);
      const points = rows
        .map(markView)
        .reverse()
        .map((m) => ({
          ts: m.periodEndAt,
          periodEnd: m.periodEnd,
          markId: m.markId,
          navUsd: m.navUsd,
          seniorNavUsd: m.seniorNavUsd,
          juniorNavUsd: m.juniorNavUsd,
          seniorSharePrice: m.seniorSharePrice,
          juniorSharePrice: m.juniorSharePrice,
          pnlUsd: m.pnlUsd,
          source: "mark" as const,
        }));
      const l = live.get(b.id) ?? null;
      return {
        bookId: b.id,
        symbol: b.symbol,
        points,
        live: l ? { ...l, ts: l.ts ?? new Date(deps.now()).toISOString() } : null,
      };
    }),

  limits: publicProcedure
    .input(z.object({ bookId: bookIdInput, from: timeInput.optional(), to: timeInput.optional(), bucketSeconds: intLike(1, 86_400).optional() }))
    .query(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const to = input.to ?? new Date(deps.now());
      const from = input.from ?? new Date(to.getTime() - DAY_MS);
      const bucketSeconds = limitsBucketSeconds(to.getTime() - from.getTime(), input.bucketSeconds);
      const [series, latest, { charter }] = await Promise.all([
        deps.data.limitsSeries(b.id, from, to, bucketSeconds),
        limitsViews(deps, [b.id]),
        loadCharterOf(deps, b),
      ]);
      return {
        bookId: b.id,
        from: from.toISOString(),
        to: to.toISOString(),
        bucketSeconds,
        latest: latest.get(b.id) ?? null,
        series: series.map((s) => ({ ...s, bucket: s.bucket.toISOString() })),
        mandate: charter ? mandateToView(charter.mandate) : null,
      };
    }),

  /** Venue fills of the book (fills table), newest first, each linked to its fill receipt. */
  fills: publicProcedure
    .input(z.object({ bookId: bookIdInput, limit: limitInput(50, 200), cursor: fillCursorInput }))
    .query(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const rows = await deps.data.listFills(b.id, { limit: input.limit, before: input.cursor });
      const ids = await softReceiptIds(deps, b.id, linkKinds.fill, "venueTradeId", rows.map((r) => ({ ts: r.ts, value: r.venueTradeId })));
      const last = rows[rows.length - 1];
      return {
        bookId: b.id,
        items: rows.map((r) => fillView(r, ids.get(r.venueTradeId) ?? null)),
        nextCursor: rows.length === input.limit && last ? encodeFillCursor(last) : null,
      };
    }),

  /** Desk hedges of the book (hedges table), newest first, each linked to its hedge receipt. */
  hedges: publicProcedure
    .input(z.object({ bookId: bookIdInput, limit: limitInput(50, 200), cursor: cursorInput }))
    .query(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const rows = await deps.data.listHedges(b.id, { limit: input.limit, beforeId: input.cursor });
      const ids = await softReceiptIds(deps, b.id, linkKinds.hedge, "txHash", rows.map((r) => ({ ts: r.ts, value: r.txHash })));
      const items = rows.map((r) => hedgeView(r, ids.get(r.txHash.toLowerCase()) ?? null));
      return { ...paged(items, input.limit, (i) => i.id), bookId: b.id };
    }),

  marks: publicProcedure
    .input(z.object({ bookId: bookIdInput, limit: limitInput(20, 200), cursor: cursorInput }))
    .query(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const rows = await deps.data.listMarks(b.id, { limit: input.limit, beforeId: input.cursor });
      const items = rows.map((m) => ({ ...markView(m), pnl: m.pnlJson, signature: m.signature }));
      return { ...paged(items, input.limit, (i) => i.markId), bookId: b.id, generatedAt: iso(new Date(deps.now())) };
    }),
});
