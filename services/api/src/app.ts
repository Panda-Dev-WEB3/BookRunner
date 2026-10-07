// Hono app: /health, tRPC at /trpc, REST mirror at /v1, read-only MCP at /mcp, CORS for apps/web.
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApiDeps } from "./deps";
import { handleMcpRequest } from "./mcp";
import { restRoutes } from "./rest";
import { appRouter } from "./router";
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
    const extra = deps.health ? await deps.health().catch((err) => ({ healthError: String(err) })) : {};
    const token = deps.settings.adminToken;
    const verbose = c.req.query("verbose") !== undefined && !!token && bearerMatches(c.req.header("authorization"), token);
    return c.json({
      ok: true,
      service: "api",
      chainId: deps.settings.chainId,
      deployment: deps.chain() !== null,
      capabilities,
      ...(verbose ? { uptimeSec: Math.floor((deps.now() - started) / 1000), procedures } : {}),
      ...extra,
    });
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
