// receipts service: every closed RECEIPTS_INTERVAL_SECONDS window per book -> receipt_roots row.
import { createDb } from "@bookrunner/db";
import { createLogger } from "@bookrunner/shared";
import { loadReceiptsConfig } from "./config";
import { onShutdown, startLoop } from "./loop";
import { type ReceiptsDeps, processClosedWindows } from "./roots";
import { PgReceiptsStore } from "./store-pg";

export async function main() {
  const cfg = loadReceiptsConfig();
  const log = createLogger("receipts", cfg.LOG_LEVEL);
  if (cfg.MARK_INTERVAL_SECONDS % cfg.RECEIPTS_INTERVAL_SECONDS !== 0) {
    log.warn({ mark: cfg.MARK_INTERVAL_SECONDS, receipts: cfg.RECEIPTS_INTERVAL_SECONDS }, "MARK_INTERVAL_SECONDS is not a multiple of RECEIPTS_INTERVAL_SECONDS; period roots cover windows starting inside the period");
  }
  const { db, close } = createDb(cfg.DATABASE_URL, 4);
  const deps: ReceiptsDeps = {
    store: new PgReceiptsStore(db),
    intervalSeconds: cfg.RECEIPTS_INTERVAL_SECONDS,
    graceSeconds: cfg.RECEIPTS_GRACE_SECONDS,
    markIntervalSeconds: cfg.MARK_INTERVAL_SECONDS,
    now: () => Math.floor(Date.now() / 1000),
    log,
  };
  const warned = new Set<string>();
  log.info({ interval: cfg.RECEIPTS_INTERVAL_SECONDS, grace: cfg.RECEIPTS_GRACE_SECONDS, tickSeconds: cfg.tickSeconds }, "receipts service starting");

  const loop = startLoop({
    name: "receipts",
    intervalMs: cfg.tickSeconds * 1000,
    log,
    run: async () => {
      const stats = await processClosedWindows(deps, { backfillSeconds: cfg.RECEIPTS_BACKFILL_SECONDS, maxWindowsPerTick: cfg.RECEIPTS_MAX_WINDOWS_PER_TICK }, warned);
      if (stats.windows) log.debug(stats, "receipts tick");
    },
  });

  onShutdown(log, async () => {
    await loop.stop();
    await close();
  });
}

if (import.meta.main) await main();
