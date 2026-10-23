// Liquidation keeper for the in-house engine markets (2026-10; docs/RUNBOOK.md "Opening the first in-house engine
// market"). A job of the waterfall keeper process: the KEEPER role key (roleSigner, local or KMS), the serialised
// TxSender (no nonce race with the settlement / keeper transactions), its own cadence.
// One pass:
//   1. the trader set from the indexer's engine_positions (open rows only; no chain scan); no open position: no RPC;
//   2. ONE read of every market's state + oracle price + settle price and every open position (Multicall3 aggregate3
//      on mainnet), market configs and the protocol's price bounds cached;
//   3. the freshest signed print per market from the oracle's Redis bundle; the engine's own rule off-chain at the
//      price the transaction would use (domain/liquidation.ts); nothing is sent for a position that is not liquidatable
//      there (or, for forceClose, not in a wind-down / settled market);
//   4. per action: eth_estimateGas (also the race check: NotLiquidatable / NoPosition = someone else was first), the
//      gas guard (cost <= reward + margin, per-tx and hourly caps), then liquidate(marketId, trader, priceData) or
//      forceClose(marketId, trader, priceData) through the sender;
//   5. the status (backlog with reasons, failure run, totals) to KEYS.liquidationKeeper for alerts and the API.
// The next pass comes after `intervalMs` while a market trades (or closes out), `idleIntervalMs` otherwise (off-hours:
// the held price does not move; a session close is caught by the first pass after it).
import type { Logger } from "@bookrunner/shared";
import type { EnginePosition } from "@bookrunner/shared/engineMath";
import type { LiquidationKeeperStatus, LiquidationMarketStatus } from "@bookrunner/shared/liquidationKeeper";
import type { SignedPrice } from "@bookrunner/shared/signedPrice";
import { attestedOracleAbi, poolEngineAbi } from "@bookrunner/shared/abi";
import type { Abi, Hex } from "viem";
import {
  Backlog,
  type EngineMarketCfg,
  type GasPolicy,
  GasWindow,
  type KeeperAction,
  type MarketRead,
  type ProtocolParams,
  classifyRevert,
  decideMarket,
  gasAllowanceWei,
  priceUsed,
  regimeOf,
} from "./domain/liquidation";
import { describeRevert } from "./kit/tx";

export interface LiqCall {
  functionName: "liquidate" | "forceClose";
  marketId: number;
  trader: string;
  priceData: Hex;
}

export interface LiquidationChain {
  /** Market configs (underlying, margins, liquidation fee) and the protocol's price bounds; cached by the runner. */
  readConfigs(marketIds: number[]): Promise<{ cfgs: Map<number, EngineMarketCfg>; params: ProtocolParams }>;
  /** ONE batched read: each market's state / close-out / oracle latest / settle price, and every position. */
  readPass(markets: Array<{ marketId: number; underlying: Hex }>, traders: Array<{ marketId: number; trader: string }>): Promise<{
    markets: Map<number, Omit<MarketRead, "cfg">>;
    positions: Map<string, EnginePosition>;
  }>;
  /** eth_estimateGas from the keeper; throws the revert. */
  estimate(call: LiqCall): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  /** Sends through the serialised sender with this gas limit; the mined receipt's cost. */
  send(call: LiqCall, gas: bigint): Promise<{ hash: Hex; costWei: bigint }>;
}

export interface LiquidationDeps {
  chain: LiquidationChain;
  /** open (marketId, trader) rows of engine_positions */
  openPositions(): Promise<Array<{ marketId: number; trader: string }>>;
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
  maxPositions: number;
  /** configs re-read at most this often (ms) */
  configTtlMs?: number;
  now?: () => number;
}

/** Engine + oracle custom errors, to name a revert (NotLiquidatable, StalePrice, BadSigner, ...). */
const REVERT_ABI = [...poolEngineAbi, ...attestedOracleAbi] as unknown as Abi;

const posKey = (marketId: number, trader: string) => `${marketId}|${trader.toLowerCase()}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

export class LiquidationKeeper {
  private readonly backlog = new Backlog();
  private readonly gasWindow = new GasWindow();
  private cfgs = new Map<number, EngineMarketCfg>();
  private params: ProtocolParams | null = null;
  private cfgAt = 0;
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
    const pass = { checked: 0, liquidated: 0, forceClosed: 0, raced: 0 };
    let markets: LiquidationMarketStatus[] = [];
    let busy = false;
    try {
      const open = (await this.d.openPositions()).slice(0, this.d.maxPositions);
      if (open.length === 0) {
        this.backlog.observe([], started);
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

  private async run(open: Array<{ marketId: number; trader: string }>, pass: { checked: number; liquidated: number; forceClosed: number; raced: number }) {
    const ids = [...new Set(open.map((o) => o.marketId))].sort((a, b) => a - b);
    await this.configs(ids);
    const params = this.params as ProtocolParams;
    const list = ids.flatMap((id) => {
      const c = this.cfgs.get(id);
      return c ? [{ marketId: id, underlying: c.underlying }] : [];
    });
    const read = await this.d.chain.readPass(list, open);
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
    this.backlog.observe(actions, this.now());
    // liquidations (they pay) before close-outs, the largest reward first
    const queue = [...actions].sort((a, b) => (a.action === b.action ? (b.rewardUsd > a.rewardUsd ? 1 : b.rewardUsd < a.rewardUsd ? -1 : 0) : a.action === "liquidate" ? -1 : 1));
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
      const cost = estimate * gasPrice;
      const allowance = gasAllowanceWei(this.d.gas, a.rewardUsd, this.gasWindow.spent(this.now()));
      if (cost > allowance) {
        this.backlog.set(a.marketId, a.trader, "gas_guard", `cost ${cost} wei > allowance ${allowance} wei (reward ${a.rewardUsd} usd6)`);
        log.warn({ costWei: cost.toString(), allowanceWei: allowance.toString(), rewardUsd6: a.rewardUsd.toString() }, "liquidation skipped by the gas guard");
        continue;
      }
      try {
        // eth_estimateGas is tight: +30% + 30k, as every keeper transaction (kit/tx.ts bufferedGas)
        const sent = await this.d.chain.send(call, (estimate * 13n) / 10n + 30_000n);
        this.gasWindow.add(this.now(), sent.costWei);
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
        log.info({ tx: sent.hash, rewardUsd6: a.rewardUsd.toString(), costWei: sent.costWei.toString() }, a.action === "liquidate" ? "position liquidated" : "position closed out");
      } catch (err) {
        const info = describeRevert(err, REVERT_ABI);
        const cls = classifyRevert(info.errorName, `${info.reason ?? ""} ${info.message}`);
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
    if (!failed) this.ok();
    if (queue.length > 0) busy = true;
    return { markets, busy };
  }
}
