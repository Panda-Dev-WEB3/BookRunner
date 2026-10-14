import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM module without types (video/demo runs in the Playwright container)
import { TRPC_WRITE_ALLOW, isProxied, routeRequest, startAppServer, trpcProcedures } from "../demo/serve-app.mjs";

describe("serve-app: API routing", () => {
  test("only /health and /trpc/<procedures> are proxied, on the normalized path + query", () => {
    expect(routeRequest("GET", "/health")).toEqual({ kind: "proxy", path: "/health" });
    expect(routeRequest("GET", "/trpc/book.list?batch=1&input=%7B%7D")).toEqual({ kind: "proxy", path: "/trpc/book.list?batch=1&input=%7B%7D" });
    expect(routeRequest("GET", "/app/x/../../health")).toEqual({ kind: "proxy", path: "/health" });
    expect(routeRequest("GET", "http://evil.example/trpc/a.b?q=1")).toEqual({ kind: "proxy", path: "/trpc/a.b?q=1" });
    expect(routeRequest("GET", "/trpc/../app/")).toEqual({ kind: "static", pathname: "/app/" });
    expect(routeRequest("GET", "/healthz").kind).toBe("static");
    expect(routeRequest("GET", "/trpcx/a").kind).toBe("static");
    expect(isProxied("/trpc/a.b,c.d?batch=1")).toBe(true);
    expect(isProxied("/app/")).toBe(false);
  });
  test("encoded separators and odd paths on API routes are refused", () => {
    for (const u of ["/trpc/a%2F..%2F..%2Fadmin", "/trpc%2F..%2Fadmin", "/trpc/a%2e%2e", "/trpc/a%5Cb", "/health%2F..%2Fx", "/trpc/a/b", "/trpc", "/trpc/", "/trpc/a,,b", "/trpc/a b"]) {
      expect([u, routeRequest("GET", u).kind]).toEqual([u, "deny"]);
    }
  });
  test("procedure lists, including batches with encoded commas", () => {
    expect(trpcProcedures("/trpc/a.b")).toEqual(["a.b"]);
    expect(trpcProcedures("/trpc/a.b,c.d")).toEqual(["a.b", "c.d"]);
    expect(trpcProcedures("/trpc/a.b%2Cc.d")).toEqual(["a.b", "c.d"]);
    expect(trpcProcedures("/trpc/a.b/c")).toBeNull();
    expect(trpcProcedures("/trpc/%E0%A4%A")).toBeNull();
  });
  test("writes: only allow-listed prepare-tx procedures, every procedure of a batch checked", () => {
    expect([...TRPC_WRITE_ALLOW].sort()).toEqual(["charter.file", "tranche.subscribe"]);
    expect(routeRequest("POST", "/trpc/tranche.subscribe?batch=1")).toEqual({ kind: "proxy", path: "/trpc/tranche.subscribe?batch=1" });
    expect(routeRequest("POST", "/trpc/charter.file")).toEqual({ kind: "proxy", path: "/trpc/charter.file" });
    for (const p of ["charter.decide", "agent.register", "agent.revoke", "tranche.claim", "tranche.redeem", "tranche.subscribe,charter.decide", "charter.decide%2Ctranche.subscribe"]) {
      const r = routeRequest("POST", `/trpc/${p}?batch=1`);
      expect([p, r.kind, r.status]).toEqual([p, "deny", 403]);
    }
    expect(routeRequest("PUT", "/trpc/tranche.subscribe").status).toBe(405);
    expect(routeRequest("POST", "/health").status).toBe(405);
    expect(routeRequest("HEAD", "/health").kind).toBe("proxy");
  });
});

describe("serve-app: static files (no upstream)", () => {
  let dir: string;
  let srv: { url: string; origin: string; close(): Promise<void> };
  const logs: string[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "serve-app-"));
    mkdirSync(join(dir, "dist/assets"), { recursive: true });
    writeFileSync(join(dir, "dist/index.html"), "<!doctype html><p>app</p>");
    writeFileSync(join(dir, "dist/assets/a.js"), "export {}");
    writeFileSync(join(dir, "secret.txt"), "outside");
    srv = await startAppServer({ distDir: join(dir, "dist"), port: 0, upstream: "https://upstream.invalid", log: (l: string) => logs.push(l) });
  });
  afterAll(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const get = (p: string, init?: RequestInit) => fetch(srv.origin + p, { redirect: "manual", ...init });
  test("serves the app, SPA fallback, 404 for missing assets, no escape from dist", async () => {
    expect(srv.url).toBe(`${srv.origin}/app/`);
    expect(await (await get("/app/")).text()).toContain("<p>app</p>");
    expect((await get("/app/assets/a.js")).headers.get("content-type")).toContain("javascript");
    expect(await (await get("/app/books/1")).text()).toContain("<p>app</p>");
    expect((await get("/app/assets/missing.js")).status).toBe(404);
    expect((await get("/app/..%2Fsecret.txt")).status).toBe(403);
    expect((await get("/app/%2e%2e/secret.txt")).status).toBe(404);
    expect((await get("/")).status).toBe(302);
  });
  test("a refused write is answered 403 locally and logged", async () => {
    const r = await get("/trpc/charter.decide?batch=1", { method: "POST", body: "{}" });
    expect(r.status).toBe(403);
    expect(logs.some((l) => l.includes("refused POST /trpc/charter.decide") && l.includes("not allow-listed"))).toBe(true);
  });
});
