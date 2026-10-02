// Hono app: /health, tRPC at /trpc, REST mirror at /v1, read-only MCP at /mcp, CORS for apps/web.
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApiDeps } from "./deps";
import { handleMcpRequest } from "./mcp";
import { restRoutes } from "./rest";
import { appRouter } from "./router";

export interface AppOptions {
  origins: string[];
}

export function createApp(deps: ApiDeps, opts: AppOptions) {
  const app = new Hono();
  const started = deps.now();

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
    return c.json({
      ok: true,
      service: "api",
      chainId: deps.settings.chainId,
      deployment: deps.chain() !== null,
      uptimeSec: Math.floor((deps.now() - started) / 1000),
      ...extra,
    });
  });

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      endpoint: "/trpc",
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
