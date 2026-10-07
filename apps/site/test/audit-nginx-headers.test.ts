// AUDIT (area 6, off-chain): web server config of https://bookrunner.use-cert.com (deploy/server).
// Live evidence (curl -sI, 2026-10-07): no Strict-Transport-Security, no Content-Security-Policy, no
// Permissions-Policy on /, /app/, /dashboard/; "Server: nginx/1.28.3 (Ubuntu)"; source maps served:
//   /app/assets/index-DSiGraYj.js.map 200 (1,043,515 bytes), /dashboard/app.js.map 200 (2,078,650 bytes).
// The dashboard and the operator app hand transactions to the user's wallet, so a CSP is the main
// defence-in-depth against an injected script, and HSTS against a first-visit TLS strip.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const site = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner.conf"), "utf8");
const locations = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-locations.conf"), "utf8");
const webVite = readFileSync(resolve(ROOT, "apps/web/vite.config.ts"), "utf8");
const siteVite = readFileSync(resolve(ROOT, "apps/site/vite.config.ts"), "utf8");
const all = `${site}\n${locations}`;

describe("audit: nginx security headers", () => {
  test("HSTS is sent", () => {
    expect(all).toMatch(/add_header\s+Strict-Transport-Security\s/i);
  });

  test("a Content-Security-Policy is sent (pages that build wallet transactions)", () => {
    expect(all).toMatch(/add_header\s+Content-Security-Policy\s/i);
  });

  test("server version tokens are off", () => {
    expect(all).toMatch(/server_tokens\s+off\s*;/);
  });

  test("production source maps are not published", () => {
    const nginxDeniesMaps = /location\s+~\*?\s+\\\.map\$\s*\{[^}]*(deny all|return 404)/.test(locations);
    const webBuildsMaps = /sourcemap:\s*true/.test(webVite);
    const siteBuildsMaps = /sourcemap:\s*true/.test(siteVite);
    expect(nginxDeniesMaps || (!webBuildsMaps && !siteBuildsMaps)).toBe(true);
  });
});
