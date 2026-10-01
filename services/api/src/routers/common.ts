import { BOOK_STATE, type Charter, VENUE } from "@bookrunner/shared/types";
import { KEYS } from "@bookrunner/shared/queues";
import { type Address, getAddress } from "viem";
import { z } from "zod";
import type { BookRow, CharterRow, LimitsRow, MarkRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { type CharterView, charterFromJson, charterToView } from "../domain/charter";
import { type LimitsView, type LiveNavView, limitsRowToView, parseLiveNav, parseRiskState } from "../domain/live";
import { dbUsdStr, iso, sharePriceStr, toDate, unixSec } from "../format";
import { parseJson } from "../kv";
import { notFound, softChain } from "../trpc";

// ------------------------------------------------------------------ input helpers
/** Integer from a number or a digit string (REST query params arrive as strings). */
export const intLike = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.union([z.number(), z.string().regex(/^-?\d+$/, "expected an integer").transform(Number)]).pipe(z.number().int().min(min).max(max));

export const bookIdInput = intLike(1);
export const trancheInput = z.enum(["senior", "junior"]);
export const walletInput = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "invalid address")
  .transform((s) => getAddress(s));
export const limitInput = (def: number, max: number) => intLike(1, max).default(def);
export const cursorInput = intLike(1).optional();

