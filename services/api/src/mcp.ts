// Read-only MCP server at /mcp (Streamable HTTP, stateless JSON mode): tools book_nav, book_limits,
// charters. Each request gets a fresh server + transport; tools reuse the tRPC procedures.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CHARTER_STATUS } from "@bookrunner/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ApiDeps } from "./deps";
import { toJsonValue } from "./format";
import { createCaller } from "./router";

export const MCP_SERVER_INFO = { name: "bookrunner", version: "0.1.0" } as const;

export const MCP_TOOLS = {
  book_nav: {
    title: "Book NAV",
    description:
      "NAV of one Bookrunner book: book, Senior and Junior NAV and share prices at the latest signed mark, the live estimate between marks, and the recent mark history with receipts roots. Read-only.",
  },
  book_limits: {
    title: "Book limits",
    description:
      "Mandate limit utilisation of one book: current state (ok, warn, reduce_only, breach, killed), inventory and skew utilisation, hedge ratio, drawdown, the mandate bounds, recent kills and a 24h series. Read-only.",
  },
  charters: {
    title: "Charters",
    description:
      "Charters filed with Bookrunner (newest first), optionally filtered by status (Filed, Approved, Rejected, Expired, Retired), with the jury recommendation and the book address once approved. Read-only.",
  },
} as const;

export interface BookNavResult {
  bookId: number;
  symbol: string;
  name: string | null;
  state: string;
  venue: string;
  navUsd: string | null;
  seniorNavUsd: string | null;
  juniorNavUsd: string | null;
  seniorSharePrice: string;
  juniorSharePrice: string;
  lastMark: { markId: number; periodEnd: string; navUsd: string; receiptsRoot: string; txHash: string } | null;
  live: { navUsd: string | null; ts: string | null } | null;
  history: Array<{ periodEnd: string; markId: number; navUsd: string; seniorSharePrice: string | null; juniorSharePrice: string | null }>;
}

export async function bookNav(deps: ApiDeps, bookId: number): Promise<BookNavResult> {
  const k = createCaller({ deps });
  const [b, nav] = await Promise.all([k.book.get({ bookId }), k.book.nav({ bookId, limit: 30 })]);
  return {
    bookId: b.bookId,
    symbol: b.symbol,
    name: b.name,
    state: b.state,
    venue: b.venue,
    navUsd: b.navUsd,
    seniorNavUsd: b.seniorNavUsd,
    juniorNavUsd: b.juniorNavUsd,
    seniorSharePrice: b.seniorSharePrice,
    juniorSharePrice: b.juniorSharePrice,
    lastMark: b.latestMark
      ? { markId: b.latestMark.markId, periodEnd: b.latestMark.periodEndAt, navUsd: b.latestMark.navUsd, receiptsRoot: b.latestMark.receiptsRoot, txHash: b.latestMark.txHash }
      : null,
    live: nav.live ? { navUsd: nav.live.navUsd, ts: nav.live.ts } : null,
    history: nav.points.map((p) => ({ periodEnd: p.ts, markId: p.markId, navUsd: p.navUsd, seniorSharePrice: p.seniorSharePrice, juniorSharePrice: p.juniorSharePrice })),
  };
}

export async function bookLimits(deps: ApiDeps, bookId: number) {
  const k = createCaller({ deps });
  const [risk, limits] = await Promise.all([k.risk.state({ bookId }), k.book.limits({ bookId })]);
  return {
    bookId,
    state: risk.state,
    current: risk.live ? { ...risk.live, meta: undefined } : risk.latest,
    mandate: limits.mandate,
    kills: risk.kills,
    series: { from: limits.from, to: limits.to, bucketSeconds: limits.bucketSeconds, buckets: limits.series },
  };
}

export async function chartersList(deps: ApiDeps, status?: string) {
  const k = createCaller({ deps });
  const res = await k.charter.list(status ? { status, limit: 100 } : { limit: 100 });
  return { status: status ?? null, charters: res.items };
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

async function asTool(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = toJsonValue(await fn()) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  } catch (e) {
    const message = e instanceof TRPCError && e.code !== "INTERNAL_SERVER_ERROR" ? e.message : "internal error";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export function createMcpServer(deps: ApiDeps): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { capabilities: { tools: {} } });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  server.registerTool(
    "book_nav",
    { ...MCP_TOOLS.book_nav, inputSchema: { bookId: z.number().int().positive().describe("Book id (equals its charter id)") }, annotations: readOnly },
    async ({ bookId }) => asTool(() => bookNav(deps, bookId)),
  );
  server.registerTool(
    "book_limits",
    { ...MCP_TOOLS.book_limits, inputSchema: { bookId: z.number().int().positive().describe("Book id (equals its charter id)") }, annotations: readOnly },
    async ({ bookId }) => asTool(() => bookLimits(deps, bookId)),
  );
  server.registerTool(
    "charters",
    { ...MCP_TOOLS.charters, inputSchema: { status: z.enum(CHARTER_STATUS).optional().describe("Charter status filter") }, annotations: readOnly },
    async ({ status }) => asTool(() => chartersList(deps, status)),
  );
  return server;
}

const jsonRpcError = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", allow: "POST" },
  });

/** Stateless Streamable HTTP: POST only (no server-initiated streams, no sessions). */
export async function handleMcpRequest(deps: ApiDeps, req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonRpcError(405, "Method not allowed: this MCP endpoint is stateless (POST only)");
  const server = createMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (err) {
    deps.log.error({ err }, "MCP request failed");
    return jsonRpcError(500, "internal error");
  } finally {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}
