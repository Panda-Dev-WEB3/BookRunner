// Source assembly from config: synthetic GBM (devnet; testnet with a secret seed; never on mainnet),
// HTTP sources, Pyth Pro (ORACLE_PYTH + PYTH_API_KEY), Chainlink feeds (config/chains/<chainId>.json +
// ORACLE_CHAINLINK_FEEDS) and the Uniswap v3 TWAP confirm source (chain config dexConfirm.pools, ORACLE_DEX_CONFIRM).
import { type Logger, chainFor, isMainnet, multicall3For, uniswapV3For } from "@bookrunner/shared";
import { createPublicClient, http, type PublicClient } from "viem";
import { type OracleConfig, syntheticSeedProblem } from "../config";
import type { HeadClock } from "../head";
import { csprngNormal } from "../domain/rng";
import type { PriceSource } from "../domain/types";
import { ChainlinkSource, viemAggregatorReader } from "./chainlink";
import { DexTwapSource, viemDexReader } from "./dex-twap";
import { GenericHttpSource, finnhubSpec } from "./http";
import { PythProSource } from "./pyth";
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

/** `head`: the process's head clock, fed with the block timestamp of every batched Chainlink / DEX pass. */
export function buildSources(cfg: OracleConfig, log: Logger, now: () => number = Date.now, head: HeadClock | null = null): BuiltSources {
  const sources: PriceSource[] = [];
  let market: SyntheticMarket | null = null;
  let syntheticRefused: string | null = null;

  if (cfg.ORACLE_SYNTHETIC) {
    const seedProblem = syntheticSeedProblem(cfg.CHAIN_ID, cfg.ORACLE_SEED);
    if (isMainnet(cfg.CHAIN_ID)) {
      // never even construct them: the service refuses to start (index.ts) rather than run without them
      syntheticRefused = "synthetic sources are impossible on Robinhood Chain mainnet (4663): set ORACLE_SYNTHETIC=0";
      log.error({ chainId: cfg.CHAIN_ID }, syntheticRefused);
    } else if (cfg.CHAIN_ID !== 31337 && cfg.CHAIN_ID !== 46630) {
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

  if (cfg.ORACLE_PYTH) {
    if (cfg.PYTH_API_KEY) {
      sources.push(
        new PythProSource({
          url: cfg.ORACLE_PYTH_URL,
          apiKey: cfg.PYTH_API_KEY,
          feeds: cfg.pythFeeds,
          channel: cfg.ORACLE_PYTH_CHANNEL,
          maxAgeMs: cfg.ORACLE_PYTH_MAX_AGE_MS,
          timeoutMs: cfg.ORACLE_SOURCE_TIMEOUT_MS,
          quality: cfg.pythQuality,
        }),
      );
      // never the access token
      log.info({ url: cfg.ORACLE_PYTH_URL, channel: cfg.ORACLE_PYTH_CHANNEL, feeds: cfg.pythFeeds, maxAgeMs: cfg.ORACLE_PYTH_MAX_AGE_MS, quality: cfg.pythQuality }, "Pyth Pro source enabled");
    } else log.warn("ORACLE_PYTH=1 but PYTH_API_KEY is not set; Pyth Pro source skipped");
  }

  // RPC budget: on a chain with Multicall3 (mainnet) every pass of a source is ONE aggregate3 eth_call (the readers
  // call multicall explicitly; no batch.multicall here, which would re-split it); elsewhere the per-call reads of a
  // tick still share one JSON-RPC batch request
  const multicall = multicall3For(cfg.CHAIN_ID);
  const clients = new Map<string, PublicClient>();
  const client = (url: string): PublicClient => {
    let c = clients.get(url);
    if (!c) {
      c = createPublicClient({ ...(multicall ? { chain: chainFor(cfg.CHAIN_ID, url) } : {}), transport: http(url, { batch: true }) }) as PublicClient;
      clients.set(url, c);
    }
    return c;
  };
  const onBlockTimestamp = head ? (ts: number) => head.observe(ts) : undefined;
  const feeds = cfg.chainlinkFeeds;
  if (Object.keys(feeds).length > 0) {
    const pub = client(cfg.ORACLE_CHAINLINK_RPC_URL ?? cfg.RPC_URL);
    sources.push(
      new ChainlinkSource(feeds, viemAggregatorReader(pub, multicall), {
        sequencerFeed: cfg.sequencerUptimeFeed,
        sequencerGraceMs: cfg.ORACLE_SEQUENCER_GRACE_MS,
        readIntervalMs: cfg.cadence.chainlinkReadMs,
        tokenStateIntervalMs: cfg.cadence.tokenStateReadMs,
        ...(onBlockTimestamp ? { onBlockTimestamp } : {}),
      }),
    );
    log.info(
      {
        feeds: Object.fromEntries(Object.entries(feeds).map(([t, f]) => [t, { proxy: f.proxy, basis: f.basis, token: f.token, maxAgeMs: f.maxAgeMs }])),
        multicall: multicall ?? null,
        readIntervalMs: cfg.cadence.chainlinkReadMs,
        tokenStateIntervalMs: cfg.cadence.tokenStateReadMs,
      },
      "Chainlink source enabled (per-token feeds divided by uiMultiplier; run source-check before mainnet)",
    );
  }

  // confirm source only: under the median policy a pool price would become a vote, so it is not built there
  const pools = cfg.ORACLE_POLICY === "primary-confirm" ? cfg.dexPools : {};
  if (Object.keys(cfg.dexPools).length > 0 && cfg.ORACLE_POLICY !== "primary-confirm") {
    log.warn("dexConfirm pools configured but ORACLE_POLICY=median: the DEX TWAP is a confirm source only and is not used");
  }
  if (Object.keys(pools).length > 0) {
    const pub = client(cfg.ORACLE_DEX_RPC_URL ?? cfg.ORACLE_CHAINLINK_RPC_URL ?? cfg.RPC_URL);
    sources.push(
      new DexTwapSource(pools, viemDexReader(pub, multicall), {
        maxAgeMs: cfg.ORACLE_DEX_MAX_AGE_MS,
        factory: uniswapV3For(cfg.CHAIN_ID)?.factory ?? null,
        readIntervalMs: cfg.cadence.dexReadMs,
        ...(onBlockTimestamp ? { onBlockTimestamp } : {}),
      }),
    );
    log.info(
      {
        pools: Object.fromEntries(Object.entries(pools).map(([t, p]) => [t, { pool: p.pool, fee: p.fee, twapSec: p.twapSec, minDepthUsd: p.minDepthUsd }])),
        readIntervalMs: cfg.cadence.dexReadMs,
        maxAgeMs: cfg.ORACLE_DEX_MAX_AGE_MS,
      },
      "DEX TWAP confirm source enabled (Uniswap v3; quote token assumed = $1: a USDG depeg shows up as confirm divergence)",
    );
  }

  if (sources.length === 0) log.error("no price sources configured; nothing will be published");
  else log.info({ sources: sources.map((s) => s.name) }, "price sources");
  return { sources, market, syntheticRefused };
}
