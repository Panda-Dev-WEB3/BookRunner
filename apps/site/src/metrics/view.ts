// Public metrics page (/metrics/): renders the API's /metrics JSON (nginx: /metrics.json). Pure markup builders, so they
// are unit-tested without a browser. Every value is escaped. Zero activity is shown as such ("no book open yet"); a
// figure the API could not read is "not available", never a zero.

export interface MetricsData {
  generatedAt: string;
  chainId: number;
  liveBooks: number;
  tvl: { booksUsd: string; insurancePoolUsd: string | null; insurancePoolFirstLossUsd: string | null; backstopUsd: string | null };
  revenue: { totalUsd: string; bySource: Array<{ source: string; usd: string }> };
  engine: { markets: number; openInterestUsd: { long: string; short: string; total: string } | null; openPositions: number };
  buybacks: { spentUsd: string; pendingUsd: string } | null;
  oracle: Array<{ priceId: string; ageSeconds: number; held: boolean }>;
}

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain text (callers escape it); null: the API could not read it. */
export const usd = (s: string | null | undefined): string => {
  if (s == null) return "not available";
  const n = Number(s);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(s);
};

export function ago(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86_400).toFixed(1)} days`;
}

const SOURCE_LABEL: Record<string, string> = { venue_taker_share: "Venue taker share", engine_fees: "Engine fees", funding: "Funding", liquidation: "Liquidations", other: "Other" };

const tile = (label: string, value: string, sub = "") => `<div class="tile"><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>`;

/** Horizontal bars of the three TVL components (one series: magnitude, one hue, direct value labels; the tiles above are the table view). */
export function tvlBars(d: MetricsData): string {
  const rows = [
    { label: "Book pools", usd: d.tvl.booksUsd },
    { label: "Insurance pool", usd: d.tvl.insurancePoolUsd },
    { label: "Backstop", usd: d.tvl.backstopUsd },
  ].filter((r): r is { label: string; usd: string } => r.usd !== null);
  const max = Math.max(...rows.map((r) => Number(r.usd)), 0);
  if (max <= 0) return `<p class="empty">Nothing to chart yet: every capital pool is at zero.</p>`;
  return `<div class="bars" role="img" aria-label="Value held, by pool">${rows
    .map((r) => {
      const pct = Math.max(0, (Number(r.usd) / max) * 100);
      return `<div class="bar-row" title="${esc(r.label)}: ${esc(usd(r.usd))}"><span class="bar-label">${esc(r.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%"></span></span><span class="bar-value">${esc(usd(r.usd))}</span></div>`;
    })
    .join("")}</div>`;
}

export function renderOracle(d: MetricsData, nowMs: number): string {
  if (!d.oracle.length) return `<p class="empty">No oracle price recorded yet.</p>`;
  // the API's ages are as of generatedAt; add the time since (the JSON may be cached)
  const extra = Math.max(0, (nowMs - Date.parse(d.generatedAt)) / 1000);
  const rows = d.oracle
    .map(
      (p) =>
        `<tr><td data-label="Price">${esc(p.priceId)}</td><td data-label="Age">${esc(ago(p.ageSeconds + extra))}</td><td data-label="Session">${p.held ? `<span class="pill idle">held (market closed)</span>` : `<span class="pill ok">live</span>`}</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Price</th><th>Age of the latest print</th><th>Session</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderMetrics(d: MetricsData, nowMs: number): string {
  const none = d.liveBooks === 0;
  const banner = none
    ? `<section class="banner idle" role="status"><span class="dot"></span>No book open yet. Totals stay at zero until the first book goes live; nothing here is estimated.</section>`
    : `<section class="banner ok" role="status"><span class="dot"></span>${esc(d.liveBooks)} book${d.liveBooks === 1 ? "" : "s"} open</section>`;
  const oi = d.engine.openInterestUsd;
  const tiles = [
    tile("Book pools", usd(d.tvl.booksUsd), none ? "no book open yet" : "net asset value of open books"),
    tile("Insurance pool", usd(d.tvl.insurancePoolUsd), d.tvl.insurancePoolFirstLossUsd ? `first-loss slice ${usd(d.tvl.insurancePoolFirstLossUsd)}` : d.tvl.insurancePoolUsd === null ? "no pool activity recorded yet" : ""),
    tile("Backstop", usd(d.tvl.backstopUsd)),
    tile("Fees earned", usd(d.revenue.totalUsd), "lifetime, received by the books"),
    tile("Open interest", oi ? usd(oi.total) : "not available", oi ? `long ${usd(oi.long)} · short ${usd(oi.short)}` : ""),
    tile("Open positions", String(d.engine.openPositions), `${d.engine.markets} engine market${d.engine.markets === 1 ? "" : "s"}`),
    tile("BKRN buybacks", d.buybacks ? usd(d.buybacks.spentUsd) : "not available", d.buybacks ? `${usd(d.buybacks.pendingUsd)} waiting for the next one` : "spent on buybacks so far"),
  ].join("");
  const sources = d.revenue.bySource.length
    ? `<ul class="plain">${d.revenue.bySource.map((r) => `<li>${esc(SOURCE_LABEL[r.source] ?? r.source)} <strong>${esc(usd(r.usd))}</strong></li>`).join("")}</ul>`
    : `<p class="empty">No fees received yet.</p>`;
  return `${banner}
<p class="meta">Chain ${esc(d.chainId)} · updated ${esc(new Date(d.generatedAt).toISOString().replace("T", " ").slice(0, 19))} UTC</p>
<dl class="tiles">${tiles}</dl>
<h2>Value held</h2>
<p class="meta">Book pools and the insurance pool overlap when books are funded by the pool, so they are not added up.</p>
${tvlBars(d)}
<h2>Fees by source</h2>
${sources}
<h2>Oracle prices</h2>
${renderOracle(d, nowMs)}`;
}

export function renderError(message: string): string {
  return `<section class="banner bad" role="status"><span class="dot"></span>Metrics unavailable: ${esc(message)}</section>`;
}
