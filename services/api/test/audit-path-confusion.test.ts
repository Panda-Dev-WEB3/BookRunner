// AUDIT 2026-10 L-3: nginx forwarded /trpc/ requests raw, and Bun resolves backslashes and dot-segments
// before the app sees the URL, so `/trpc/..\v1\books` reached the REST mirror, the admin-token check of
// /v1/webhooks and /mcp (which accepted a 100-message JSON-RPC batch). nginx now refuses and normalizes such
// paths (deploy/server/nginx-path-check.sh); defence in depth here: the API refuses a request outside the
// location nginx stamped (X-Bookrunner-Route), any path with encoded slashes / backslashes / dots or a
// dot-segment, and MCP batches above MCP_MAX_BATCH.
import { describe, expect, test } from "bun:test";
import { ROUTE_HEADER, createApp, pathAllowed } from "../src/app";
import { webOrigins } from "../src/config";
import { MCP_MAX_BATCH, MCP_MAX_BODY_BYTES } from "../src/mcp";
import { makeWorld, seedBook } from "./fixtures";

const BS = "\\";
const trpcInput = encodeURIComponent(JSON.stringify({ json: { bookId: 1 } }));

function app() {
  const w = makeWorld();
  seedBook(w);
  w.deps.settings.adminToken = "test-admin-token";
  return createApp(w.deps, { origins: webOrigins("http://127.0.0.1:5180") });
}

/** Raw HTTP/1.1 over a socket: no client-side URL normalisation (what nginx used to forward). */
async function rawGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let buf = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(s) {
          const extra = Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("");
          s.write(`GET ${path} HTTP/1.1\r\nHost: bookrunner.tech\r\n${extra}Connection: close\r\n\r\n`);
        },
        data(_s, d) {
          buf += new TextDecoder().decode(d);
        },
        close() {
          resolve({ status: Number(buf.split(" ")[1]), body: buf.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
        },
        error(_s, e) {
          reject(e);
        },
      },
    }).catch(reject);
  });
}

describe("audit L-3: path confusion", () => {
  test("pathAllowed: stamped location, encoded separators and dot-segments", () => {
    expect(pathAllowed("/trpc/book.get", "/trpc/")).toBe(true);
    expect(pathAllowed("/trpc/book.get,book.nav", "/trpc/")).toBe(true);
    expect(pathAllowed("/health", "/health")).toBe(true);
    expect(pathAllowed("/status", "/status")).toBe(true);
    expect(pathAllowed("/v1/books", undefined)).toBe(true); // loopback tooling without nginx
    for (const [p, route] of [
      ["/v1/books", "/trpc/"],
      ["/mcp", "/trpc/"],
      ["/v1/webhooks", "/trpc/"],
      ["/trpc/", "/trpc/"],
      ["/healthz", "/health"],
      ["/v1/books", "/health"],
      ["/trpc/..%5Cv1%5Cbooks", undefined],
      ["/trpc/..%5cv1", undefined],
      ["/trpc/..%2fv1%2fbooks", undefined],
      ["/trpc/%2e%2e/v1", undefined],
      [`/trpc/..${BS}v1`, undefined],
      ["/trpc/../v1/books", undefined],
      ["/trpc/./book.get", undefined],
      ["/v1/books/..", undefined],
    ] as const) expect([p, pathAllowed(p, route)]).toEqual([p, false]);
  });

  test("a request stamped /trpc/ by nginx reaches neither /v1 nor /mcp", async () => {
    const a = app();
    const stamp = { [ROUTE_HEADER]: "/trpc/" };
    expect((await a.request("/v1/books", { headers: stamp })).status).toBe(400);
    expect((await a.request("/v1/webhooks", { headers: { ...stamp, authorization: "Bearer test-admin-token" } })).status).toBe(400);
    expect((await a.request("/mcp", { method: "POST", headers: { ...stamp, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    expect((await a.request(`/trpc/book.get?input=${trpcInput}`, { headers: stamp })).status).toBe(200);
    // /health and /status keep working with their own stamps
    expect((await a.request("/health", { headers: { [ROUTE_HEADER]: "/health" } })).status).toBe(200);
    expect((await a.request("/v1/books", { headers: { [ROUTE_HEADER]: "/health" } })).status).toBe(400);
    // without a stamp (loopback tooling) the REST mirror still answers
    expect((await a.request("/v1/books")).status).toBe(200);
  });

  test("encoded backslashes / slashes / dots in the path are refused on every route", async () => {
    const a = app();
    for (const p of ["/trpc/..%5Cv1%5Cbooks", "/trpc/..%5cv1%5cbooks", "/trpc/..%2fv1%2fbooks", "/trpc/book%2Eget", "/v1/books%2F1"]) {
      expect([p, (await a.request(p)).status]).toEqual([p, 400]);
    }
  });

  test("PoC over a real Bun socket: /trpc/..\\v1\\books as nginx forwarded it", async () => {
    const a = app();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: a.fetch });
    const port = server.port as number;
    try {
      const poc = `/trpc/..${BS}v1${BS}books`;
      // Bun itself resolves the path to /v1/books: without nginx's stamp the REST mirror answers (why the
      // nginx fix is the primary one) ...
      const unstamped = await rawGet(port, poc);
      expect(unstamped.status).toBe(200);
      expect(unstamped.body).toContain("PERP_NVDA_USDC");
      // ... and with the stamp nginx now sends on /trpc/ the API refuses it
      for (const p of [poc, `/trpc/..${BS}mcp`, `/trpc/book.get/..${BS}..${BS}v1${BS}webhooks`, "/trpc/..%5Cv1%5Cbooks", "/trpc/x/../../v1/books"]) {
        const r = await rawGet(port, p, { [ROUTE_HEADER]: "/trpc/" });
        expect([p, r.status]).toEqual([p, 400]);
      }
      const ok = await rawGet(port, `/trpc/book.get?input=${trpcInput}`, { [ROUTE_HEADER]: "/trpc/" });
      expect(ok.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});

describe("audit L-3: MCP batch cap", () => {
  const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list", params: {} }));

  test(`a JSON-RPC batch above ${MCP_MAX_BATCH} messages is refused before any tool runs`, async () => {
    const a = app();
    const big = await a.request("/mcp", { method: "POST", headers: HEADERS, body: JSON.stringify(msgs(100)) });
    expect(big.status).toBe(400); // audited code: 200 with 100 results
    expect(((await big.json()) as { error: { message: string } }).error.message).toContain(`${MCP_MAX_BATCH}`);
    const capped = await a.request("/mcp", { method: "POST", headers: HEADERS, body: JSON.stringify(msgs(MCP_MAX_BATCH + 1)) });
    expect(capped.status).toBe(400);
    const small = await a.request("/mcp", { method: "POST", headers: HEADERS, body: JSON.stringify(msgs(2)) });
    expect(small.status).toBe(200);
    expect((await small.json()) as unknown[]).toHaveLength(2);
  });

  test("an oversized body is refused", async () => {
    const a = app();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(MCP_MAX_BODY_BYTES) } });
    expect((await a.request("/mcp", { method: "POST", headers: HEADERS, body })).status).toBe(413);
    // streamed without content-length: refused once the cap is crossed (multi-byte characters count as bytes)
    const pulled = { chunks: 0 };
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled.chunks++;
        if (pulled.chunks > 1000) return c.close();
        c.enqueue(new TextEncoder().encode("é".repeat(8 * 1024))); // 16 KiB per chunk
      },
    });
    const res = await a.request("/mcp", { method: "POST", headers: HEADERS, body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled.chunks).toBeLessThan(10);
  });
});
