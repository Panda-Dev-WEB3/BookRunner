// viem implementation of the ChainGateway with a short-TTL Redis cache for repeated reads.
// Reads are parallel readContract calls: the shared public client batches them through Multicall3
// where the chain defines it and falls back to plain eth_call otherwise (anvil has no Multicall3,
// so explicit client.multicall() would fail on devnet).
import type { Charter, Deployment, Mandate } from "@bookrunner/shared";
import { isTokenUnderlying, underlyingToToken } from "@bookrunner/shared";
import {
  bkrnStakingAbi,
  bookAbi,
  bookrunnerConfigAbi,
  marketCharterAbi,
  mMMandateAbi,
  riskCommitteeAbi,
  stockTokenRegistryAbi,
  trancheAbi,
} from "@bookrunner/shared/abi";
import { type Address, type Hex, type PublicClient, erc20Abi, getAddress, zeroAddress } from "viem";
import { type Kv, cached } from "../kv";
import type {
  BookChainState,
  ChainGateway,
  CharterChainRecord,
  CommitteeState,
  MandateChainState,
  ProtocolParams,
  TrancheWalletState,
} from "./gateway";

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
    return this.client.readContract({ address: this.c.charter, abi: marketCharterAbi, functionName: "validate", args: [c] });
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

  trancheWallet(tranche: Address, wallet: Address, requestIds: bigint[]): Promise<TrancheWalletState> {
    const ids = [...new Set(requestIds.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
    return cached(this.kv, this.key("tranche", tranche.toLowerCase(), wallet.toLowerCase(), ids.join(",")), this.ttlSeconds, async () => {
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
}
