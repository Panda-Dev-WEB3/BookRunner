// Liquidation keeper for the in-house engine markets (2026-10; docs/RUNBOOK.md "Opening the first in-house engine
// market"). A job of the waterfall keeper process: the KEEPER role key (roleSigner, local or KMS), the serialised
// TxSender (no nonce race with the settlement / keeper transactions), its own cadence.
// One pass:
//   1. the trader set from the indexer's engine_positions (open rows only; no chain scan); no open position: no RPC;
//   2. the open positions in batches of `batchSize` (one Multicall3 aggregate3 each, with every market's state +
//      oracle price + settle price), at most `maxBatches` per pass: beyond that the positions are paged across passes
//      and the status says so (coverage.truncated, review I-6); market configs and the price bounds cached;
//   3. the freshest signed print per market from the oracle's Redis bundle; the engine's own rule off-chain at the
//      price the transaction would use (domain/liquidation.ts); nothing is sent for a position that is not liquidatable
//      there (or, for forceClose, not in a wind-down / settled market);
//   4. candidates in order of what is at stake (max of reward and bad debt, liquidations first); per candidate
//      eth_estimateGas (also the race check: NotLiquidatable / NoPosition = someone else was first), the gas policy
//      (domain/liquidation.ts gasDecision: pays for itself / dust / under water, hourly loss budget, review I-3), then
//      liquidate(marketId, trader, priceData) or forceClose(marketId, trader, priceData) through the sender;
//   5. every `reconcileMs` (and at start) one pass over EVERY known (market, trader) row, size 0 included, reading
//      positionOf on chain and repairing the row's size when the indexer's differs (review I-5);
//   6. the status (backlog with reasons, failure run, coverage, reconciliation, totals) to KEYS.liquidationKeeper.
// The next pass comes after `intervalMs` while a market trades (or closes out), `idleIntervalMs` otherwise (off-hours:
// the held price does not move; a session close is caught by the first pass after it).
import type { Logger } from "@bookrunner/shared";
import { attestedOracleAbi, poolEngineAbi } from "@bookrunner/shared/abi";
import type { EnginePosition } from "@bookrunner/shared/engineMath";
import type { LiquidationKeeperStatus, LiquidationMarketStatus } from "@bookrunner/shared/liquidationKeeper";
import type { SignedPrice } from "@bookrunner/shared/signedPrice";
import type { Abi, Hex } from "viem";
import {
  Backlog,
  type EngineMarketCfg,
  type GasPolicy,
  GasWindow,
  type KeeperAction,
  type MarketRead,
  type ProtocolParams,
  byStake,
  classifyRevert,
  decideMarket,
  gasDecision,
  priceUsed,
  regimeOf,
} from "./domain/liquidation";
import { TxRevertedError, describeRevert } from "./kit/tx";

export interface LiqCall {
  functionName: "liquidate" | "forceClose";
  marketId: number;
  trader: string;
  priceData: Hex;
}

export interface TraderRef {
  marketId: number;
  trader: string;
}

export interface LiquidationChain {
  /** Market configs (underlying, margins, liquidation fee) and the protocol's price bounds; cached by the runner. */
  readConfigs(marketIds: number[]): Promise<{ cfgs: Map<number, EngineMarketCfg>; params: ProtocolParams }>;
  /** ONE batched read: each market's state / close-out / oracle latest / settle price, and every listed position. */
  readPass(markets: Array<{ marketId: number; underlying: Hex }>, traders: TraderRef[]): Promise<{
    markets: Map<number, Omit<MarketRead, "cfg">>;
    positions: Map<string, EnginePosition>;
  }>;
  /** eth_estimateGas from the keeper; throws the revert. */
  estimate(call: LiqCall): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  /** Sends through the serialised sender with this gas limit; the mined receipt's cost (a revert throws TxRevertedError with its cost). */
  send(call: LiqCall, gas: bigint): Promise<{ hash: Hex; costWei: bigint }>;
}

export interface PositionStore {
  /** open (marketId, trader) rows of engine_positions */
  open(): Promise<TraderRef[]>;
  /** every row, size 0 included, with the stored size */
  all(): Promise<Array<TraderRef & { sizeRaw: string }>>;
  /** repairs the stored size of a row (on-chain positionOf differs) */
  repair(marketId: number, trader: string, sizeRaw: string): Promise<void>;
}

