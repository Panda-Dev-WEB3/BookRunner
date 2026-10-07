// trader-sim: simulated taker flow for the launch books.
//   in-house books: trader0..traderN (devkeys) mint devnet USDC, depositMargin, trade with an
//                   acceptable price, close occasionally; reduce-only rejections switch the trader to
//                   closes for a while; while the engine's price is held (off-hours) or stale no trade is
//                   sent at all (PoolEngine fills none then, closes included) and an OffHours / StalePrice
//                   rejection pauses the trader; exposure-cap rejections are expected and skipped.
//                   Leverage stays below what survives a session close (off-hours maintenance = 2x
//                   initial margin), and the liquidation sweep applies that requirement while held. Pull
//                   oracle (docs/LOW_GAS.md §1): every trade carries the freshest signed price of its market
//                   (PoolEngine.trade(..., priceData) — the trader pays the oracle update), quoted off-chain
//                   from it; sim positions close to maintenance are liquidated the same way
//                   (liquidate(..., priceData)). A legacy engine / no signed price: the stored-price path.
//   Orderly books:  POST /mock/taker against mock-orderly, sized from the freshest attested price.
// Intensity: TRADER_SIM_TRADES_PER_MIN per book (Poisson arrivals, seeded by TRADER_SIM_SEED); default
// 6 on the local devnet, 1 elsewhere (demo traffic, traders pay their own gas).

import {
  type Deployment,
  type Logger,
  VENUE,
  bytes32ToStr,
  createLogger,
  deploymentPath,
  publicClientFor,
  roleAccount,
  tryLoadDeployment,
  usd,
  walletClientFor,
  type DevRole,
} from "@bookrunner/shared";
import { bookrunnerConfigAbi, poolEngineAdapterAbi } from "@bookrunner/shared/abi";
import { Redis } from "ioredis";
import type { Hex, PublicClient } from "viem";
import { BookChain, type OraclePoint } from "./chain/book-chain";
import {
  DEFAULT_MAX_TRADE_PRICE_AGE_SEC,
  LIQUIDATE_WITH_PRICES_SIG,
  TRADE_WITH_PRICES_SIG,
  supportsFunction,
} from "./chain/lowgas-abi";
import { PullPrices, type SignedUpdate, httpBundleSource, pointOf, redisBundleSource, resolvePullMode, toPriceData } from "./chain/pull-prices";
import { type SimEnv, loadSimEnv } from "./config";
import { type Rng, mulberry32, pick, seedFrom } from "./domain/rng";
import { EngineTrader } from "./sim/engine-trader";
import { MockOrderlyTaker } from "./sim/orderly-taker";
import {
  CLOSE_ONLY_CLASSES,
  PAUSE_CLASSES,
  type SimParams,
  acceptablePriceWad,
  classifyTradeError,
  engineFillPriceWad,
  engineGate,
  holdableLeverage,
  liquidationMarginBps,
  nearLiquidation,
  nextAction,
  nextDelayMs,
  sizeDeltaFor,
} from "./sim/trader-logic";
import { backoffMs, errMsg, revertName, sleep } from "./util";

type BookEntry = Deployment["books"][number];

const TRADER_ROLES: readonly DevRole[] = ["trader0", "trader1", "trader2", "trader3"];
const UNIT = 10n ** 18n;

function simParams(env: SimEnv): SimParams {
  return {
    minNotionalUsd: env.TRADER_SIM_MIN_NOTIONAL_USD,
    maxNotionalUsd: env.TRADER_SIM_MAX_NOTIONAL_USD,
    closeProb: env.TRADER_SIM_CLOSE_PROB,
    maxLeverage: env.TRADER_SIM_MAX_LEVERAGE,
    slippageBps: env.TRADER_SIM_SLIPPAGE_BPS,
  };
}

interface SimPrices {
  /** signed prices (Redis bundle / oracle HTTP); null = never carry (legacy engine, TRADER_SIM_PULL_PRICES=off) */
  pull: PullPrices | null;
  /** AttestedOracle staleness bound for the stored price (config.maxPriceAge) */
  maxPriceAgeSec: number;
  /** a carried price must be at most this old at the block (config.maxTradePriceAge) */
  maxTradePriceAgeSec: number;
}

/** Freshest signed update of one market within the trade-age bound, or null. */
async function freshSigned(prices: SimPrices, priceIdHex: Hex): Promise<SignedUpdate | null> {
  if (!prices.pull) return null;
  // keep a little headroom: the tx is mined a block or two after the selection
  const bound = Math.max(1, prices.maxTradePriceAgeSec - 3);
  const [s] = await prices.pull.select([priceIdHex], bound).catch(() => []);
  return s ?? null;
}

