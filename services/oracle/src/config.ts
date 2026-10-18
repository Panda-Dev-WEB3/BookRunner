// Oracle service configuration: shared base env (baseEnvSchema) + oracle-specific fields.
import { type ChainPriceConfig, type FeedConfig, baseEnvSchema, feedConfigSchema, feedToken, isMainnet, loadChainPriceConfig } from "@bookrunner/shared";
import { getAddress } from "viem";
import { z } from "zod";
import { ORACLE_POLICIES, type OraclePolicy } from "./domain/types";
import type { ResolvedFeed } from "./sources/chainlink";
import type { ResolvedDexPool } from "./sources/dex-twap";

/** Devnet demo prices (ARCHITECTURE §7) — USD per share, devnet only. */
export const DEFAULT_DEMO_PRICES: Record<string, number> = { NVDA: 190, TSLA: 440, AAPL: 255, MSFT: 520, AMZN: 230 };
/** Annualised volatility per ticker for the synthetic GBM path. */
export const DEFAULT_VOLS: Record<string, number> = { NVDA: 0.45, TSLA: 0.6, AAPL: 0.25, MSFT: 0.25, AMZN: 0.3 };
/** Fallback index definitions (weights in bps, sum 1e4) when the chain cannot be read. */
export const DEFAULT_INDEXES: Record<string, Record<string, number>> = {
  RHX5: { NVDA: 2000, TSLA: 2000, AAPL: 2000, MSFT: 2000, AMZN: 2000 },
};

const flag = (def: boolean) => z.stringbool().default(def);

/** The repo's devnet seed: public, so every synthetic price derived from it is predictable by anyone. */
export const PUBLIC_DEFAULT_ORACLE_SEED = "bookrunner-devnet";
export const MIN_SECRET_SEED_LENGTH = 16;

/**
 * Why synthetic sources must not run with this seed (null = fine). Devnet (31337) accepts anything;
 * every other chain needs a secret ORACLE_SEED: signed synthetic prices derived from a public seed can be
 * computed in advance and traded against with perfect foresight.
 */
export function syntheticSeedProblem(chainId: number, seed: string): string | null {
  if (chainId === 31337) return null;
  if (seed.trim() === PUBLIC_DEFAULT_ORACLE_SEED) return "ORACLE_SEED is the public repo default";
  if (seed.trim().length < MIN_SECRET_SEED_LENGTH) return `ORACLE_SEED is shorter than ${MIN_SECRET_SEED_LENGTH} characters`;
  return null;
}

