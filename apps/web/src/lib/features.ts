// Per-build feature switches (vite env). The Insurance Pool is off on mainnet until its audit fixes are deployed and
// re-audited (owner decision 2026-10-23): VITE_POOL_ENABLED=false in .env.mainnet hides the page and its links.
export const POOL_ENABLED = String(import.meta.env.VITE_POOL_ENABLED ?? "true") !== "false";
