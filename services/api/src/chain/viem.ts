// viem implementation of the ChainGateway with a short-TTL Redis cache for repeated reads.
// Reads are parallel readContract calls: the shared public client batches them through Multicall3
// where the chain defines it and falls back to plain eth_call otherwise (anvil has no Multicall3,
// so explicit client.multicall() would fail on devnet).
import type { Charter, Deployment, Mandate } from "@bookrunner/shared";
import { charterArg, isTokenUnderlying, underlyingToToken } from "@bookrunner/shared";
import {
  attestedOracleAbi,
  bkrnStakingAbi,
  bookAbi,
  bookrunnerConfigAbi,
  insurancePoolAbi,
  marketCharterAbi,
  mMMandateAbi,
  poolEngineAbi,
  poolEngineAdapterAbi,
  riskCommitteeAbi,
  stockTokenRegistryAbi,
  trancheAbi,
  underwritingVaultAbi,
} from "@bookrunner/shared/abi";
import { type Address, type Hex, type PublicClient, erc20Abi, getAddress, zeroAddress } from "viem";
import { type Kv, cached } from "../kv";
import type {
  BookChainState,
  ChainGateway,
  CharterChainRecord,
  CommitteeState,
  EngineMarketChainState,
  EngineTraderChainState,
  MandateChainState,
  PoolChainState,
  PoolWalletState,
  ProtocolParams,
  TrancheWalletState,
} from "./gateway";

/** One whole pool share (12 decimals: settlement token 6 + the pool's virtual offset 6). */
export const POOL_SHARE_UNIT = 10n ** 12n;

/** Value of a read that may revert (e.g. a view not valid in the current book state). */
async function orDefault<T>(p: Promise<T>, fallback: T): Promise<{ ok: boolean; v: T }> {
  try {
    return { ok: true, v: await p };
  } catch {
    return { ok: false, v: fallback };
  }
}

export class ViemChainGateway implements ChainGateway {
  readonly chainId: number;

  constructor(
    private readonly client: PublicClient,
    readonly deployment: Deployment,
    private readonly kv: Kv,
    private readonly ttlSeconds: number,
  ) {
    this.chainId = deployment.chainId;
  }

  private get c() {
    return this.deployment.contracts;
  }

  private key(...parts: Array<string | number | bigint>) {
    return `${this.chainId}:${parts.join(":")}`;
  }

  params(): Promise<ProtocolParams> {
    return cached(this.kv, this.key("params"), Math.max(this.ttlSeconds, 30), async () => {
      const address = this.c.config;
      const abi = bookrunnerConfigAbi;
      const r = this.client;
      const [charterFeeUsd, sponsorBondBkrn, committeeBondBkrn, markInterval, maxPriceAge, newBooksPaused, minOrderly, minEngine] = await Promise.all([
        r.readContract({ address, abi, functionName: "charterFeeUsd" }),
        r.readContract({ address, abi, functionName: "sponsorBondBkrn" }),
        r.readContract({ address, abi, functionName: "committeeBondBkrn" }),
        r.readContract({ address, abi, functionName: "markInterval" }),
        r.readContract({ address, abi, functionName: "maxPriceAge" }),
        r.readContract({ address, abi, functionName: "newBooksPaused" }),
        r.readContract({ address, abi, functionName: "venueMinIfUsd", args: [0] }),
        r.readContract({ address, abi, functionName: "venueMinIfUsd", args: [1] }),
      ]);
      return {
        charterFeeUsd,
        sponsorBondBkrn,
        committeeBondBkrn,
        markInterval: Number(markInterval),
        maxPriceAge: Number(maxPriceAge),
        newBooksPaused,
        venueMinIfUsd: [minOrderly, minEngine],
      };
    });
  }

  validateCharter(c: Charter): Promise<Hex> {
    return this.client.readContract({ address: this.c.charter, abi: marketCharterAbi, functionName: "validate", args: [charterArg(c)] });
  }

