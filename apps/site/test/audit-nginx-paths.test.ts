// AUDIT 2026-10 L-3 (nginx path confusion) and M-4 (receipts rate zone): static checks of deploy/server.
// `/trpc/..\v1\books` was forwarded raw (proxy_pass without a URI) and Bun resolved it to /v1/books, so the
// REST mirror, the admin check of /v1/webhooks and /mcp were reachable through the public /trpc/ location.
// The behaviour itself is checked in Docker by deploy/server/nginx-path-check.sh (nginx -t + raw requests
// against a stand-in API); services/api/test/audit-path-confusion.test.ts covers the API side.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const locations = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-locations.conf"), "utf8");
const http = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-http.conf"), "utf8");
const code = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "").trimEnd())
    .filter((l) => l.trim())
    .join("\n");

function block(src: string, header: string): string {
  const at = src.indexOf(`${header} {`);
  expect(at).toBeGreaterThanOrEqual(0);
  return code(src.slice(at, src.indexOf("\n}", at) + 2));
}

/** The two path guards of the /trpc/ location, as JS regexes (PCRE syntax of the config is compatible). */
function trpcGuards() {
  const trpc = block(locations, "location ^~ /trpc/");
  const raw = trpc.match(/if \(\$request_uri ~ "([^"]+)"\) \{\s*return 400;\s*\}/)?.[1];
  const allow = trpc.match(/if \(\$uri !~ "([^"]+)"\) \{\s*return 400;\s*\}/)?.[1];
  expect(raw).toBeDefined();
  expect(allow).toBeDefined();
  // PCRE's \x5c (a backslash) means the same in a JS regex
  return { raw: new RegExp(raw!), allow: new RegExp(allow!) };
}

describe("audit L-3: nginx /trpc/ path confusion", () => {
  test("/trpc/ forwards the normalized path to the API's /trpc/ and stamps the location", () => {
    const trpc = block(locations, "location ^~ /trpc/");
    expect(trpc).toMatch(/^\s*proxy_pass http:\/\/127\.0\.0\.1:4400\/trpc\/;$/m);
    expect(trpc).toMatch(/^\s*proxy_set_header X-Bookrunner-Route \/trpc\/;$/m);
    // the guards come before anything else in the location
    expect(trpc.indexOf("$request_uri")).toBeLessThan(trpc.indexOf("proxy_pass"));
  });

  test("every proxied API location passes a fixed URI and its own stamp", () => {
    const proxies = [...code(locations).matchAll(/proxy_pass ([^;]+);/g)].map((m) => m[1]);
    expect(proxies.sort()).toEqual(["http://127.0.0.1:4400/health", "http://127.0.0.1:4400/status", "http://127.0.0.1:4400/trpc/"]);
    expect(block(locations, "location = /health")).toContain("proxy_set_header X-Bookrunner-Route /health;");
    expect(block(locations, "location = /status.json")).toContain("proxy_set_header X-Bookrunner-Route /status;");
  });

  test("raw-path guard: backslashes, encoded slashes / backslashes / dots and dot-segments are refused", () => {
    const { raw } = trpcGuards();
    const B = "\\";
    for (const p of [
      `/trpc/..${B}v1${B}books`,
      `/trpc/book.get/..${B}..${B}mcp`,
      "/trpc/..%5Cv1%5Cbooks",
      "/trpc/..%5cv1",
      "/trpc/..%2fv1%2fbooks",
      "/trpc/..%2Fmcp",
      "/trpc/%2e%2e/v1/books",
      "/trpc/.%2E/v1",
      "/trpc/../v1/books",
      "/trpc/./book.get",
      "/trpc/book.get/..",
      "/trpc/book.get/.?input=1",
    ])
      expect([p, raw.test(p)]).toEqual([p, true]);
    // tRPC calls pass, whatever their URL-encoded JSON input holds (the query is not inspected)
    for (const p of [
      "/trpc/book.get?input=%7B%22json%22%3A%7B%22bookId%22%3A1%7D%7D",
      "/trpc/book.get,book.nav?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22at%22%3A%222026-10-18T00%3A00%3A00.000Z%22%7D%7D%7D",
      "/trpc/receipts.proof?input=%2F..%5C%2e",
      "/trpc/charter.draft",
    ])
      expect([p, raw.test(p)]).toEqual([p, false]);
  });

  test("normalized-path allowlist: procedure names only", () => {
    const { allow } = trpcGuards();
    for (const p of ["/trpc/book.get", "/trpc/book.get,book.nav,receipts.list", "/trpc/tranche.position"]) expect([p, allow.test(p)]).toEqual([p, true]);
    for (const p of ["/trpc/", "/trpc/..\\v1\\books", "/trpc/book.get/x", "/trpc/a b", "/trpc/book.get\u0000"]) expect([p, allow.test(p)]).toEqual([p, false]);
  });

  test("the REST mirror and MCP have no public location", () => {
    const c = code(locations);
    expect(c).not.toMatch(/location[^{]*\/v1/);
    expect(c).not.toMatch(/location[^{]*\/mcp/);
  });
});

describe("audit M-4: receipts.* rate zone", () => {
  test("a stricter per-IP zone keyed only for /trpc/ paths holding a receipts.* call", () => {
    const h = code(http);
    const map = h.match(/map \$uri \$bookrunner_receipts_key \{([^}]+)\}/)?.[1];
    expect(map).toBeDefined();
    expect(map).toMatch(/default "";/);
    const re = map!.match(/"~([^"]+)" \$binary_remote_addr;/)?.[1];
    expect(re).toBeDefined();
    const keyed = new RegExp(re!);
    for (const p of ["/trpc/receipts.proof", "/trpc/receipts.root", "/trpc/book.get,receipts.list", "/trpc/a,b,receipts.proof"]) expect([p, keyed.test(p)]).toEqual([p, true]);
    for (const p of ["/trpc/book.get", "/trpc/book.get,book.nav", "/trpc/settlements.list", "/receipts.proof"]) expect([p, keyed.test(p)]).toEqual([p, false]);
    const zone = h.match(/limit_req_zone \$bookrunner_receipts_key zone=bookrunner_receipts:\d+m rate=(\d+)r\/s;/);
    expect(zone).not.toBeNull();
    expect(Number(zone![1])).toBeLessThan(Number(h.match(/zone=bookrunner_trpc:\d+m rate=(\d+)r\/s/)![1]));
    const trpc = block(locations, "location ^~ /trpc/");
    expect(trpc).toMatch(/limit_req zone=bookrunner_trpc burst=\d+ nodelay;/);
    expect(trpc).toMatch(/limit_req zone=bookrunner_receipts burst=\d+ nodelay;/);
  });
});
