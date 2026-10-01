// Read-only chain adapter for one book: charter, mandate, kill/off-hours flags, book state, desk
// balances, Stock Token registry and AttestedOracle views.

import { ACCOUNT, BOOK_STATE, type BookComponents, type BookState, type Charter, type Deployment, type Mandate, type VenueId } from "@bookrunner/shared";
import {
  attestedOracleAbi,
  bookAbi,
  bookrunnerConfigAbi,
  bookrunnerDeskAbi,
  mMMandateAbi,
  mockERC20Abi,
  orderlyAdapterAbi,
  poolEngineAdapterAbi,
  stockTokenRegistryAbi,
} from "@bookrunner/shared/abi";
import type { Address, Hex, PublicClient } from "viem";

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
