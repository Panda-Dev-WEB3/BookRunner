// Hono app: /health (+ ops-venue's Orderly listing status), tRPC at /trpc, REST mirror at /v1, read-only MCP at /mcp, CORS for apps/web.
import { KEYS } from "@bookrunner/shared";
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
 * Procedures a client may find missing on an older API (apps/web useOptional): /health lists which of
 * them this build serves as `capabilities`, so the web never probes one that is absent. The full
 * procedure list (and uptime) is only in `/health?verbose` with the admin bearer token.
 */
export const OPTIONAL_PROCEDURES = ["book.fills", "book.hedges", "receipts.list"] as const;

/** /status is computed at most this often per process (nginx micro-caches it too); public, so cheap. */
export const STATUS_CACHE_MS = 15_000;
export const STATUS_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";

/** /health `orderlyListing`: ops-venue's Orderly listing status (KEYS.venueSymbolIssues, docs/VERIFY.md O20). */
export interface OrderlyListingHealth {
  mode: "mock" | "live";
  listingMode: "api" | "manual";
  /** books whose Orderly market is not listed yet (manual mode: awaiting the admin in Orderly One) */
  awaiting: Array<{ bookId: number; symbol: string; venueStatus: string | null; since: number }>;
}

/** ops-venue's status from Redis (absent / unreadable / slow -> null; never fails /health). */
export async function orderlyListingHealth(kv: Kv, timeoutMs = 500): Promise<OrderlyListingHealth | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raw = await Promise.race([kv.get(KEYS.venueSymbolIssues).catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)))]).finally(() => clearTimeout(timer));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { mode?: unknown; listingMode?: unknown; awaitingListing?: unknown };
    if (o.mode !== "mock" && o.mode !== "live") return null;
    const rows = Array.isArray(o.awaitingListing) ? (o.awaitingListing as Array<Record<string, unknown> | null>) : [];
    return {
      mode: o.mode,
      listingMode: o.listingMode === "manual" ? "manual" : "api",
      awaiting: rows
        .filter((x): x is Record<string, unknown> => !!x && Number.isFinite(Number(x.bookId)) && typeof x.symbol === "string")
        .map((x) => ({ bookId: Number(x.bookId), symbol: x.symbol as string, venueStatus: typeof x.venueStatus === "string" ? x.venueStatus : null, since: Number(x.since) || 0 })),
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