export const oracleEnvShape = {
  ORACLE_PORT: z.coerce.number().int().positive().default(4410),
  /** HTTP bind address. Loopback by default: the API is an internal health / debug surface. */
  ORACLE_HOST: z.string().min(1).default("127.0.0.1"),
  /** Aggregation / Redis publication cadence (signed prices + the pull bundle). */
  ORACLE_TICK_MS: z.coerce.number().int().positive().default(1000),
  /**
   * pull (default, docs/LOW_GAS.md §1): never push on a timer — every tick publishes the signed bundle
   * (Redis KEYS.oracleBundle, GET /prices/signed) and consumers carry it in their own transaction.
   * heartbeat: the pre-low-gas behaviour (AttestedOracle.pushMany on the push policy), for debugging.
   */
  ORACLE_PUSH_MODE: z.enum(["pull", "heartbeat"]).default("pull"),
  /** A price id whose latest signed update is older than this (sources failing) is left out of the bundle. */
  ORACLE_BUNDLE_MAX_AGE_MS: z.coerce.number().int().positive().default(300_000),
  /**
   * Heartbeat mode: on-chain AttestedOracle.pushMany cadence per price id. Both modes: cadence of the
   * oracle_prices history rows.
   */
  ORACLE_PUSH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  /**
   * Immediate push when |price - last pushed| exceeds this (bps). Keep it below the cheapest in-house
   * round trip (spread + 2 x taker fee; RHX5 22 bps) so the stored price never lags the signed one by an
   * arbitrageable move.
   */
  ORACLE_PUSH_DEVIATION_BPS: z.coerce.number().nonnegative().default(10),
  /**
   * Aggregation policy (domain/types.ts OraclePolicy): median (default off mainnet: devnet / testnet / tests) |
   * primary-confirm (default and required on mainnet: Chainlink alone signs, sourceCount 1; the DEX TWAP and any
   * other live source only confirm it).
   */
  ORACLE_POLICY: z.enum(ORACLE_POLICIES).optional(),
  /** primary-confirm: a confirm source further than this from the Chainlink price (bps) = divergence (warn + alert). */
  ORACLE_CONFIRM_BPS: z.coerce.number().positive().default(200),
  /** primary-confirm: an in-session ticker without any confirm source this long is logged (rate-limited). */
  ORACLE_CONFIRM_UNAVAILABLE_WARN_MS: z.coerce.number().int().positive().default(600_000),
  /**
   * primary-confirm: a confirm gap above this (bps, below ORACLE_CONFIRM_BPS) while no new Chainlink round arrives is
   * the signature of a feed that silently stopped updating (its deviation rule is 50 bps): /health confirm[].lagSince,
   * services/alerts oracle_primary_suspect_stale after 10 min. Never changes the price.
   */
  ORACLE_PRIMARY_LAG_BPS: z.coerce.number().positive().default(100),
  /** primary-confirm: a diverged / unavailable / lagging run ends only after the other state held this long (no reset on a one-tick flap). */
  ORACLE_CONFIRM_HYSTERESIS_MS: z.coerce.number().int().nonnegative().default(60_000),
  /** Sources further than this from the median are rejected (bps; median policy). */
  ORACLE_OUTLIER_BPS: z.coerce.number().positive().default(150),
  /**
   * Minimum accepted sources for a non-held price (raised to AttestedOracle.minSources() if higher). Default: 1 under
   * primary-confirm (the only value it accepts on mainnet), 3 under median.
   */
  ORACLE_MIN_SOURCES: z.coerce.number().int().positive().optional(),
  /** Source observations older than this are ignored (per-source overrides, e.g. Chainlink). */
  ORACLE_MAX_SOURCE_AGE_MS: z.coerce.number().int().positive().default(15_000),
  ORACLE_SOURCE_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  ORACLE_UNIVERSE_REFRESH_MS: z.coerce.number().int().positive().default(60_000),
  ORACLE_DEPLOYMENT_RETRY_MS: z.coerce.number().int().positive().default(10_000),
  ORACLE_RECEIPT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Sessions for priceIds no charter governs: 24x7 | 24x5 | nyse. */
  ORACLE_DEFAULT_SESSIONS: z.enum(["24x7", "24x5", "nyse"]).default("24x5"),
  ORACLE_PUSH_ONCHAIN: flag(true),
  ORACLE_VENUE_PRICES: flag(true),

  // ---- synthetic GBM sources (devnet; testnet only with a secret ORACLE_SEED) ----
  ORACLE_SYNTHETIC: flag(true),
  /**
   * Seed of the synthetic GBM paths. The default is public (it is in this repo), so it is accepted on the
   * local devnet only: any other chain refuses to start synthetic sources unless ORACLE_SEED is a secret
   * of at least MIN_SECRET_SEED_LENGTH characters (`openssl rand -hex 32` into .env.testnet). Off devnet
   * every step also mixes CSPRNG noise, so not even the seed reproduces the path.
   */
  ORACLE_SEED: z.string().min(1).default(PUBLIC_DEFAULT_ORACLE_SEED),
  ORACLE_GBM_STEP_MS: z.coerce.number().int().positive().default(1000),
  /** Fixed path origin (unix ms) for reproducible runs; default = process start floored to a step. */
  ORACLE_GBM_EPOCH_MS: z.coerce.number().int().nonnegative().optional(),
  /** Multiplies every annualised vol (demo: >1 makes moves visible within minutes). */
  ORACLE_VOL_SCALE: z.coerce.number().positive().default(1),
  ORACLE_SYNTH_NOISE_BPS: z.coerce.number().nonnegative().default(3),
  ORACLE_SYNTH_DROPOUT: z.coerce.number().min(0).max(1).default(0.01),
  ORACLE_SYNTH_SPIKE_PROB: z.coerce.number().min(0).max(1).default(0.002),
  ORACLE_SYNTH_SPIKE_BPS: z.coerce.number().nonnegative().default(400),

  // ---- fallback universe (used when chain reads fail) ----
  ORACLE_TICKERS: z.string().default("NVDA,TSLA,AAPL,MSFT,AMZN"),
  ORACLE_DEMO_PRICES: z.string().optional(), // JSON {"NVDA":190,...}
  ORACLE_VOLS: z.string().optional(), // JSON {"NVDA":0.45,...}
  ORACLE_INDEXES: z.string().optional(), // JSON {"RHX5":{"NVDA":2000,...}}

  /** TEE attestation document served at GET /attestation (attestation.ts; docs/RUNBOOK.md). */
  ORACLE_ATTESTATION_FILE: z.string().optional(),

  // ---- live sources ----
  /**
   * Per-chain price config (canonical Stock Tokens + Chainlink feeds): default
   * config/chains/<CHAIN_ID>.json when it exists (mainnet 4663 ships one; VERIFY T3 / C4 before launch).
   */
  ORACLE_CHAIN_CONFIG: z.string().optional(),
  /**
   * JSON map ticker -> feed, merged over the chain config's feeds: either a full feed object
   * ({"proxy","basis":"per-token"|"per-share","token"?,"decimals"?,"heartbeatSec"?,"maxAgeSec"?}) or a plain
   * AggregatorV3 address (legacy: per-share, refused on mainnet). No equity feeds exist on devnet.
   */
  ORACLE_CHAINLINK_FEEDS: z.string().default("{}"),
  ORACLE_CHAINLINK_RPC_URL: z.string().optional(),
  /** In-session max age of a feed observation when the feed has neither maxAgeSec nor heartbeatSec. */
  ORACLE_CHAINLINK_MAX_AGE_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Added to a feed's heartbeat to form its in-session staleness bound. */
  ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS: z.coerce.number().int().nonnegative().default(600_000),
  /** Time the L2 sequencer must have been up before feeds are trusted (Chainlink's example: 3600 s). */
  ORACLE_SEQUENCER_GRACE_MS: z.coerce.number().int().nonnegative().default(3_600_000),
  ORACLE_HTTP_FINNHUB: flag(false),
  ORACLE_FINNHUB_API_KEY: z.string().optional(),
  /** JSON array of generic HTTP JSON sources (see sources/http.ts). */
  ORACLE_HTTP_SOURCES: z.string().default("[]"),

  // ---- Pyth Pro (sources/pyth.ts): optional confirm source on mainnet (VERIFY C6), a vote under the median policy ----
  ORACLE_PYTH: flag(false),
  /** Pyth Pro access token (Authorization: Bearer). Secret: never logged; reaches the oracle process only. */
  PYTH_API_KEY: z.string().optional(),
  /** Pyth Pro Router latest-price endpoint (POST, JSON body = the WebSocket subscription params). */
  ORACLE_PYTH_URL: z.url().default("https://pyth-lazer.dourolabs.app/v1/latest_price"),
  /** Channel of the requested update; must be at or above each feed's min_channel (US equities: fixed_rate@50ms). */
  ORACLE_PYTH_CHANNEL: z.enum(["real_time", "fixed_rate@50ms", "fixed_rate@200ms", "fixed_rate@1000ms"]).default("fixed_rate@200ms"),
  /** JSON map ticker -> Pyth Pro feed id (pyth_lazer_id), merged over DEFAULT_PYTH_FEEDS. */
  ORACLE_PYTH_FEEDS: z.string().optional(),
  /** In-session max age of a Pyth observation (its own feedUpdateTimestamp, never the receive time). */
  ORACLE_PYTH_MAX_AGE_MS: z.coerce.number().int().positive().default(10_000),
  /** Drop a regular-session Pyth print with fewer publishers (Pyth's own regular-session min_pub is 3). */
  ORACLE_PYTH_MIN_PUBLISHERS: z.coerce.number().int().nonnegative().default(3),
  /** Same for pre / post / overnight prints (Pyth's own min_pub there is 2). */
  ORACLE_PYTH_MIN_PUBLISHERS_EXTENDED: z.coerce.number().int().nonnegative().default(2),
  /** Drop a Pyth print whose confidence interval is wider than this (bps of the price). */
  ORACLE_PYTH_MAX_CONF_BPS: z.coerce.number().positive().default(50),
  /**
   * Oldest Chainlink observation that may back a price when only two sources are accepted (0 = no limit). The
   * Robinhood equity feeds round on a 0.5% deviation or a 24 h heartbeat, so an in-session round can legitimately be
   * hours old in a calm market; with only one other source that round is the whole cross-check, so it is capped at
   * an hour (beyond: no price rather than a price anchored on a possibly held round).
   */
  ORACLE_CHAINLINK_PAIR_MAX_AGE_MS: z.coerce.number().int().nonnegative().default(3_600_000),

  // ---- DEX TWAP confirm source (sources/dex-twap.ts; pools: chain config dexConfirm.pools) ----
  /** Uniswap v3 TWAP confirm source, active when the chain config lists dexConfirm pools (mainnet: required). */
  ORACLE_DEX_CONFIRM: flag(true),
  /** Overrides every pool's twapSec (s). */
  ORACLE_DEX_TWAP_SEC: z.coerce.number().int().min(60).max(86_400).optional(),
  /** A TWAP observation whose block is older than this (RPC / chain stalled) is ignored. */
  ORACLE_DEX_MAX_AGE_MS: z.coerce.number().int().positive().default(60_000),
  /** RPC of the DEX reads (default ORACLE_CHAINLINK_RPC_URL, else RPC_URL). */
  ORACLE_DEX_RPC_URL: z.string().optional(),
};

