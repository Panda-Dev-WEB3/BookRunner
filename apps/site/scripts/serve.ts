// Tiny static server for the built site (dist/) with the same-origin API proxy nginx provides in
// production: /trpc/* and /health go to SITE_API_ORIGIN (default: the live testnet API, which is
// safe for read-only use). Usage: bun scripts/serve.ts [--port 5191]
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dir, "..", "dist");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg > 0 ? process.argv[portArg + 1] : (process.env.SITE_PORT ?? 5191));
const apiOrigin = (process.env.SITE_API_ORIGIN ?? "https://bookrunner.use-cert.com").replace(/\/+$/, "");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

if (!existsSync(root)) {
  console.error(`dist/ not found: run \`bun run build\` in apps/site first`);
  process.exit(1);
}

async function proxy(req: Request, url: URL): Promise<Response> {
  const target = `${apiOrigin}${url.pathname}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  const res = await fetch(target, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer() });
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/trpc/") || url.pathname === "/health") return proxy(req, url);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let file = join(root, rel);
    if (!file.startsWith(root)) return new Response("Forbidden", { status: 403 });
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!url.pathname.endsWith("/")) return new Response(null, { status: 301, headers: { location: `${url.pathname}/${url.search}` } });
      file = join(file, "index.html");
    }
    if (!existsSync(file)) return new Response("Not found", { status: 404 });
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    // pages revalidate (they carry the versioned bundle URL); assets may be cached
    return new Response(Bun.file(file), { headers: { "content-type": type, "cache-control": type.startsWith("text/html") ? "no-cache" : "public, max-age=300" } });
  },
});

console.log(`apps/site: http://127.0.0.1:${port}/ (dist/, API proxy -> ${apiOrigin})`);
