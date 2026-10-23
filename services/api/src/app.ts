// Hono app: /health (+ ops-venue's Orderly listing status), tRPC at /trpc, REST mirror at /v1, read-only MCP at /mcp, CORS for apps/web.
import { KEYS, parseVenueMarkets, type VenueMarketMsg, venueMarketGate } from "@bookrunner/shared";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApiDeps } from "./deps";
import type { Kv } from "./kv";
import { type StatusView, buildStatus } from "./domain/status";
import { handleMcpRequest } from "./mcp";
import { restRoutes } from "./rest";
import { appRouter } from "./router";
import { limitsViews, markInterval } from "./routers/common";
import { bearerMatches } from "./webhooks/routes";

export interface AppOptions {
  origins: string[];
}

/**
 * Most procedures one HTTP batch may carry. Every call of a batch runs its own DB / chain reads, so an
 * unbounded GET is an amplification lever; the web client splits its batches at the same size
 * (apps/web httpBatchLink maxItems) and nginx rate-limits /trpc/ per IP.
 */
export const MAX_TRPC_BATCH = 10;

/**
 * Batch weight (audit M-4): receipts.* calls (Merkle proofs / roots over an hour of leaves) are heavy, so one
 * counts as a full batch: a request may carry a single receipts.* call and nothing else. The web client
 * sends them unbatched (apps/web httpLink split), and nginx rate-limits them per IP in their own zone.
 * Every other procedure weighs 1 (the batch cap above).
 */
export const TRPC_HEAVY_PREFIXES = ["receipts."] as const;
export const TRPC_HEAVY_WEIGHT = MAX_TRPC_BATCH;

export function trpcBatchWeight(paths: string[]): number {
  return paths.reduce((w, p) => w + (TRPC_HEAVY_PREFIXES.some((h) => p.startsWith(h)) ? TRPC_HEAVY_WEIGHT : 1), 0);
}

/**
 * Path confusion (audit L-3). nginx exposes only /health, /status.json and /trpc/ of this API; a request
 * like `/trpc/..\v1\books` used to reach the REST mirror, /v1/webhooks and /mcp because Bun resolves
 * backslashes and dot-segments before the app sees the URL. nginx now forwards a normalized path and
 * stamps each proxied location in ROUTE_HEADER; the API refuses a request whose path is outside the
 * stamped location (prefix when it ends with "/", else exact), and any path with encoded slashes,
 * backslashes or dots or a dot-segment, whoever sends it.
 */
export const ROUTE_HEADER = "x-bookrunner-route";
const SUSPECT_PATH = /\\|%(?:2f|5c|2e)|(?:^|\/)\.\.?(?:\/|$)/i;

export function pathAllowed(pathname: string, route: string | undefined): boolean {
  if (SUSPECT_PATH.test(pathname)) return false;
  if (route === undefined) return true;
  return route.endsWith("/") ? pathname.startsWith(route) && pathname.length > route.length : pathname === route;
}

/**
 * Procedures a client may find missing on an older API (apps/web useOptional): /health lists which of
 * them this build serves as `capabilities`, so the web never probes one that is absent. The full
 * procedure list (and uptime) is only in `/health?verbose` with the admin bearer token.
 */
export const OPTIONAL_PROCEDURES = ["book.fills", "book.hedges", "receipts.list", "pool.overview", "trade.markets"] as const;

/** /status is computed at most this often per process (nginx micro-caches it too); public, so cheap. */
export const STATUS_CACHE_MS = 15_000;
export const STATUS_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";

/** /health `orderlyListing`: ops-venue's Orderly market state (KEYS.venueSymbolIssues, docs/VERIFY.md O20). */
export interface OrderlyListingHealth {
  mode: "mock" | "live";
  listingMode: "api" | "manual";
  /** per venue symbol: phase (unknown / awaiting / listed / missing), Orderly status, open for new risk, failed checks */
  markets: Array<Omit<VenueMarketMsg, "error" | "checkedAt" | "everListed">>;
  /** books whose market is not open for new risk (not listed, missing, restricted or POST_ONLY) */
  notOpen: number[];
  /** manual mode: IF withdrawals waiting for the admin's delisting in Orderly One */
  delistWaits: Array<{ bookId: number; symbol: string; since: number }>;
}

/** ops-venue's status from Redis (absent / unreadable / slow -> null; never fails /health). Check errors stay private. */
export async function orderlyListingHealth(kv: Kv, timeoutMs = 500): Promise<OrderlyListingHealth | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raw = await Promise.race([kv.get(KEYS.venueSymbolIssues).catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)))]).finally(() => clearTimeout(timer));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { mode?: unknown; listingMode?: unknown; delistWaits?: unknown };
    if (o.mode !== "mock" && o.mode !== "live") return null;
    const markets = parseVenueMarkets(o);
    const waits = Array.isArray(o.delistWaits) ? (o.delistWaits as Array<Record<string, unknown> | null>) : [];
    return {
      mode: o.mode,
      listingMode: o.listingMode === "manual" ? "manual" : "api",
      markets: markets.map(({ symbol, bookIds, phase, venueStatus, openForRisk, since, failures }) => ({ symbol, bookIds, phase, venueStatus, openForRisk, since, failures })),
      notOpen: markets.flatMap((m) => (venueMarketGate([m], m.bookIds[0] ?? -1) ? m.bookIds : [])).sort((a, b) => a - b),
      delistWaits: waits
        .filter((x): x is Record<string, unknown> => !!x && Number.isFinite(Number(x.bookId)) && typeof x.symbol === "string")
        .map((x) => ({ bookId: Number(x.bookId), symbol: x.symbol as string, since: Number(x.since) || 0 })),
    };
  } catch {
    return null;
  }
}