/**
 * Pyth Pro feed ids (pyth_lazer_id) of the US-equity feeds `Equity.US.<TICKER>/USD` (USD per share, exponent -5,
 * 24/5 incl. pre / post / overnight sessions). Read from Pyth's symbols endpoint
 * (https://pyth.dourolabs.app/v1/symbols, 2026-10-17); `source-check` compares them with Chainlink per share.
 */
export const DEFAULT_PYTH_FEEDS: Readonly<Record<string, number>> = { NVDA: 1314, TSLA: 1435, AAPL: 922, MSFT: 1292, AMZN: 954 };

/** Names of built-in sources: an HTTP source must not reuse them (one name = one vote in the median). */
export const RESERVED_SOURCE_NAMES = ["chainlink", "pyth", "dex-twap"] as const;

export const httpSourceSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .refine((n) => !(RESERVED_SOURCE_NAMES as readonly string[]).includes(n.toLowerCase()) && !n.toLowerCase().startsWith("synthetic"), {
      message: "reserved source name (chainlink, pyth, dex-twap, synthetic*)",
    }),
  /** URL template; `{ticker}` is replaced with the (mapped) symbol. */
  url: z.string().min(1),
  /** Dot path to the price in the JSON body, e.g. "data.price" or "c". */
  pricePath: z.string().min(1),
  /** Dot path to the observation time; omitted = receive time. */
  tsPath: z.string().optional(),
  tsUnit: z.enum(["s", "ms"]).default("s"),
  headers: z.record(z.string(), z.string()).default({}),
  /** ticker -> provider symbol. */
  symbols: z.record(z.string(), z.string()).default({}),
  maxAgeMs: z.number().int().positive().optional(),
});
export type HttpSourceSpec = z.infer<typeof httpSourceSpecSchema>;

