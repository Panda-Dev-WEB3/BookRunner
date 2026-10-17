// Mainnet (Robinhood Chain 4663) production rules. The service refuses to start while any problem is
// listed, and OracleService (settings.production) refuses to sign below them at runtime:
//   - synthetic sources are impossible (ORACLE_SYNTHETIC must be 0; any synthetic source is fatal);
//   - the 3-source design: Chainlink + Pyth Pro (ORACLE_PYTH=1 + PYTH_API_KEY) + at least one more independent
//     per-share source (ORACLE_HTTP_SOURCES / a preset), i.e. >= MAINNET_MIN_LIVE_SOURCES distinct live sources,
//     and always at least ORACLE_MIN_SOURCES + 1 (one source outage is tolerated, and with 3 quotes the 150 bps
//     band can isolate one bad source);
//   - ORACLE_MIN_SOURCES >= MAINNET_MIN_SOURCES_FLOOR (the on-chain AttestedOracle.minSources() raises it, and
//     must itself leave one spare live source: onchainMinSourcesProblem, checked at startup);
//   - feeds must state their basis (a plain ORACLE_CHAINLINK_FEEDS address is refused: per-token or per-share
//     decides whether the multiplier is divided out — VERIFY C2);
//   - session calendar on (SESSIONS_MODE=24x7 is a demo override that would never hold off-hours: C3).
import { MAINNET_CHAIN_ID } from "@bookrunner/shared";
import type { OracleConfig } from "./config";
import { type PriceSource, sourceKind } from "./domain/types";

/** Lowest accepted ORACLE_MIN_SOURCES on mainnet: every non-held price needs 2 agreeing sources. */
export const MAINNET_MIN_SOURCES_FLOOR = 2;
/** Distinct live sources required on mainnet: Chainlink + Pyth Pro + one more, so one can fail. */
export const MAINNET_MIN_LIVE_SOURCES = 3;
/** Live sources beyond the minimum on mainnet (outage tolerance). */
export const MAINNET_SPARE_SOURCES = 1;

export const isProductionChain = (chainId: number): boolean => chainId === MAINNET_CHAIN_ID;

export type ProductionConfig = Pick<
  OracleConfig,
  "CHAIN_ID" | "ORACLE_SYNTHETIC" | "ORACLE_MIN_SOURCES" | "SESSIONS_MODE" | "chainlinkFeeds" | "legacyChainlinkFeeds" | "tickers"
> &
  Partial<Pick<OracleConfig, "ORACLE_PYTH" | "PYTH_API_KEY" | "pythFeeds" | "ORACLE_PYTH_URL">>;

/** Distinct live (non-synthetic) source names: what one price can be backed by at most. */
export function liveSourceCount(sources: readonly PriceSource[]): number {
  return new Set(sources.filter((s) => sourceKind(s) !== "synthetic").map((s) => s.name)).size;
}

