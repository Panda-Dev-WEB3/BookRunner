// bookrunner-agent: one process per book (BOOK_ID). Boots from the deployment file (idles with retry
// while it is missing), builds the venue (EngineVenue for in-house books, ops-venue's OrderlyVenue or
// the mock fallback for Orderly books), the hedger and the BookAgent loops, and handles kill/halt,
// resume after a remandate, and graceful shutdown on SIGINT/SIGTERM: no new quote / hedge leg starts,
// a desk tx in flight confirms and is recorded, quotes are cancelled, then the process exits 0 — within
// AGENT_SHUTDOWN_GRACE_MS (scripts/dev.ts force-exits its children shortly after).

import { createDb } from "@bookrunner/db";
import {
  CHANNELS,
  type Deployment,
  KEYS,
  type Logger,
  type OraclePriceMsg,
  type QuotingVenue,
  VENUE,
  bytes32ToStr,
  createLogger,
  deploymentPath,
  effectiveSessions,
  isTokenUnderlying,
  priceId as priceIdOfTicker,
  publicClientFor,
  roleAccount,
  tryLoadDeployment,
  underlyingToToken,
  walletClientFor,
} from "@bookrunner/shared";
import type { Hex, LocalAccount, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type AgentBus, RedisBus } from "./adapters/bus";
import { DbStore } from "./adapters/store";
import { BookAgent } from "./agent/book-agent";
import { type HedgeChain, Hedger } from "./agent/hedger";
import { makeVenueReportRelay } from "./chain/venue-report-relay";
import { PriceFeed, oracleMsgFromChain, parseOracleMsg } from "./agent/price-feed";
import { BookChain } from "./chain/book-chain";
import { DeskClient } from "./chain/desk-client";
import { ViemEngineChain } from "./chain/engine-chain";
import { EXECUTE_WITH_PRICES_SIG, supportsFunction } from "./chain/lowgas-abi";
import { PullPrices, deskPriceData, freshestOracleLatest, httpBundleSource, redisBundleSource, resolvePullMode } from "./chain/pull-prices";
import { type AgentEnv, engineVenueConfigFrom, hedgeConfigFrom, loadAgentEnv, quotingConfigFrom, sizingConfigFrom, volConfigFrom } from "./config";
import { type UniverseComponent, buildHedgeUniverse, parseAllowPairs } from "./domain/hedge-universe";
import { RuleBasedSizing } from "./domain/sizing";
import { EwmaVolatility } from "./domain/volatility";
import { SerialLock, errMsg, sleep } from "./util";
import { EngineVenue } from "./venues/engine";
import { createOrderlyVenue } from "./venues/orderly";

const DESK_ROLES = ["deskKeyNvda", "deskKeyTsla", "deskKeyIndex"] as const;

interface BookContext {
  deployment: Deployment;
  bookId: number;
  name: string;
  pub: PublicClient;
  chain: BookChain;
  symbol: string;
  priceIdStr: string;
  priceIdHex: Hex;
  maxPriceAgeSec: number;
  deskAccount: LocalAccount | null;
  deskKeyActive: boolean;
}

/** Desk session key: DESK_KEY_PRIVATE_KEY, else the devnet key for the book's launch order. */
export function deskAccountFor(env: AgentEnv, deployment: Deployment, bookId: number): LocalAccount | null {
  if (env.DESK_KEY_PRIVATE_KEY) return privateKeyToAccount(env.DESK_KEY_PRIVATE_KEY as Hex);
  const order = [...deployment.books].sort((a, b) => a.bookId - b.bookId).findIndex((b) => b.bookId === bookId);
  const role = DESK_ROLES[order];
  if (!role) return null;
  return roleAccount(role, process.env);
}