/** unix seconds | unix ms | ISO string | Date (superjson clients) -> Date. */
export const timeInput = z.union([z.number(), z.string(), z.date()]).transform((v, ctx) => {
  try {
    return toDate(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid time (unix seconds, unix ms or ISO 8601)" });
    return z.NEVER;
  }
});

export interface Paged<T> {
  items: T[];
  nextCursor: number | null;
}

export function paged<T>(items: T[], limit: number, cursorOf: (t: T) => number): Paged<T> {
  const last = items[items.length - 1];
  return { items, nextCursor: items.length === limit && last ? cursorOf(last) : null };
}

// ------------------------------------------------------------------ loading
export async function loadBook(deps: ApiDeps, bookId: number): Promise<BookRow> {
  const b = await deps.data.getBook(bookId);
  return b ?? notFound(`book ${bookId}`);
}

export async function loadCharterOf(deps: ApiDeps, book: BookRow): Promise<{ row: CharterRow | null; charter: Charter | null }> {
  const row = await deps.data.getCharter(book.charterId);
  return { row, charter: row ? charterFromJson(row.structJson) : null };
}

export async function markInterval(deps: ApiDeps): Promise<number> {
  return softChain(deps, "config.markInterval", async (c) => (await c.params()).markInterval, deps.settings.markIntervalSeconds);
}

export const stockTokens = (deps: ApiDeps) => deps.chain()?.deployment.stockTokens ?? {};

export function charterViewOf(deps: ApiDeps, c: Charter): CharterView {
  return charterToView(c, { stockTokens: stockTokens(deps) });
}

export const trancheAddress = (b: BookRow, t: "senior" | "junior"): Address => getAddress(t === "senior" ? b.seniorAddr : b.juniorAddr);
export const trancheKind = (t: "senior" | "junior"): 0 | 1 => (t === "senior" ? 0 : 1);
export const trancheLabel = (b: BookRow, t: "senior" | "junior") => `the ${t === "senior" ? "Senior" : "Junior"} tranche of book #${b.id} (${b.symbol})`;

// ------------------------------------------------------------------ views
export interface MarkView {
  markId: number;
  bookId: number;
  periodEnd: number;
  periodEndAt: string;
  navUsd: string;
  deployedValueUsd: string;
  seniorNavUsd: string | null;
  juniorNavUsd: string | null;
  seniorSharePrice: string | null;
  juniorSharePrice: string | null;
  pnlUsd: string | null;
  flowNonce: number;
  receiptsRoot: string;
  inventoryRoot: string;
  pnlJsonHash: string;
  signer: string;
  txHash: string;
  appliedTx: string | null;
  committedAt: string;
}

function pnlTranches(m: MarkRow): Record<string, unknown> {
  const p = (m.pnlJson ?? {}) as Record<string, unknown>;
  return (p.tranches ?? {}) as Record<string, unknown>;
}

export function markView(m: MarkRow): MarkView {
  const t = pnlTranches(m);
  return {
    markId: m.id,
    bookId: m.bookId,
    periodEnd: unixSec(m.periodEnd),
    periodEndAt: m.periodEnd.toISOString(),
    navUsd: dbUsdStr(m.navUsd) ?? "0.000000",
    deployedValueUsd: dbUsdStr(m.deployedValueUsd) ?? "0.000000",
    seniorNavUsd: dbUsdStr(m.seniorNav),
    juniorNavUsd: dbUsdStr(m.juniorNav),
    seniorSharePrice: sharePriceStr(m.seniorPrice) ?? sharePriceStr(t.seniorPrice as string | number | undefined),
    juniorSharePrice: sharePriceStr(m.juniorPrice) ?? sharePriceStr(t.juniorPrice as string | number | undefined),
    pnlUsd: dbUsdStr(m.pnlUsd),
    flowNonce: m.flowNonce,
    receiptsRoot: m.receiptsRoot,
    inventoryRoot: m.inventoryRoot,
    pnlJsonHash: m.pnlJsonHash,
    signer: m.signer,
    txHash: m.txHash,
    appliedTx: m.appliedTx,
    committedAt: m.committedAt.toISOString(),
  };
}

export interface BookComponentsView {
  book: Address;
  senior: Address;
  junior: Address;
  vault: Address;
  mandate: Address;
  router: Address;
  desk: Address;
  adapter: Address;
}

export const componentsView = (b: BookRow): BookComponentsView => ({
  book: getAddress(b.bookAddr),
  senior: getAddress(b.seniorAddr),
  junior: getAddress(b.juniorAddr),
  vault: getAddress(b.vaultAddr),
  mandate: getAddress(b.mandateAddr),
  router: getAddress(b.routerAddr),
  desk: getAddress(b.deskAddr),
  adapter: getAddress(b.adapterAddr),
});

export interface BookSummary {
  bookId: number;
  charterId: number;
  name: string | null;
  symbol: string;
  venue: "orderly" | "pool_engine";
  state: string;
  underlying: string;
  subscriptionEnds: string | null;
  createdAt: string;
  components: BookComponentsView;
  navUsd: string | null;
  seniorNavUsd: string | null;
  juniorNavUsd: string | null;
  seniorSharePrice: string;
  juniorSharePrice: string;
  lastMark: Pick<MarkView, "markId" | "periodEnd" | "periodEndAt" | "navUsd" | "committedAt"> | null;
  liveNav: LiveNavView | null;
  limits: LimitsView | null;
}

export const venueName = (v: number): "orderly" | "pool_engine" => (v === VENUE.POOL_ENGINE ? "pool_engine" : "orderly");

/** Book row + latest mark + live NAV + limits -> summary. Share price is 1.0 before the first mark. */
export function bookSummary(b: BookRow, mark: MarkRow | null, live: LiveNavView | null, limits: LimitsView | null): BookSummary {
  const mv = mark ? markView(mark) : null;
  return {
    bookId: b.id,
    charterId: b.charterId,
    name: b.name,
    symbol: b.symbol,
    venue: venueName(b.venue),
    state: BOOK_STATE.includes(b.state as (typeof BOOK_STATE)[number]) ? b.state : "Subscription",
    underlying: b.underlying,
    subscriptionEnds: iso(b.subscriptionEnds),
    createdAt: b.createdAt.toISOString(),
    components: componentsView(b),
    navUsd: dbUsdStr(b.navUsd) ?? mv?.navUsd ?? null,
    seniorNavUsd: dbUsdStr(b.seniorNav) ?? mv?.seniorNavUsd ?? null,
    juniorNavUsd: dbUsdStr(b.juniorNav) ?? mv?.juniorNavUsd ?? null,
    seniorSharePrice: mv?.seniorSharePrice ?? "1.0",
    juniorSharePrice: mv?.juniorSharePrice ?? "1.0",
    lastMark: mv ? { markId: mv.markId, periodEnd: mv.periodEnd, periodEndAt: mv.periodEndAt, navUsd: mv.navUsd, committedAt: mv.committedAt } : null,
    liveNav: live,
    limits,
  };
}

// ------------------------------------------------------------------ live state readers
export async function liveNavs(deps: ApiDeps, bookIds: number[]): Promise<Map<number, LiveNavView>> {
  const raw = await deps.kv.mget(bookIds.map((id) => KEYS.liveNav(id)));
  const out = new Map<number, LiveNavView>();
  bookIds.forEach((id, i) => {
    const v = parseLiveNav(parseJson(raw[i]));
    if (v) out.set(id, v);
  });
  return out;
}

/** Limits per book: live Redis risk state when present, else the newest limits row. */
export async function limitsViews(deps: ApiDeps, bookIds: number[], rows?: LimitsRow[]): Promise<Map<number, LimitsView>> {
  const raw = await deps.kv.mget(bookIds.map((id) => KEYS.riskState(id)));
  const dbRows = rows ?? (await deps.data.latestLimits(bookIds));
  const byBook = new Map(dbRows.map((r) => [r.bookId, r]));
  const out = new Map<number, LimitsView>();
  bookIds.forEach((id, i) => {
    const live = parseRiskState(parseJson(raw[i]));
    if (live) {
      const { meta: _meta, ...view } = live;
      out.set(id, view);
    } else {
      const r = byBook.get(id);
      if (r) out.set(id, limitsRowToView(r));
    }
  });
  return out;
}