/** Problems that forbid running on mainnet (empty off mainnet, and when the config is production-ready). */
export function productionProblems(cfg: ProductionConfig, sources: readonly PriceSource[]): string[] {
  if (!isProductionChain(cfg.CHAIN_ID)) return [];
  const problems: string[] = [];
  if (cfg.ORACLE_SYNTHETIC) problems.push("ORACLE_SYNTHETIC must be 0 on mainnet (synthetic prices are impossible on chain 4663)");
  const synthetic = sources.filter((s) => sourceKind(s) === "synthetic").map((s) => s.name);
  if (synthetic.length > 0) problems.push(`synthetic sources configured: ${synthetic.join(", ")}`);
  if (cfg.ORACLE_MIN_SOURCES < MAINNET_MIN_SOURCES_FLOOR) {
    problems.push(`ORACLE_MIN_SOURCES=${cfg.ORACLE_MIN_SOURCES} is below the mainnet floor ${MAINNET_MIN_SOURCES_FLOOR}`);
  }
  if (cfg.ORACLE_PYTH && !cfg.PYTH_API_KEY) problems.push("ORACLE_PYTH=1 but PYTH_API_KEY is not set (Pyth Pro access token)");
  if (cfg.ORACLE_PYTH && cfg.ORACLE_PYTH_URL !== undefined && !cfg.ORACLE_PYTH_URL.startsWith("https://")) {
    problems.push("ORACLE_PYTH_URL must be https:// on mainnet (the access token travels in its Authorization header)");
  }
  const live = sources.filter((s) => sourceKind(s) !== "synthetic");
  const chainlink = live.filter((s) => sourceKind(s) === "chainlink");
  const others = live.filter((s) => sourceKind(s) !== "chainlink");
  if (chainlink.length === 0) problems.push("no Chainlink feeds configured (config/chains/4663.json or ORACLE_CHAINLINK_FEEDS)");
  if (!live.some((s) => sourceKind(s) === "pyth")) problems.push("no Pyth Pro source (ORACLE_PYTH=1 + PYTH_API_KEY)");
  if (others.filter((s) => sourceKind(s) !== "pyth").length === 0) {
    problems.push("no third live source besides Chainlink and Pyth Pro (ORACLE_HTTP_SOURCES or a preset): one source outage would stop every price");
  }
  const distinct = liveSourceCount(sources);
  const needed = Math.max(MAINNET_MIN_LIVE_SOURCES, cfg.ORACLE_MIN_SOURCES + MAINNET_SPARE_SOURCES);
  if (distinct < needed) {
    problems.push(
      `${distinct} distinct live sources < ${needed} required on mainnet (Chainlink + Pyth Pro + >= 1 more; ORACLE_MIN_SOURCES=${cfg.ORACLE_MIN_SOURCES} + 1 spare)`,
    );
  }
  for (const id of cfg.legacyChainlinkFeeds) {
    problems.push(`ORACLE_CHAINLINK_FEEDS.${id} is a plain address: give {"proxy","basis","token"} (per-token feeds are divided by uiMultiplier)`);
  }
  const missing = cfg.tickers.filter((t) => !cfg.chainlinkFeeds[t]);
  if (chainlink.length > 0 && missing.length > 0) problems.push(`no Chainlink feed for ${missing.join(", ")}`);
  if (live.some((s) => sourceKind(s) === "pyth") && cfg.pythFeeds) {
    const noPyth = cfg.tickers.filter((t) => cfg.pythFeeds?.[t] === undefined);
    if (noPyth.length > 0) problems.push(`no Pyth Pro feed id for ${noPyth.join(", ")} (ORACLE_PYTH_FEEDS)`);
  }
  if (cfg.SESSIONS_MODE === "24x7") {
    problems.push("SESSIONS_MODE=24x7 is a demo override: set SESSIONS_MODE=charter so prices hold off-hours (session calendar, VERIFY C3)");
  }
  return problems;
}

/**
 * The on-chain minimum must be reachable by the configured sources with `spare` sources to spare: AttestedOracle
 * refuses every non-held price below `minSources()` (and the service applies max(ORACLE_MIN_SOURCES,
 * minSources())). Mainnet passes MAINNET_SPARE_SOURCES (one source may be down). Null = fine.
 */
export function onchainMinSourcesProblem(onchainMin: number, sources: readonly PriceSource[], spare = 0): string | null {
  const live = liveSourceCount(sources);
  if (onchainMin + spare <= live) return null;
  if (onchainMin > live) {
    return (
      `AttestedOracle.minSources()=${onchainMin} > ${live} configured live sources: every price would be refused on-chain ` +
      `(lower it through the timelock, setMinSources(${Math.max(1, live - spare)}), or configure another source)`
    );
  }
  return (
    `AttestedOracle.minSources()=${onchainMin} leaves no spare among ${live} configured live sources: one source outage ` +
    `would stop every price (need ${onchainMin + spare}; configure another source or lower it through the timelock)`
  );
}

/**
 * Startup gate (mainnet): reads AttestedOracle.minSources() (`attempts` tries, `delayMs` apart) and returns why
 * the service must not start, or null. An unreadable contract is a refusal too: the minimum cannot be checked.
 */
export async function startupOnchainMinSourcesProblem(p: {
  readMinSources: () => Promise<number>;
  sources: readonly PriceSource[];
  /** live sources required beyond minSources() (mainnet: MAINNET_SPARE_SOURCES) */
  spare?: number;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string | null> {
  const attempts = p.attempts ?? 5;
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = "";
  for (let i = 0; i < attempts; i++) {
    try {
      return onchainMinSourcesProblem(await p.readMinSources(), p.sources, p.spare ?? 0);
    } catch (e) {
      last = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
      if (i + 1 < attempts) await sleep(p.delayMs ?? 2_000);
    }
  }
  return `AttestedOracle.minSources() not readable (${last}): cannot check it against the configured sources`;
}