async function bootstrap(env: AgentEnv, log: Logger, signal: AbortSignal): Promise<BookContext | null> {
  let failures = 0;
  while (!signal.aborted) {
    const deployment = tryLoadDeployment(env.DEPLOYMENT_FILE);
    if (!deployment) {
      log.warn({ file: deploymentPath(env.DEPLOYMENT_FILE), retryMs: env.DEPLOYMENT_RETRY_MS }, "deployment file missing; waiting for contracts to be deployed");
      await sleep(env.DEPLOYMENT_RETRY_MS, signal);
      continue;
    }
    const entry = env.BOOK_ID !== undefined ? deployment.books.find((b) => b.bookId === env.BOOK_ID) : deployment.books[0];
    if (!entry) {
      log.warn({ bookId: env.BOOK_ID ?? null, books: deployment.books.map((b) => b.bookId) }, "book not in deployment; retrying");
      await sleep(env.DEPLOYMENT_RETRY_MS, signal);
      continue;
    }
    if (env.BOOK_ID === undefined) log.warn({ bookId: entry.bookId }, "BOOK_ID not set: using the first book in the deployment");
    try {
      const pub = publicClientFor(env.CHAIN_ID, env.RPC_URL);
      const chain = new BookChain(pub, deployment, entry.components);
      const charter = await chain.readCharter();
      const priceIdHex = env.ORACLE_PRICE_ID ? priceIdOfTicker(env.ORACLE_PRICE_ID) : await chain.priceIdOf(charter.underlying);
      const priceIdStr = env.ORACLE_PRICE_ID ?? bytes32ToStr(priceIdHex);
      const maxPriceAgeSec = await chain.maxPriceAge().catch(() => 300);
      let deskAccount: LocalAccount | null = null;
      try {
        deskAccount = deskAccountFor(env, deployment, entry.bookId);
      } catch (err) {
        log.warn({ err: errMsg(err) }, "no desk session key available");
      }
      const deskKeyActive = deskAccount ? await chain.isActiveKey(deskAccount.address) : false;
      return {
        deployment,
        bookId: entry.bookId,
        name: entry.name,
        pub,
        chain,
        symbol: bytes32ToStr(charter.symbol) || entry.symbol,
        priceIdStr,
        priceIdHex,
        maxPriceAgeSec,
        deskAccount,
        deskKeyActive,
      };
    } catch (err) {
      failures++;
      const wait = Math.min(60_000, env.DEPLOYMENT_RETRY_MS * Math.min(failures, 6));
      log.warn({ bookId: entry.bookId, err: errMsg(err), retryMs: wait }, "chain not ready (contracts not deployed or RPC down); retrying");
      await sleep(wait, signal);
    }
  }
  return null;
}

async function hedgeComponents(ctx: BookContext, underlying: Hex): Promise<UniverseComponent[]> {
  if (isTokenUnderlying(underlying)) return [{ token: underlyingToToken(underlying), weightBps: 10_000 }];
  if (await ctx.chain.isIndex(underlying)) return (await ctx.chain.getIndex(underlying)).components;
  return [];
}

interface Holder {
  agent: BookAgent | null;
}

