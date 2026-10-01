import { describe, expect, test } from "bun:test";
import { KEYS } from "@bookrunner/shared";
import { createApp } from "../src/app";
import { type BookNavResult, MCP_TOOLS } from "../src/mcp";
import { makeWorld, seedBook } from "./fixtures";

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };

function rpc(app: ReturnType<typeof createApp>, method: string, params: unknown, id = 1) {
  return app.request("/mcp", { method: "POST", headers: HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
}

async function result<T = Record<string, unknown>>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: T; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result as T;
}

describe("MCP /mcp (stateless streamable HTTP)", () => {
  const w = makeWorld();
  seedBook(w);
  w.kv.put(KEYS.liveNav(1), { navUsd: "100400", ts: Date.now() });
  const app = createApp(w.deps, { origins: [] });

  test("initialize advertises tools", async () => {
    const r = await result<{ serverInfo: { name: string }; capabilities: { tools?: unknown } }>(
      await rpc(app, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
    );
    expect(r.serverInfo.name).toBe("bookrunner");
    expect(r.capabilities.tools).toBeDefined();
  });

  test("tools/list: book_nav, book_limits, charters, all read-only", async () => {
    const r = await result<{ tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[] }; annotations?: { readOnlyHint?: boolean } }> }>(
      await rpc(app, "tools/list", {}),
    );
    expect(r.tools.map((t) => t.name).sort()).toEqual(["book_limits", "book_nav", "charters"]);
    for (const t of r.tools) expect(t.annotations?.readOnlyHint).toBe(true);
    const nav = r.tools.find((t) => t.name === "book_nav")!;
    expect(nav.inputSchema.properties).toHaveProperty("bookId");
    expect(nav.inputSchema.required).toEqual(["bookId"]);
    expect(nav.description).toBe(MCP_TOOLS.book_nav.description);
    expect(r.tools.find((t) => t.name === "charters")!.inputSchema.required ?? []).toEqual([]);
  });

  test("tools/call book_nav: output shape", async () => {
    const r = await result<{ content: Array<{ type: string; text: string }>; structuredContent: BookNavResult; isError?: boolean }>(
      await rpc(app, "tools/call", { name: "book_nav", arguments: { bookId: 1 } }),
    );
    expect(r.isError).toBeFalsy();
    const nav = r.structuredContent;
    expect(JSON.parse(r.content[0]!.text)).toEqual(nav);
    expect(Object.keys(nav).sort()).toEqual(
      ["bookId", "history", "juniorNavUsd", "juniorSharePrice", "lastMark", "live", "name", "navUsd", "seniorNavUsd", "seniorSharePrice", "state", "symbol", "venue"].sort(),
    );
    expect(nav).toMatchObject({ bookId: 1, symbol: "PERP_NVDA_USDC", state: "Live", venue: "orderly", seniorSharePrice: "1.003" });
    expect(nav.lastMark).toMatchObject({ markId: 3 });
    expect(nav.live?.navUsd).toBe("100400.000000");
    expect(nav.history.map((h) => h.markId)).toEqual([1, 2, 3]);
    expect(typeof nav.history[0]!.navUsd).toBe("string");
  });

  test("tools/call book_limits and charters", async () => {
    const l = await result<{ structuredContent: { bookId: number; state: string; mandate: { maxSkewBps: number }; series: { buckets: unknown[] } } }>(
      await rpc(app, "tools/call", { name: "book_limits", arguments: { bookId: 1 } }),
    );
    expect(l.structuredContent).toMatchObject({ bookId: 1, state: "warn", mandate: { maxSkewBps: 25 } });
    const c = await result<{ structuredContent: { charters: Array<{ charterId: number; status: string }> } }>(
      await rpc(app, "tools/call", { name: "charters", arguments: { status: "Approved" } }),
    );
    expect(c.structuredContent.charters.map((x) => x.charterId)).toEqual([1]);
  });

  test("unknown book is a tool error, not a transport error", async () => {
    const r = await result<{ isError: boolean; content: Array<{ text: string }> }>(await rpc(app, "tools/call", { name: "book_nav", arguments: { bookId: 42 } }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("not found");
  });

  test("GET is rejected (stateless, POST only)", async () => {
    const res = await app.request("/mcp", { method: "GET", headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(405);
  });
});
