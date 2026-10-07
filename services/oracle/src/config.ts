// Oracle service configuration: shared base env (baseEnvSchema) + oracle-specific fields.
import { baseEnvSchema } from "@bookrunner/shared";
import { z } from "zod";

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
  /** Sources further than this from the median are rejected (bps). */
  ORACLE_OUTLIER_BPS: z.coerce.number().positive().default(150),
  /** Minimum accepted sources for a non-held price (raised to AttestedOracle.minSources() if higher). */
  ORACLE_MIN_SOURCES: z.coerce.number().int().positive().default(3),
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

  // ---- optional live sources (VERIFY, disabled by default) ----
  /** JSON map ticker -> AggregatorV3 address. VERIFY: no equity feeds on devnet. */
  ORACLE_CHAINLINK_FEEDS: z.string().default("{}"),
  ORACLE_CHAINLINK_RPC_URL: z.string().optional(),
  ORACLE_CHAINLINK_MAX_AGE_MS: z.coerce.number().int().positive().default(3_600_000),
  ORACLE_HTTP_FINNHUB: flag(false),
  ORACLE_FINNHUB_API_KEY: z.string().optional(),
  /** JSON array of generic HTTP JSON sources (see sources/http.ts). */
  ORACLE_HTTP_SOURCES: z.string().default("[]"),
};

export const httpSourceSpecSchema = z.object({
  name: z.string().min(1),
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
  return {
    ...env,
    tickers,
    demoPrices: { ...DEFAULT_DEMO_PRICES, ...parseJson("ORACLE_DEMO_PRICES", env.ORACLE_DEMO_PRICES, numberMap, {}) },
    vols: { ...DEFAULT_VOLS, ...parseJson("ORACLE_VOLS", env.ORACLE_VOLS, numberMap, {}) },
    indexes: parseJson("ORACLE_INDEXES", env.ORACLE_INDEXES, indexMap, DEFAULT_INDEXES),
    chainlinkFeeds: parseJson(
      "ORACLE_CHAINLINK_FEEDS",
      env.ORACLE_CHAINLINK_FEEDS,
      z.record(z.string(), z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
      {},
    ) as Record<string, `0x${string}`>,
    httpSources: parseJson("ORACLE_HTTP_SOURCES", env.ORACLE_HTTP_SOURCES, z.array(httpSourceSpecSchema), []),
  };
}

export type OracleConfig = ReturnType<typeof loadOracleConfig>;
