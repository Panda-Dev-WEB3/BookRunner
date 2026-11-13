// AUDIT (area 6, off-chain): web server config of https://bookrunner.tech (deploy/server).
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

  test("every HSTS header covers subdomains for a year, and none asks for preload", () => {
    const lines = all.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter((l) => l.includes("Strict-Transport-Security"));
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(l).toBe('add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;');
  });

  test("www.bookrunner.tech answers 301 to the apex (server level, before any location)", () => {
    const redirect = locations.match(/^if \(\$host = www\.bookrunner\.tech\) \{\s*return 301 https:\/\/bookrunner\.tech\$request_uri;\s*\}/m);
    expect(redirect).not.toBeNull();
    expect(redirect!.index!).toBeLessThan(locations.search(/^location /m));
    // the site serves exactly the names its certificate covers
    expect(site).toMatch(/server_name bookrunner\.tech www\.bookrunner\.tech;/);
    expect(site).not.toMatch(/use-cert|sslip/);
  });

  test("the operator app is not indexed: X-Robots-Tag on every /app/ location, meta robots in its HTML", () => {
    for (const loc of ["location ^~ /app/assets/", "location ^~ /app/"]) {
      const at = locations.indexOf(`${loc} {`);
      expect(at).toBeGreaterThanOrEqual(0);
      const body = locations.slice(at, locations.indexOf("\n}", at));
      expect(body).toContain('add_header X-Robots-Tag "noindex" always;');
    }
    expect(readFileSync(resolve(ROOT, "apps/web/index.html"), "utf8")).toContain('<meta name="robots" content="noindex" />');
  });

  test("gzip covers the text types the site ships (server level, not http level)", () => {
    expect(locations).toMatch(/^gzip on;$/m);
    expect(locations).toMatch(/^gzip_vary on;$/m);
    const types = locations.match(/^gzip_types ([^;]+);$/m)?.[1]?.split(/\s+/) ?? [];
    for (const t of ["text/css", "application/javascript", "text/javascript", "application/json", "image/svg+xml"]) expect(types).toContain(t);
  });

  test("security.txt is served as text/plain from /.well-known/", () => {
    const at = locations.indexOf("location = /.well-known/security.txt {");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(locations.slice(at, locations.indexOf("\n}", at))).toContain('default_type "text/plain; charset=utf-8";');
    const txt = readFileSync(resolve(ROOT, "apps/site/public/.well-known/security.txt"), "utf8");
    for (const field of ["Contact: mailto:", "Expires: ", "Canonical: https://bookrunner.tech/.well-known/security.txt"]) expect(txt).toContain(field);
    const expires = Date.parse(txt.match(/^Expires: (.+)$/m)![1]!);
    expect(expires).toBeGreaterThan(Date.now());
  });

  test("other *.bookrunner.tech names: a port-80 redirect only (no wildcard certificate, so no 443 block)", () => {
    const wildcard = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-wildcard.conf"), "utf8");
    const code = wildcard.replace(/#.*/g, "");
    expect(code).toMatch(/server_name \*\.bookrunner\.tech;/);
    expect(code).toMatch(/return 301 https:\/\/bookrunner\.tech\/;/);
    expect(code).not.toMatch(/listen[^;]*443|ssl/);
  });

  test("a Content-Security-Policy is sent (pages that build wallet transactions)", () => {
    expect(all).toMatch(/add_header\s+Content-Security-Policy\s/i);
  });

  /** Every location block of the snippet: header line -> its body (code only). */
  const blocks = (): Array<{ head: string; body: string }> =>
    [...locations.matchAll(/^location ([^{]+)\{([\s\S]*?)^\}/gm)].map((m) => ({ head: m[1]!.trim(), body: m[2]!.replace(/#.*$/gm, "") }));

  test("Cross-Origin-Resource-Policy: same-site on every location that sends headers, cross-origin only for the icons", () => {
    const withHeaders = blocks().filter((b) => b.body.includes("Strict-Transport-Security"));
    expect(withHeaders.length).toBeGreaterThan(10);
    for (const b of withHeaders) {
      const corp = [...b.body.matchAll(/add_header Cross-Origin-Resource-Policy "([^"]+)" always;/g)].map((m) => m[1]);
      expect([b.head, corp]).toEqual([b.head, [b.head.includes("favicon") ? "cross-origin" : "same-site"]]);
    }
  });

  test("Cross-Origin-Opener-Policy with every page: same-origin-allow-popups for /app/ (wallet popups), same-origin elsewhere", () => {
    const pages = blocks().filter((b) => b.body.includes("Content-Security-Policy"));
    expect(pages.length).toBeGreaterThanOrEqual(6);
    for (const b of pages) {
      const coop = [...b.body.matchAll(/add_header Cross-Origin-Opener-Policy "([^"]+)" always;/g)].map((m) => m[1]);
      expect([b.head, coop]).toEqual([b.head, [b.head.includes("/app/") ? "same-origin-allow-popups" : "same-origin"]]);
      expect(b.body).toContain(`add_header Reporting-Endpoints 'csp-endpoint="https://bookrunner.tech/csp-report"' always;`);
    }
    // nothing else sets COOP (a JSON or video response is never a browsing context)
    expect((locations.match(/add_header Cross-Origin-Opener-Policy /g) ?? []).length).toBe(pages.length);
  });

  test("/csp-report: POST only, 16 KB bodies, its own rate-limit zone, the visitor's address never forwarded", () => {
    const b = blocks().find((x) => x.head === "= /csp-report");
    expect(b).toBeDefined();
    expect(b!.body).toMatch(/limit_req zone=bookrunner_csp burst=\d+ nodelay;/);
    expect(b!.body).toMatch(/limit_except POST \{\s*deny all;\s*\}/);
    expect(b!.body).toContain("client_max_body_size 16k;");
    expect(b!.body).toContain("proxy_pass http://127.0.0.1:4400/csp-report;");
    expect(b!.body).not.toContain("X-Forwarded-For");
    expect(b!.body).not.toContain("X-Real-IP");
  });

  test("mta-sts.bookrunner.tech: exact name, the policy snippet, a valid RFC 8461 policy for the documented MX", () => {
    const siteConf = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-mta-sts.conf"), "utf8").replace(/#.*/g, "");
    const snippet = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-mta-sts-locations.conf"), "utf8");
    const lib = readFileSync(resolve(ROOT, "deploy/server/nginx-lib.sh"), "utf8");
    const readme = readFileSync(resolve(ROOT, "deploy/server/README.md"), "utf8");
    expect(siteConf).toMatch(/server_name mta-sts\.bookrunner\.tech;/);
    expect(siteConf).not.toMatch(/listen[^;]*443|ssl_/); // certbot adds TLS in place
    const dst = lib.match(/NGINX_MTA_STS_SNIPPET_DST="\$\{NGINX_MTA_STS_SNIPPET_DST:-([^}]+)\}"/)?.[1];
    expect(siteConf).toContain(`include ${dst};`);
    const body = snippet.match(/location = \/\.well-known\/mta-sts\.txt \{[\s\S]*?return 200 "([^"]+)";/)?.[1];
    expect(body).toBeDefined();
    const policy = Object.fromEntries(body!.split("\\n").filter(Boolean).map((l) => l.split(": ") as [string, string]));
    expect(policy.version).toBe("STSv1");
    expect(["testing", "enforce"]).toContain(policy.mode ?? "");
    expect(Number(policy.max_age)).toBeGreaterThanOrEqual(86_400);
    expect(Number(policy.max_age)).toBeLessThanOrEqual(31_557_600);
    expect(snippet).toContain('default_type "text/plain; charset=utf-8";');
    // the policy's MX is the domain's MX the DNS records name
    expect(readme).toContain(`| \`bookrunner.tech\` MX | \`10 ${policy.mx}\` |`);
    for (const rec of ['_mta-sts.bookrunner.tech.     TXT  "v=STSv1; id=', '_smtp._tls.bookrunner.tech.   TXT  "v=TLSRPTv1; rua=mailto:', '"v=spf1 mx -all"', '"v=DMARC1; p=quarantine;', '"v=DMARC1; p=reject;'])
      expect(readme).toContain(rec);
    expect(readme).toContain("sudo certbot --nginx -d mta-sts.bookrunner.tech");
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
