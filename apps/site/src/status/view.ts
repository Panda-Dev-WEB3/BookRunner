// Public status page (/status/): renders the API's /status JSON (nginx: /status.json). Pure markup
// builders, so they are unit-tested without a browser. Every value is escaped.

export interface StatusBook {
  bookId: number;
  name: string | null;
  symbol: string;
  venue: string;
  state: string;
  latestMark: { periodEnd: string; committedAt: string; ageSeconds: number } | null;
  markStatus: "ok" | "late" | "overdue" | "not_marked";
  risk: "ok" | "warn" | "breach" | "unknown";
  killed: boolean;
  lastDistribution: { at: string; period: number | null; grossUsd: string; seniorUsd: string; juniorUsd: string; txHash: string } | null;
}

export interface StatusData {
  generatedAt: string;
  chainId: number;
  markIntervalSeconds: number;
  markGraceSeconds: number;
  overall: "ok" | "warn" | "breach";
  books: StatusBook[];
}

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function ago(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)} h ago`;
  return `${(s / 86_400).toFixed(1)} days ago`;
}

export const every = (sec: number): string => (sec % 86_400 === 0 ? `${sec / 86_400} day${sec === 86_400 ? "" : "s"}` : sec % 3600 === 0 ? `${sec / 3600} h` : `${Math.round(sec / 60)} min`);

const usd = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : esc(s);
};

const pill = (label: string, tone: "ok" | "warn" | "bad" | "idle") => `<span class="pill ${tone}">${esc(label)}</span>`;

export function markCell(b: StatusBook, nowMs: number, generatedAt: string): string {
  if (!b.latestMark) return b.markStatus === "not_marked" ? pill("not marked", "idle") : `${pill(b.markStatus === "ok" ? "awaiting first mark" : b.markStatus, b.markStatus === "ok" ? "idle" : b.markStatus === "late" ? "warn" : "bad")}`;
  // the API's age is as of generatedAt; add the time since (the JSON may be cached for a few seconds)
  const age = b.latestMark.ageSeconds + Math.max(0, (nowMs - Date.parse(generatedAt)) / 1000);
  const tone = b.markStatus === "ok" ? "ok" : b.markStatus === "late" ? "warn" : b.markStatus === "overdue" ? "bad" : "idle";
  const label = b.markStatus === "not_marked" ? "not marked" : b.markStatus;
  return `${pill(label, tone)} <span class="sub">period end ${esc(ago(age))}</span>`;
}

export function riskCell(b: StatusBook): string {
  if (b.killed) return pill("killed", "bad");
  const tone = b.risk === "ok" ? "ok" : b.risk === "warn" ? "warn" : b.risk === "breach" ? "bad" : "idle";
  return pill(b.risk, tone);
}

export function distributionCell(b: StatusBook, nowMs: number): string {
  const d = b.lastDistribution;
  if (!d) return `<span class="sub">none yet</span>`;
  return `${usd(d.grossUsd)} <span class="sub">${esc(ago((nowMs - Date.parse(d.at)) / 1000))}</span>`;
}

const OVERALL: Record<StatusData["overall"], { text: string; tone: "ok" | "warn" | "bad" }> = {
  ok: { text: "All books operating normally", tone: "ok" },
  warn: { text: "Degraded: a mark is late or a book is near its risk limits", tone: "warn" },
  breach: { text: "Attention: a mark is overdue or a book breached its risk limits", tone: "bad" },
};

export function renderStatus(d: StatusData, nowMs: number): string {
  const o = OVERALL[d.overall] ?? OVERALL.warn;
  const rows = d.books
    .map(
      (b) => `<tr>
  <td data-label="Book"><strong>${esc(b.name ?? b.symbol)}</strong><span class="sub">#${esc(b.bookId)} · ${esc(b.symbol)}</span></td>
  <td data-label="State">${esc(b.state)}</td>
  <td data-label="Latest mark">${markCell(b, nowMs, d.generatedAt)}</td>
  <td data-label="Risk">${riskCell(b)}</td>
  <td data-label="Last distribution">${distributionCell(b, nowMs)}</td>
</tr>`,
    )
    .join("");
  return `<section class="banner ${o.tone}" role="status"><span class="dot"></span>${esc(o.text)}</section>
<p class="meta">Marks every ${esc(every(d.markIntervalSeconds))} (late after ${esc(every(d.markGraceSeconds))} of grace) · chain ${esc(d.chainId)} · updated ${esc(new Date(d.generatedAt).toISOString().replace("T", " ").slice(0, 19))} UTC</p>
${d.books.length ? `<div class="table-wrap"><table><thead><tr><th>Book</th><th>State</th><th>Latest mark</th><th>Risk</th><th>Last distribution</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="empty">No books yet.</p>`}`;
}

export function renderError(message: string): string {
  return `<section class="banner bad" role="status"><span class="dot"></span>Status unavailable: ${esc(message)}</section>`;
}
