// apps/site: the BookRunner public site (static pages vendored in public/, served as-is) plus the
// live book desk at /dashboard/, whose script is the only bundled code (src/dashboard/main.ts ->
// dist/dashboard/app.js). `vite build` copies public/ verbatim into dist/ and adds the bundle, so
// dist/ is a plain static tree: index.html, research/, jobs/, documents/, dashboard/, assets/...
//
// Dev: `bun run dev` serves the same tree and proxies /trpc + /health to SITE_API_ORIGIN
// (default https://bookrunner.use-cert.com, the live testnet API; read-only queries are safe).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Plugin, defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const apiOrigin = process.env.SITE_API_ORIGIN ?? "https://bookrunner.use-cert.com";
const port = Number(process.env.SITE_PORT ?? 5191);

/** Dev only: directory URLs serve their index.html; the dashboard bundle URL maps to its TS entry. */
function staticTree(): Plugin {
  return {
    name: "bookrunner-static-tree",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/dashboard/app.js") {
          req.url = "/src/dashboard/main.ts";
          return next();
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
          return res.end(readFileSync(file));
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root,
  publicDir,
  plugins: [staticTree()],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {
      "/trpc": { target: apiOrigin, changeOrigin: true, secure: true },
      "/health": { target: apiOrigin, changeOrigin: true, secure: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    copyPublicDir: true,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      input: { app: join(root, "src/dashboard/main.ts") },
      output: {
        entryFileNames: "dashboard/app.js",
        chunkFileNames: "dashboard/chunks/[name]-[hash].js",
        assetFileNames: "dashboard/assets/[name]-[hash][extname]",
      },
    },
  },
});