async function runOnce(
  ctx: BookContext,
  env: AgentEnv,
  baseLog: Logger,
  bus: AgentBus,
  store: DbStore,
  holder: Holder,
  signal: AbortSignal,
): Promise<{ halted: boolean; reason: string }> {
  const log = baseLog.child({ bookId: ctx.bookId, book: ctx.name, symbol: ctx.symbol });
  const charter = await ctx.chain.readCharter();
  const mandate = await ctx.chain.readMandate();
  const vol = new EwmaVolatility(volConfigFrom(env));
  const price = new PriceFeed(ctx.priceIdStr, vol);
  price.ingest(await bus.getJson<OraclePriceMsg>(KEYS.oracleLast(ctx.priceIdStr)).catch(() => null));

  // pull oracle (docs/LOW_GAS.md §1): the freshest signed prices ride in every price-checked desk tx
  let comps: UniverseComponent[] = [];
  try {
    comps = await hedgeComponents(ctx, charter.underlying);
  } catch (err) {
    if (env.HEDGE_ENABLED && ctx.deskAccount && ctx.deskKeyActive) throw err; // the hedger needs them: setup retries
    log.warn({ err: errMsg(err) }, "hedge components unreadable; desk actions carry the book price only");
  }
  const pullPrices = new PullPrices({
    sources: [redisBundleSource((k) => bus.getJson(k)), ...(env.ORACLE_URL ? [httpBundleSource(env.ORACLE_URL)] : [])],
    stream: () => [price.latest()],
    domain: { chainId: env.CHAIN_ID, oracle: ctx.deployment.contracts.oracle },
    log,
  });
  const pull = await resolvePullMode(env.AGENT_PULL_PRICES, () => supportsFunction(ctx.pub, ctx.chain.components.desk, EXECUTE_WITH_PRICES_SIG));
  let componentIds: Promise<Hex[]> | null = null;
  const componentPriceIds = () => {
    componentIds ??= Promise.all(comps.map((c) => ctx.chain.getToken(c.token).then((t) => t.priceId))).catch((err: unknown) => {
      componentIds = null; // retry on the next action
      throw err;
    });
    return componentIds;
  };
  const deskPrices = pull
    ? deskPriceData(pullPrices, {
        bookPriceId: ctx.priceIdHex,
        componentPriceIds,
        maxAgeSec: env.AGENT_PRICE_DATA_MAX_AGE_SECONDS,
        stored: (id) => ctx.chain.oracleLatest(id),
        storedFreshSec: env.AGENT_PRICE_DATA_SKIP_IF_STORED_SECONDS,
      })
    : null;
  log.info({ pull, mode: env.AGENT_PULL_PRICES, oracleUrl: env.ORACLE_URL ?? null }, pull ? "desk actions carry signed prices (executeWithPrices)" : "desk actions use stored prices (execute)");

  const desk =
    ctx.deskAccount && ctx.deskKeyActive
      ? new DeskClient(ctx.pub, walletClientFor(env.CHAIN_ID, env.RPC_URL, ctx.deskAccount), ctx.chain.components.desk, log, env.TX_RECEIPT_TIMEOUT_MS, new SerialLock(), deskPrices)
      : null;
  if (!ctx.deskKeyActive) log.warn({ key: ctx.deskAccount?.address ?? null }, "desk session key not active on the mandate: on-chain legs disabled");

  const mandateNow = () => holder.agent?.currentMandate ?? mandate;
  let venue: QuotingVenue;
  if (charter.venue === VENUE.POOL_ENGINE) {
    if (!desk) throw new Error("in-house book needs an active desk session key (SetQuote)");
    const engineChain = await ViemEngineChain.create(ctx.pub, ctx.deployment.contracts.poolEngine, ctx.chain.components.adapter, {
      lookbackBlocks: env.ENGINE_FILL_LOOKBACK_BLOCKS,
      chunkBlocks: env.ENGINE_LOG_CHUNK_BLOCKS,
      startBlock: ctx.deployment.startBlock,
    });
    venue = new EngineVenue(
      {
        chain: engineChain,
        desk,
        mandate: mandateNow,
        oraclePx: () => price.latest()?.price ?? null,
        symbol: ctx.symbol,
        onSent: (p, reason, txHash) =>
          log.info({ spreadBps: p.spreadBps, skewBps: p.skewBps, maxNetExposureUsd: p.maxNetExposureUsd.toString(), reason, txHash }, "engine quote set"),
      },
      engineVenueConfigFrom(env),
    );
    log.info({ marketId: engineChain.marketId.toString() }, "venue: in-house PoolEngine (desk SetQuote)");
  } else {
    const accountId = env.ORDERLY_ACCOUNT_ID ?? (await ctx.chain.orderlyMmAccountId().catch(() => null)) ?? String(ctx.bookId);
    venue = await createOrderlyVenue({ bookId: ctx.bookId, symbol: ctx.symbol, accountId, baseUrl: env.ORDERLY_BASE_URL, mode: env.ORDERLY_MODE, env: process.env }, log);
  }

  // Orderly books (low-gas): the on-chain venue view only advances at marks, so plan from the latest signed
  // report (what risk monitors) and relay it on-chain right before each hedge leg
  const reportRelay =
    !(venue instanceof EngineVenue) && ctx.deskAccount
      ? makeVenueReportRelay({
          redisUrl: env.REDIS_URL,
          bookId: ctx.bookId,
          chainId: env.CHAIN_ID,
          adapter: ctx.chain.components.adapter,
          pub: ctx.pub,
          wallet: walletClientFor(env.CHAIN_ID, env.RPC_URL, ctx.deskAccount),
          log: log.child({ part: "venue-report-relay" }),
        })
      : null;

  let hedger: Hedger | null = null;
  if (env.HEDGE_ENABLED && desk) {
    const pairs = env.HEDGE_ALLOW_PAIRS ? parseAllowPairs(env.HEDGE_ALLOW_PAIRS) : undefined;
    const universe = buildHedgeUniverse(comps, mandate.hedgeAllowRoot, pairs);
    log.info({ components: comps.length, root: universe.root, rootMatches: universe.rootMatches, perpAllowed: universe.perpAllowed }, "hedge universe");
    // pull: plan on the freshest signed prices (what the carried update makes the mandate check against)
    const hedgeChain: HedgeChain = pull
      ? {
          deskHedgeUsd: () => ctx.chain.deskHedgeUsd(),
          deskValueUsd: () => ctx.chain.deskValueUsd(),
          deskUsdc: () => ctx.chain.deskUsdc(),
          tokenBalance: (t, o) => ctx.chain.tokenBalance(t, o),
          getToken: (t) => ctx.chain.getToken(t),
          vaultDeployable: () => ctx.chain.vaultDeployable(),
          mmRecall: () => ctx.chain.mmRecall(),
          capitalFlowOpen: () => ctx.chain.capitalFlowOpen(),
          oracleLatest: freshestOracleLatest(pullPrices, (id) => ctx.chain.oracleLatest(id), env.AGENT_PRICE_DATA_MAX_AGE_SECONDS),
        }
      : ctx.chain;
    hedger = new Hedger({
      bookId: ctx.bookId,
      desk: ctx.chain.components.desk,
      chain: hedgeChain,
      offchainValuation: pull,
      runner: desk,
      store,
      universe,
      cfg: hedgeConfigFrom(env),
      poolFee: env.HEDGE_POOL_FEE,
      receiptsIntervalSec: env.RECEIPTS_INTERVAL_SECONDS,
      log: log.child({ part: "hedge" }),
      perp: null, // HEDGE_PERP_ENABLED: perp venue client not wired in v1 (VERIFY venue integration)
      ...(reportRelay ? { beforeHedgeLeg: () => reportRelay.relay() } : {}),
    });
  }

  const agent = new BookAgent(
    {
      bookId: ctx.bookId,
      venue,
      chain: {
        readMandate: () => ctx.chain.readMandate(),
        mandateKilled: () => ctx.chain.mandateKilled(),
        mandateOffHours: () => ctx.chain.mandateOffHours(),
        bookState: () => ctx.chain.bookState(),
        oracleFallback: async () => oracleMsgFromChain(ctx.priceIdStr, ctx.priceIdHex, await ctx.chain.oracleLatest(ctx.priceIdHex)),
        venueExposureUsd: reportRelay ? async () => (await reportRelay.view()).exposureUsd : () => ctx.chain.adapterExposureUsd(),
        venueValuationAt: reportRelay ? async () => (await reportRelay.view()).valuationAt : () => ctx.chain.adapterValuationAt(),
      },
      price,
      vol,
      sizing: new RuleBasedSizing(sizingConfigFrom(env)),
      store,
      bus,
      hedger,
      sessions: effectiveSessions(charter.sessions, env.SESSIONS_MODE),
      initialMandate: mandate,
      log,
    },
    {
      quoting: quotingConfigFrom(env),
      quoteIntervalMs: env.AGENT_QUOTE_INTERVAL_MS,
      stateRefreshMs: env.AGENT_STATE_REFRESH_MS,
      fillPollMs: env.AGENT_FILL_POLL_MS,
      hedgeIntervalMs: env.AGENT_HEDGE_INTERVAL_MS,
      priceStaleSec: env.AGENT_PRICE_STALE_SECONDS,
      chainPriceFallbackSec: env.AGENT_CHAIN_PRICE_FALLBACK_SECONDS,
      maxPriceAgeSec: ctx.maxPriceAgeSec,
      requoteBps: env.AGENT_REQUOTE_BPS,
      requoteSizeFrac: env.AGENT_REQUOTE_SIZE_FRAC,
      requoteMaxMs: env.AGENT_REQUOTE_MAX_MS,
      quoteSampleMs: env.AGENT_QUOTE_SAMPLE_MS,
      quoteReceiptMs: env.AGENT_QUOTE_RECEIPT_MS,
      receiptsIntervalSec: env.RECEIPTS_INTERVAL_SECONDS,
      heartbeatTtlMs: env.AGENT_HEARTBEAT_TTL_MS,
      quoteTtlMs: Math.max(5_000, env.AGENT_QUOTE_INTERVAL_MS * 10),
      fillLookbackMs: 15 * 60_000,
      pullPrices: pull,
    },
  );
  holder.agent = agent;
  if (signal.aborted) agent.stop(); // shutdown arrived during setup: run() only cancels and returns
  log.info(
    { venue: venue.kind, priceId: ctx.priceIdStr, maxInventoryUsd: mandate.maxInventoryUsd.toString(), minWidthBps: mandate.minQuoteWidthBps, maxSkewBps: mandate.maxSkewBps, hedging: !!hedger },
    "bookrunner agent starting",
  );
  try {
    return await agent.run();
  } finally {
    holder.agent = null;
  }
}

