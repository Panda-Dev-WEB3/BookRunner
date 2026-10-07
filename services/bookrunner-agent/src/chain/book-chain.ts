// Read-only chain adapter for one book: charter, mandate, kill/off-hours flags, book state, desk
// balances, Stock Token registry and AttestedOracle views.

import { ACCOUNT, BOOK_STATE, type BookComponents, type BookState, type Charter, type Deployment, type Mandate, VENUE, type VenueId } from "@bookrunner/shared";
import {
  attestedOracleAbi,
  bookAbi,
  bookrunnerConfigAbi,
  bookrunnerDeskAbi,
  mMMandateAbi,
  mockERC20Abi,
  orderlyAdapterAbi,
  poolEngineAbi,
  poolEngineAdapterAbi,
  stockTokenRegistryAbi,
  underwritingVaultAbi,
} from "@bookrunner/shared/abi";
import type { Address, Hex, PublicClient } from "viem";
import { type MmRecallInfo, engineWithdrawableUsd } from "../domain/hedge-planner";
import { type MarkWindowState, capitalFlowOpen } from "../domain/mark-window";

/** Orderly free-margin estimate keeps 10% of |exposure| as initial margin (VERIFY Orderly IMR per symbol). */
const ORDERLY_IM_RESERVE_BPS = 1_000n;

export interface StockTokenInfo {
  token: Address;
  priceId: Hex;
  multiplierWad: bigint;
  decimals: number;
  active: boolean;
  floatCapRaw: bigint;
}

export interface OraclePoint {
  priceWad: bigint;
  publishedAt: number;
  held: boolean;
  sourceCount: number;
}

export class BookChain {
  constructor(
    readonly pub: PublicClient,
    readonly deployment: Deployment,
    readonly components: BookComponents,
  ) {}

  async readCharter(): Promise<Charter> {
    const c = await this.pub.readContract({ address: this.components.book, abi: bookAbi, functionName: "getCharter" });
    return {
      underlying: c.underlying,
      venue: c.venue as VenueId,
      oracle: c.oracle as Charter["oracle"],
      sessions: c.sessions,
      ifTargetUsd: c.ifTargetUsd,
      mmInventoryUsd: c.mmInventoryUsd,
      mandate: toMandate(c.mandate),
      seniorHurdleBps: c.seniorHurdleBps,
      seniorCapBps: c.seniorCapBps,
      subscriptionWindow: c.subscriptionWindow,
      juniorNoticeSeconds: c.juniorNoticeSeconds,
      sponsor: c.sponsor,
      perWalletCapUsd: c.perWalletCapUsd,
      symbol: c.symbol,
      takerFeeBps: c.takerFeeBps,
      makerFeeBps: c.makerFeeBps,
    };
  }

  async readMandate(): Promise<Mandate> {
    const m = await this.pub.readContract({ address: this.components.mandate, abi: mMMandateAbi, functionName: "getMandate" });
    return toMandate(m);
  }

  mandateKilled(): Promise<boolean> {
    return this.pub.readContract({ address: this.components.mandate, abi: mMMandateAbi, functionName: "killed" });
  }

  mandateOffHours(): Promise<boolean> {
    return this.pub.readContract({ address: this.components.mandate, abi: mMMandateAbi, functionName: "offHours" });
  }

  isActiveKey(key: Address): Promise<boolean> {
    return this.pub.readContract({ address: this.components.mandate, abi: mMMandateAbi, functionName: "isActiveKey", args: [key] });
  }

  async bookState(): Promise<BookState> {
    const s = await this.pub.readContract({ address: this.components.book, abi: bookAbi, functionName: "state" });
    const name = BOOK_STATE[s];
    if (!name) throw new Error(`unknown book state ${s}`);
    return name;
  }

