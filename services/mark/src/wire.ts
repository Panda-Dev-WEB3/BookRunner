// Builds the mark service's adapters + pipeline (shared by the service runner and the mark-now CLI).
import { createDb } from "@bookrunner/db";
import { PgReceiptsStore } from "@bookrunner/receipts";
import { type Deployment, type Logger, roleAccount, walletClientFor } from "@bookrunner/shared";
import { bookrunnerConfigAbi } from "@bookrunner/shared/abi";
import {
  BookDirectory,
  DbRedeemCandidates,
  PgRedisEventSink,
  type Publisher,
  RedeemLogIndex,
  TxSender,
  UnionCandidates,
  WaterfallChainAdapter,
} from "@bookrunner/waterfall";
import type { PublicClient } from "viem";
import { MarkChainAdapter } from "./adapters/chain";
import { type FeedRedis, RedisMarkFeeds, chainVerifier } from "./adapters/feeds";
import { LocalMarkSigner, ReceiptsRootAdapter } from "./adapters/signer";
import { PgMarkStore } from "./adapters/store";
import type { MarkConfig } from "./config";
import { MarkPipeline } from "./pipeline";
import { MarkSpool } from "./spool";

/**
 * `publisher`: domain events (null = none, e.g. dry runs). `feedRedis`: where the signed oracle prices and
 * ops-venue reports are read from (docs/LOW_GAS.md); null = value from on-chain state only.
 */
export async function wireMark(cfg: MarkConfig, log: Logger, deployment: Deployment, pc: PublicClient, publisher: Publisher | null, feedRedis: FeedRedis | null = null) {
  const account = roleAccount("markSigner");
  const wallet = walletClientFor(cfg.CHAIN_ID, cfg.RPC_URL, account);
  const sender = new TxSender(pc, wallet, log);
  try {
    const role = await pc.readContract({ address: deployment.contracts.config, abi: bookrunnerConfigAbi, functionName: "MARK_SIGNER_ROLE" });
    const ok = await pc.readContract({ address: deployment.contracts.config, abi: bookrunnerConfigAbi, functionName: "hasRole", args: [role, account.address] });
    if (!ok) log.warn({ signer: account.address }, "mark signer lacks MARK_SIGNER role; MarkRegistry.commit will revert");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message.split("\n")[0] : String(err) }, "could not verify MARK_SIGNER role");
  }

  const markChain = new MarkChainAdapter(pc, sender, deployment);
  const feeds = feedRedis
    ? new RedisMarkFeeds(feedRedis, chainVerifier(pc, { config: deployment.contracts.config, oracle: deployment.contracts.oracle }, cfg.CHAIN_ID), log)
    : null;
  const markInterval = await markChain.markInterval(); // may throw (RPC): nothing allocated yet
  if (markInterval !== cfg.MARK_INTERVAL_SECONDS) log.warn({ onchain: markInterval, env: cfg.MARK_INTERVAL_SECONDS }, "config.markInterval() differs from MARK_INTERVAL_SECONDS; using the on-chain value");
  const { db, close } = createDb(cfg.DATABASE_URL, 5);
  const books = new BookDirectory(pc, deployment, log);
  const candidates = new UnionCandidates([new RedeemLogIndex(pc, BigInt(deployment.startBlock ?? 0), cfg.MARK_LOG_CHUNK_BLOCKS, log), new DbRedeemCandidates(db)], log);
  // read-only use (state, idle, in-transit, Distributed logs, pending redemptions); never sends from here
  const readChain = new WaterfallChainAdapter({ pc, sender, deployment, candidates, logChunk: cfg.MARK_LOG_CHUNK_BLOCKS, logLookback: cfg.MARK_LOG_LOOKBACK_BLOCKS });
  const store = new PgMarkStore(db);
  const events = new PgRedisEventSink(db, publisher, log);
  const spool = new MarkSpool(cfg.MARK_SPOOL_DIR);
  const receipts = new ReceiptsRootAdapter({
    store: new PgReceiptsStore(db),
    intervalSeconds: cfg.RECEIPTS_INTERVAL_SECONDS,
    graceSeconds: cfg.RECEIPTS_GRACE_SECONDS,
    markIntervalSeconds: markInterval,
    now: () => Math.floor(Date.now() / 1000),
    log,
  });
  const pipeline = new MarkPipeline({
    books,
    chain: markChain,
    store,
    receipts,
    signer: new LocalMarkSigner(account, cfg.CHAIN_ID, deployment.contracts.markRegistry),
    events,
    log,
    maxRetries: cfg.MARK_MAX_RETRIES,
    confirmations: cfg.MARK_CONFIRMATIONS,
    receiptsWaitMs: cfg.MARK_RECEIPTS_WAIT_SECONDS * 1000,
    maxVenueReportAgeSec: cfg.MARK_MAX_VENUE_REPORT_AGE_SECONDS,
    retireTokenDustUsd: cfg.MARK_RETIRE_TOKEN_DUST_USD,
    spool,
    chainId: cfg.CHAIN_ID,
    commitMode: cfg.MARK_COMMIT_MODE,
    ...(feeds ? { feeds } : {}),
  });
  return { account, sender, db, close, books, markChain, readChain, store, events, spool, pipeline, markInterval };
}

export type MarkContext = Awaited<ReturnType<typeof wireMark>>;
