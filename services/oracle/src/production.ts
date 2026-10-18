// Mainnet (Robinhood Chain 4663) production rules. The service refuses to start while any problem is
// listed, and OracleService (settings.production) refuses to sign below them at runtime. The mainnet design is
// "primary + confirm" (domain/confirm.ts, VERIFY C6):
//   - ORACLE_POLICY=primary-confirm: Chainlink is the only source that sets and signs a price (sourceCount 1);
//     ORACLE_MIN_SOURCES must be exactly 1 and the on-chain AttestedOracle.minSources() exactly 1
//     (onchainMinSourcesProblem, checked at startup and on every chain-state refresh);
//   - a Chainlink feed for every ticker, with an explicit basis (a plain ORACLE_CHAINLINK_FEEDS address is refused:
//     per-token or per-share decides whether the multiplier is divided out — VERIFY C2);
//   - a DEX confirm pool (Uniswap v3 TWAP, chain config dexConfirm.pools) for every ticker, with a liquidity floor
//     of at least MAINNET_DEX_MIN_FLOOR_USD; the floor itself is checked live (source-check, and every tick);
//   - ORACLE_CONFIRM_BPS at most MAINNET_MAX_CONFIRM_BPS (a wider band would hide a lagging feed);
//   - Pyth Pro is OPTIONAL (an extra confirm source): when ORACLE_PYTH=1 it needs its key, https and feed ids;
//   - HTTP confirm sources carry their own quote timestamp (tsPath) and an in-session max age <=
//     MAINNET_HTTP_MAX_AGE_MS (a stale last trade stamped with our receive time would "confirm" anything); the
//     Finnhub preset is refused;
//   - synthetic sources are impossible (ORACLE_SYNTHETIC must be 0; any synthetic source is fatal);
//   - session calendar on (SESSIONS_MODE=24x7 is a demo override that would never hold off-hours: C3).
import { MAINNET_CHAIN_ID } from "@bookrunner/shared";
import type { OracleConfig } from "./config";
import { type OraclePolicy, type PriceSource, PRIMARY_SOURCE, sourceKind } from "./domain/types";

/** sourceCount of every primary-confirm price, and the only ORACLE_MIN_SOURCES / on-chain minSources() it accepts. */
export const PRIMARY_CONFIRM_SOURCE_COUNT = 1;
/** Largest in-session max age of an HTTP source's own quote timestamp on mainnet. */
export const MAINNET_HTTP_MAX_AGE_MS = 30_000;
/** Lowest liquidity floor (quote tokens, ~USD) a mainnet DEX confirm pool may be configured with. */
export const MAINNET_DEX_MIN_FLOOR_USD = 10_000;
/** Widest confirm band on mainnet (bps). */
export const MAINNET_MAX_CONFIRM_BPS = 500;

export const isProductionChain = (chainId: number): boolean => chainId === MAINNET_CHAIN_ID;

export type ProductionConfig = Pick<
  OracleConfig,
  "CHAIN_ID" | "ORACLE_SYNTHETIC" | "ORACLE_MIN_SOURCES" | "SESSIONS_MODE" | "chainlinkFeeds" | "legacyChainlinkFeeds" | "tickers"
> &
  Partial<
    Pick<
      OracleConfig,
      | "ORACLE_POLICY"
      | "ORACLE_CONFIRM_BPS"
      | "ORACLE_DEX_CONFIRM"
      | "dexPools"
      | "ORACLE_PYTH"
      | "PYTH_API_KEY"
      | "pythFeeds"
      | "ORACLE_PYTH_URL"
      | "httpSources"
      | "ORACLE_HTTP_FINNHUB"
    >
  >;

/** Mainnet rule for one HTTP source spec (null = fine): its own quote timestamp and a tight in-session max age. */
export function httpSpecProblem(spec: { name: string; tsPath?: string | undefined; maxAgeMs?: number | undefined }): string | null {
  if (!spec.tsPath) {
    return `ORACLE_HTTP_SOURCES.${spec.name} has no tsPath: on mainnet every quote must carry the vendor's own timestamp (receive time would make a stale last trade look fresh)`;
  }
  if (spec.maxAgeMs === undefined || spec.maxAgeMs > MAINNET_HTTP_MAX_AGE_MS) {
    return `ORACLE_HTTP_SOURCES.${spec.name} needs maxAgeMs <= ${MAINNET_HTTP_MAX_AGE_MS} on mainnet (got ${spec.maxAgeMs ?? "unset: the 15 s default is not pinned"})`;
  }
  return null;
}