async function liquidationSweep(
  book: BookEntry,
  marketId: bigint,
  liquidator: EngineTrader,
  traders: EngineTrader[],
  px: OraclePoint,
  pool: { initialMarginBps: number; maintenanceMarginBps: number },
  priceData: Hex | null,
  log: Logger,
): Promise<void> {
  // while held the engine liquidates below the off-hours requirement (2x initial margin), else maintenance
  const requirementBps = liquidationMarginBps(pool, px.held);
  for (const t of traders) {
    if (t === liquidator) continue;
    const pos = await t.position(marketId).catch(() => null);
    if (!pos || !nearLiquidation(pos, px.priceWad, requirementBps)) continue;
    const hash = await liquidator.liquidate(marketId, t.address, priceData).catch((err: unknown) => {
      log.debug({ book: book.name, trader: t.name, err: errMsg(err) }, "sim: liquidation send failed");
      return null;
    });
    if (hash) log.info({ book: book.name, liquidator: liquidator.name, trader: t.name, withPrices: !!priceData && liquidator.pullLiquidate, txHash: hash }, "sim: engine liquidation");
  }
}

async function engineLoop(
  book: BookEntry,
  dep: Deployment,
  pub: PublicClient,
  traders: EngineTrader[],
  prices: SimPrices,
  env: SimEnv,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const rng: Rng = mulberry32(env.TRADER_SIM_SEED ^ seedFrom(`engine:${book.bookId}`));
  const chain = new BookChain(pub, dep, book.components);
  const params = simParams(env);
  const closeOnlyUntil = new Map<string, number>();
  const pausedUntil = new Map<string, number>();
  let marketId: bigint | null = null;
  let priceIdHex: Hex | null = null;
  let failures = 0;
  let lastState = "";
  while (!signal.aborted) {
    await sleep(Math.max(nextDelayMs(rng, env.TRADER_SIM_TRADES_PER_MIN), backoffMs(failures)), signal);
    if (signal.aborted) break;
    let trader: EngineTrader | null = null;
    let carried = false;
    try {
      const state = await chain.bookState();
      if (state !== lastState) log.info({ book: book.name, state }, "sim: book state");
      lastState = state;
      if (state !== "Live" && state !== "Retiring") continue;
      if (marketId === null) marketId = await pub.readContract({ address: book.components.adapter, abi: poolEngineAdapterAbi, functionName: "marketId" });
      if (priceIdHex === null) priceIdHex = await chain.priceIdOf((await chain.readCharter()).underlying);
      trader = pick(rng, traders);
      await trader.ensureMargin(marketId, usd(env.TRADER_SIM_MARGIN_USD), usd(env.TRADER_SIM_MINT_USD));

      // the price this trade will use: the freshest signed one it carries, else the stored one
      const signed = trader.pullTrade ? await freshSigned(prices, priceIdHex) : null;
      const [pos, pool, stored] = await Promise.all([
        trader.position(marketId),
        trader.poolView(marketId),
        signed ? Promise.resolve(null) : chain.oracleLatest(priceIdHex),
      ]);
      const px: OraclePoint = signed ? pointOf(signed.update) : (stored as OraclePoint);
      const priceData = signed ? toPriceData([signed]) : null;
      // without a carried price the stored one must be recent: maxTradePriceAge on a pull engine
      const staleAfter = trader.pullTrade ? prices.maxTradePriceAgeSec : prices.maxPriceAgeSec;
      const offChainQuote = !!signed;
      const quoteAt = async (size: bigint) => (offChainQuote ? engineFillPriceWad(px.priceWad, pool.spreadBps, pool.skewBps, size) : trader!.quotePrice(marketId!, size));

      await liquidationSweep(book, marketId, trader, traders, px, pool, priceData, log);

      const unitPx = Number(await quoteAt(UNIT)) / 1e18;
      const gate = engineGate({
        reduceOnly: pool.reduceOnly,
        oracleHeld: px.held,
        oracleStale: !signed && Date.now() / 1000 - px.publishedAt > staleAfter,
        poolExposureUsd: Number(pool.poolExposureUsd) / 1e6,
        maxNetExposureUsd: Number(pool.maxNetExposureUsd) / 1e6,
      });
      const action = nextAction(
        rng,
        {
          positionUsd: (Number(pos.size) / 1e18) * unitPx,
          marginUsd: Number(pos.marginUsd) / 1e6,
          closeOnly: gate.closeOnly || state === "Retiring" || (closeOnlyUntil.get(trader.name) ?? 0) > Date.now(),
          ...(gate.frozen || (pausedUntil.get(trader.name) ?? 0) > Date.now() ? { frozen: true } : {}),
          ...(gate.forceSide ? { forceSide: gate.forceSide } : {}),
        },
        { ...params, maxLeverage: holdableLeverage(params.maxLeverage, pool.initialMarginBps) },
      );
      if (action.kind === "none") continue;
      const sizeDelta = action.kind === "close" ? -pos.size : sizeDeltaFor(action.notionalUsd, unitPx, action.side);
      if (sizeDelta === 0n) continue;
      const quote = await quoteAt(sizeDelta);
      carried = !!priceData;
      const txHash = await trader.trade(marketId, sizeDelta, acceptablePriceWad(quote, sizeDelta, params.slippageBps), priceData);
      failures = 0;
      log.info(
        {
          book: book.name,
          trader: trader.name,
          action: action.kind,
          units: Number(sizeDelta) / 1e18,
          quotePx: Number(quote) / 1e18,
          withPrices: !!priceData,
          priceAgeSec: Math.round(Date.now() / 1000 - px.publishedAt),
          txHash,
        },
        "sim: engine trade",
      );
    } catch (err) {
      const cls = classifyTradeError(revertName(err), errMsg(err), { carriedPrice: carried });
      if (trader && PAUSE_CLASSES.includes(cls)) {
        pausedUntil.set(trader.name, Date.now() + 60_000);
        log.info({ book: book.name, trader: trader.name, cls }, "sim: engine price not live (held / stale); trader pauses for 60s");
      } else if (trader && CLOSE_ONLY_CLASSES.includes(cls)) {
        closeOnlyUntil.set(trader.name, Date.now() + 60_000);
        log.info({ book: book.name, trader: trader.name, cls }, "sim: venue rejects new risk; trader closes only for 60s");
      } else if (cls === "exposure_cap" || cls === "price" || cls === "stale_price") {
        log.debug({ book: book.name, cls, err: errMsg(err) }, "sim: trade rejected by the pool's quote / price limits");
      } else {
        failures++;
        log.warn({ book: book.name, cls, failures, err: errMsg(err) }, "sim: engine trade failed");
      }
    }
  }
}

