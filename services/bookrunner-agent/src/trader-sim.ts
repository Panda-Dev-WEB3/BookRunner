// trader-sim: simulated taker flow for the launch books.
//   in-house books: trader0..traderN (devkeys) mint devnet USDC, depositMargin, trade with an
//                   acceptable price, close occasionally; reduce-only / off-hours rejections switch the
//                   trader to closes for a while, exposure-cap rejections are expected and skipped.
//   Orderly books:  POST /mock/taker against mock-orderly, sized from the attested oracle price.
// Intensity: TRADER_SIM_TRADES_PER_MIN per book (Poisson arrivals, seeded by TRADER_SIM_SEED).

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
import { poolEngineAdapterAbi } from "@bookrunner/shared/abi";
import type { Hex, PublicClient } from "viem";
import { BookChain } from "./chain/book-chain";
import { type SimEnv, loadSimEnv } from "./config";
import { type Rng, mulberry32, pick, seedFrom } from "./domain/rng";
import { EngineTrader } from "./sim/engine-trader";
import { MockOrderlyTaker } from "./sim/orderly-taker";
import { CLOSE_ONLY_CLASSES, type SimParams, acceptablePriceWad, classifyTradeError, engineGate, nextAction, nextDelayMs, sizeDeltaFor } from "./sim/trader-logic";
import { backoffMs, errMsg, revertName, sleep } from "./util";

type BookEntry = Deployment["books"][number];

const TRADER_ROLES: readonly DevRole[] = ["trader0", "trader1", "trader2", "trader3"];

function simParams(env: SimEnv): SimParams {
  return {
    minNotionalUsd: env.TRADER_SIM_MIN_NOTIONAL_USD,
    maxNotionalUsd: env.TRADER_SIM_MAX_NOTIONAL_USD,
    closeProb: env.TRADER_SIM_CLOSE_PROB,
    maxLeverage: env.TRADER_SIM_MAX_LEVERAGE,
    slippageBps: env.TRADER_SIM_SLIPPAGE_BPS,
  };
}

async function engineLoop(book: BookEntry, dep: Deployment, pub: PublicClient, traders: EngineTrader[], env: SimEnv, log: Logger, signal: AbortSignal): Promise<void> {
  const rng: Rng = mulberry32(env.TRADER_SIM_SEED ^ seedFrom(`engine:${book.bookId}`));
  const chain = new BookChain(pub, dep, book.components);
  const params = simParams(env);
  const closeOnlyUntil = new Map<string, number>();
  let marketId: bigint | null = null;
  let priceIdHex: Hex | null = null;
  let maxPriceAge: number | null = null;
  let failures = 0;
  let lastState = "";
  while (!signal.aborted) {
    await sleep(Math.max(nextDelayMs(rng, env.TRADER_SIM_TRADES_PER_MIN), backoffMs(failures)), signal);
    if (signal.aborted) break;
    let trader: EngineTrader | null = null;
    try {
      const state = await chain.bookState();
      if (state !== lastState) log.info({ book: book.name, state }, "sim: book state");
      lastState = state;
      if (state !== "Live" && state !== "Retiring") continue;
      if (marketId === null) marketId = await pub.readContract({ address: book.components.adapter, abi: poolEngineAdapterAbi, functionName: "marketId" });
      if (priceIdHex === null) priceIdHex = await chain.priceIdOf((await chain.readCharter()).underlying);
      if (maxPriceAge === null) maxPriceAge = await chain.maxPriceAge().catch(() => 300);
      trader = pick(rng, traders);
      await trader.ensureMargin(marketId, usd(env.TRADER_SIM_MARGIN_USD), usd(env.TRADER_SIM_MINT_USD));
      const [pos, pool, px] = await Promise.all([trader.position(marketId), trader.poolView(marketId), chain.oracleLatest(priceIdHex)]);
      const unitPx = Number(await trader.quotePrice(marketId, 10n ** 18n)) / 1e18;
      const gate = engineGate({
        reduceOnly: pool.reduceOnly,
        oracleHeld: px.held,
        oracleStale: Date.now() / 1000 - px.publishedAt > maxPriceAge,
        poolExposureUsd: Number(pool.poolExposureUsd) / 1e6,
        maxNetExposureUsd: Number(pool.maxNetExposureUsd) / 1e6,
      });
      const action = nextAction(
        rng,
        {
          positionUsd: (Number(pos.size) / 1e18) * unitPx,
          marginUsd: Number(pos.marginUsd) / 1e6,
          closeOnly: gate.closeOnly || state === "Retiring" || (closeOnlyUntil.get(trader.name) ?? 0) > Date.now(),
          ...(gate.forceSide ? { forceSide: gate.forceSide } : {}),
        },
        params,
      );
      if (action.kind === "none") continue;
      const sizeDelta = action.kind === "close" ? -pos.size : sizeDeltaFor(action.notionalUsd, unitPx, action.side);
      if (sizeDelta === 0n) continue;
      const quote = await trader.quotePrice(marketId, sizeDelta);
      const txHash = await trader.trade(marketId, sizeDelta, acceptablePriceWad(quote, sizeDelta, params.slippageBps));
      failures = 0;
      log.info(
        { book: book.name, trader: trader.name, action: action.kind, units: Number(sizeDelta) / 1e18, quotePx: Number(quote) / 1e18, txHash },
        "sim: engine trade",
      );
    } catch (err) {
      const cls = classifyTradeError(revertName(err), errMsg(err));
      if (trader && CLOSE_ONLY_CLASSES.includes(cls)) {
        closeOnlyUntil.set(trader.name, Date.now() + 60_000);
        log.info({ book: book.name, trader: trader.name, cls }, "sim: venue rejects new risk; trader closes only for 60s");
      } else if (cls === "exposure_cap" || cls === "price") {
        log.debug({ book: book.name, cls, err: errMsg(err) }, "sim: trade rejected by the pool's quote limits");
      } else {
        failures++;
        log.warn({ book: book.name, cls, failures, err: errMsg(err) }, "sim: engine trade failed");
      }
    }
  }
}

