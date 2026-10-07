// Source assembly from config: synthetic GBM (devnet only), optional HTTP and AggregatorV3 sources.
import type { Logger } from "@bookrunner/shared";
import { createPublicClient, http, type PublicClient } from "viem";
import { type OracleConfig, syntheticSeedProblem } from "../config";
import { csprngNormal } from "../domain/rng";
import type { PriceSource } from "../domain/types";
import { ChainlinkSource, viemAggregatorReader } from "./chainlink";
import { GenericHttpSource, finnhubSpec } from "./http";
import { SyntheticMarket, syntheticSources } from "./synthetic";

export const DEFAULT_S0 = 100;
export const DEFAULT_VOL = 0.3;

export interface BuiltSources {
  sources: PriceSource[];
  market: SyntheticMarket | null;
  /** Why the configured synthetic sources were refused (public / weak ORACLE_SEED off devnet), else null. */
  syntheticRefused: string | null;
}

export function syntheticTicker(cfg: Pick<OracleConfig, "demoPrices" | "vols">, ticker: string) {
  return { s0: cfg.demoPrices[ticker] ?? DEFAULT_S0, vol: cfg.vols[ticker] ?? DEFAULT_VOL };
}

export function buildSources(cfg: OracleConfig, log: Logger, now: () => number = Date.now): BuiltSources {
  const sources: PriceSource[] = [];
  let market: SyntheticMarket | null = null;
  let syntheticRefused: string | null = null;

  if (cfg.ORACLE_SYNTHETIC) {
    const seedProblem = syntheticSeedProblem(cfg.CHAIN_ID, cfg.ORACLE_SEED);
    if (cfg.CHAIN_ID !== 31337 && cfg.CHAIN_ID !== 46630) {
      log.error({ chainId: cfg.CHAIN_ID }, "synthetic sources are devnet/testnet-only; disabled on this chain (set ORACLE_SYNTHETIC=0 to silence)");
    } else if (seedProblem) {
      // signed prices from a public seed are computable in advance by anyone: never sign them on a public chain
      syntheticRefused = `${seedProblem}: set a secret ORACLE_SEED (e.g. \`openssl rand -hex 32\`) for chain ${cfg.CHAIN_ID}`;
      log.error({ chainId: cfg.CHAIN_ID }, `synthetic sources refused: ${syntheticRefused}`);
    } else {
      const devnet = cfg.CHAIN_ID === 31337;
      if (!devnet) log.warn({ chainId: cfg.CHAIN_ID }, "TESTNET: prices are synthetic (secret-seeded GBM + CSPRNG noise), not market data — VERIFY real feeds before mainnet");
      const step = cfg.ORACLE_GBM_STEP_MS;
      const epochMs = cfg.ORACLE_GBM_EPOCH_MS ?? Math.floor(now() / step) * step;
      market = new SyntheticMarket({
        seed: cfg.ORACLE_SEED,
        stepMs: step,
        epochMs,
        tickers: Object.fromEntries(cfg.tickers.map((t) => [t, syntheticTicker(cfg, t)])),
        // devnet keeps reproducible paths; anywhere else the path must not be computable in advance
        ...(devnet ? {} : { entropy: csprngNormal }),
        volScale: cfg.ORACLE_VOL_SCALE,
        noiseBps: cfg.ORACLE_SYNTH_NOISE_BPS,
        dropoutProb: cfg.ORACLE_SYNTH_DROPOUT,
        spikeProb: cfg.ORACLE_SYNTH_SPIKE_PROB,
        spikeBps: cfg.ORACLE_SYNTH_SPIKE_BPS,
      });
      sources.push(...syntheticSources(market, now));
      // the seed itself is never logged off devnet (it keys the signed price path)
      log.info({ ...(devnet ? { seed: cfg.ORACLE_SEED } : {}), entropy: !devnet, epochMs, stepMs: step, volScale: cfg.ORACLE_VOL_SCALE }, "synthetic GBM sources enabled");
    }
  }

  if (cfg.ORACLE_HTTP_FINNHUB) {
    if (cfg.ORACLE_FINNHUB_API_KEY) sources.push(new GenericHttpSource(finnhubSpec(cfg.ORACLE_FINNHUB_API_KEY), cfg.ORACLE_SOURCE_TIMEOUT_MS));
    else log.warn("ORACLE_HTTP_FINNHUB=1 but ORACLE_FINNHUB_API_KEY is not set; source skipped");
  }
  for (const spec of cfg.httpSources) sources.push(new GenericHttpSource(spec, cfg.ORACLE_SOURCE_TIMEOUT_MS));

  const feeds = cfg.chainlinkFeeds;
  if (Object.keys(feeds).length > 0) {
    const pub = createPublicClient({ transport: http(cfg.ORACLE_CHAINLINK_RPC_URL ?? cfg.RPC_URL) }) as PublicClient;
    sources.push(new ChainlinkSource(feeds, viemAggregatorReader(pub), cfg.ORACLE_CHAINLINK_MAX_AGE_MS));
    log.info({ tickers: Object.keys(feeds) }, "AggregatorV3 source enabled (VERIFY feed addresses)");
  }

  if (sources.length === 0) log.error("no price sources configured; nothing will be published");
  else log.info({ sources: sources.map((s) => s.name) }, "price sources");
  return { sources, market, syntheticRefused };
}
