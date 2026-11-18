// /metrics/ page: rendering of the API's /metrics JSON (zero activity stated, unknown figures not faked), the static
// page (no inline script, CSP-clean, no third-party origin) and the nginx route with its own rate-limit zone.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type MetricsData, ago, renderError, renderMetrics, renderOracle, tvlBars, usd } from "../src/metrics/view";

const ROOT = resolve(import.meta.dir, "../../..");
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

const empty = (over: Partial<MetricsData> = {}): MetricsData => ({
  generatedAt: new Date(NOW).toISOString(),
  chainId: 4663,
  liveBooks: 0,
  tvl: { booksUsd: "0.000000", insurancePoolUsd: null, insurancePoolFirstLossUsd: null, backstopUsd: null },
  revenue: { totalUsd: "0.000000", bySource: [] },
  engine: { markets: 0, openInterestUsd: { long: "0.000000", short: "0.000000", total: "0.000000" }, openPositions: 0 },
  buybacks: null,
  oracle: [],
  ...over,
});

const active = (): MetricsData =>
  empty({
    liveBooks: 2,
    tvl: { booksUsd: "100300.000000", insurancePoolUsd: "50000.000000", insurancePoolFirstLossUsd: "5000.000000", backstopUsd: "2500.5" },
    revenue: { totalUsd: "20.000000", bySource: [{ source: "engine_fees", usd: "20.000000" }] },
    engine: { markets: 1, openInterestUsd: { long: "200.000000", short: "100.000000", total: "300.000000" }, openPositions: 4 },
    buybacks: { spentUsd: "250.000000", pendingUsd: "10.000000" },
    oracle: [{ priceId: "NVDA", ageSeconds: 42, held: false }, { priceId: "TSLA", ageSeconds: 7200, held: true }],
  });

describe("metrics view", () => {
  test("no book open: says so, zeros stay zeros, unknown stays unknown, no chart", () => {
    const html = renderMetrics(empty(), NOW);
    expect(html).toContain("No book open yet");
    expect(html).toContain("$0.00");
    expect(html).toContain("not available"); // insurance pool, backstop, buybacks
    expect(html).toContain("Nothing to chart yet");
    expect(html).toContain("No oracle price recorded yet");
    expect(html).toContain("No fees received yet");
    expect(html).not.toContain("bar-fill");
  });

  test("active: tiles, bars scaled to the largest pool, fees by source, oracle ages", () => {
    const html = renderMetrics(active(), NOW + 60_000);
    expect(html).toContain("2 books open");
    expect(html).toContain("$100,300.00");
    expect(html).toContain("$2,500.50");
    expect(html).toContain("$300.00");
    expect(html).toContain("long $200.00");
    expect(html).toContain("$250.00");
    expect(html).toContain("Engine fees");
    expect(html).toContain("width:100.0%"); // the largest pool
    expect(html).toContain("width:2.5%"); // backstop 2500.5 / 100300
    expect(html).toContain("2 min"); // 42 s + the minute since generatedAt
  });

  test("oracle ages advance past a cached generatedAt; held sessions are labelled", () => {
    expect(renderOracle(active(), NOW + 120_000)).toContain("3 min");
    expect(renderOracle(active(), NOW)).toContain("held (market closed)");
    expect(renderOracle(active(), NOW)).toContain("2.0 h");
  });

  test("an unreadable pool is left out of the chart, not drawn as zero", () => {
    const html = tvlBars(empty({ tvl: { ...empty().tvl, booksUsd: "10.000000", backstopUsd: null } }));
    expect(html).toContain("Book pools");
    expect(html).not.toContain("Backstop");
  });

  test("escapes everything it prints", () => {
    const html = renderMetrics(empty({ oracle: [{ priceId: "<img src=x onerror=alert(1)>", ageSeconds: 1, held: false }], revenue: { totalUsd: "1", bySource: [{ source: "<b>", usd: "1" }] } }), NOW);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(renderError("<b>")).toContain("&lt;b&gt;");
  });

  test("helpers", () => {
    expect(usd(null)).toBe("not available");
    expect(usd("1234.5")).toBe("$1,234.50");
    expect(ago(30)).toBe("30 s");
    expect(ago(600)).toBe("10 min");
  });
});

describe("metrics page + nginx route", () => {
  const page = readFileSync(resolve(ROOT, "apps/site/public/metrics/index.html"), "utf8");
  const css = readFileSync(resolve(ROOT, "apps/site/public/metrics/metrics.css"), "utf8");
  const locations = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-locations.conf"), "utf8");
  const httpConf = readFileSync(resolve(ROOT, "deploy/server/nginx-bookrunner-http.conf"), "utf8");

  test("external module only (no inline script under the CSP), no third-party origin", () => {
    expect(page).toContain('<script type="module" src="/metrics/app.js');
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(page).not.toMatch(/(?:src|href)="https?:\/\/(?!bookrunner\.tech)/);
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
  });

  test("light and dark themes, a phone layout", () => {
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toContain("@media (max-width:640px)");
    expect(page).toContain('name="viewport"');
  });

  test("/metrics.json proxies to the API's /metrics with its own zone, defined at http level", () => {
    const block = locations.match(/location = \/metrics\.json \{[^}]*\}/)?.[0] ?? "";
    expect(block).toContain("proxy_pass http://127.0.0.1:4400/metrics;");
    expect(block).toContain("proxy_set_header X-Bookrunner-Route /metrics;");
    expect(block).toContain("limit_req zone=bookrunner_metrics");
    expect(httpConf).toMatch(/limit_req_zone \$binary_remote_addr zone=bookrunner_metrics:\d+m rate=\d+r\/s;/);
  });
});