export function createApp(deps: ApiDeps, opts: AppOptions) {
  const app = new Hono();
  const started = deps.now();
  const procedures = Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures).sort();
  const capabilities = OPTIONAL_PROCEDURES.filter((p) => procedures.includes(p));

  app.use("*", async (c, next) => {
    // the raw path as Bun parsed it (c.req.path is the routing path)
    const pathname = new URL(c.req.url).pathname;
    if (!pathAllowed(pathname, c.req.header(ROUTE_HEADER))) return c.json({ error: { code: "BAD_REQUEST", message: "invalid request path" } }, 400);
    await next();
  });

  app.use(
    "*",
    cors({
      origin: opts.origins,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "mcp-session-id", "mcp-protocol-version", "last-event-id", "trpc-accept"],
      exposeHeaders: ["mcp-session-id"],
      maxAge: 600,
    }),
  );

  app.get("/health", async (c) => {
    const [extra, orderlyListing] = await Promise.all([deps.health ? deps.health().catch((err) => ({ healthError: String(err) })) : {}, orderlyListingHealth(deps.kv)]);
    const token = deps.settings.adminToken;
    const verbose = c.req.query("verbose") !== undefined && !!token && bearerMatches(c.req.header("authorization"), token);
    return c.json({
      ok: true,
      service: "api",
      chainId: deps.settings.chainId,
      deployment: deps.chain() !== null,
      capabilities,
      ...(verbose ? { uptimeSec: Math.floor((deps.now() - started) / 1000), procedures } : {}),
      ...(orderlyListing ? { orderlyListing } : {}),
      ...extra,
    });
  });

  // public status (apps/site /status/, nginx /status.json): mark age, risk level, last distribution per book
  let statusCache: { at: number; body: StatusView } | null = null;
  let statusInflight: Promise<StatusView> | null = null;
  const loadStatus = async (): Promise<StatusView> => {
    const books = await deps.data.listBooks();
    const ids = books.map((b) => b.id);
    const [marks, limits, distributions, interval] = await Promise.all([deps.data.latestMarks(ids), limitsViews(deps, ids), deps.data.latestDistributions(ids), markInterval(deps)]);
    return buildStatus({ books, marks, limits, distributions, markIntervalSec: interval, chainId: deps.settings.chainId, now: deps.now() });
  };
  app.get("/status", async (c) => {
    const now = deps.now();
    if (!statusCache || now - statusCache.at >= STATUS_CACHE_MS) {
      // one computation at a time, however many requests arrive together
      statusInflight ??= loadStatus().finally(() => {
        statusInflight = null;
      });
      try {
        statusCache = { at: now, body: await statusInflight };
      } catch (err) {
        deps.log.warn({ err }, "status unavailable");
        c.header("Cache-Control", "no-store");
        return c.json({ error: { code: "UNAVAILABLE", message: "status temporarily unavailable" } }, 503);
      }
    }
    c.header("Cache-Control", STATUS_CACHE_CONTROL);
    return c.json(statusCache.body);
  });

  // weighted batch cap (receipts.* fill a batch): checked before tRPC parses inputs or runs anything
  app.use("/trpc/*", async (c, next) => {
    const raw = new URL(c.req.url).pathname.slice("/trpc/".length);
    let paths: string[];
    try {
      paths = decodeURIComponent(raw).split(",");
    } catch {
      return c.json({ error: { code: "BAD_REQUEST", message: "invalid procedure path" } }, 400);
    }
    if (paths.length > 1 && trpcBatchWeight(paths) > MAX_TRPC_BATCH) {
      return c.json(
        { error: { json: { message: `Batch too heavy: receipts.* calls must be sent alone, others at most ${MAX_TRPC_BATCH} per batch`, code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400 } } } },
        400,
      );
    }
    await next();
  });

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      endpoint: "/trpc",
      maxBatchSize: MAX_TRPC_BATCH,
      createContext: () => ({ deps }),
      onError: ({ error, path }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") deps.log.error({ err: error.cause ?? error, path }, "tRPC procedure failed");
      },
    }),
  );

  app.route("/v1", restRoutes(deps, { origins: opts.origins }));

  app.all("/mcp", (c) => handleMcpRequest(deps, c.req.raw));

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "route not found" } }, 404));
  app.onError((err, c) => {
    deps.log.error({ err }, "unhandled route error");
    return c.json({ error: { code: "INTERNAL_SERVER_ERROR", message: "internal error" } }, 500);
  });

  return app;
}

export type ApiApp = ReturnType<typeof createApp>;
