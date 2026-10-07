import { describe, expect, test } from "bun:test";
import { createTRPCClient, createTRPCUntypedClient, httpBatchLink, httpLink } from "@trpc/client";
import superjson from "superjson";
import { MAX_TRPC_BATCH, createApp } from "../src/app";
import { webOrigins } from "../src/config";
import type { AppRouter } from "../src/router";
import { ALICE, BOOK, makeWorld, sampleDraft, seedActivity, seedBook } from "./fixtures";

function setup() {
  const w = makeWorld();
  seedBook(w);
  const app = createApp(w.deps, { origins: webOrigins("http://127.0.0.1:5180") });
  return { w, app };
}

describe("http app", () => {
  test("GET /health", async () => {
    const { app } = setup();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { procedures?: string[]; capabilities?: string[]; uptimeSec?: number };
    expect(body).toMatchObject({ ok: true, service: "api", chainId: 31337, deployment: true });
    // the optional procedures this build serves, so the web skips absent ones (no 404 probes)
    expect(body.capabilities).toEqual(["book.fills", "book.hedges", "receipts.list"]);
    // no reconnaissance surface for anonymous callers: no full procedure list, no uptime
    expect(body.procedures).toBeUndefined();
    expect(body.uptimeSec).toBeUndefined();
  });

  test("GET /health?verbose lists every procedure and the uptime for the admin token only", async () => {
    const { w, app } = setup();
    const TOKEN = "health-admin-token-0123456789";
    w.deps.settings.adminToken = TOKEN;
    const anon = (await (await app.request("/health?verbose=1")).json()) as { procedures?: string[] };
    expect(anon.procedures).toBeUndefined();
    const wrong = (await (await app.request("/health?verbose=1", { headers: { authorization: "Bearer nope" } })).json()) as { procedures?: string[] };
    expect(wrong.procedures).toBeUndefined();
    const admin = (await (await app.request("/health?verbose=1", { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { procedures?: string[]; uptimeSec?: number };
    expect(admin.procedures).toContain("book.get");
    expect(admin.procedures).toContain("tranche.position");
    expect(admin.procedures).not.toContain("book.trades");
    expect(typeof admin.uptimeSec).toBe("number");
  });

  test("tRPC batches above MAX_TRPC_BATCH are refused; a batch at the cap runs", async () => {
    const { app } = setup();
    const batch = (n: number) => {
      const paths = Array.from({ length: n }, () => "book.list").join(",");
      const input = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), { json: null }]));
      return app.request(`/trpc/${paths}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`);
    };
    expect((await batch(MAX_TRPC_BATCH)).status).toBe(200);
    expect((await batch(MAX_TRPC_BATCH + 1)).status).toBe(400);
  });

  test("CORS allows the web app origins only", async () => {
    const { app } = setup();
    for (const origin of ["http://127.0.0.1:5180", "http://localhost:5180"]) {
      const res = await app.request("/v1/books", { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
    const evil = await app.request("/v1/books", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await app.request("/trpc/book.list", { method: "OPTIONS", headers: { origin: "http://localhost:5180", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
  });

  test("webOrigins: loopback-only WEB_ORIGIN adds the devnet defaults; a public deployment allows exactly its list", () => {
    expect(webOrigins("http://127.0.0.1:5180")).toEqual(["http://127.0.0.1:5180", "http://localhost:5180"]);
    expect(webOrigins("https://app.example/, http://127.0.0.1:5180")).toEqual(["https://app.example", "http://127.0.0.1:5180"]);
    expect(webOrigins("https://bookrunner.use-cert.com,https://bookrunner.141-94-203-130.sslip.io")).toEqual([
      "https://bookrunner.use-cert.com",
      "https://bookrunner.141-94-203-130.sslip.io",
    ]);
  });

  test("tRPC over HTTP with superjson (typed client)", async () => {
    const { app } = setup();
    type LinkFetch = NonNullable<Parameters<typeof httpBatchLink>[0]["fetch"]>;
    const viaApp = (async (url: unknown, init?: RequestInit) => app.request(String(url), init)) as unknown as LinkFetch;
    const client = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: "http://api.test/trpc", transformer: superjson, fetch: viaApp })],
    });
    const books = await client.book.list.query();
    expect(books[0]?.symbol).toBe("PERP_NVDA_USDC");
    const sub = await client.tranche.redeem.mutate({ bookId: 1, tranche: "junior", shares: "0.5", wallet: ALICE }).catch((e: Error) => e);
    expect(sub).toBeInstanceOf(Error); // Alice holds no Junior shares in the fake chain
    const filed = await client.charter.file.mutate(sampleDraft());
    expect(filed.ok).toBe(true);
    expect(filed.txs.at(-1)?.description).toContain("File charter PERP_NVDA_USDC");
  });

  test("activity feeds over HTTP the way the web asks for them (untyped client, unbatched)", async () => {
    const { app, w } = setup();
    const { f2, h1 } = seedActivity(w);
    type LinkFetch = NonNullable<Parameters<typeof httpLink>[0]["fetch"]>;
    const viaApp = (async (url: unknown, init?: RequestInit) => app.request(String(url), init)) as unknown as LinkFetch;
    const client = createTRPCUntypedClient<AppRouter>({ links: [httpLink({ url: "http://api.test/trpc", transformer: superjson, fetch: viaApp })] });
    const fills = (await client.query("book.fills", { bookId: 1, limit: 100 })) as { items: Array<{ venueTradeId: string; receiptId: number | null; ts: string }> };
    expect(fills.items.find((f) => f.venueTradeId === "t-2")?.receiptId).toBe(f2);
    expect(typeof fills.items[0]!.ts).toBe("string");
    const hedges = (await client.query("book.hedges", { bookId: 1, limit: 100 })) as { items: Array<{ id: number; receiptId: number | null }> };
    expect(hedges.items.find((h) => h.id === 1)?.receiptId).toBe(h1);
    const receipts = (await client.query("receipts.list", { bookId: 1, limit: 25 })) as { items: Array<{ id: number; kindName: string }> };
    expect(receipts.items[0]).toMatchObject({ id: h1, kindName: "hedge" });
    // an unknown book is a NOT_FOUND that is not "no procedure found" (the web shows an error, not the fallback)
    const missing = await client.query("book.fills", { bookId: 99 }).catch((e: unknown) => e as { message: string; data?: { code?: string } });
    expect(missing).toMatchObject({ message: "book 99 not found", data: { code: "NOT_FOUND" } });
  });

  test("REST mirror: GET + POST routes and error mapping", async () => {
    const { app, w } = setup();
    const books = (await (await app.request("/v1/books")).json()) as { items: Array<{ bookId: number }> };
    expect(books.items[0]!.bookId).toBe(1);
    expect((await (await app.request("/v1/books/1")).json()) as object).toMatchObject({ bookId: 1, source: "chain" });
    const nav = (await (await app.request("/v1/books/1/nav?limit=2")).json()) as { points: unknown[] };
    expect(nav.points).toHaveLength(2);
    expect(((await (await app.request("/v1/books/1/marks?limit=1")).json()) as { nextCursor: number }).nextCursor).toBe(3);
    expect(await (await app.request("/v1/books/1/limits")).json()).toHaveProperty("series");
    expect(await (await app.request("/v1/books/1/risk")).json()).toHaveProperty("state", "warn");
    expect(await (await app.request("/v1/books/1/settlements")).json()).toHaveProperty("items");
    for (const feed of ["fills", "hedges", "receipts"]) {
      const r = await app.request(`/v1/books/1/${feed}?limit=5`);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ bookId: 1, items: [], nextCursor: null });
    }
    expect((await app.request("/v1/books/1/fills?limit=201")).status).toBe(400);
    expect(await (await app.request("/v1/charters?status=approved")).json()).toHaveProperty("items");
    expect(await (await app.request("/v1/charters/1")).json()).toHaveProperty("charterId", 1);
    expect(await (await app.request("/v1/oracle/prices?priceIds=NVDA,TSLA")).json()).toHaveProperty("prices");
    expect(await (await app.request("/v1/events?limit=5")).json()).toHaveProperty("items");
    expect(await (await app.request("/v1/books/1/agents")).json()).toHaveProperty("keys");

    w.chain.setWallet(BOOK.senior, ALICE, { shares: 5_000_000n });
    const red = await app.request("/v1/books/1/tranches/senior/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shares: "5", wallet: ALICE }),
    });
    expect(red.status).toBe(200);
    const redBody = (await red.json()) as { notice: { isGate: boolean }; txs: Array<{ value: string }> };
    expect(redBody.notice.isGate).toBe(false);
    expect(redBody.txs[0]!.value).toBe("0");

    const pos = (await (await app.request(`/v1/books/1/positions/${ALICE}`)).json()) as { tranches: Array<{ shares: string }> };
    expect(pos.tranches[0]!.shares).toBe("5.000000");

    expect((await app.request("/v1/books/99")).status).toBe(404);
    const bad = await app.request("/v1/books/1/tranches/mezzanine/subscribe", { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { code: string; issues?: unknown[] } };
    expect(badBody.error.code).toBe("BAD_REQUEST");
    expect(Array.isArray(badBody.error.issues)).toBe(true);
    expect((await app.request("/v1/receipts/12345/proof")).status).toBe(404);
    expect((await app.request("/nope")).status).toBe(404);

    w.setChain(false);
    const pf = await app.request("/v1/books/1/claims", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: ALICE }) });
    expect(pf.status).toBe(412);
  });

  test("internal errors are not leaked", async () => {
    const { app, w } = setup();
    w.data.listBooks = async () => {
      throw new Error("password authentication failed for user bookrunner");
    };
    const res = await app.request("/v1/books");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("password");
    const t = await app.request("/trpc/book.list");
    expect(t.status).toBe(500);
    expect(await t.text()).not.toContain("password");
  });
});