  /** Inputs of the desk's mark-window gate on capital flows (domain/mark-window.ts). */
  async markWindow(): Promise<MarkWindowState> {
    const [state, lastMarkPeriodEnd, subscriptionEnds, markInterval] = await Promise.all([
      this.bookState(),
      this.pub.readContract({ address: this.components.book, abi: bookAbi, functionName: "lastMarkPeriodEnd" }),
      this.pub.readContract({ address: this.components.book, abi: bookAbi, functionName: "subscriptionEnds" }),
      this.pub.readContract({ address: this.deployment.contracts.config, abi: bookrunnerConfigAbi, functionName: "markInterval" }),
    ]);
    return { state, lastMarkPeriodEnd: Number(lastMarkPeriodEnd), subscriptionEnds: Number(subscriptionEnds), markInterval: Number(markInterval) };
  }

  /** May a desk key move capital now (no mark pending, with a guard for the tx's inclusion delay)? Chain time. */
  async capitalFlowOpen(): Promise<boolean> {
    const [w, head] = await Promise.all([this.markWindow(), this.pub.getBlock({ blockTag: "latest" })]);
    return capitalFlowOpen(w, Number(head.timestamp));
  }

  deskHedgeUsd(): Promise<bigint> {
    return this.pub.readContract({ address: this.components.desk, abi: bookrunnerDeskAbi, functionName: "hedgeNotionalUsd" });
  }

  deskValueUsd(): Promise<bigint> {
    return this.pub.readContract({ address: this.components.desk, abi: bookrunnerDeskAbi, functionName: "valueUsd" });
  }

  deskUsdc(): Promise<bigint> {
    return this.tokenBalance(this.deployment.contracts.usdc, this.components.desk);
  }

  tokenBalance(token: Address, owner: Address): Promise<bigint> {
    return this.pub.readContract({ address: token, abi: mockERC20Abi, functionName: "balanceOf", args: [owner] });
  }

  priceIdOf(underlying: Hex): Promise<Hex> {
    return this.pub.readContract({ address: this.deployment.contracts.stockRegistry, abi: stockTokenRegistryAbi, functionName: "priceIdOf", args: [underlying] });
  }

  isIndex(underlying: Hex): Promise<boolean> {
    return this.pub.readContract({ address: this.deployment.contracts.stockRegistry, abi: stockTokenRegistryAbi, functionName: "isIndex", args: [underlying] });
  }

  async getIndex(underlying: Hex): Promise<{ priceId: Hex; components: Array<{ token: Address; weightBps: number }> }> {
    const [priceId, comps] = await this.pub.readContract({
      address: this.deployment.contracts.stockRegistry,
      abi: stockTokenRegistryAbi,
      functionName: "getIndex",
      args: [underlying],
    });
    return { priceId, components: comps.map((c) => ({ token: c.token, weightBps: Number(c.weightBps) })) };
  }

  async getToken(token: Address): Promise<StockTokenInfo> {
    const t = await this.pub.readContract({ address: this.deployment.contracts.stockRegistry, abi: stockTokenRegistryAbi, functionName: "getToken", args: [token] });
    return { token: t.token, priceId: t.priceId, multiplierWad: t.multiplierWad, decimals: t.decimals, active: t.active, floatCapRaw: t.floatCapRaw };
  }

  async oracleLatest(priceId: Hex): Promise<OraclePoint> {
    const p = await this.pub.readContract({ address: this.deployment.contracts.oracle, abi: attestedOracleAbi, functionName: "latest", args: [priceId] });
    return { priceWad: p.priceWad, publishedAt: Number(p.publishedAt), held: p.held, sourceCount: Number(p.sourceCount) };
  }

  async maxPriceAge(): Promise<number> {
    const v = await this.pub.readContract({ address: this.deployment.contracts.config, abi: bookrunnerConfigAbi, functionName: "maxPriceAge" });
    return Number(v);
  }

  /** IVenueAdapter.netExposureUsd() (same selector on both adapters). */
  adapterExposureUsd(): Promise<bigint> {
    return this.pub.readContract({ address: this.components.adapter, abi: poolEngineAdapterAbi, functionName: "netExposureUsd" });
  }