/** After a halt: idle until a remandate clears the kill and the desk key is active again. */
async function waitForResume(ctx: BookContext, env: AgentEnv, log: Logger, bus: AgentBus, reason: string, signal: AbortSignal): Promise<boolean> {
  const terminal = reason === "BOOK_RETIRED" || reason === "BOOK_CANCELLED";
  let sawKilled = false;
  let lastLog = 0;
  while (!signal.aborted) {
    await bus.heartbeat(ctx.bookId, env.AGENT_HEARTBEAT_TTL_MS).catch(() => undefined);
    if (!terminal) {
      try {
        const killed = await ctx.chain.mandateKilled();
        if (killed) sawKilled = true;
        const active = ctx.deskAccount ? await ctx.chain.isActiveKey(ctx.deskAccount.address) : false;
        if (sawKilled && !killed && active) {
          log.info({ bookId: ctx.bookId }, "mandate re-issued and desk key active: resuming");
          return true;
        }
      } catch (err) {
        log.debug({ err: errMsg(err) }, "halt watch: chain read failed");
      }
    }
    if (Date.now() - lastLog >= env.AGENT_HALT_LOG_MS) {
      log.warn({ bookId: ctx.bookId, reason, waitingFor: terminal ? "shutdown" : "remandate" }, "agent halted: not quoting");
      lastLog = Date.now();
    }
    await sleep(Math.min(30_000, env.AGENT_STATE_REFRESH_MS * 3), signal);
  }
  return false;
}