async function orderlyLoop(
  book: BookEntry,
  dep: Deployment,
  pub: PublicClient,
  taker: MockOrderlyTaker,
  prices: SimPrices,
  env: SimEnv,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const rng: Rng = mulberry32(env.TRADER_SIM_SEED ^ seedFrom(`orderly:${book.bookId}`));
  const chain = new BookChain(pub, dep, book.components);
  const params = simParams(env);
  let priceIdHex: Hex | null = null;
  let symbol = book.symbol;
  let failures = 0;
  while (!signal.aborted) {
    await sleep(Math.max(nextDelayMs(rng, env.TRADER_SIM_TRADES_PER_MIN), backoffMs(failures)), signal);
    if (signal.aborted) break;
    try {
      if ((await chain.bookState()) !== "Live") continue;
      if (!priceIdHex) {
        const charter = await chain.readCharter();
        priceIdHex = await chain.priceIdOf(charter.underlying);
        symbol = bytes32ToStr(charter.symbol) || book.symbol;
      }
      // pull mode: the stored on-chain price is whatever the last consumer tx carried; size from the
      // freshest signed print when there is one
      const signed = prices.pull ? await prices.pull.point(priceIdHex, prices.maxPriceAgeSec).catch(() => null) : null;
      const p = signed ?? (await chain.oracleLatest(priceIdHex));
      const px = Number(p.priceWad) / 1e18;
      if (!(px > 0) || p.held) continue; // off-hours: no new taker risk
      const action = nextAction(rng, { positionUsd: 0, marginUsd: Number.MAX_SAFE_INTEGER, closeOnly: false }, params);
      if (action.kind !== "open") continue;
      const qty = Math.max(0.0001, Math.round((action.notionalUsd / px) * 1e4) / 1e4);
      const side = action.side === "buy" ? "BUY" : "SELL";
      const res = await taker.take(symbol, side, qty);
      failures = 0;
      log.info({ book: book.name, symbol, side, qty, px, signedPrice: !!signed, res }, "sim: mock-orderly taker");
    } catch (err) {
      failures++;
      log.warn({ book: book.name, failures, err: errMsg(err) }, "sim: orderly taker failed");
    }
  }
}

/** Redis JSON getter that fails fast while Redis is down (the sim then quotes from the chain). */
function redisJson(redis: Redis): (key: string) => Promise<unknown> {
  return async (key) => {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  };
}

