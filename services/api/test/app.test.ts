import { describe, expect, test } from "bun:test";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { createApp } from "../src/app";
import { webOrigins } from "../src/config";
import type { AppRouter } from "../src/router";
import { ALICE, BOOK, makeWorld, sampleDraft, seedBook } from "./fixtures";

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
    expect(await res.json()).toMatchObject({ ok: true, service: "api", chainId: 31337, deployment: true });
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

  test("webOrigins merges WEB_ORIGIN with the devnet defaults", () => {
    expect(webOrigins("https://app.example/, http://127.0.0.1:5180")).toEqual(["https://app.example", "http://127.0.0.1:5180", "http://localhost:5180"]);
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
