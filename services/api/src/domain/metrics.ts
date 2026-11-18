// Public metrics (GET /metrics, apps/site /metrics/, nginx /metrics.json): protocol-wide totals, read-only and with
// nothing per wallet: book TVL, the insurance pool, the backstop, revenue, engine open interest and open positions,
// BKRN buybacks and the age of the latest oracle prices. A figure that cannot be read is null (the page says so), never
// a made-up zero. Book NAV and insurance pool assets are NOT summed: pool-funded books hold pool money, so a total would
// count it twice.
import { KEYS } from "@bookrunner/shared/queues";
import { VENUE } from "@bookrunner/shared/types";
import { USD_DECIMALS, parseFixed } from "@bookrunner/shared/units";
import type { Address } from "viem";
import type { ProtocolTotals } from "../chain/gateway";
import type { BookRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { dbUsdStr, usdStr } from "../format";
import { parseJson } from "../kv";
import { SIZE_PRICE_TO_USD } from "./engine";
import { parseOraclePrice } from "./live";

export const METRICS_CACHE_MS = 30_000;
export const METRICS_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";

const LIVE_STATES = new Set(["Live", "Retiring"]);

export interface MetricsView {
  generatedAt: string;
  chainId: number;
  /** books holding capital (Live / Retiring) */
  liveBooks: number;
  tvl: {
    /** sum of the live books' NAV */
    booksUsd: string;
    /** InsurancePool.poolAssets (free liquidity + claims on books), from the indexer's latest snapshot; null: no pool activity indexed */
    insurancePoolUsd: string | null;
    insurancePoolFirstLossUsd: string | null;
    /** Backstop balance; null: not readable */
    backstopUsd: string | null;
  };
  revenue: { totalUsd: string; bySource: Array<{ source: string; usd: string }> };
  engine: {
    markets: number;
    /** long + short notional at the stored oracle price; null: a market with open size has no price, or the chain is unreadable */
    openInterestUsd: { long: string; short: string; total: string } | null;
    openPositions: number;
  };
  buybacks: { spentUsd: string; pendingUsd: string } | null;
  oracle: Array<{ priceId: string; ageSeconds: number; held: boolean }>;
}

export interface MetricsInput {
  now: number;
  chainId: number;
  books: BookRow[];
  insurance: { poolAssets: string; firstLoss: string } | null;
  totals: ProtocolTotals | null;
  revenue: Array<{ source: string; totalUsd: string }>;
  openPositions: number;
  markets: Array<{ longSize: bigint; shortSize: bigint; priceWad: bigint | null }> | null;
  prices: Array<{ priceId: string; publishedAtMs: number; held: boolean }>;
}

const rawUsd = (s: string | null | undefined): bigint => (s ? parseFixed(s, USD_DECIMALS) : 0n);

export function buildMetrics(i: MetricsInput): MetricsView {
  const live = i.books.filter((b) => LIVE_STATES.has(b.state));
  const booksUsd = live.reduce((s, b) => s + rawUsd(dbUsdStr(b.navUsd)), 0n);
  const revenueTotal = i.revenue.reduce((s, r) => s + rawUsd(r.totalUsd), 0n);

  let oi: MetricsView["engine"]["openInterestUsd"] = null;
  if (i.markets && i.markets.every((m) => m.priceWad !== null || (m.longSize === 0n && m.shortSize === 0n))) {
    let long = 0n;
    let short = 0n;
    for (const m of i.markets) {
      if (m.priceWad === null) continue;
      long += (m.longSize * m.priceWad) / SIZE_PRICE_TO_USD;
      short += (-m.shortSize * m.priceWad) / SIZE_PRICE_TO_USD;
    }
    oi = { long: usdStr(long), short: usdStr(short), total: usdStr(long + short) };
  }
  const t = i.totals;
  return {
    generatedAt: new Date(i.now).toISOString(),
    chainId: i.chainId,
    liveBooks: live.length,
    tvl: {
      booksUsd: usdStr(booksUsd),
      insurancePoolUsd: i.insurance ? dbUsdStr(i.insurance.poolAssets) : null,
      insurancePoolFirstLossUsd: i.insurance ? dbUsdStr(i.insurance.firstLoss) : null,
      backstopUsd: t?.backstopUsd != null ? usdStr(t.backstopUsd) : null,
    },
    revenue: { totalUsd: usdStr(revenueTotal), bySource: i.revenue.map((r) => ({ source: r.source, usd: r.totalUsd })) },
    engine: { markets: i.markets?.length ?? 0, openInterestUsd: oi, openPositions: i.openPositions },
    buybacks: t && t.buybackSpentUsd != null ? { spentUsd: usdStr(t.buybackSpentUsd), pendingUsd: usdStr(t.buybackPendingUsd ?? 0n) } : null,
    oracle: i.prices
      .map((p) => ({ priceId: p.priceId, ageSeconds: Math.max(0, Math.floor((i.now - p.publishedAtMs) / 1000)), held: p.held }))
      .sort((a, b) => a.priceId.localeCompare(b.priceId)),
  };
}

/** Reads everything (DB reads propagate their errors; chain reads that fail leave their figures null). */
export async function loadMetrics(deps: ApiDeps): Promise<MetricsView> {
  const now = deps.now();
  const books = await deps.data.listBooks();
  const gw = deps.chain();
  const soft = async <T>(what: string, p: Promise<T>): Promise<T | null> =>
    p.catch((err) => {
      deps.log.warn({ err, what }, "metrics chain read failed");
      return null;
    });
  const engineLive = books.filter((b) => b.venue === VENUE.POOL_ENGINE && LIVE_STATES.has(b.state));
  const [snapshot, revenue, openPositions, totals, chains, kvKeys] = await Promise.all([
    deps.data.latestPoolSnapshot(),
    deps.data.revenueTotals(),
    deps.data.openEnginePositions(),
    gw ? soft("protocolTotals", gw.protocolTotals()) : Promise.resolve(null),
    gw ? soft("engineMarkets", Promise.all(engineLive.map((b) => gw.engineMarket(b.adapterAddr as Address)))) : Promise.resolve(null),
    deps.kv.scan(KEYS.oracleLast("*"), 500).catch(() => [] as string[]),
  ]);
  const prices = new Map<string, { priceId: string; publishedAtMs: number; held: boolean }>();
  for (const r of await deps.kv.mget(kvKeys).catch(() => [] as Array<string | null>)) {
    const v = parseOraclePrice(parseJson(r), now, 0);
    if (v) prices.set(v.priceId, { priceId: v.priceId, publishedAtMs: Date.parse(v.publishedAt), held: v.held });
  }
  for (const r of await deps.data.latestOraclePrices()) if (!prices.has(r.priceId)) prices.set(r.priceId, { priceId: r.priceId, publishedAtMs: r.ts.getTime(), held: r.held });
  return buildMetrics({
    now,
    chainId: deps.settings.chainId,
    books,
    insurance: snapshot ? { poolAssets: snapshot.poolAssets, firstLoss: snapshot.firstLoss } : null,
    totals,
    revenue,
    openPositions,
    markets: chains ? chains.flatMap((c) => (c ? [{ longSize: c.state.longSize, shortSize: c.state.shortSize, priceWad: c.stored ? c.stored.priceWad : null }] : [])) : null,
    prices: [...prices.values()].filter((p) => Number.isFinite(p.publishedAtMs)),
  });
}
