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
  FORGED_WINDOW_SEC,
  ForgedLog,
  KillVerifier,
  OraclePriceVerifier,
  RiskStateVerifier,
  type QuoteMsg,
  type QuotingVenue,
  VENUE,
  assertVenueSymbolConfig,
  bytes32ToStr,
  cachedAddressCheck,
  derivedDeskAccount,
  createLogger,
  deploymentPath,
  effectiveSessions,
  isTokenUnderlying,
  oracleSignerCheck,
  priceId as priceIdOfTicker,
  publicClientFor,
  signQuote,
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
import { DeskRejects } from "./agent/desk-rejects";
import { AgentKillGate, AgentRiskStateGate } from "./agent/kill-gate";
import { PriceFeed, VerifiedPriceInput, oracleMsgFromChain } from "./agent/price-feed";
import { BookChain } from "./chain/book-chain";
import { DeskClient } from "./chain/desk-client";
import { ViemEngineChain } from "./chain/engine-chain";
import { attestedOracleAbi, bookrunnerConfigAbi } from "@bookrunner/shared/abi";
import { DEFAULT_MAX_TRADE_PRICE_AGE_SEC, EXECUTE_WITH_PRICES_SIG, supportsFunction } from "./chain/lowgas-abi";
import { PullPrices, deskPriceData, freshestOracleLatest, httpBundleSource, redisBundleSource, resolvePullMode, swapPriceMaxAgeSec } from "./chain/pull-prices";
import { type AgentEnv, engineVenueConfigFrom, hedgeConfigFrom, loadAgentEnv, quotingConfigFrom, resolveVenuePostOnlyQuote, sizingConfigFrom, volConfigFrom } from "./config";
import { type UniverseComponent, buildHedgeUniverse, parseAllowPairs } from "./domain/hedge-universe";
import { RuleBasedSizing } from "./domain/sizing";
import { EwmaVolatility } from "./domain/volatility";
import { SerialLock, errMsg, sleep } from "./util";
import { EngineVenue } from "./venues/engine";
import { createOrderlyVenue } from "./venues/orderly";
import { VenueSymbolError, agentVenueSymbol, idleUntilAborted } from "./venues/symbol";


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
export function deskAccountFor(env: AgentEnv, deployment: Deployment, bookId: number, procEnv: Record<string, string | undefined> = process.env): LocalAccount | null {
  if (env.DESK_KEY_PRIVATE_KEY) return privateKeyToAccount(env.DESK_KEY_PRIVATE_KEY as Hex);
  // launch books: their launch role; every other book (devnet / testnet): its own derived key (scripts/desk-keys.ts
  // registers it); mainnet: none (DESK_KEY_PRIVATE_KEY_<bookId>)
  return derivedDeskAccount(deployment.books.map((b) => b.bookId), bookId, procEnv);
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
  /** Redis prints -> verified prints of this book's price id (set once the book's context is known) */
  prices: VerifiedPriceInput | null;
  /** Redis kill messages -> RISK-signed kill orders for this book */
  kills: AgentKillGate | null;
  /** Redis risk states -> RISK-signed states for this book (monotonic across agent restarts in the process) */
  riskStates: AgentRiskStateGate | null;
}

/**
 * The oracle signature check of every price read from Redis (audit 2026-10 lead "Redis is a shared trust domain"):
 * EIP-712 PriceUpdate under (CHAIN_ID, the deployment's AttestedOracle), signer = AttestedOracle.isSigner on-chain.
 */
export function oracleVerifierFor(ctx: Pick<BookContext, "pub" | "deployment">, chainId: number, pinned?: string): OraclePriceVerifier {
  const oracle = ctx.deployment.contracts.oracle;
  return new OraclePriceVerifier(
    oracleSignerCheck({ chainId, oracle, pinned, pinnedEnv: "AGENT_ORACLE_SIGNERS", isSignerOnChain: (a) => ctx.pub.readContract({ address: oracle, abi: attestedOracleAbi, functionName: "isSigner", args: [a] }) }),
  );
}

/**
 * The kill-order check of the kill channel (audit 2026-10 lead "Redis trust"): RISK-signed EIP-712 KillOrder under
 * (CHAIN_ID, BookrunnerConfig); signer = config.hasRole(RISK_ROLE) on-chain (cached) or the pinned AGENT_RISK_SIGNERS.
 */
