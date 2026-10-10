import type { SupervisorStatus } from "@bookrunner/shared/supervisor";
import { type RuleConfig, loadConfig } from "../src/config";
import type { BookSnap, Snapshot } from "../src/types";

export const NOW = Date.UTC(2026, 9, 10, 12, 0, 0); // 2026-10-10T12:00:00Z
export const NOW_S = NOW / 1000;

/** Testnet rule defaults (no env overrides). */
export function rules(over: Partial<RuleConfig> = {}): RuleConfig {
  return { ...loadConfig({ NETWORK: "testnet", CHAIN_ID: "46630" }).rules, ...over };
}

export function book(over: Partial<BookSnap> = {}): BookSnap {
  return {
    bookId: 3,
    name: "NVDA",
    symbol: "PERP_NVDA_USDC",
    state: "Live",
    venue: "orderly",
    lastMarkPeriodEnd: NOW_S - 600,
    liveSince: NOW_S - 86_400,
    risk: { state: "ok", breaches: [], ts: NOW - 5_000, killed: false, killReason: null, journal: null },
    venueReportAsOf: NOW_S - 60,
    ...over,
  };
}

export function supervisor(over: Partial<SupervisorStatus> = {}): SupervisorStatus {
  return {
    v: 1,
    ts: NOW - 5_000,
    network: "testnet",
    startedAt: NOW - 3_600_000,
    procs: [{ name: "mark", state: "running", startedAt: NOW - 3_600_000, exits: 0, recentExits: [], lastExitCode: null, lastExitAt: null, oneShot: false }],
    ...over,
  };
}

/** A healthy snapshot: every rule returns nothing. */
export function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    now: NOW,
    network: "testnet",
    chainId: 46630,
    markIntervalSec: 3600,
    books: [book()],
    kills: [],
    supervisor: supervisor(),
    balances: [{ role: "markSigner", address: "0x00000000000000000000000000000000000000aa", wei: 10n ** 16n }],
    rpc: { ok: true, head: 1_000_000, headTs: NOW_S - 2, error: null },
    rpcSamples: Array.from({ length: 10 }, (_, i) => ({ ts: NOW - i * 60_000, value: 1 })).reverse(),
    indexer: [
      { name: "indexer:protocol", block: 999_990, updatedAt: NOW - 10_000 },
      { name: "indexer:books", block: 999_990, updatedAt: NOW - 10_000 },
    ],
    buybackSamples: [],
    api: { ok: true, httpStatus: 200, db: "up", redis: "ready", error: null },
    backup: { ts: NOW - 3_600_000, ok: true, error: "", offsite: "ok", bytes: 1_000_000, dir: "/var/backups/bookrunner/daily/x" },
    infraErrors: [],
    ...over,
  };
}
