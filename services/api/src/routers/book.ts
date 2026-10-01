import { BOOK_STATE } from "@bookrunner/shared/types";
import { KEYS } from "@bookrunner/shared/queues";
import { z } from "zod";
import { mandateToView } from "../domain/charter";
import { parseQuote } from "../domain/live";
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
  markView,
  paged,
  timeInput,
} from "./common";

const DAY_MS = 86_400_000;
const AGENT_ALIVE_MS = 30_000;

/** Bucket width for a limits window: ~288 buckets (5 min over 24h), at least 60s, at most 2000 buckets. */
export function limitsBucketSeconds(spanMs: number, requested?: number): number {
  const span = Math.max(1, Math.ceil(spanMs / 1000));
  const auto = Math.max(60, Math.ceil(span / 288));
  return Math.max(requested ?? auto, Math.ceil(span / 2000), 1);
}

export const bookRouter = router({
  list: publicProcedure.query(async ({ ctx: { deps } }) => {
    const books = await deps.data.listBooks();
    const ids = books.map((b) => b.id);
    const [marks, live, limits] = await Promise.all([deps.data.latestMarks(ids), liveNavs(deps, ids), limitsViews(deps, ids)]);
    const markBy = new Map(marks.map((m) => [m.bookId, m]));
    return books.map((b) => bookSummary(b, markBy.get(b.id) ?? null, live.get(b.id) ?? null, limits.get(b.id) ?? null));
  }),

  get: publicProcedure.input(z.object({ bookId: bookIdInput })).query(async ({ ctx: { deps }, input }) => {
    const b = await loadBook(deps, input.bookId);
    const [{ row: charterRow, charter }, marks, live, limits, quoteRaw, hbRaw] = await Promise.all([
      loadCharterOf(deps, b),
      deps.data.latestMarks([b.id]),
      liveNavs(deps, [b.id]),
      limitsViews(deps, [b.id]),
      deps.kv.get(KEYS.agentQuote(b.id)),
      deps.kv.get(KEYS.agentHeartbeat(b.id)),
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

  marks: publicProcedure
    .input(z.object({ bookId: bookIdInput, limit: limitInput(20, 200), cursor: cursorInput }))
    .query(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const rows = await deps.data.listMarks(b.id, { limit: input.limit, beforeId: input.cursor });
      const items = rows.map((m) => ({ ...markView(m), pnl: m.pnlJson, signature: m.signature }));
      return { ...paged(items, input.limit, (i) => i.markId), bookId: b.id, generatedAt: iso(new Date(deps.now())) };
    }),
});
