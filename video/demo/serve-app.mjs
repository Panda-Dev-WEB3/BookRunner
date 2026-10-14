// Serves a testnet build of apps/web at /app/ (SPA fallback) and proxies /trpc/* and /health to the live API, so the
// app (built with VITE_API_URL=same-origin) sees a same-origin API: the live API only allows the bookrunner.tech
// origin. Node built-ins only. Standalone: node serve-app.mjs [port]  (APP_DIST overrides the dist directory)
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM = "https://bookrunner.tech";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
};
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);

/** True for the API paths the server forwards upstream. */
export const isProxied = (pathname) => pathname === "/health" || pathname === "/trpc" || pathname.startsWith("/trpc/");

function proxy(req, res, upstream) {
  const up = new URL(upstream);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers.host = up.host;
  headers.origin = up.origin;
  if (headers.referer) headers.referer = `${up.origin}/app/`;
  const out = httpsRequest({ hostname: up.hostname, port: up.port || 443, method: req.method, path: req.url, headers }, (r) => {
    const h = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v;
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  out.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `proxy: ${e.message}` }));
  });
  req.pipe(out);
}

function sendFile(res, file, method) {
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store" });
  if (method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Starts the server on 127.0.0.1:`port` (0 = any free port). Resolves { url: "http://localhost:<port>/app/", port, close() }. */
export async function startAppServer({ distDir, port = 4610, upstream = UPSTREAM }) {
  const root = resolve(distDir);
  const index = join(root, "index.html");
  if (!isFile(index)) throw new Error(`${index} missing: build apps/web first (video/README.md, "Demo harness")`);
  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (isProxied(pathname)) return proxy(req, res, upstream);
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
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });
  const actual = server.address().port;
  return {
    url: `http://localhost:${actual}/app/`,
    port: actual,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = process.env.APP_DIST ?? fileURLToPath(new URL("../../apps/web/dist", import.meta.url));
  const s = await startAppServer({ distDir, port: Number(process.argv[2] ?? 4610) });
  console.log(`serving ${distDir} at ${s.url} (proxy /trpc, /health -> ${UPSTREAM})`);
}