const numberMap = z.record(z.string(), z.number().positive());
const pythFeedMap = z.record(z.string(), z.number().int().nonnegative());
const indexMap = z.record(z.string(), z.record(z.string(), z.number().int().positive()));

function parseJson<T>(name: string, raw: string | undefined, schema: z.ZodType<T>, fallback: T): T {
  if (raw === undefined || raw.trim() === "") return fallback;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid environment: ${name} is not valid JSON (${(err as Error).message})`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid environment: ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return parsed.data;
}

const oracleEnvSchema = baseEnvSchema.extend(oracleEnvShape);
export type OracleEnv = z.infer<typeof oracleEnvSchema>;

/**
 * Same contract as shared loadEnv(extra) (base env + extension, identical error format); parsed
 * locally because loadEnv's declared return type does not carry the extension fields.
 */
export function parseOracleEnv(source: Record<string, string | undefined> = process.env): OracleEnv {
  const parsed = oracleEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function loadOracleConfig(source: Record<string, string | undefined> = process.env) {
  const env = parseOracleEnv(source);
  const tickers = env.ORACLE_TICKERS.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const chainConfig = loadChainPriceConfig(env.CHAIN_ID, env.ORACLE_CHAIN_CONFIG);
  const envFeeds = parseJson("ORACLE_CHAINLINK_FEEDS", env.ORACLE_CHAINLINK_FEEDS, envFeedsSchema, {});
  const { feeds: chainlinkFeeds, legacy: legacyChainlinkFeeds } = resolveFeeds(chainConfig, envFeeds, {
    defaultMaxAgeMs: env.ORACLE_CHAINLINK_MAX_AGE_MS,
    heartbeatGraceMs: env.ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS,
  });
  const policy: OraclePolicy = env.ORACLE_POLICY ?? (isMainnet(env.CHAIN_ID) ? "primary-confirm" : "median");
  return {
    ...env,
    ORACLE_POLICY: policy,
    ORACLE_MIN_SOURCES: env.ORACLE_MIN_SOURCES ?? (policy === "primary-confirm" ? 1 : 3),
    tickers,
    demoPrices: { ...DEFAULT_DEMO_PRICES, ...parseJson("ORACLE_DEMO_PRICES", env.ORACLE_DEMO_PRICES, numberMap, {}) },
    vols: { ...DEFAULT_VOLS, ...parseJson("ORACLE_VOLS", env.ORACLE_VOLS, numberMap, {}) },
    indexes: parseJson("ORACLE_INDEXES", env.ORACLE_INDEXES, indexMap, DEFAULT_INDEXES),
    chainConfig,
    chainlinkFeeds,
    /** feed ids given as a plain address in ORACLE_CHAINLINK_FEEDS (basis assumed per-share) */
    legacyChainlinkFeeds,
    sequencerUptimeFeed: chainConfig?.chainlink.sequencerUptimeFeed ? getAddress(chainConfig.chainlink.sequencerUptimeFeed) : null,
    httpSources: parseJson("ORACLE_HTTP_SOURCES", env.ORACLE_HTTP_SOURCES, z.array(httpSourceSpecSchema), []),
    pythQuality: {
      minPublishers: env.ORACLE_PYTH_MIN_PUBLISHERS,
      minPublishersExtended: env.ORACLE_PYTH_MIN_PUBLISHERS_EXTENDED,
      maxConfidenceBps: env.ORACLE_PYTH_MAX_CONF_BPS,
    },
    pythFeeds: { ...DEFAULT_PYTH_FEEDS, ...parseJson("ORACLE_PYTH_FEEDS", env.ORACLE_PYTH_FEEDS, pythFeedMap, {}) },
    /** ticker -> confirm pool (chain config dexConfirm.pools); empty when ORACLE_DEX_CONFIRM=0 or none configured */
    dexPools: env.ORACLE_DEX_CONFIRM ? resolveDexPools(chainConfig, env.ORACLE_DEX_TWAP_SEC) : {},
  };
}

/** The chain config's DEX confirm pools with their Stock Token (stockTokens[ticker]) and window resolved. */
export function resolveDexPools(chainConfig: ChainPriceConfig | null, twapSecOverride?: number): Record<string, ResolvedDexPool> {
  const out: Record<string, ResolvedDexPool> = {};
  for (const [id, p] of Object.entries(chainConfig?.dexConfirm?.pools ?? {})) {
    const st = chainConfig?.stockTokens[id];
    if (!st) throw new Error(`invalid chain config: dexConfirm.pools.${id} has no stockTokens entry`);
    const r: ResolvedDexPool = {
      pool: getAddress(p.pool),
      token: getAddress(st.token),
      tokenDecimals: st.decimals,
      quoteToken: getAddress(p.quoteToken),
      twapSec: twapSecOverride ?? p.twapSec,
      minDepthUsd: p.minDepthUsd,
      fee: p.fee,
    };
    out[id] = r;
  }
  return out;
}

export type OracleConfig = ReturnType<typeof loadOracleConfig>;

const envFeedsSchema = z.record(
  z.string(),
  z.union([z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an address or a feed object"), feedConfigSchema]),
);

/**
 * Chain-config feeds overlaid with ORACLE_CHAINLINK_FEEDS, resolved to {proxy, basis, token, maxAgeMs}.
 * In-session max age: maxAgeSec, else heartbeatSec + grace, else ORACLE_CHAINLINK_MAX_AGE_MS. A per-token
 * feed must resolve its Stock Token (explicit `token`, else the chain config's stockTokens entry).
 */
export function resolveFeeds(
  chainConfig: ChainPriceConfig | null,
  envFeeds: Record<string, string | FeedConfig>,
  o: { defaultMaxAgeMs: number; heartbeatGraceMs: number },
): { feeds: Record<string, ResolvedFeed>; legacy: string[] } {
  const merged: Record<string, FeedConfig> = { ...(chainConfig?.chainlink.feeds ?? {}) };
  const legacy: string[] = [];
  for (const [id, f] of Object.entries(envFeeds)) {
    if (typeof f === "string") {
      merged[id] = { proxy: f, basis: "per-share" };
      legacy.push(id);
    } else merged[id] = f;
  }
  const stock = { stockTokens: chainConfig?.stockTokens ?? {} };
  const feeds: Record<string, ResolvedFeed> = {};
  for (const [id, f] of Object.entries(merged)) {
    const token = feedToken(stock, id, f);
    if (f.basis === "per-token" && !token) {
      throw new Error(`invalid environment: chainlink feed ${id}: a per-token feed needs its Stock Token (token, or stockTokens.${id} in the chain config)`);
    }
    const maxAgeMs =
      f.maxAgeSec !== undefined ? f.maxAgeSec * 1000 : f.heartbeatSec !== undefined ? f.heartbeatSec * 1000 + o.heartbeatGraceMs : o.defaultMaxAgeMs;
    const r: ResolvedFeed = { proxy: getAddress(f.proxy), basis: f.basis, token: f.basis === "per-token" ? token : null, maxAgeMs };
    if (f.heartbeatSec !== undefined) r.heartbeatSec = f.heartbeatSec;
    if (f.decimals !== undefined) r.decimals = f.decimals;
    if (f.description !== undefined) r.description = f.description;
    feeds[id] = r;
  }
  return { feeds, legacy };
}
