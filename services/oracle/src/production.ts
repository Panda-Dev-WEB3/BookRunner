// Mainnet (Robinhood Chain 4663) production rules. The service refuses to start while any problem is
// listed, and OracleService (settings.production) refuses to sign below them at runtime. The mainnet design is
// "primary + confirm" (domain/confirm.ts, VERIFY C6):
//   - ORACLE_POLICY=primary-confirm: Chainlink is the only source that sets and signs a price (sourceCount 1);
//     ORACLE_MIN_SOURCES must be exactly 1 and the on-chain AttestedOracle.minSources() exactly 1
//     (onchainMinSourcesProblem, checked at startup and on every chain-state refresh);
//   - a Chainlink feed for every ticker, with an explicit basis (a plain ORACLE_CHAINLINK_FEEDS address is refused:
//     per-token or per-share decides whether the multiplier is divided out — VERIFY C2), and an in-session max age
//     of at most heartbeat + MAINNET_CHAINLINK_MAX_GRACE_MS (1 h): Chainlink alone signs, so a widened bound would
//     sign an old round as a fresh, non-held price (ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS and ORACLE_CHAINLINK_MAX_AGE_MS
//     are bounded the same way);
//   - a DEX confirm pool (Uniswap v3 TWAP, chain config dexConfirm.pools) for every ticker, with a 2% depth floor
//     of at least MAINNET_DEX_MIN_FLOOR_USD (the depth itself is checked live: source-check, and every tick), a TWAP
//     window within MAINNET_DEX_TWAP_SEC (a short window is cheap to push) and ORACLE_DEX_MAX_AGE_MS at most
//     MAINNET_DEX_MAX_AGE_MS (an RPC stall must not confirm with an old block);
//   - ORACLE_CONFIRM_BPS at most MAINNET_MAX_CONFIRM_BPS (a wider band would hide a lagging feed), and
//     ORACLE_PRIMARY_LAG_BPS below it (the stalled-feed signal must fire before the divergence one);
//   - Pyth Pro is OPTIONAL (an extra confirm source): when ORACLE_PYTH=1 it needs its key, https and feed ids;
//   - HTTP confirm sources carry their own quote timestamp (tsPath) and an in-session max age <=
//     MAINNET_HTTP_MAX_AGE_MS (a stale last trade stamped with our receive time would "confirm" anything); the
//     Finnhub preset is refused;
//   - synthetic sources are impossible (ORACLE_SYNTHETIC must be 0; any synthetic source is fatal);
//   - session calendar on (SESSIONS_MODE=24x7 is a demo override that would never hold off-hours: C3).
import { MAINNET_CHAIN_ID } from "@bookrunner/shared";
import type { OracleConfig, RpcCadence } from "./config";
import { type OraclePolicy, type PriceSource, PRIMARY_SOURCE, sourceKind } from "./domain/types";

/** sourceCount of every primary-confirm price, and the only ORACLE_MIN_SOURCES / on-chain minSources() it accepts. */
export const PRIMARY_CONFIRM_SOURCE_COUNT = 1;
/** Largest in-session max age of an HTTP source's own quote timestamp on mainnet. */
export const MAINNET_HTTP_MAX_AGE_MS = 30_000;
/** Lowest liquidity floor (quote tokens, ~USD) a mainnet DEX confirm pool may be configured with. */
export const MAINNET_DEX_MIN_FLOOR_USD = 10_000;
/** Widest confirm band on mainnet (bps). */
export const MAINNET_MAX_CONFIRM_BPS = 500;
/** Largest grace beyond a Chainlink feed's heartbeat on mainnet (the in-session max age is heartbeat + grace). */
export const MAINNET_CHAINLINK_MAX_GRACE_MS = 3_600_000;
/** Heartbeat assumed for a feed whose heartbeatSec is not configured (the Robinhood equity feeds: 24 h). */
export const MAINNET_CHAINLINK_DEFAULT_HEARTBEAT_SEC = 86_400;
/** Allowed DEX TWAP window on mainnet (s). */
export const MAINNET_DEX_TWAP_SEC = { min: 300, max: 3_600 } as const;
/** Largest DEX observation age (block time vs now) on mainnet. */
export const MAINNET_DEX_MAX_AGE_MS = 120_000;