async function runSim(dep: Deployment, env: SimEnv, log: Logger, signal: AbortSignal): Promise<void> {
  const pub = publicClientFor(env.CHAIN_ID, env.RPC_URL);
  const wanted = env.TRADER_SIM_BOOKS ? new Set(env.TRADER_SIM_BOOKS.split(",").map((s) => Number(s.trim()))) : null;
  const books = dep.books.filter((b) => !wanted || wanted.has(b.bookId));
  const roles = TRADER_ROLES.slice(0, Math.max(1, Math.min(TRADER_ROLES.length, Math.floor(env.TRADER_SIM_TRADERS))));

  const engine = dep.contracts.poolEngine;
  const [pullTrade, pullLiquidate] = await Promise.all([
    resolvePullMode(env.TRADER_SIM_PULL_PRICES, () => supportsFunction(pub, engine, TRADE_WITH_PRICES_SIG)),
    resolvePullMode(env.TRADER_SIM_PULL_PRICES, () => supportsFunction(pub, engine, LIQUIDATE_WITH_PRICES_SIG)),
  ]);
  const usePull = env.TRADER_SIM_PULL_PRICES !== "off";
  const redis = usePull ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: (n) => Math.min(30_000, 500 * 2 ** Math.min(n, 6)) }) : null;
  redis?.on("error", () => undefined); // reads fail fast; the sim falls back to the stored price
  const chainCfg = dep.contracts.config;
  const prices: SimPrices = {
    pull: usePull
      ? new PullPrices({
          sources: [...(redis ? [redisBundleSource(redisJson(redis))] : []), ...(env.ORACLE_URL ? [httpBundleSource(env.ORACLE_URL)] : [])],
          domain: { chainId: env.CHAIN_ID, oracle: dep.contracts.oracle },
          log,
        })
      : null,
    maxPriceAgeSec: await pub
      .readContract({ address: chainCfg, abi: bookrunnerConfigAbi, functionName: "maxPriceAge" })
      .then((v) => Number(v))
      .catch(() => 300),
    maxTradePriceAgeSec: await pub
      .readContract({ address: chainCfg, abi: bookrunnerConfigAbi, functionName: "maxTradePriceAge" })
      .then((v) => Number(v))
      .catch(() => DEFAULT_MAX_TRADE_PRICE_AGE_SEC),
  };

  const traders = roles.map(
    (r) =>
      new EngineTrader(r, pub, walletClientFor(env.CHAIN_ID, env.RPC_URL, roleAccount(r)), engine, dep.contracts.usdc, log, env.TX_RECEIPT_TIMEOUT_MS, env.CHAIN_ID === 31337, {
        trade: pullTrade,
        liquidate: pullLiquidate,
      }),
  );
  const taker = new MockOrderlyTaker(env.ORDERLY_BASE_URL);
  const loops: Array<Promise<void>> = [];
  for (const b of books) {
    if (b.venue === VENUE.POOL_ENGINE && env.TRADER_SIM_ENGINE) loops.push(engineLoop(b, dep, pub, traders, prices, env, log, signal));
    if (b.venue === VENUE.ORDERLY && env.TRADER_SIM_ORDERLY) loops.push(orderlyLoop(b, dep, pub, taker, prices, env, log, signal));
  }
  log.info(
    {
      books: books.map((b) => b.name),
      traders: roles,
      tradesPerMin: env.TRADER_SIM_TRADES_PER_MIN,
      pullTrade,
      pullLiquidate,
      maxTradePriceAgeSec: prices.maxTradePriceAgeSec,
    },
    "trader-sim running",
  );
  if (loops.length === 0) log.warn("trader-sim: no books selected");
  try {
    await Promise.all(loops);
  } finally {
    redis?.disconnect();
  }
}

async function main(): Promise<void> {
  const env = loadSimEnv();
  const log = createLogger("trader-sim", env.LOG_LEVEL);
  const ctl = new AbortController();
  const stop = (sig: string) => {
    log.info({ sig }, "trader-sim stopping");
    ctl.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  while (!ctl.signal.aborted) {
    const dep = tryLoadDeployment(env.DEPLOYMENT_FILE);
    if (!dep) {
      log.warn({ file: deploymentPath(env.DEPLOYMENT_FILE), retryMs: env.DEPLOYMENT_RETRY_MS }, "deployment file missing; waiting");
      await sleep(env.DEPLOYMENT_RETRY_MS, ctl.signal);
      continue;
    }
    try {
      await runSim(dep, env, log, ctl.signal);
    } catch (err) {
      log.warn({ err: errMsg(err) }, "trader-sim setup failed; retrying");
    }
    await sleep(env.DEPLOYMENT_RETRY_MS, ctl.signal); // e.g. no books selected yet: re-read the deployment later
  }
  log.info("trader-sim stopped");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
