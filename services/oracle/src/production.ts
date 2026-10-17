// Mainnet (Robinhood Chain 4663) production rules. The service refuses to start while any problem is
// listed, and OracleService (settings.production) refuses to sign below them at runtime:
//   - synthetic sources are impossible (ORACLE_SYNTHETIC must be 0; any synthetic source is fatal);
//   - Chainlink + at least one other live source (the design: Pyth Pro, ORACLE_PYTH=1 + PYTH_API_KEY), and at
//     least `minSources` live sources in total;
//   - ORACLE_MIN_SOURCES >= MAINNET_MIN_SOURCES_FLOOR (the on-chain AttestedOracle.minSources() raises it, and
//     must itself not exceed the configured live sources: onchainMinSourcesProblem, checked at startup);
//   - feeds must state their basis (a plain ORACLE_CHAINLINK_FEEDS address is refused: per-token or per-share
//     decides whether the multiplier is divided out — VERIFY C2);
//   - session calendar on (SESSIONS_MODE=24x7 is a demo override that would never hold off-hours: C3).
import { MAINNET_CHAIN_ID } from "@bookrunner/shared";
import type { OracleConfig } from "./config";
import { type PriceSource, sourceKind } from "./domain/types";

/** Lowest accepted ORACLE_MIN_SOURCES on mainnet (Chainlink + one independent source: Pyth Pro). */
export const MAINNET_MIN_SOURCES_FLOOR = 2;

export const isProductionChain = (chainId: number): boolean => chainId === MAINNET_CHAIN_ID;

export type ProductionConfig = Pick<
  OracleConfig,
  "CHAIN_ID" | "ORACLE_SYNTHETIC" | "ORACLE_MIN_SOURCES" | "SESSIONS_MODE" | "chainlinkFeeds" | "legacyChainlinkFeeds" | "tickers"
> &
  Partial<Pick<OracleConfig, "ORACLE_PYTH" | "PYTH_API_KEY" | "pythFeeds">>;

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
  const live = sources.filter((s) => sourceKind(s) !== "synthetic");
  const chainlink = live.filter((s) => sourceKind(s) === "chainlink");
  const others = live.filter((s) => sourceKind(s) !== "chainlink");
  if (chainlink.length === 0) problems.push("no Chainlink feeds configured (config/chains/4663.json or ORACLE_CHAINLINK_FEEDS)");
  if (others.length === 0) {
    problems.push(
      "no live source besides Chainlink (ORACLE_PYTH=1 + PYTH_API_KEY, or ORACLE_HTTP_SOURCES / ORACLE_HTTP_FINNHUB): the median needs an independent source",
    );
  }
  const distinct = liveSourceCount(sources);
  if (distinct < cfg.ORACLE_MIN_SOURCES) {
    problems.push(`${distinct} distinct live sources < ORACLE_MIN_SOURCES=${cfg.ORACLE_MIN_SOURCES}: every price would be refused`);
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
 * The on-chain minimum must be reachable by the configured sources: AttestedOracle refuses every non-held
 * price below `minSources()` (and the service applies max(ORACLE_MIN_SOURCES, minSources())). Null = fine.
 */
export function onchainMinSourcesProblem(onchainMin: number, sources: readonly PriceSource[]): string | null {
  const live = liveSourceCount(sources);
  if (onchainMin <= live) return null;
  return (
    `AttestedOracle.minSources()=${onchainMin} > ${live} configured live sources: every price would be refused on-chain ` +
    `(lower it through the timelock, setMinSources(${live}), or configure another source)`
  );
}

/**
 * Startup gate (mainnet): reads AttestedOracle.minSources() (`attempts` tries, `delayMs` apart) and returns why
 * the service must not start, or null. An unreadable contract is a refusal too: the minimum cannot be checked.
 */
export async function startupOnchainMinSourcesProblem(p: {
  readMinSources: () => Promise<number>;
  sources: readonly PriceSource[];
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string | null> {
  const attempts = p.attempts ?? 5;
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = "";
  for (let i = 0; i < attempts; i++) {
    try {
      return onchainMinSourcesProblem(await p.readMinSources(), p.sources);
    } catch (e) {
      last = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
      if (i + 1 < attempts) await sleep(p.delayMs ?? 2_000);
    }
  }
  return `AttestedOracle.minSources() not readable (${last}): cannot check it against the configured sources`;
}