export interface LiquidationDeps {
  chain: LiquidationChain;
  positions: PositionStore;
  /** the freshest signed print per underlying (one Redis read per pass) */
  signedPrices(underlyings: Hex[]): Promise<Map<string, SignedPrice>>;
  writeStatus(s: LiquidationKeeperStatus): Promise<void>;
  /** marketId -> bookId, for the status (best effort) */
  bookOf?(marketId: number): Promise<number | null>;
  gas: GasPolicy;
  keeper: string;
  log: Logger;
  intervalMs: number;
  idleIntervalMs: number;
  maxTxPerPass: number;
  /** positions per aggregate3 */
  batchSize: number;
  /** aggregate3 batches per pass at most (beyond: paged across passes) */
  maxBatches: number;
  /** on-chain reconciliation of every known row this often (ms); 0 = off */
  reconcileMs: number;
  /** configs re-read at most this often (ms) */
  configTtlMs?: number;
  now?: () => number;
}

/** Engine + oracle custom errors, to name a revert (NotLiquidatable, StalePrice, BadSigner, ...). */
const REVERT_ABI = [...poolEngineAbi, ...attestedOracleAbi] as unknown as Abi;

const posKey = (marketId: number, trader: string) => `${marketId}|${trader.toLowerCase()}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
const sortRefs = (xs: TraderRef[]) => [...xs].sort((a, b) => a.marketId - b.marketId || (a.trader.toLowerCase() < b.trader.toLowerCase() ? -1 : a.trader.toLowerCase() > b.trader.toLowerCase() ? 1 : 0));
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

type Pass = { checked: number; liquidated: number; forceClosed: number; raced: number };

export class LiquidationKeeper {
  private readonly backlog = new Backlog();
  private readonly gasWindow = new GasWindow();
  private cfgs = new Map<number, EngineMarketCfg>();
  private params: ProtocolParams | null = null;
  private cfgAt = 0;
  private offset = 0;
  private reconciledAt: number | null = null;
  private reconcile: LiquidationKeeperStatus["reconcile"] = { at: null, checked: 0, repaired: 0, error: null };
  private coverage: LiquidationKeeperStatus["coverage"] = { total: 0, checked: 0, truncated: false, rotationSec: 0 };
  private failures: LiquidationKeeperStatus["failures"] = { consecutive: 0, since: null, lastError: null, lastErrorAt: null };
  private totals = { liquidations: 0, forceCloses: 0, raced: 0, rewardsUsd: 0n, gasWei: 0n };

  constructor(private readonly d: LiquidationDeps) {}

  private now() {
    return this.d.now ? this.d.now() : Date.now();
  }

  private fail(err: string) {
    const now = this.now();
    this.failures = { consecutive: this.failures.consecutive + 1, since: this.failures.since ?? now, lastError: err, lastErrorAt: now };
  }

  private ok() {
    this.failures = { ...this.failures, consecutive: 0, since: null };
  }

  /** One pass; returns the delay to the next one (ms). Never throws: a failed pass is counted and reported. */
  async tick(): Promise<number> {
    const started = this.now();
    const pass: Pass = { checked: 0, liquidated: 0, forceClosed: 0, raced: 0 };
    let markets: LiquidationMarketStatus[] = [];
    let busy = false;
    try {
      if (this.d.reconcileMs > 0 && (this.reconciledAt === null || started - this.reconciledAt >= this.d.reconcileMs)) await this.reconcileAll();
      const open = sortRefs(await this.d.positions.open());
      if (open.length === 0) {
        this.backlog.observe([], started);
        this.coverage = { total: 0, checked: 0, truncated: false, rotationSec: 0 };
        this.ok();
      } else {
        const r = await this.run(open, pass);
        markets = r.markets;
        busy = r.busy;
      }
    } catch (err) {
      this.fail(errText(err));
      this.d.log.warn({ err: errText(err) }, "liquidation pass failed; retrying next pass");
      busy = true;
    }
    const delay = busy ? this.d.intervalMs : this.d.idleIntervalMs;
    if (this.coverage.truncated) this.coverage.rotationSec = Math.ceil(this.coverage.total / Math.max(1, this.coverage.checked)) * Math.round(delay / 1000);
    await this.d
      .writeStatus({
        ts: this.now(),
        enabled: true,
        keeper: this.d.keeper,
        nextPassSec: Math.round(delay / 1000),
        markets,
        backlog: this.backlog.list(),
        lastPass: { at: started, durationMs: this.now() - started, ...pass },
        failures: this.failures,
        totals: { ...this.totals, rewardsUsd: (Number(this.totals.rewardsUsd) / 1e6).toFixed(6), gasWei: this.totals.gasWei.toString() },
        gasGuard: this.d.gas.ethUsdWad > 0n ? "reward" : "cap_only",
        coverage: this.coverage,
        reconcile: this.reconcile,
      })
      .catch((err) => this.d.log.warn({ err: errText(err) }, "liquidation status write failed"));
    return delay;
  }

  private async configs(ids: number[]) {
    const stale = this.now() - this.cfgAt > (this.d.configTtlMs ?? 600_000);
    const missing = ids.filter((id) => !this.cfgs.has(id));
    if (!stale && missing.length === 0 && this.params) return;
    const r = await this.d.chain.readConfigs(stale ? ids : missing);
    for (const [id, c] of r.cfgs) this.cfgs.set(id, c);
    this.params = r.params;
    if (stale) this.cfgAt = this.now();
  }

  private marketList(ids: number[]) {
    return ids.flatMap((id) => {
      const c = this.cfgs.get(id);
      return c ? [{ marketId: id, underlying: c.underlying }] : [];
    });
  }

  /** Reads `refs` in batches of batchSize (one aggregate3 each): the markets from the first batch, every position. */
  private async read(list: Array<{ marketId: number; underlying: Hex }>, refs: TraderRef[]) {
    const markets = new Map<number, Omit<MarketRead, "cfg">>();
    const positions = new Map<string, EnginePosition>();
    for (const [i, batch] of chunks(refs, this.d.batchSize).entries()) {
      const r = await this.d.chain.readPass(i === 0 ? list : [], batch);
      if (i === 0) for (const [k, v] of r.markets) markets.set(k, v);
      for (const [k, v] of r.positions) positions.set(k, v);
    }
    return { markets, positions };
  }

  /** Review I-5: positionOf of every known row (size 0 too) on chain; the row's size is repaired where it differs. */
  private async reconcileAll() {
    const at = this.now();
    this.reconciledAt = at;
    try {
      const rows = sortRefs(await this.d.positions.all()) as Array<TraderRef & { sizeRaw: string }>;
      if (rows.length === 0) {
        this.reconcile = { at, checked: 0, repaired: 0, error: null };
        return;
      }
      let repaired = 0;
      for (const batch of chunks(rows, this.d.batchSize)) {
        const r = await this.d.chain.readPass([], batch);
        for (const row of batch) {
          const p = r.positions.get(posKey(row.marketId, row.trader));
          if (!p || p.size.toString() === row.sizeRaw) continue;
          await this.d.positions.repair(row.marketId, row.trader, p.size.toString());
          repaired++;
          this.d.log.warn({ marketId: row.marketId, trader: row.trader, indexed: row.sizeRaw, onchain: p.size.toString() }, "engine position repaired from chain (indexer row out of date)");
        }
      }
      this.reconcile = { at, checked: rows.length, repaired, error: null };
    } catch (err) {
      this.reconcile = { ...this.reconcile, at, error: errText(err) };
      this.fail(`reconcile: ${errText(err)}`);
      this.d.log.warn({ err: errText(err) }, "engine position reconciliation failed; retrying next interval");
    }
  }

  /** The positions this pass reads: all of them, or a window paged across passes (review I-6). */
  private window(open: TraderRef[]): TraderRef[] {
    const cap = this.d.batchSize * this.d.maxBatches;
    if (open.length <= cap) {
      this.offset = 0;
      this.coverage = { total: open.length, checked: open.length, truncated: false, rotationSec: 0 };
      return open;
    }
    const start = this.offset % open.length;
    const out = [...open.slice(start, start + cap), ...open.slice(0, Math.max(0, start + cap - open.length))];
    this.offset = (start + cap) % open.length;
    this.coverage = { total: open.length, checked: out.length, truncated: true, rotationSec: 0 };
    this.d.log.warn({ total: open.length, checked: out.length }, "more open engine positions than one pass reads: paged across passes");
    return out;
  }

  private async run(allOpen: TraderRef[], pass: Pass) {
    const open = this.window(allOpen);
    const ids = [...new Set(open.map((o) => o.marketId))].sort((a, b) => a - b);
    await this.configs(ids);
    const params = this.params as ProtocolParams;
    const list = this.marketList(ids);
    const read = await this.read(list, open);
    const signed = await this.d.signedPrices(list.map((m) => m.underlying));
    const nowSec = Math.floor(this.now() / 1000);
    const actions: KeeperAction[] = [];
    const markets: LiquidationMarketStatus[] = [];
    let busy = false;
    for (const { marketId, underlying } of list) {
      const raw = read.markets.get(marketId);
      const cfg = this.cfgs.get(marketId);
      if (!raw || !cfg) continue;
      const m: MarketRead = { ...raw, cfg };
      const px = priceUsed(m, signed.get(underlying.toLowerCase()) ?? null, nowSec, params);
      const positions = open
        .filter((o) => o.marketId === marketId)
        .map((o) => ({ trader: o.trader, position: read.positions.get(posKey(marketId, o.trader)) }))
        .filter((x): x is { trader: string; position: EnginePosition } => !!x.position && x.position.size !== 0n);
      pass.checked += positions.length;
      const regime = regimeOf(m, px, nowSec, params);
      if (regime === "open" || regime === "closeout") busy = true;
      markets.push({ marketId, bookId: (await this.d.bookOf?.(marketId).catch(() => null)) ?? null, regime, openPositions: positions.length, priceAgeSec: px ? Math.max(0, nowSec - px.publishedAt) : null });
      actions.push(...decideMarket(m, positions, px, nowSec, params));
    }
    // a truncated pass only sees its window: the backlog keeps the other pages' items until their turn comes
    if (!this.coverage.truncated) this.backlog.observe(actions, this.now());
    else this.backlog.merge(actions, this.now(), new Set(open.map((o) => posKey(o.marketId, o.trader))));
    const queue = [...actions].sort(byStake);
    let gasPrice: bigint | null = null;
    let failed = false;
    for (const a of queue.slice(0, this.d.maxTxPerPass)) {
      const call: LiqCall = { functionName: a.action, marketId: a.marketId, trader: a.trader, priceData: a.priceData };
      const log = this.d.log.child({ duty: "liquidation", marketId: a.marketId, trader: a.trader, action: a.action });
      let estimate: bigint;
      try {
        estimate = await this.d.chain.estimate(call);
      } catch (err) {
        const info = describeRevert(err, REVERT_ABI);
        const cls = classifyRevert(info.errorName, `${info.reason ?? ""} ${info.message}`);
        if (cls === "raced") {
          pass.raced++;
          this.totals.raced++;
          this.backlog.done(a.marketId, a.trader);
          log.info({ revert: info.errorName ?? info.message }, "position no longer actionable on chain (another keeper or a price move); skipped");
          continue;
        }
        this.backlog.set(a.marketId, a.trader, cls, info.errorName ?? info.message);
        if (cls === "failed") {
          failed = true;
          this.fail(info.errorName ?? info.message);
        }
        log.warn({ revert: info, cls }, "liquidation simulation failed; retrying next pass");
        continue;
      }
      gasPrice ??= await this.d.chain.gasPrice();
      // the worst case of the gas limit sent (review M-13): estimate + 30 % + 30k
      const gasLimit = (estimate * 13n) / 10n + 30_000n;
      const cost = gasLimit * gasPrice;
      const decision = gasDecision(this.d.gas, a, cost, this.gasWindow.spent(this.now()));
      if (!decision.send) {
        this.backlog.set(a.marketId, a.trader, decision.reason, decision.detail);
        log[decision.reason === "dust" ? "debug" : "warn"]({ costWei: cost.toString(), rewardUsd6: a.rewardUsd.toString(), badDebtUsd6: a.badDebtUsd.toString(), why: decision.detail }, decision.reason === "dust" ? "dust position skipped (not under water)" : "liquidation held back by the gas policy");
        continue;
      }
      try {
        const sent = await this.d.chain.send(call, gasLimit);
        const rewardWei = this.d.gas.ethUsdWad > 0n ? (a.rewardUsd * 10n ** 30n) / this.d.gas.ethUsdWad : 0n;
        this.gasWindow.add(this.now(), sent.costWei > rewardWei ? sent.costWei - rewardWei : 0n);
        this.totals.gasWei += sent.costWei;
        this.backlog.done(a.marketId, a.trader);
        if (a.action === "liquidate") {
          pass.liquidated++;
          this.totals.liquidations++;
          this.totals.rewardsUsd += a.rewardUsd;
        } else {
          pass.forceClosed++;
          this.totals.forceCloses++;
        }
        log.info({ tx: sent.hash, rewardUsd6: a.rewardUsd.toString(), badDebtUsd6: a.badDebtUsd.toString(), costWei: sent.costWei.toString() }, a.action === "liquidate" ? "position liquidated" : "position closed out");
      } catch (err) {
        // a transaction mined and reverted burnt its gas: counted in full against the hourly budget (review I-3)
        if (err instanceof TxRevertedError) {
          this.gasWindow.add(this.now(), err.costWei);
          this.totals.gasWei += err.costWei;
        }
        const info = describeRevert(err, REVERT_ABI);
        const cls = err instanceof TxRevertedError ? classifyRevert(undefined, "reverted on chain") : classifyRevert(info.errorName, `${info.reason ?? ""} ${info.message}`);
        if (cls === "raced") {
          pass.raced++;
          this.totals.raced++;
          this.backlog.done(a.marketId, a.trader);
          continue;
        }
        this.backlog.set(a.marketId, a.trader, cls, info.errorName ?? info.message);
        if (cls === "failed") {
          failed = true;
          this.fail(info.errorName ?? info.message);
        }
        log.warn({ revert: info, cls }, "liquidation transaction failed; retrying next pass");
      }
    }
    if (!failed && this.reconcile.error === null) this.ok();
    if (queue.length > 0) busy = true;
    return { markets, busy };
  }
}
