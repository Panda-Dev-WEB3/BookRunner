// /status/ page: rendering of the API's /status JSON, the static page (no inline script, CSP-clean) and
// the nginx route that serves the JSON at /status.json.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type StatusBook, type StatusData, ago, every, markCell, renderError, renderStatus, riskCell } from "../src/status/view";

const ROOT = resolve(import.meta.dir, "../../..");
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const book = (over: Partial<StatusBook> = {}): StatusBook => ({
  bookId: 3,
  name: "NVDA",
  symbol: "PERP_NVDA_USDC",
  venue: "orderly",
  state: "Live",
  latestMark: { periodEnd: new Date(NOW - 600_000).toISOString(), committedAt: new Date(NOW - 570_000).toISOString(), ageSeconds: 600 },
  markStatus: "ok",
  risk: "ok",
  killed: false,
  lastDistribution: { at: new Date(NOW - 7_200_000).toISOString(), period: 1, grossUsd: "1234.5", seniorUsd: "600", juniorUsd: "400", txHash: "0xabc" },
  ...over,
});

const data = (over: Partial<StatusData> = {}): StatusData => ({
  generatedAt: new Date(NOW).toISOString(),
  chainId: 46630,
  markIntervalSeconds: 3600,
  markGraceSeconds: 900,
  overall: "ok",
  books: [book()],
  ...over,
});

describe("status view", () => {
  test("overall banner, cadence, one row per book", () => {
    const html = renderStatus(data(), NOW);
    expect(html).toContain("All books operating normally");
    expect(html).toContain("Marks every 1 h");
    expect(html).toContain("$1,234.50");
    expect(html).toContain("2.0 h ago");
    expect((html.match(/<tr>/g) ?? []).length).toBe(2); // head + 1 book
  });

  test("degraded / attention banners", () => {
    expect(renderStatus(data({ overall: "warn" }), NOW)).toContain("banner warn");
    expect(renderStatus(data({ overall: "breach" }), NOW)).toContain("banner bad");
  });

  test("mark age advances with the clock past a cached generatedAt", () => {
    expect(markCell(book(), NOW + 60_000, new Date(NOW).toISOString())).toContain("11 min ago");
    expect(markCell(book({ markStatus: "overdue" }), NOW, new Date(NOW).toISOString())).toContain("pill bad");
    expect(markCell(book({ latestMark: null, markStatus: "not_marked", state: "Subscription" }), NOW, new Date(NOW).toISOString())).toContain("not marked");
  });

  test("risk: killed wins over the level", () => {
    expect(riskCell(book({ risk: "breach", killed: true }))).toContain("killed");
    expect(riskCell(book({ risk: "warn" }))).toContain("pill warn");
  });

  test("escapes everything it prints", () => {
    const html = renderStatus(data({ books: [book({ name: "<img src=x onerror=alert(1)>" })] }), NOW);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(renderError("<b>")).toContain("&lt;b&gt;");
  });

  test("helpers", () => {
    expect(ago(30)).toBe("30 s ago");
    expect(ago(600)).toBe("10 min ago");
    expect(every(86_400)).toBe("1 day");
    expect(every(900)).toBe("15 min");
  });
});

describe("status page + nginx route", () => {
  const page = readFileSync(resolve(ROOT, "apps/site/public/status/index.html"), "utf8");
  const locations = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-locations.conf"), "utf8");

  test("the page loads its bundle as an external module (no inline script under the CSP)", () => {
    expect(page).toContain('<script type="module" src="/status/app.js');
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
  });

  test("/status.json proxies to the API's /status, rate-limited", () => {
    const block = locations.match(/location = \/status\.json \{[^}]*\}/)?.[0] ?? "";
    expect(block).toContain("proxy_pass http://127.0.0.1:4400/status;");
    expect(block).toContain("limit_req zone=bookrunner_health");
  });
});
