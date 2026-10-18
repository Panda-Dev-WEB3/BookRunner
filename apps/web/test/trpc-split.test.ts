// Audit 2026-10 M-4: the API counts a receipts.* call as a full tRPC batch (services/api TRPC_HEAVY_WEIGHT) and
// refuses a batch holding one with anything else, so the client must send receipts.* unbatched; a regression
// would make the Verify panel fail with HTTP 400.
import { afterEach, describe, expect, test } from "bun:test";
import { createTRPCUntypedClient } from "@trpc/client";
import superjson from "superjson";
import { TRPC_MAX_BATCH, isHeavyProcedure, trpcLinks } from "../src/api/trpc";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records request URLs and answers every call of a (batched or single) GET with `null`. */
function recordFetch(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1");
    urls.push(`${url.pathname}${url.search}`);
    const item = { result: { data: superjson.serialize(null) } };
    const n = url.searchParams.get("batch") === "1" ? url.pathname.split("/trpc/")[1]!.split(",").length : 0;
    return new Response(JSON.stringify(n ? Array.from({ length: n }, () => item) : item), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return urls;
}

describe("tRPC client: receipts.* travel alone", () => {
  test("isHeavyProcedure matches the API's heavy prefix only", () => {
    for (const p of ["receipts.proof", "receipts.root", "receipts.list"]) expect(isHeavyProcedure(p)).toBe(true);
    for (const p of ["book.get", "book.nav", "settlements.list"]) expect(isHeavyProcedure(p)).toBe(false);
  });

  test("concurrent queries: receipts.* each in its own unbatched request, the rest batched", async () => {
    const urls = recordFetch();
    // the typed client (createTrpcClient) is built from the same links
    const client = createTRPCUntypedClient({ links: trpcLinks() });
    await Promise.all([
      client.query("book.get", { bookId: 1 }),
      client.query("receipts.proof", { receiptId: 1 }),
      client.query("book.nav", { bookId: 1 }),
      client.query("receipts.root", { markId: 3 }),
    ]);
    const paths = urls.map((u) => u.split("?")[0]).sort();
    expect(paths).toEqual(["/trpc/book.get,book.nav", "/trpc/receipts.proof", "/trpc/receipts.root"]);
    for (const u of urls.filter((x) => x.includes("receipts."))) expect(u).not.toContain("batch=1");
    expect(urls.find((u) => u.startsWith("/trpc/book.get"))).toContain("batch=1");
    expect(TRPC_MAX_BATCH).toBe(10);
  });
});
