// Serves a testnet build of apps/web at /app/ (SPA fallback) and proxies /trpc/* and /health to the live API, so the
// app (built with VITE_API_URL=same-origin) sees a same-origin API: the live API only allows the bookrunner.tech
// origin. Node built-ins only. Standalone: node serve-app.mjs [port]  (APP_DIST overrides the dist directory)
//
// Writes to the live API are allow-listed (plan Global Constraints: only read queries and the prepare-tx procedures
// the app itself calls): tRPC queries are GETs and pass; a POST (mutation) passes only when every procedure in it is in
// TRPC_WRITE_ALLOW. Everything else is refused with 403 and a log line.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";

export const UPSTREAM = "https://bookrunner.tech";

/**
 * tRPC mutations the demo flows may send. Both only PREPARE transactions (the API returns calldata for the wallet to
 * sign; services/api/src/routers): `tranche.subscribe` is the deposit step of clip 2 (approve + deposit txs,
 * apps/web DepositFlow.tsx); `charter.file` validates a charter draft and returns the filing txs shown on the review
 * step of clip 3 (FileCharter.tsx; nothing is sent). Deliberately absent: `charter.decide` (committee vote),
 * `agent.register` / `agent.revoke` (sponsor only), `tranche.claim` / `tranche.redeem` (no withdrawal is demoed).
 */
export const TRPC_WRITE_ALLOW = new Set(["tranche.subscribe", "charter.file"]);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
};
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);
const PROC_LIST = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*(,[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*)*$/;

/** The procedure names of a tRPC path (`/trpc/a.b,c.d` -> ["a.b", "c.d"]); null when the path is not a plain list. */
export function trpcProcedures(pathname) {
  if (!pathname.startsWith("/trpc/")) return null;
  let rest;
  try {
    rest = decodeURIComponent(pathname.slice("/trpc/".length)); // a batch may encode its commas
  } catch {
    return null;
  }
  return PROC_LIST.test(rest) ? rest.split(",") : null;
}

/**
 * What to do with a request: { kind: "static", pathname } (not an API path), { kind: "proxy", path } (forward this
 * normalized path + query), or { kind: "deny", status, reason }. Decided on the WHATWG-normalized path (dot segments
 * resolved, absolute-form targets reduced to their path); encoded slashes, backslashes and dots are refused on API
 * paths so the upstream cannot normalize them into a different route.
 */
export function routeRequest(method, rawUrl) {
  let u;
  try {
    u = new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return { kind: "deny", status: 400, reason: "bad url" };
  }
  const p = u.pathname;
  const api = p === "/health" || p === "/trpc" || p.startsWith("/trpc/") || /^\/(trpc|health)(%|\\)/i.test(p);
  if (!api) return { kind: "static", pathname: p };
  if (/%2f|%5c|%2e|\\/i.test(p)) return { kind: "deny", status: 400, reason: "encoded separator in API path" };
  const path = p + u.search;
  if (p === "/health") {
    return method === "GET" || method === "HEAD" ? { kind: "proxy", path } : { kind: "deny", status: 405, reason: "/health is GET only" };
  }
  const procs = trpcProcedures(p);
  if (!procs) return { kind: "deny", status: 404, reason: "not a tRPC procedure path" };
  if (method === "GET") return { kind: "proxy", path }; // queries (tRPC answers a mutation over GET with 405 itself)
  if (method !== "POST") return { kind: "deny", status: 405, reason: `${method} not allowed on /trpc` };
  const refused = procs.filter((x) => !TRPC_WRITE_ALLOW.has(x));
  if (refused.length > 0) return { kind: "deny", status: 403, reason: `write to ${refused.join(", ")} is not allow-listed` };
  return { kind: "proxy", path };
}

/** True for paths the server forwards upstream for some method (GET for /health and tRPC queries). */
export const isProxied = (rawUrl) => routeRequest("GET", rawUrl).kind === "proxy";

function proxy(req, res, upstream, path) {
  const up = new URL(upstream);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers.host = up.host;
  headers.origin = up.origin;
  if (headers.referer) headers.referer = `${up.origin}/app/`;
  const fail = (e) => {
    if (!e) return;
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `proxy: ${e.message}` }));
    } else res.destroy();
  };
  const out = httpsRequest({ hostname: up.hostname, port: up.port || 443, method: req.method, path, headers }, (r) => {
    const h = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v;
    res.writeHead(r.statusCode ?? 502, h);
    pipeline(r, res, () => {});
  });
  out.on("error", fail);
  // the browser gave up (navigation, abort): stop the upstream request too
  res.on("close", () => {
    if (!res.writableFinished) out.destroy();
  });
  pipeline(req, out, fail);
}

function sendFile(res, file, method) {
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store" });
  if (method === "HEAD") return res.end();
  pipeline(createReadStream(file), res, () => {});
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Starts the server on 127.0.0.1:`port` (0 = any free port). Resolves { url: "http://localhost:<port>/app/", origin, port, close() }. */
export async function startAppServer({ distDir, port = 4610, upstream = UPSTREAM, log = console.log }) {
  const root = resolve(distDir);
  const index = join(root, "index.html");
  if (!isFile(index)) throw new Error(`${index} missing: build apps/web first (video/README.md, "Demo harness")`);
  const server = createServer((req, res) => {
    const route = routeRequest(req.method, req.url);
    if (route.kind === "deny") {
      log(`serve-app: refused ${req.method} ${req.url}: ${route.reason}`);
      return res.writeHead(route.status, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: route.reason }));
    }
    if (route.kind === "proxy") return proxy(req, res, upstream, route.path);
    let pathname;
    try {
      pathname = decodeURIComponent(route.pathname);
    } catch {
      return res.writeHead(400).end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    if (pathname === "/" || pathname === "/app") return res.writeHead(302, { location: "/app/" }).end();
    if (!pathname.startsWith("/app/")) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    const file = resolve(root, `.${pathname.slice("/app".length)}`);
    if (file !== root && !file.startsWith(root + sep)) return res.writeHead(403).end();
    if (isFile(file)) return sendFile(res, file, req.method);
    // a missing asset is a 404; any other path is a client-side route
    if (extname(pathname) !== "") return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    sendFile(res, index, req.method);
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });
  const actual = server.address().port;
  const origin = `http://localhost:${actual}`;
  return {
    url: `${origin}/app/`,
    origin,
    port: actual,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = process.env.APP_DIST ?? fileURLToPath(new URL("../../apps/web/dist", import.meta.url));
  const s = await startAppServer({ distDir, port: Number(process.argv[2] ?? 4610) });
  console.log(`serving ${distDir} at ${s.url} (proxy /trpc, /health -> ${UPSTREAM})`);
}