async function orderlyLoop(book: BookEntry, dep: Deployment, pub: PublicClient, taker: MockOrderlyTaker, env: SimEnv, log: Logger, signal: AbortSignal): Promise<void> {
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
      const p = await chain.oracleLatest(priceIdHex);
      const px = Number(p.priceWad) / 1e18;
      if (!(px > 0) || p.held) continue; // off-hours: no new taker risk
      const action = nextAction(rng, { positionUsd: 0, marginUsd: Number.MAX_SAFE_INTEGER, closeOnly: false }, params);
      if (action.kind !== "open") continue;
      const qty = Math.max(0.0001, Math.round((action.notionalUsd / px) * 1e4) / 1e4);
      const side = action.side === "buy" ? "BUY" : "SELL";
      const res = await taker.take(symbol, side, qty);
      failures = 0;
      log.info({ book: book.name, symbol, side, qty, px, res }, "sim: mock-orderly taker");
    } catch (err) {
      failures++;
      log.warn({ book: book.name, failures, err: errMsg(err) }, "sim: orderly taker failed");
    }
  }
}

async function runSim(dep: Deployment, env: SimEnv, log: Logger, signal: AbortSignal): Promise<void> {
  const pub = publicClientFor(env.CHAIN_ID, env.RPC_URL);
  const wanted = env.TRADER_SIM_BOOKS ? new Set(env.TRADER_SIM_BOOKS.split(",").map((s) => Number(s.trim()))) : null;
  const books = dep.books.filter((b) => !wanted || wanted.has(b.bookId));
  const roles = TRADER_ROLES.slice(0, Math.max(1, Math.min(TRADER_ROLES.length, Math.floor(env.TRADER_SIM_TRADERS))));
  const traders = roles.map(
    (r) =>
      new EngineTrader(r, pub, walletClientFor(env.CHAIN_ID, env.RPC_URL, roleAccount(r)), dep.contracts.poolEngine, dep.contracts.usdc, log, env.TX_RECEIPT_TIMEOUT_MS, env.CHAIN_ID === 31337),
  );
  const taker = new MockOrderlyTaker(env.ORDERLY_BASE_URL);
  const loops: Array<Promise<void>> = [];
  for (const b of books) {
    if (b.venue === VENUE.POOL_ENGINE && env.TRADER_SIM_ENGINE) loops.push(engineLoop(b, dep, pub, traders, env, log, signal));
    if (b.venue === VENUE.ORDERLY && env.TRADER_SIM_ORDERLY) loops.push(orderlyLoop(b, dep, pub, taker, env, log, signal));
  }
  log.info({ books: books.map((b) => b.name), traders: roles, tradesPerMin: env.TRADER_SIM_TRADES_PER_MIN }, "trader-sim running");
  if (loops.length === 0) log.warn("trader-sim: no books selected");
  await Promise.all(loops);
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