  /** IVenueAdapter.valuationAt(): block time on-chain venues, last report on Orderly. */
  async adapterValuationAt(): Promise<number> {
    return Number(await this.pub.readContract({ address: this.components.adapter, abi: poolEngineAdapterAbi, functionName: "valuationAt" }));
  }

  /** UnderwritingVault.deployable(): idle USDC not reserved for unfunded claims (FundDesk bound). */
  vaultDeployable(): Promise<bigint> {
    return this.pub.readContract({ address: this.components.vault, abi: underwritingVaultAbi, functionName: "deployable" });
  }

  /**
   * What a desk InventoryToVault(MM) can bring to the vault now. Engine: synchronous, bounded by
   * PoolEngine.withdrawLiquidity (pool cash and required pool margin). Orderly: asynchronous
   * (ops-venue executes it), bounded by the reported MM margin less an initial-margin reserve;
   * requested + confirmed-unswept withdrawals count as in flight.
   */
  async mmRecall(): Promise<MmRecallInfo> {
    const adapter = this.components.adapter;
    const kind = await this.pub.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "venueKind" });
    if (kind === VENUE.POOL_ENGINE) {
      const [engine, marketId] = await Promise.all([
        this.pub.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "engine" }),
        this.pub.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "marketId" }),
      ]);
      const [st, equity, required] = await Promise.all([
        this.pub.readContract({ address: engine, abi: poolEngineAbi, functionName: "state", args: [marketId] }),
        this.pub.readContract({ address: engine, abi: poolEngineAbi, functionName: "poolEquityUsd", args: [marketId] }),
        this.pub.readContract({ address: engine, abi: poolEngineAbi, functionName: "requiredPoolMarginUsd", args: [marketId] }),
      ]);
      return { sync: true, inFlightUsd: 0n, recallableUsd: engineWithdrawableUsd(st.poolCashUsd, equity, required) };
    }
    const [margin, exposure, inTransit, pendingIf, pendingMm] = await Promise.all([
      this.pub.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "marginEquityUsd" }),
      this.pub.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "netExposureUsd" }),
      this.pub.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "inTransitUsd" }),
      this.pub.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "pendingWithdrawUsd", args: [ACCOUNT.IF] }),
      this.pub.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "pendingWithdrawUsd", args: [ACCOUNT.MM] }),
    ]);
    const absExposure = exposure < 0n ? -exposure : exposure;
    const free = margin - (absExposure * ORDERLY_IM_RESERVE_BPS) / 10_000n;
    return { sync: false, inFlightUsd: inTransit + pendingIf + pendingMm, recallableUsd: free > 0n ? free : 0n };
  }

  orderlyMmAccountId(): Promise<Hex> {
    return this.pub.readContract({ address: this.components.adapter, abi: orderlyAdapterAbi, functionName: "accountId", args: [ACCOUNT.MM] });
  }
}

export function toMandate(m: {
  maxInventoryUsd: bigint;
  maxSkewBps: number;
  minQuoteWidthBps: number;
  maxHedgeLeverage: number;
  hedgeRatioMinBps: number;
  hedgeRatioMaxBps: number;
  noNewRiskOffHours: boolean;
  killAtDrawdownBps: number;
  hedgeAllowRoot: Hex;
}): Mandate {
  return {
    maxInventoryUsd: m.maxInventoryUsd,
    maxSkewBps: m.maxSkewBps,
    minQuoteWidthBps: m.minQuoteWidthBps,
    maxHedgeLeverage: m.maxHedgeLeverage,
    hedgeRatioMinBps: m.hedgeRatioMinBps,
    hedgeRatioMaxBps: m.hedgeRatioMaxBps,
    noNewRiskOffHours: m.noNewRiskOffHours,
    killAtDrawdownBps: m.killAtDrawdownBps,
    hedgeAllowRoot: m.hedgeAllowRoot,
  };
}
