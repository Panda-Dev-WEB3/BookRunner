// /metrics/ page script: fetches the public metrics JSON (same origin /metrics.json, nginx -> API /metrics) and
// re-renders every 60 s (the API caches it for 30 s). No wallet, no chain access, no third-party request.
import { type MetricsData, renderError, renderMetrics } from "./view";

const ENDPOINT = "/metrics.json";
const REFRESH_MS = 60_000;
const root = document.getElementById("metrics");

async function refresh(): Promise<void> {
  if (!root) return;
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    root.innerHTML = renderMetrics((await res.json()) as MetricsData, Date.now());
  } catch (err) {
    root.innerHTML = renderError(err instanceof Error ? err.message : String(err));
  }
}

void refresh();
setInterval(() => {
  if (document.visibilityState === "visible") void refresh();
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