export function riskSignerCheckFor(ctx: Pick<BookContext, "pub" | "deployment">, pinned?: string): (a: Hex) => Promise<boolean> {
  const config = ctx.deployment.contracts.config;
  let role: Hex | null = null;
  const onChain = async (a: Hex) => {
    role ??= (await ctx.pub.readContract({ address: config, abi: bookrunnerConfigAbi, functionName: "RISK_ROLE" })) as Hex;
    return (await ctx.pub.readContract({ address: config, abi: bookrunnerConfigAbi, functionName: "hasRole", args: [role, a] })) as boolean;
  };
  return cachedAddressCheck({ pinned, pinnedEnv: "AGENT_RISK_SIGNERS", onChain });
}

export function killVerifierFor(ctx: Pick<BookContext, "pub" | "deployment">, chainId: number, isRiskSigner: (a: Hex) => Promise<boolean>): KillVerifier {
  return new KillVerifier({ chainId, config: ctx.deployment.contracts.config, isRiskSigner });
}

async function runOnce(
  ctx: BookContext,
  env: AgentEnv,
  baseLog: Logger,
  bus: AgentBus,
  store: DbStore,
  holder: Holder,
  verifier: OraclePriceVerifier,
  signal: AbortSignal,
): Promise<{ halted: boolean; reason: string }> {
  const log = baseLog.child({ bookId: ctx.bookId, book: ctx.name, symbol: ctx.symbol });
  const charter = await ctx.chain.readCharter();
  const mandate = await ctx.chain.readMandate();
  const vol = new EwmaVolatility(volConfigFrom(env));
  const price = new PriceFeed(ctx.priceIdStr, vol);
  // Redis is not trusted for the quote price: only a print signed by an oracle signer for this price id is used
  price.ingest(await (holder.prices?.accept(await bus.getJson<unknown>(KEYS.oracleLast(ctx.priceIdStr)).catch(() => null)) ?? null));

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
    verify: async (u, sig) => (await verifier.verify(u, sig)).ok,
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
  // the desk refuses key swaps on a price older than config.maxTradePriceAge (audit 2026-10 "old prints"): never carry one
  const tradeAgeSec = pull
    ? await ctx.pub
        .readContract({ address: ctx.deployment.contracts.config, abi: bookrunnerConfigAbi, functionName: "maxTradePriceAge" })
        .then(Number)
        .catch(() => DEFAULT_MAX_TRADE_PRICE_AGE_SEC)
    : DEFAULT_MAX_TRADE_PRICE_AGE_SEC;
  const deskPrices = pull
    ? deskPriceData(pullPrices, {
        bookPriceId: ctx.priceIdHex,
        componentPriceIds,
        maxAgeSec: env.AGENT_PRICE_DATA_MAX_AGE_SECONDS,
        stored: (id) => ctx.chain.oracleLatest(id),
        storedFreshSec: env.AGENT_PRICE_DATA_SKIP_IF_STORED_SECONDS,
        swapMaxAgeSec: swapPriceMaxAgeSec(tradeAgeSec, env.AGENT_SWAP_PRICE_MARGIN_SECONDS, env.AGENT_PRICE_DATA_MAX_AGE_SECONDS),
      })
    : null;
  log.info({ pull, mode: env.AGENT_PULL_PRICES, oracleUrl: env.ORACLE_URL ?? null }, pull ? "desk actions carry signed prices (executeWithPrices)" : "desk actions use stored prices (execute)");

  const desk =
    ctx.deskAccount && ctx.deskKeyActive
      ? new DeskClient(ctx.pub, walletClientFor(env.CHAIN_ID, env.RPC_URL, ctx.deskAccount), ctx.chain.components.desk, log, env.TX_RECEIPT_TIMEOUT_MS, new SerialLock(), deskPrices)
      : null;
  if (desk) {
    // StaleTradePrice refusals of the desk's key swaps, for services/alerts (desk_stale_trade_price)
    const rejects = new DeskRejects(ctx.bookId, bus, log);
    await rejects.load();
    desk.onRejected = (revert, action) => rejects.note(revert, action);
  }
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
    // the charter symbol stays the book's label (logs, marks, UI); Orderly is spoken to with the venue symbol
    // (PERP_<T>_USDC_<broker> with ORDERLY_MODE=live, VERIFY O19)
    const symbol = agentVenueSymbol(ctx.symbol, env, (warning) => log.warn({ warning }, "charter symbol breaks the Orderly charter rule"));
    log.info({ venueSymbol: symbol }, "venue: Orderly");
    venue = await createOrderlyVenue({ bookId: ctx.bookId, symbol, accountId, baseUrl: env.ORDERLY_BASE_URL, mode: env.ORDERLY_MODE, env: process.env }, log);
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
        // quoting new risk needs an active desk session key (read every state refresh: expiry / REVOKE_KEY take effect)
        ...(ctx.deskAccount ? { deskKeyActive: () => ctx.chain.isActiveKey((ctx.deskAccount as LocalAccount).address) } : {}),
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
      // risk checks only quotes signed by an active desk key of the mandate (Redis is not trusted)
      ...(ctx.deskAccount ? { signQuote: (q: QuoteMsg) => signQuote(ctx.deskAccount as LocalAccount, env.CHAIN_ID, ctx.chain.components.mandate, q) } : {}),
      ...(holder.riskStates ? { verifyRiskState: (raw: unknown) => (holder.riskStates as AgentRiskStateGate).accept(raw) } : {}),
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
      requireDeskKey: true,
      riskStateTimeoutMs: env.AGENT_RISK_STATE_TIMEOUT_MS,
      venueGate: { enabled: env.AGENT_VENUE_MARKET_GATE, allowPostOnly: resolveVenuePostOnlyQuote(env), holdMs: env.AGENT_VENUE_GATE_HOLD_MS },
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
      // a RISK-signed kill message (or risk "killed") the chain never confirms (alert-mode kill) stays a stop until a restart
      log.warn({ bookId: ctx.bookId, reason, waitingFor: terminal ? "shutdown" : "remandate", killConfirmedOnChain: sawKilled }, "agent halted: not quoting");
      lastLog = Date.now();
    }
    await sleep(Math.min(30_000, env.AGENT_STATE_REFRESH_MS * 3), signal);
  }
  return false;
}