/**
 * Mainnet RPC cadence bounds (ms; deploy/server/MAINNET.md "RPC budget"), mirrored by scripts/network-profile.ts.
 * Lower bounds keep the RPC bill bounded (a 100 ms tick would multiply it), upper bounds keep the prices safe:
 *   - ORACLE_TICK_MS: the signing tick (no RPC of its own): >= 1 s, <= 5 s (ops-venue re-sends a price at most 3 ticks
 *     old, risk wants one younger than 15 s);
 *   - Chainlink pass: <= 30 s behind a new round (0.5% deviation feeds);
 *   - token state: at least every Chainlink pass, at most 60 s old (audit M-2; the split window forces every pass);
 *   - DEX pass: at most half ORACLE_DEX_MAX_AGE_MS (a reused pass must never look stale);
 *   - head clock: at most 60 s of extrapolation.
 */
export const MAINNET_RPC_BOUNDS = {
  tickMs: { min: 1_000, max: 5_000 },
  chainlinkReadMs: { min: 2_000, max: 30_000 },
  tokenStateReadMs: { max: 60_000 },
  dexReadMs: { min: 10_000 },
  headReadMs: { min: 1_000, max: 60_000 },
} as const;

/** Mainnet RPC cadence problems (empty = within bounds). */
export function rpcCadenceProblems(c: { tickMs: number } & RpcCadence): string[] {
  const b = MAINNET_RPC_BOUNDS;
  const out: string[] = [];
  const range = (name: string, v: number, min: number, max: number, why: string) => {
    if (!(v >= min && v <= max)) out.push(`${name}=${v} outside ${min}-${max} ms on mainnet (${why})`);
  };
  range("ORACLE_TICK_MS", c.tickMs, b.tickMs.min, b.tickMs.max, "signing cadence: RPC-free, but each tick re-signs every price");
  range("ORACLE_CHAINLINK_READ_MS", c.chainlinkReadMs, b.chainlinkReadMs.min, b.chainlinkReadMs.max, "one aggregate3 per pass; a new Chainlink round must be seen within 30 s");
  range("ORACLE_TOKEN_STATE_READ_MS", c.tokenStateReadMs, c.chainlinkReadMs, b.tokenStateReadMs.max, "at least every Chainlink pass, at most 60 s old: audit M-2");
  range("ORACLE_DEX_READ_MS", c.dexReadMs, b.dexReadMs.min, Math.floor(c.dexMaxAgeMs / 2), "at most half ORACLE_DEX_MAX_AGE_MS: a reused pass must stay fresh");
  range("ORACLE_HEAD_READ_MS", c.headReadMs, b.headReadMs.min, b.headReadMs.max, "publishedAt clamp: at most 60 s of extrapolation");
  return out;
}

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
      | "ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS"
      | "ORACLE_CHAINLINK_MAX_AGE_MS"
      | "ORACLE_DEX_MAX_AGE_MS"
      | "ORACLE_PRIMARY_LAG_BPS"
      | "ORACLE_TICK_MS"
      | "cadence"
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
  if (cfg.ORACLE_PRIMARY_LAG_BPS !== undefined && cfg.ORACLE_CONFIRM_BPS !== undefined && cfg.ORACLE_PRIMARY_LAG_BPS >= cfg.ORACLE_CONFIRM_BPS) {
    problems.push(`ORACLE_PRIMARY_LAG_BPS=${cfg.ORACLE_PRIMARY_LAG_BPS} must be below ORACLE_CONFIRM_BPS=${cfg.ORACLE_CONFIRM_BPS} (the stalled-feed signal precedes divergence)`);
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
  problems.push(...chainlinkAgeProblems(cfg));

  // ---- confirm: the DEX TWAP, one pool per ticker ----
  if (cfg.ORACLE_DEX_CONFIRM === false) {
    problems.push("ORACLE_DEX_CONFIRM=0 on mainnet: the Uniswap v3 TWAP confirm source is required (a DEX confirm pool per ticker)");
  } else {
    if (!live.some((s) => sourceKind(s) === "dex")) problems.push("no DEX confirm source (config/chains/4663.json dexConfirm.pools)");
    const pools = cfg.dexPools ?? {};
    const noPool = cfg.tickers.filter((t) => !pools[t]);
    if (noPool.length > 0) problems.push(`no DEX confirm pool for ${noPool.join(", ")} (dexConfirm.pools in the chain config)`);
    for (const [t, p] of Object.entries(pools)) {
      if (p.minDepthUsd < MAINNET_DEX_MIN_FLOOR_USD) {
        problems.push(`dexConfirm.pools.${t}.minDepthUsd=${p.minDepthUsd} < ${MAINNET_DEX_MIN_FLOOR_USD} on mainnet (a shallow pool is cheap to move)`);
      }
      if (p.twapSec < MAINNET_DEX_TWAP_SEC.min || p.twapSec > MAINNET_DEX_TWAP_SEC.max) {
        problems.push(`dexConfirm.pools.${t} TWAP window ${p.twapSec}s outside ${MAINNET_DEX_TWAP_SEC.min}-${MAINNET_DEX_TWAP_SEC.max}s on mainnet (twapSec / ORACLE_DEX_TWAP_SEC)`);
      }
    }
    if (cfg.ORACLE_DEX_MAX_AGE_MS !== undefined && cfg.ORACLE_DEX_MAX_AGE_MS > MAINNET_DEX_MAX_AGE_MS) {
      problems.push(`ORACLE_DEX_MAX_AGE_MS=${cfg.ORACLE_DEX_MAX_AGE_MS} > ${MAINNET_DEX_MAX_AGE_MS} on mainnet (an RPC stall would confirm with an old block)`);
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
  if (cfg.cadence) problems.push(...rpcCadenceProblems({ tickMs: cfg.ORACLE_TICK_MS ?? 1_000, ...cfg.cadence }));
  return problems;
}

/**
 * Mainnet bound on Chainlink freshness (null-free list of problems): Chainlink is the only signing source, so every
 * feed's in-session max age must stay within its heartbeat + MAINNET_CHAINLINK_MAX_GRACE_MS (heartbeat unknown: the
 * 24 h of the Robinhood feeds), and neither the grace nor the default max age may be widened beyond that.
 */
export function chainlinkAgeProblems(
  cfg: Pick<ProductionConfig, "chainlinkFeeds"> & Partial<Pick<ProductionConfig, "ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS" | "ORACLE_CHAINLINK_MAX_AGE_MS">>,
): string[] {
  const out: string[] = [];
  const grace = cfg.ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS;
  if (grace !== undefined && grace > MAINNET_CHAINLINK_MAX_GRACE_MS) {
    out.push(`ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS=${grace} > ${MAINNET_CHAINLINK_MAX_GRACE_MS} on mainnet: a wider grace signs an old Chainlink round as a fresh price`);
  }
  const defaultBound = MAINNET_CHAINLINK_DEFAULT_HEARTBEAT_SEC * 1000 + MAINNET_CHAINLINK_MAX_GRACE_MS;
  if (cfg.ORACLE_CHAINLINK_MAX_AGE_MS !== undefined && cfg.ORACLE_CHAINLINK_MAX_AGE_MS > defaultBound) {
    out.push(`ORACLE_CHAINLINK_MAX_AGE_MS=${cfg.ORACLE_CHAINLINK_MAX_AGE_MS} > ${defaultBound} on mainnet (24 h heartbeat + 1 h)`);
  }
  for (const [id, f] of Object.entries(cfg.chainlinkFeeds)) {
    const bound = (f.heartbeatSec ?? MAINNET_CHAINLINK_DEFAULT_HEARTBEAT_SEC) * 1000 + MAINNET_CHAINLINK_MAX_GRACE_MS;
    if (f.maxAgeMs > bound) {
      out.push(`chainlink feed ${id}: in-session max age ${f.maxAgeMs} ms > heartbeat + 1 h (${bound} ms) on mainnet: an old round would be signed as fresh`);
    }
  }
  return out;
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
