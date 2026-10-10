// /status/ page script: fetches the public status JSON (same origin /status.json, nginx -> API /status)
// and re-renders every 30 s. No wallet, no chain access, no third-party request.
import { type StatusData, renderError, renderStatus } from "./view";

const ENDPOINT = "/status.json";
const REFRESH_MS = 30_000;
const root = document.getElementById("status");

async function refresh(): Promise<void> {
  if (!root) return;
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    root.innerHTML = renderStatus((await res.json()) as StatusData, Date.now());
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
