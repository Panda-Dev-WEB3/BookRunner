// Mainnet (Robinhood Chain 4663) production rules. The service refuses to start while any problem is
// listed, and OracleService (settings.production) refuses to sign below them at runtime:
//   - synthetic sources are impossible (ORACLE_SYNTHETIC must be 0; any synthetic source is fatal);
//   - Chainlink + at least one other live source, and at least `minSources` live sources in total;
//   - ORACLE_MIN_SOURCES >= MAINNET_MIN_SOURCES_FLOOR (the on-chain AttestedOracle.minSources() raises it);
//   - feeds must state their basis (a plain ORACLE_CHAINLINK_FEEDS address is refused: per-token or per-share
//     decides whether the multiplier is divided out — VERIFY C2);
//   - session calendar on (SESSIONS_MODE=24x7 is a demo override that would never hold off-hours: C3).
import { MAINNET_CHAIN_ID } from "@bookrunner/shared";
import type { OracleConfig } from "./config";
import { type PriceSource, sourceKind } from "./domain/types";

/** Lowest accepted ORACLE_MIN_SOURCES on mainnet (Chainlink + one independent source). */
export const MAINNET_MIN_SOURCES_FLOOR = 2;

export const isProductionChain = (chainId: number): boolean => chainId === MAINNET_CHAIN_ID;

export type ProductionConfig = Pick<
  OracleConfig,
  "CHAIN_ID" | "ORACLE_SYNTHETIC" | "ORACLE_MIN_SOURCES" | "SESSIONS_MODE" | "chainlinkFeeds" | "legacyChainlinkFeeds" | "tickers"
>;

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
  const live = sources.filter((s) => sourceKind(s) !== "synthetic");
  const chainlink = live.filter((s) => sourceKind(s) === "chainlink");
  const others = live.filter((s) => sourceKind(s) !== "chainlink");
  if (chainlink.length === 0) problems.push("no Chainlink feeds configured (config/chains/4663.json or ORACLE_CHAINLINK_FEEDS)");
  if (others.length === 0) problems.push("no live source besides Chainlink (ORACLE_HTTP_SOURCES / ORACLE_HTTP_FINNHUB): the median needs an independent source");
  const distinct = new Set(live.map((s) => s.name)).size;
  if (distinct < cfg.ORACLE_MIN_SOURCES) {
    problems.push(`${distinct} distinct live sources < ORACLE_MIN_SOURCES=${cfg.ORACLE_MIN_SOURCES}: every price would be refused`);
  }
  for (const id of cfg.legacyChainlinkFeeds) {
    problems.push(`ORACLE_CHAINLINK_FEEDS.${id} is a plain address: give {"proxy","basis","token"} (per-token feeds are divided by uiMultiplier)`);
  }
  const missing = cfg.tickers.filter((t) => !cfg.chainlinkFeeds[t]);
  if (chainlink.length > 0 && missing.length > 0) problems.push(`no Chainlink feed for ${missing.join(", ")}`);
  if (cfg.SESSIONS_MODE === "24x7") {
    problems.push("SESSIONS_MODE=24x7 is a demo override: set SESSIONS_MODE=charter so prices hold off-hours (session calendar, VERIFY C3)");
  }
  return problems;
}
