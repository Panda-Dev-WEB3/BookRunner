// apps/site: the BookRunner public site (static pages vendored in public/, served as-is) plus the
// live book desk at /dashboard/, the public status page at /status/ and the public metrics page at /metrics/, whose scripts are the only
// bundled code (src/dashboard/main.ts -> dist/dashboard/app.js, src/status/main.ts -> dist/status/app.js, src/metrics/main.ts -> dist/metrics/app.js).
// `vite build` copies public/ verbatim into dist/ and adds the bundles, so dist/ is a plain static tree:
// index.html, research/, jobs/, documents/, dashboard/, status/, official-links/, assets/... The official-links page's
// contract tables are generated from the mainnet deployment record at build time (scripts/official-links.ts).
//
// Dev: `bun run dev` serves the same tree and proxies /trpc, /health, /status.json and /metrics.json to SITE_API_ORIGIN
// (default https://bookrunner.tech, the live testnet API; read-only queries are safe).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Plugin, defineConfig } from "vite";
import { loadOfficialLinks, renderOfficialLinks } from "./scripts/official-links";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(root, "..", "..");
const publicDir = join(root, "public");
const apiOrigin = process.env.SITE_API_ORIGIN ?? "https://bookrunner.tech";
const port = Number(process.env.SITE_PORT ?? 5191);

/** Bundled pages: the page directory, its TS entry, the built script (dist/<dir>/app.js). */
const BUNDLES = { app: "dashboard", status: "status", metrics: "metrics" } as const;
const ENTRIES: Record<string, string> = { app: "src/dashboard/main.ts", status: "src/status/main.ts", metrics: "src/metrics/main.ts" };

/** Dev only: directory URLs serve their index.html; each bundle URL maps to its TS entry. */
function staticTree(): Plugin {
  return {
    name: "bookrunner-static-tree",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        for (const [name, dir] of Object.entries(BUNDLES)) {
          if (url.pathname === `/${dir}/app.js`) {
            req.url = `/${ENTRIES[name]}`;
            return next();
          }
        }
        const dir = join(publicDir, decodeURIComponent(url.pathname));
        if (!dir.startsWith(publicDir)) return next();
        let file: string | null = null;
        if (url.pathname.endsWith("/")) file = join(dir, "index.html");
        else if (existsSync(dir) && statSync(dir).isDirectory()) {
          res.statusCode = 301;
          res.setHeader("Location", `${url.pathname}/${url.search}`);
          return res.end();
        }
        if (file && existsSync(file)) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          if (url.pathname === OFFICIAL_LINKS_PAGE) return res.end(renderOfficialLinks(readFileSync(file, "utf8"), loadOfficialLinks(repoRoot)));
          return res.end(readFileSync(file));
        }
        next();
      });
    },
  };
}

/** Build only: each bundled page loads its app.js with a content hash, so a release is never served stale. */
function versionedBundle(): Plugin {
  return {
    name: "bookrunner-versioned-bundle",
    apply: "build",
    closeBundle() {
      for (const dir of Object.values(BUNDLES)) {
        const out = join(root, "dist", dir);
        const js = readFileSync(join(out, "app.js"));
        const v = createHash("sha256").update(js).digest("hex").slice(0, 12);
        const page = join(out, "index.html");
        writeFileSync(page, readFileSync(page, "utf8").replace(new RegExp(`/${dir}/app\\.js(\\?[^"]*)?"`), `/${dir}/app.js?v=${v}"`));
      }
    },
  };
}

/** The official-links page: its contract tables come from the deployment record (scripts/official-links.ts). */
const OFFICIAL_LINKS_PAGE = "/official-links/";

/** Build only: fills dist/official-links/index.html from contracts/deployments/4663.json (placeholders without it). */
function officialLinksPage(): Plugin {
  return {
    name: "bookrunner-official-links",
    apply: "build",
    closeBundle() {
      const page = join(root, "dist", "official-links", "index.html");
      writeFileSync(page, renderOfficialLinks(readFileSync(page, "utf8"), loadOfficialLinks(repoRoot)));
    },
  };
}

export default defineConfig({
  root,
  publicDir,
  plugins: [staticTree(), versionedBundle(), officialLinksPage()],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {
      "/trpc": { target: apiOrigin, changeOrigin: true, secure: true },
      "/health": { target: apiOrigin, changeOrigin: true, secure: true },
      "/status.json": { target: apiOrigin, changeOrigin: true, secure: true },
      "/metrics.json": { target: apiOrigin, changeOrigin: true, secure: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // no public source maps (deploy/server nginx also answers *.map with 404); `vite build --sourcemap` locally
    sourcemap: false,
    copyPublicDir: true,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      input: Object.fromEntries(Object.entries(ENTRIES).map(([name, entry]) => [name, join(root, entry)])),
      output: {
        entryFileNames: (chunk) => `${BUNDLES[chunk.name as keyof typeof BUNDLES] ?? chunk.name}/app.js`,
        chunkFileNames: "dashboard/chunks/[name]-[hash].js",
        assetFileNames: "dashboard/assets/[name]-[hash][extname]",
      },
    },
  },
});