  async underlyingKnown(underlying: Hex): Promise<boolean> {
    const address = this.c.stockRegistry;
    if (isTokenUnderlying(underlying)) {
      return this.client.readContract({ address, abi: stockTokenRegistryAbi, functionName: "isCanonical", args: [underlyingToToken(underlying)] });
    }
    return this.client.readContract({ address, abi: stockTokenRegistryAbi, functionName: "isIndex", args: [underlying] });
  }

  async charterRecord(charterId: number): Promise<CharterChainRecord | null> {
    const count = await this.client.readContract({ address: this.c.charter, abi: marketCharterAbi, functionName: "count" });
    if (charterId <= 0 || BigInt(charterId) > count) return null;
    const r = await this.client.readContract({ address: this.c.charter, abi: marketCharterAbi, functionName: "get", args: [BigInt(charterId)] });
    return { status: Number(r.status), filedAt: Number(r.filedAt), decidedAt: Number(r.decidedAt), juryCid: r.juryCid, book: r.book };
  }

  async committeeState(charterId: number): Promise<CommitteeState> {
    const address = this.c.committee;
    const abi = riskCommitteeAbi;
    const id = BigInt(charterId);
    const [members, verdict, votes] = await Promise.all([
      this.client.readContract({ address, abi, functionName: "members" }),
      this.client.readContract({ address, abi, functionName: "juryVerdict", args: [id] }),
      this.client.readContract({ address, abi, functionName: "votesOf", args: [id] }),
    ]);
    const seated = members.filter((m) => m !== zeroAddress).map((m) => getAddress(m));
    const memberStatus = await Promise.all(
      seated.map(async (member) => {
        const [bonded, voted] = await Promise.all([
          this.client.readContract({ address, abi, functionName: "isBonded", args: [member] }),
          this.client.readContract({ address, abi, functionName: "hasVoted", args: [id, member] }),
        ]);
        return { member, bonded, voted };
      }),
    );
    return {
      members: seated,
      juryVerdict: { cid: verdict[0], recommendApprove: verdict[1], posted: verdict[2] },
      approvals: Number(votes[0]),
      rejections: Number(votes[1]),
      memberStatus,
    };
  }

  stakeAvailable(account: Address): Promise<bigint> {
    return this.client.readContract({ address: this.c.staking, abi: bkrnStakingAbi, functionName: "availableOf", args: [account] });
  }

  operatorConsent(mandate: Address, operator: Address, key: Address): Promise<boolean> {
    return this.client.readContract({ address: mandate, abi: mMMandateAbi, functionName: "operatorConsent", args: [operator, key] });
  }

