// Markup helpers of the book desk (the original dashboard's building blocks, unchanged in shape so
// dashboard.css applies as before).
import { addressUrl, txUrl } from "./config";
import { date, esc, short, usd } from "./format";
import type { ChartGeometry } from "./model";

export { esc };

export const badge = (label: string, cls = ""): string => `<span class="status ${esc(cls || label.toLowerCase())}">${esc(label)}</span>`;

export const btn = (label: string, action: string, args: Record<string, unknown> = {}, style = "btn-outline", extra = ""): string =>
  `<button type="button" class="${style}" data-action="${esc(action)}" data-args="${esc(JSON.stringify(args))}" ${extra}>${label}</button>`;

export const metric = (label: string, value: string, note = ""): string =>
  `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`;

export const panel = (title: string, body: string, extra = ""): string => `<section class="panel"><div class="panel-head"><h2>${title}</h2>${extra}</div>${body}</section>`;

export const empty = (text: string): string => `<div class="empty">${text}</div>`;

export const notice = (text: string, cls = ""): string => `<div class="notice ${cls}">${text}</div>`;

export const loading = (what = "Reading live data"): string => empty(`${esc(what)}…`);

export function table(heads: string[], rows: string[][], emptyText = "Nothing recorded yet."): string {
  if (!rows.length) return empty(emptyText);
  return `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td data-label="${esc(heads[i] || "Action")}">${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

export const splitList = (pairs: Array<[string, string]>): string => `<dl class="split-list">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;

/** Explorer link for a tx hash (plain short hash when it is not a tx hash). */
export const txLink = (hash: string | null | undefined, label?: string): string => {
  const url = txUrl(hash);
  return url ? `<a class="hash" href="${esc(url)}" target="_blank" rel="noopener">${esc(label ?? short(hash))} ↗</a>` : `<span class="hash">${esc(short(hash))}</span>`;
};

export const addrLink = (a: string | null | undefined, label?: string): string => {
  const url = addressUrl(a);
  return url ? `<a class="hash" href="${esc(url)}" target="_blank" rel="noopener">${esc(label ?? short(a))} ↗</a>` : `<span class="hash">${esc(short(a))}</span>`;
};

export const errorBox = (message: string): string => notice(`Live data unavailable: ${esc(message)} This view retries automatically.`, "error");

/** NAV history line (the original chart, fed with committed marks). */
export function navChart(g: ChartGeometry | null, label = "Committed NAV history"): string {
  if (!g) return empty("NAV history appears after the book's first committed mark.");
  const pts = g.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const first = g.points[0];
  const last = g.points.at(-1);
  const dots = g.points.length <= 72 ? g.points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="currentColor"><title>${esc(usd(p.value))} · ${esc(date(p.at))} ${esc(new Date(p.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }))}</title></circle>`).join("") : "";
  return `<svg class="chart" viewBox="0 0 710 160" role="img" aria-label="${esc(label)}"><path d="M40 20V130H685" fill="none" stroke="#b6c9ed"/><text x="44" y="16">${esc(usd(g.max))}</text><text x="44" y="142">${esc(usd(g.min))}</text><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2.5"/>${dots}<text x="40" y="156">${esc(first ? date(first.at) : "")}</text><text x="555" y="156">${esc(last ? date(last.at) : "")}</text></svg>`;
}
