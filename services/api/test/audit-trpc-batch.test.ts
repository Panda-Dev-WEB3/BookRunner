// AUDIT (area 6, off-chain): /trpc is public (nginx proxies /trpc/ with no limit_req) and the tRPC
// adapter accepts unbounded HTTP batches, so one unauthenticated GET fans out into N procedure runs, each
// with its own DB queries + chain reads (book.get alone: ~10 Redis/DB reads and 2 RPC calls; book.nav
// limit up to 5000 rows; receipts.proof rebuilds an hour's Merkle tree). No per-IP rate limit exists
// anywhere in the stack. Secure behaviour asserted here: batches are capped.
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { webOrigins } from "../src/config";
import { makeWorld, seedBook } from "./fixtures";

describe("audit: tRPC batch amplification", () => {
  test("a GET batch of 200 procedure calls is refused", async () => {
    const w = makeWorld();
    seedBook(w);
    const app = createApp(w.deps, { origins: webOrigins("http://127.0.0.1:5180") });
    const n = 200;
    const paths = Array.from({ length: n }, () => "book.get").join(",");
    const input = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), { json: { bookId: 1 } }]));
    const res = await app.request(`/trpc/${paths}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`);
    // insecure today: 200 OK with 200 results (every call executed)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