async function main(): Promise<void> {
  const env = loadAgentEnv();
  const log = createLogger("bookrunner-agent", env.LOG_LEVEL);
  assertVenueSymbolConfig({ mode: env.ORDERLY_MODE, brokerId: env.ORDERLY_BROKER_ID }); // live: books trade PERP_<T>_USDC_<broker>
  const ctl = new AbortController();
  const holder: Holder = { agent: null, prices: null, kills: null, riskStates: null };
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
      const verifier = oracleVerifierFor(ctx, env.CHAIN_ID, env.AGENT_ORACLE_SIGNERS);
      const forgedSource = `agent-${ctx.bookId}`;
      const isRiskSigner = riskSignerCheckFor(ctx, env.AGENT_RISK_SIGNERS);
      const forgedLog = new ForgedLog(forgedSource, (m) => bus.setJson(KEYS.busForged(forgedSource), m, FORGED_WINDOW_SEC * 1000));
      holder.riskStates = new AgentRiskStateGate(
        new RiskStateVerifier({ chainId: env.CHAIN_ID, config: ctx.deployment.contracts.config, bookId: ctx.bookId, isRiskSigner }),
        forgedLog,
        log.child({ bookId: ctx.bookId, part: "risk-state" }),
      );
      holder.kills = new AgentKillGate(
        ctx.bookId,
        killVerifierFor(ctx, env.CHAIN_ID, isRiskSigner),
        forgedLog,
        log.child({ bookId: ctx.bookId, part: "kill" }),
      );
      holder.prices = new VerifiedPriceInput(verifier, ctx.priceIdHex, log.child({ bookId: ctx.bookId, part: "price" }));
      subscribeOnce(CHANNELS.oraclePrice(ctx.priceIdStr), (raw) => {
        void holder.prices?.accept(raw).then((m) => holder.agent?.onPrice(m));
      });
      subscribeOnce(CHANNELS.kill(ctx.bookId), (raw) => {
        // only a RISK-signed kill order halts the agent (a forged one is logged and counted)
        void holder.kills?.accept(raw).then((m) => m && holder.agent?.onKill(m));
      });
      subscribeOnce(CHANNELS.riskState(ctx.bookId), (raw) => holder.agent?.onRiskState(raw));
      let result: { halted: boolean; reason: string };
      try {
        result = await runOnce(ctx, env, log, bus, store, holder, verifier, ctl.signal);
      } catch (err) {
        if (err instanceof VenueSymbolError) {
          // deterministic (immutable charter symbol): log once and idle this book until shutdown, no retry loop.
          // ops-venue keeps its reports / withdrawals and alerts on it (venue_symbol_unmapped).
          log.error({ bookId: ctx.bookId, charterSymbol: ctx.symbol, err: err.message }, "no Orderly market for the charter symbol: this book does not quote; idling until shutdown");
          await idleUntilAborted(ctl.signal);
          break;
        }
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