/** Distinct live (non-synthetic) source names. */
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

  const policy: OraclePolicy = cfg.ORACLE_POLICY ?? "primary-confirm";
  if (policy !== "primary-confirm") {
    problems.push(`ORACLE_POLICY=${policy} on mainnet: set ORACLE_POLICY=primary-confirm (Chainlink signs, the DEX TWAP / Pyth only confirm)`);
  }
  if (cfg.ORACLE_MIN_SOURCES !== PRIMARY_CONFIRM_SOURCE_COUNT) {
    problems.push(
      `ORACLE_MIN_SOURCES=${cfg.ORACLE_MIN_SOURCES} on mainnet: must be ${PRIMARY_CONFIRM_SOURCE_COUNT} (primary-confirm signs every price with sourceCount 1)`,
    );
  }
  if (cfg.ORACLE_CONFIRM_BPS !== undefined && cfg.ORACLE_CONFIRM_BPS > MAINNET_MAX_CONFIRM_BPS) {
    problems.push(`ORACLE_CONFIRM_BPS=${cfg.ORACLE_CONFIRM_BPS} > ${MAINNET_MAX_CONFIRM_BPS} on mainnet (a wider band would hide a lagging Chainlink feed)`);
  }

  // ---- primary: Chainlink, one feed per ticker ----
  const live = sources.filter((s) => sourceKind(s) !== "synthetic");
  if (!live.some((s) => s.name === PRIMARY_SOURCE && sourceKind(s) === "chainlink")) {
    problems.push("no Chainlink feeds configured (config/chains/4663.json or ORACLE_CHAINLINK_FEEDS): Chainlink is the only signing source");
  }
  for (const id of cfg.legacyChainlinkFeeds) {
    problems.push(`ORACLE_CHAINLINK_FEEDS.${id} is a plain address: give {"proxy","basis","token"} (per-token feeds are divided by uiMultiplier)`);
  }
  const missing = cfg.tickers.filter((t) => !cfg.chainlinkFeeds[t]);
  if (missing.length > 0) problems.push(`no Chainlink feed for ${missing.join(", ")}`);

  // ---- confirm: the DEX TWAP, one pool per ticker ----
  if (cfg.ORACLE_DEX_CONFIRM === false) {
    problems.push("ORACLE_DEX_CONFIRM=0 on mainnet: the Uniswap v3 TWAP confirm source is required (a DEX confirm pool per ticker)");
  } else {
    if (!live.some((s) => sourceKind(s) === "dex")) problems.push("no DEX confirm source (config/chains/4663.json dexConfirm.pools)");
    const pools = cfg.dexPools ?? {};
    const noPool = cfg.tickers.filter((t) => !pools[t]);
    if (noPool.length > 0) problems.push(`no DEX confirm pool for ${noPool.join(", ")} (dexConfirm.pools in the chain config)`);
    for (const [t, p] of Object.entries(pools)) {
      if (p.minQuoteLiquidity < MAINNET_DEX_MIN_FLOOR_USD) {
        problems.push(`dexConfirm.pools.${t}.minQuoteLiquidityUsd=${p.minQuoteLiquidity} < ${MAINNET_DEX_MIN_FLOOR_USD} on mainnet (a shallow pool confirms nothing)`);
      }
    }
  }

  // ---- optional confirm sources ----
  if (cfg.ORACLE_PYTH && !cfg.PYTH_API_KEY) problems.push("ORACLE_PYTH=1 but PYTH_API_KEY is not set (Pyth Pro access token)");
  if (cfg.ORACLE_PYTH && cfg.ORACLE_PYTH_URL !== undefined && !cfg.ORACLE_PYTH_URL.startsWith("https://")) {
    problems.push("ORACLE_PYTH_URL must be https:// on mainnet (the access token travels in its Authorization header)");
  }
  if (live.some((s) => sourceKind(s) === "pyth") && cfg.pythFeeds) {
    const noPyth = cfg.tickers.filter((t) => cfg.pythFeeds?.[t] === undefined);
    if (noPyth.length > 0) problems.push(`no Pyth Pro feed id for ${noPyth.join(", ")} (ORACLE_PYTH_FEEDS)`);
  }
  for (const spec of cfg.httpSources ?? []) {
    const p = httpSpecProblem(spec);
    if (p) problems.push(p);
  }
  if (cfg.ORACLE_HTTP_FINNHUB) {
    problems.push("ORACLE_HTTP_FINNHUB is not a mainnet source (regular session only, 120 s quote age, licence unverified): use a 24/5 vendor in ORACLE_HTTP_SOURCES");
  }

  if (cfg.SESSIONS_MODE === "24x7") {
    problems.push("SESSIONS_MODE=24x7 is a demo override: set SESSIONS_MODE=charter so prices hold off-hours (session calendar, VERIFY C3)");
  }
  return problems;
}

/**
 * The on-chain minimum must accept what the service signs: AttestedOracle refuses every non-held price below
 * `minSources()`. primary-confirm signs every price with sourceCount 1, so minSources() must be exactly 1 (above:
 * every price refused; the contract forbids 0). median: minSources() must be reachable by the live sources. Null = fine.
 */
export function onchainMinSourcesProblem(onchainMin: number, policy: OraclePolicy, sources: readonly PriceSource[]): string | null {
  if (policy === "primary-confirm") {
    if (onchainMin === PRIMARY_CONFIRM_SOURCE_COUNT) return null;
    return (
      `AttestedOracle.minSources()=${onchainMin} but primary-confirm signs every price with sourceCount ${PRIMARY_CONFIRM_SOURCE_COUNT} ` +
      `(Chainlink only): ${onchainMin > PRIMARY_CONFIRM_SOURCE_COUNT ? "every price would be refused on-chain" : "unexpected value"} ` +
      `(setMinSources(${PRIMARY_CONFIRM_SOURCE_COUNT}) through the timelock)`
    );
  }
  const live = liveSourceCount(sources);
  if (onchainMin <= live) return null;
  return (
    `AttestedOracle.minSources()=${onchainMin} > ${live} configured live sources: every price would be refused on-chain ` +
    `(lower it through the timelock, setMinSources(${Math.max(1, live)}), or configure another source)`
  );
}

/**
 * Startup gate (mainnet): reads AttestedOracle.minSources() (`attempts` tries, `delayMs` apart) and returns why
 * the service must not start, or null. An unreadable contract is a refusal too: the minimum cannot be checked.
 */
export async function startupOnchainMinSourcesProblem(p: {
  readMinSources: () => Promise<number>;
  policy: OraclePolicy;
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
      return onchainMinSourcesProblem(await p.readMinSources(), p.policy, p.sources);
    } catch (e) {
      last = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
      if (i + 1 < attempts) await sleep(p.delayMs ?? 2_000);
    }
  }
  return `AttestedOracle.minSources() not readable (${last}): cannot check it against the configured sources`;
}
