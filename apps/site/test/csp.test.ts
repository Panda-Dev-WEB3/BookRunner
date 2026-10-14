// deploy/server nginx: the Content-Security-Policy allows exactly the inline scripts the pages ship
// (by hash, never 'unsafe-inline'), and the rate-limit zones the snippet uses are defined at http level.
// When a page under apps/site/public or apps/web/index.html changes an inline <script>, this test names
// the hash to put into nginx-bookrunner-locations.conf.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "../../..");
const locations = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-locations.conf"), "utf8");
const httpConf = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-http.conf"), "utf8");

const csp = locations.match(/set \$bookrunner_csp "([^"]+)";/)?.[1] ?? "";
const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

/** sha256 CSP sources of every executable inline <script> of an HTML file. */
function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    if (/\ssrc=/i.test(attrs)) continue;
    const type = attrs.match(/\stype=["']?([^"'\s>]+)/i)?.[1];
    if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type)) continue; // data blocks (framer/appear)
    // browsers hash the script text after HTML newline normalisation (CRLF / CR -> LF); the Framer
    // exports are stored with CRLF line endings
    const text = m[2]!.replace(/\r\n?/g, "\n");
    out.push(`'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`);
  }
  return out;
}

const pages = [
  ...[...new Glob("**/*.html").scanSync(resolve(ROOT, "apps/site/public"))].map((f) => resolve(ROOT, "apps/site/public", f)),
  resolve(ROOT, "apps/web/index.html"),
];

describe("nginx Content-Security-Policy", () => {
  test("is defined once and sent by the page locations", () => {
    expect(csp.length).toBeGreaterThan(100);
    expect((locations.match(/add_header Content-Security-Policy \$bookrunner_csp always;/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  test("script-src: self + hashes only (no 'unsafe-inline', no 'unsafe-eval', no wildcard)", () => {
    const s = directive("script-src");
    expect(s).toContain("'self'");
    expect(s).not.toContain("unsafe-inline");
    expect(s).not.toContain("unsafe-eval");
    expect(s).not.toMatch(/\s\*|https:(\s|$)/);
  });

  test("every inline script the pages ship is allowed by its hash", () => {
    const script = directive("script-src");
    const missing: string[] = [];
    for (const p of pages) for (const h of inlineScriptHashes(readFileSync(p, "utf8"))) if (!script.includes(h)) missing.push(`${h} (${p.slice(ROOT.length + 1)})`);
    expect(missing).toEqual([]);
  });

  test("no inline event handlers or javascript: URLs in the pages (CSP would block them)", () => {
    for (const p of pages) {
      const html = readFileSync(p, "utf8");
      expect(html.match(/<[^>]+\son[a-z]+=["']/gi) ?? []).toEqual([]);
      expect(html.match(/href=["']javascript:/gi) ?? []).toEqual([]);
    }
  });

  test("locks down the rest: objects, base, framing, forms", () => {
    for (const d of ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'"]) expect(csp).toContain(d);
  });

  test("JSON-LD blocks are data, not script: no hash is demanded for them, and they parse", () => {
    const home = readFileSync(resolve(ROOT, "apps/site/public/index.html"), "utf8");
    const blocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(blocks.length).toBe(1);
    expect(inlineScriptHashes(`<script type="application/ld+json">${blocks[0]}</script>`)).toEqual([]);
    const types = (JSON.parse(blocks[0]!) as { "@type": string }[]).map((b) => b["@type"]);
    expect(types).toEqual(["Organization", "WebSite"]);
  });

  test("every absolute image / media URL in the site's pages and chunks is on an img-src host", () => {
    const allowed = directive("img-src").split(/\s+/).filter((s) => s.startsWith("https://"));
    const ok = (host: string) =>
      allowed.some((a) => {
        const h = a.slice("https://".length);
        return h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h;
      });
    const files = [...new Glob("**/*.{html,mjs,js,css}").scanSync(resolve(ROOT, "apps/site/public"))];
    const offenders = new Set<string>();
    for (const f of files) {
      const text = readFileSync(resolve(ROOT, "apps/site/public", f), "utf8");
      for (const m of text.matchAll(/https:\/\/([a-z0-9.-]+)\/[^"'`\s()]*\.(?:avif|webp|png|jpe?g|gif|svg)\b/gi)) {
        const host = m[1]!.toLowerCase();
        if (host !== "bookrunner.tech" && !ok(host)) offenders.add(`${host} (${f})`);
      }
    }
    expect([...offenders]).toEqual([]);
  });
});

describe("nginx rate limits", () => {
  test("/trpc/ and /health use zones defined in the http-level conf", () => {
    for (const zone of ["bookrunner_trpc", "bookrunner_health"]) {
      expect(locations).toContain(`limit_req zone=${zone} `);
      expect(httpConf).toMatch(new RegExp(`limit_req_zone \\$binary_remote_addr zone=${zone}:\\d+m rate=\\d+r/s;`));
    }
    const trpc = locations.match(/location \^~ \/trpc\/ \{[^}]*\}/)?.[0] ?? "";
    expect(trpc).toContain("limit_req zone=bookrunner_trpc");
  });

  test("the http-level conf holds only uniquely named zones (nothing that can clash with nginx.conf)", () => {
    const directives = httpConf
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean);
    expect(directives.every((d) => d.startsWith("limit_req_zone "))).toBe(true);
  });
});