  agentTierBond(inventoryUsd: bigint): Promise<bigint> {
    return this.client.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "agentTierBond", args: [inventoryUsd] });
  }

  async usdcState(wallet: Address, spender: Address) {
    const [balance, allowance] = await Promise.all([
      this.client.readContract({ address: this.c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
      this.client.readContract({ address: this.c.usdc, abi: erc20Abi, functionName: "allowance", args: [wallet, spender] }),
    ]);
    return { balance, allowance };
  }

  bookState(book: Address): Promise<BookChainState> {
    return cached(this.kv, this.key("book", book.toLowerCase()), this.ttlSeconds, async () => {
      const abi = bookAbi;
      const r = this.client;
      const [state, subscriptionEnds, sp, jp, navs, lastMarkId, topUp] = await Promise.all([
        r.readContract({ address: book, abi, functionName: "state" }),
        r.readContract({ address: book, abi, functionName: "subscriptionEnds" }),
        r.readContract({ address: book, abi, functionName: "sharePrice", args: [0] }),
        r.readContract({ address: book, abi, functionName: "sharePrice", args: [1] }),
        r.readContract({ address: book, abi, functionName: "trancheNav" }),
        r.readContract({ address: book, abi, functionName: "lastMarkId" }),
        r.readContract({ address: book, abi, functionName: "topUp" }).catch(() => null),
      ]);
      return {
        state: Number(state),
        subscriptionEnds: Number(subscriptionEnds),
        seniorPriceWad: sp,
        juniorPriceWad: jp,
        seniorNav: navs[0],
        juniorNav: navs[1],
        lastMarkId: Number(lastMarkId),
        topUp: topUp ? { open: topUp[0], endsAt: Number(topUp[1]) } : null,
      };
    });
  }

  /**
   * Never served from the TTL cache: it is wallet-scoped, and the wallet re-reads it right after its
   * own transaction confirms (tranche.position after a claim, subscribe / redeem / claim preparing the
   * next step). A cached answer from before the transaction showed 'Ready to collect' after a claim
   * and could prepare a no-op claimAllocation that still costs gas.
   */
  trancheWallet(tranche: Address, wallet: Address, requestIds: bigint[]): Promise<TrancheWalletState> {
    const ids = [...new Set(requestIds.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
    return cached(this.kv, this.key("tranche", tranche.toLowerCase(), wallet.toLowerCase(), ids.join(",")), 0, async () => {
      const abi = trancheAbi;
      const r = this.client;
      const address = tranche;
      const [shares, totalSupply, committed, totalCommitted, depositsOpen, paused, alloc, claimableAssets] = await Promise.all([
        orDefault(r.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }), 0n),
        orDefault(r.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }), 0n),
        orDefault(r.readContract({ address, abi, functionName: "committedOf", args: [wallet] }), 0n),
        orDefault(r.readContract({ address, abi, functionName: "totalCommitted" }), 0n),
        orDefault(r.readContract({ address, abi, functionName: "depositsOpen" }), false),
        orDefault(r.readContract({ address, abi, functionName: "paused" }), false),
        orDefault(r.readContract({ address, abi, functionName: "claimableAllocation", args: [wallet] }), [0n, 0n] as readonly [bigint, bigint]),
        orDefault(r.readContract({ address, abi, functionName: "claimableAssets", args: [wallet] }), 0n),
      ]);
      if (![shares, totalSupply, committed, depositsOpen].some((x) => x.ok)) throw new Error(`tranche ${tranche}: view calls failed`);
      const [nav, buckets] = await Promise.all([
        orDefault(r.readContract({ address, abi, functionName: "convertToAssets", args: [shares.v] }), 0n),
        Promise.all(
          ids.map(async (requestId) => {
            const [pending, claimable] = await Promise.all([
              orDefault(r.readContract({ address, abi, functionName: "pendingRedeemRequest", args: [requestId, wallet] }), 0n),
              orDefault(r.readContract({ address, abi, functionName: "claimableRedeemRequest", args: [requestId, wallet] }), 0n),
            ]);
            return { requestId, pendingShares: pending.v, claimableShares: claimable.v };
          }),
        ),
      ]);
      return {
        shares: shares.v,
        totalSupply: totalSupply.v,
        committed: committed.v,
        totalCommitted: totalCommitted.v,
        depositsOpen: depositsOpen.v,
        paused: paused.v,
        claimableShares: alloc.v[0],
        claimableRefund: alloc.v[1],
        claimableAssets: claimableAssets.v,
        navValue: nav.v,
        buckets,
      };
    });
  }

  async claimLiquidity(tranche: Address, vault: Address): Promise<bigint> {
    const [escrow, idle] = await Promise.all([
      this.client.readContract({ address: tranche, abi: trancheAbi, functionName: "redemptionLiquidity" }),
      this.client.readContract({ address: vault, abi: underwritingVaultAbi, functionName: "idle" }),
    ]);
    return escrow + idle;
  }

  mandateState(mandate: Address): Promise<MandateChainState> {
    return cached(this.kv, this.key("mandate", mandate.toLowerCase()), this.ttlSeconds, async () => {
      const abi = mMMandateAbi;
      const r = this.client;
      const [m, killed, killReason, keys] = await Promise.all([
        r.readContract({ address: mandate, abi, functionName: "getMandate" }),
        r.readContract({ address: mandate, abi, functionName: "killed" }),
        r.readContract({ address: mandate, abi, functionName: "killReason" }),
        r.readContract({ address: mandate, abi, functionName: "activeKeys" }),
      ]);
      const out: Mandate = {
        maxInventoryUsd: m.maxInventoryUsd,
        maxSkewBps: Number(m.maxSkewBps),
        minQuoteWidthBps: Number(m.minQuoteWidthBps),
        maxHedgeLeverage: Number(m.maxHedgeLeverage),
        hedgeRatioMinBps: Number(m.hedgeRatioMinBps),
        hedgeRatioMaxBps: Number(m.hedgeRatioMaxBps),
        noNewRiskOffHours: m.noNewRiskOffHours,
        killAtDrawdownBps: Number(m.killAtDrawdownBps),
        hedgeAllowRoot: m.hedgeAllowRoot,
      };
      return { mandate: out, killed, killReason, activeKeys: keys.map((k) => getAddress(k)) };
    });
  }

  // ------------------------------------------------------------------ insurance pool (2026-10)
  private get pool(): Address | null {
    const p = this.c.insurancePool;
    return p && p !== zeroAddress ? p : null;
  }

  async poolState(): Promise<PoolChainState | null> {
    const address = this.pool;
    if (!address) return null;
    return cached(this.kv, this.key("pool"), this.ttlSeconds, async () => {
      const abi = insurancePoolAbi;
      const r = this.client;
      const block = await r.getBlock();
      const blockNumber = block.number;
      const q = { address, abi, blockNumber } as const;
      const [poolAssets, depositorAssets, totalSupply, sharePrice, firstLoss, firstLossBps, freeLiquidity, claims, utilisation, ledger, params, paused, queue, active] = await Promise.all([
        r.readContract({ ...q, functionName: "poolAssets" }),
        r.readContract({ ...q, functionName: "totalAssets" }),
        r.readContract({ ...q, functionName: "totalSupply" }),
        r.readContract({ ...q, functionName: "convertToAssets", args: [POOL_SHARE_UNIT] }),
        r.readContract({ ...q, functionName: "firstLossAssets" }),
        r.readContract({ ...q, functionName: "firstLossBps" }),
        r.readContract({ ...q, functionName: "freeLiquidity" }),
        r.readContract({ ...q, functionName: "claimsTotal" }),
        r.readContract({ ...q, functionName: "utilisationBps" }),
        r.readContract({ ...q, functionName: "ledger" }),
        r.readContract({ ...q, functionName: "params" }),
        r.readContract({ ...q, functionName: "paused" }),
        r.readContract({ ...q, functionName: "queue" }),
        r.readContract({ ...q, functionName: "activeBooks" }),
      ]);
      const [epoch, stale] = await Promise.all([
        r.readContract({ ...q, functionName: "epochInfo", args: [queue[0]] }),
        r.readContract({ ...q, functionName: "staleBooks", args: [BigInt(queue[1])] }),
      ]);
      return {
        address,
        nowSec: Number(block.timestamp),
        poolAssets,
        depositorAssets,
        totalSupply,
        sharePrice,
        firstLoss,
        firstLossBps: Number(firstLossBps),
        freeLiquidity,
        claims,
        utilisationBps: Number(utilisation),
        premiumsTotal: ledger[3],
        lossesTotal: ledger[4],
        depositsPending: ledger[2],
        params: {
          premiumFloorBps: Number(params[0]),
          marketCapBps: Number(params[1]),
          bufferBps: Number(params[2]),
          firstLossTargetBps: Number(params[3]),
          cooldown: Number(params[4]),
          epochLength: Number(params[5]),
          processGrace: Number(params[6]),
          pendingEpochLength: Number(params[7]),
        },
        paused: { deposits: paused[0], allocations: paused[1] },
        queue: { procEpoch: Number(queue[0]), procEndsAt: Number(queue[1]), fillEpoch: Number(queue[2]), pendingShares: queue[3], reserved: queue[4] },
        openEpoch: { depositAssets: epoch.depositAssets, withdrawShares: epoch.shares },
        staleBooks: Number(stale),
        activeBooks: active.map(Number),
      };
    });
  }

  async poolWallet(wallet: Address, ids: { requestIds: number[]; depositIds: number[]; epochs: number[] }): Promise<PoolWalletState | null> {
    const address = this.pool;
    if (!address) return null;
    const abi = insurancePoolAbi;
    const r = this.client;
    const uniq = (xs: number[]) => [...new Set(xs.filter((x) => Number.isSafeInteger(x) && x >= 0))];
    const [shares, cooldownEnds, usdcBalance, usdcAllowance] = await Promise.all([
      r.readContract({ address, abi, functionName: "balanceOf", args: [wallet] }),
      r.readContract({ address, abi, functionName: "cooldownEnds", args: [wallet] }),
      r.readContract({ address: this.c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
      r.readContract({ address: this.c.usdc, abi: erc20Abi, functionName: "allowance", args: [wallet, address] }),
    ]);
    const [value, claimable, deposits, epochs] = await Promise.all([
      shares === 0n ? Promise.resolve(0n) : r.readContract({ address, abi, functionName: "convertToAssets", args: [shares] }),
      Promise.all(uniq(ids.requestIds).map(async (id) => [id, await r.readContract({ address, abi, functionName: "claimable", args: [BigInt(id)] })] as const)),
      Promise.all(uniq(ids.depositIds).map(async (id) => [id, await r.readContract({ address, abi, functionName: "depositInfo", args: [BigInt(id)] })] as const)),
      Promise.all(uniq(ids.epochs).map(async (e) => [e, await r.readContract({ address, abi, functionName: "epochInfo", args: [BigInt(e)] })] as const)),
    ]);
    return {
      shares,
      value,
      cooldownEnds: Number(cooldownEnds),
      usdcBalance,
      usdcAllowance,
      claimable: new Map(claimable),
      deposits: new Map(deposits.map(([id, d]) => [id, { owner: getAddress(d.owner), epoch: Number(d.epoch), done: d.done, assets: d.assets }])),
      epochs: new Map(
        epochs.map(([e, x]) => [
          e,
          { shares: x.shares, filledShares: x.filledShares, assets: x.assets, depositAssets: x.depositAssets, depositShares: x.depositShares, endsAt: Number(x.endsAt), processed: x.processed },
        ]),
      ),
    };
  }

  // ------------------------------------------------------------------ in-house engine (2026-10 trading page)
  private engineMarketId(adapter: Address): Promise<number> {
    // fixed at the adapter's initialisation: cached for an hour
    return cached(this.kv, this.key("engine-market-id", adapter.toLowerCase()), 3_600, async () =>
      Number(await this.client.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "marketId" })),
    );
  }

  async engineMarket(adapter: Address): Promise<EngineMarketChainState | null> {
    const engine = this.c.poolEngine;
    if (!engine || engine === zeroAddress) return null;
    const marketId = await this.engineMarketId(adapter);
    if (marketId === 0) return null;
    return cached(this.kv, this.key("engine-market", marketId), this.ttlSeconds, async () => {
      const r = this.client;
      const id = BigInt(marketId);
      const e = { address: engine, abi: poolEngineAbi } as const;
      const cfgAddr = this.c.config;
      const [block, cfg, st, cap, closeOut, funding, budget, maxPriceAge, maxTradePriceAge] = await Promise.all([
        r.getBlock(),
        r.readContract({ ...e, functionName: "config", args: [id] }),
        r.readContract({ ...e, functionName: "state", args: [id] }),
        r.readContract({ ...e, functionName: "inventoryCapUsd", args: [id] }),
        r.readContract({ ...e, functionName: "closeOutAfter", args: [id] }),
        // reverts NoPrice while an open market was never priced
        orDefault(r.readContract({ ...e, functionName: "fundingRatePerDayWad", args: [id] }), 0n),
        orDefault(r.readContract({ ...e, functionName: "lossBudget", args: [id] }), null),
        r.readContract({ address: cfgAddr, abi: bookrunnerConfigAbi, functionName: "maxPriceAge" }),
        // an older config without the getter: the engine default (15 s)
        orDefault(r.readContract({ address: cfgAddr, abi: bookrunnerConfigAbi, functionName: "maxTradePriceAge" }), 15),
      ]);
      const latest = await r.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [cfg.underlying] });
      return {
        engine: getAddress(engine),
        adapter: getAddress(adapter),
        marketId,
        nowSec: Number(block.timestamp),
        config: {
          underlying: cfg.underlying,
          symbol: cfg.symbol,
          takerFeeBps: Number(cfg.takerFeeBps),
          makerFeeBps: Number(cfg.makerFeeBps),
          initialMarginBps: Number(cfg.initialMarginBps),
          maintenanceMarginBps: Number(cfg.maintenanceMarginBps),
          liquidationFeeBps: Number(cfg.liquidationFeeBps),
          fundingVelocityBps: Number(cfg.fundingVelocityBps),
          maxNetExposureUsd: cfg.maxNetExposureUsd,
        },
        state: {
          spreadBps: Number(st.spreadBps),
          skewBps: Number(st.skewBps),
          reduceOnly: st.reduceOnly,
          longSize: st.longSize,
          shortSize: st.shortSize,
          poolCashUsd: st.poolCashUsd,
          insuranceUsd: st.insuranceUsd,
          fundingIndex: st.fundingIndex,
        },
        inventoryCapUsd: cap,
        closeOutAfter: Number(closeOut),
        fundingRatePerDayWad: funding.v,
        lossBudgetBlocked: budget.v ? budget.v[5] : false,
        stored: latest.priceWad > 0n && latest.publishedAt > 0n ? { priceWad: latest.priceWad, publishedAt: Number(latest.publishedAt), held: latest.held } : null,
        maxPriceAge: Number(maxPriceAge),
        maxTradePriceAge: Number(maxTradePriceAge.v),
      };
    });
  }

  async engineTrader(marketId: number, wallet: Address): Promise<EngineTraderChainState> {
    const engine = this.c.poolEngine;
    const r = this.client;
    const [p, usdcBalance, usdcAllowance] = await Promise.all([
      r.readContract({ address: engine, abi: poolEngineAbi, functionName: "positionOf", args: [BigInt(marketId), wallet] }),
      r.readContract({ address: this.c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
      r.readContract({ address: this.c.usdc, abi: erc20Abi, functionName: "allowance", args: [wallet, engine] }),
    ]);
    return { position: { size: p.size, entryPriceWad: p.entryPriceWad, marginUsd: p.marginUsd, fundingIndexAtEntry: p.fundingIndexAtEntry }, usdcBalance, usdcAllowance };
  }

  async splitGate(priceId: Hex, basisAt: number): Promise<{ pending: boolean; window: boolean }> {
    const reg = this.c.stockRegistry;
    if (!reg || reg === zeroAddress) return { pending: false, window: false };
    return cached(this.kv, this.key("split-gate", priceId.toLowerCase(), basisAt), this.ttlSeconds, async () => {
      const [pending, window] = await this.client.readContract({ address: reg, abi: stockTokenRegistryAbi, functionName: "splitGate", args: [priceId, BigInt(basisAt)] });
      return { pending, window };
    });
  }
}