async function main(): Promise<void> {
  const env = loadAgentEnv();
  const log = createLogger("bookrunner-agent", env.LOG_LEVEL);
  const ctl = new AbortController();
  const holder: Holder = { agent: null };
  let forceExit: ReturnType<typeof setTimeout> | null = null;
  const onSignal = (sig: string) => {
    log.info({ sig, graceMs: env.AGENT_SHUTDOWN_GRACE_MS }, "shutdown requested");
    ctl.abort();
    holder.agent?.stop();
    // bounded: a stuck RPC / receipt wait never outlives the supervisor's force-exit window
    forceExit ??= setTimeout(() => {
      log.warn({ graceMs: env.AGENT_SHUTDOWN_GRACE_MS }, "shutdown grace elapsed with work in flight; exiting");
      process.exit(0);
    }, env.AGENT_SHUTDOWN_GRACE_MS);
    forceExit.unref?.();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const bus = new RedisBus(env.REDIS_URL, log);
  const dbh = createDb(env.DATABASE_URL, 4);
  const store = new DbStore(dbh.db);
  const subscribed = new Set<string>();
  // Non-blocking: with Redis down the subscribe stays queued (ioredis re-subscribes on reconnect)
  // and the agent still runs on the AttestedOracle price fallback and on-chain kill/state reads.
  const subscribeOnce = (channel: string, handler: (raw: string) => void) => {
    if (subscribed.has(channel)) return;
    subscribed.add(channel);
    bus.subscribe(channel, handler).catch((err) => {
      subscribed.delete(channel);
      log.warn({ channel, err: errMsg(err) }, "redis subscribe failed");
    });
  };

  try {
    while (!ctl.signal.aborted) {
      const ctx = await bootstrap(env, log, ctl.signal);
      if (!ctx) break;
      subscribeOnce(CHANNELS.oraclePrice(ctx.priceIdStr), (raw) => holder.agent?.onPrice(parseOracleMsg(raw)));
      subscribeOnce(CHANNELS.kill(ctx.bookId), (raw) => holder.agent?.onKill(raw));
      subscribeOnce(CHANNELS.riskState(ctx.bookId), (raw) => holder.agent?.onRiskState(raw));
      let result: { halted: boolean; reason: string };
      try {
        result = await runOnce(ctx, env, log, bus, store, holder, ctl.signal);
      } catch (err) {
        log.error({ bookId: ctx.bookId, err: errMsg(err) }, "agent setup failed; retrying");
        await sleep(env.DEPLOYMENT_RETRY_MS, ctl.signal);
        continue;
      }
      if (ctl.signal.aborted) break;
      if (result.halted) {
        const resume = await waitForResume(ctx, env, log, bus, result.reason, ctl.signal);
        if (!resume) break;
      }
    }
  } finally {
    await bus.close();
    await dbh.close().catch(() => undefined);
    log.info("bookrunner agent stopped");
  }
}

if (import.meta.main) {
  // exit explicitly: open handles (e.g. the venue-report relay's Redis client) must not keep a stopped agent alive
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
