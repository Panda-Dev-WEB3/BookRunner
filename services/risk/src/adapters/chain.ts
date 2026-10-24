// viem adapter: book discovery, per-tick reads and RISK-role writes. Every write is simulated
// first, sent from roleAccount("risk") with a buffered gas limit, serialised through one mutex
// (single nonce stream) and awaited to a successful receipt; tx hashes are logged.
import {
  ACCOUNT,
  BOOK_STATE,
  type BookComponents,
  type BookState,
  type Deployment,
  HEDGE_VENUES,
  type Logger,
  VENUE,
  type VenueId,
  bytes32ToStr,
  inSplitWindow,
  priceBasisAt,
  strToBytes32,
  valueAtMultiplier,
} from "@bookrunner/shared";
import {
  attestedOracleAbi,
  bookAbi,
  bookFactoryAbi,
  bookrunnerConfigAbi,
  bookrunnerDeskAbi,
  mMMandateAbi,
  orderlyAdapterAbi,
  poolEngineAbi,
  poolEngineAdapterAbi,
  stockTokenRegistryAbi,
  underwritingVaultAbi,
} from "@bookrunner/shared/abi";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeAbiParameters,
  erc20Abi,
  parseAbiParameters,
  zeroHash,
} from "viem";
import { readAfterPriceUpdate, unbatchedClient } from "../../../mark/src/adapters/priceSim";
import { type SignedPrice, encodePriceData, pickSignedPrice } from "../../../mark/src/domain/prices";
import type { FlattenOrder, Holding } from "../domain/flatten";
import { stockValueUsd } from "../domain/flatten";
import { oracleFromChain, oracleFromSigned } from "../domain/oracle";
import type { ChainPort, DiscoveryPort, KillLog, SignedPriceMap } from "../ports";
import type { BookRef, ChainObservation, EngineLossBudget, OracleReading } from "../types";
import { Mutex, errMsg } from "../util/async";

/** BookrunnerDesk.ActionKind.Flatten */
export const ACTION_FLATTEN = 6;
const FLATTEN_PARAMS = parseAbiParameters("address token, uint256 amountIn, uint256 minAmountOut, uint24 poolFee, bytes32 venue");
const MAX_PRICE_AGE_TTL_MS = 60_000;

export interface ViemChainOptions {
  txTimeoutMs: number;
  killLogLookbackBlocks: number;
  log: Logger;
  /** wall clock (ms) for off-chain price staleness; default Date.now */
  now?: () => number;
}

export class ViemChain implements ChainPort, DiscoveryPort {
  readonly riskAddress: Address;
  private readonly mutex = new Mutex();
  private maxPriceAge: { value: number; at: number } | null = null;
  /** non-batching client for the update-then-read eth_call */
  private readonly raw: PublicClient;
  private readonly now: () => number;

  constructor(
    private readonly pub: PublicClient,
    private readonly wallet: WalletClient<Transport, Chain, Account>,
    readonly deployment: Deployment,
    private readonly o: ViemChainOptions,
  ) {
    this.riskAddress = wallet.account.address;
    this.raw = unbatchedClient(pub);
    this.now = o.now ?? Date.now;
  }

  private get c() {
    return this.deployment.contracts;
  }

  // ------------------------------------------------------------------ discovery

  async listBookIds(): Promise<number[]> {
    const ids = await this.pub.readContract({ address: this.c.factory, abi: bookFactoryAbi, functionName: "bookIds" });
    return ids.map((x) => Number(x));
  }

  async loadRef(bookId: number, hint?: BookComponents): Promise<BookRef> {
    const components: BookComponents =
      hint ??
      (await this.pub.readContract({ address: this.c.factory, abi: bookFactoryAbi, functionName: "componentsOf", args: [BigInt(bookId)] }));
    const charter = await this.pub.readContract({ address: components.book, abi: bookAbi, functionName: "getCharter" });
    const priceId = await this.pub.readContract({
      address: this.c.stockRegistry,
      abi: stockTokenRegistryAbi,
      functionName: "priceIdOf",
      args: [charter.underlying],
    });
    return {
      bookId,
      venue: charter.venue as VenueId,
      components: { ...components },
      underlying: charter.underlying,
      priceId,
      priceIdStr: safeStr(priceId),
      symbol: safeStr(charter.symbol),
    };
  }

  async bookState(ref: BookRef): Promise<BookState> {
    const s = await this.pub.readContract({ address: ref.components.book, abi: bookAbi, functionName: "state" });
    return BOOK_STATE[s] ?? "Subscription";
  }

  /** Orderly: last on-chain capital flow (deposit/confirm/cancel), 0 if unreadable. */
  async orderlyLastFlowAt(ref: BookRef): Promise<number> {
    try {
      return Number(await this.pub.readContract({ address: ref.components.adapter, abi: orderlyAdapterAbi, functionName: "lastFlowAt" }));
    } catch {
      return 0;
    }
  }

  /** Orderly MM account id (bytes32) held by the OrderlyAdapter. */
  async orderlyAccountId(ref: BookRef, account: number = ACCOUNT.MM): Promise<Hex> {
    return this.pub.readContract({ address: ref.components.adapter, abi: orderlyAdapterAbi, functionName: "accountId", args: [account] });
  }

  // ------------------------------------------------------------------ reads

  async observe(ref: BookRef, prices?: SignedPriceMap): Promise<ChainObservation> {
    const k = ref.components;
    const p = this.pub;
    // RPC budget: started with the views below, so on mainnet (Multicall3) they share their aggregate3 (one block);
    // none of them rejects (each falls back on its own)
    const oracleRead = Promise.all([this.readOracle(ref.priceId), this.readMaxPriceAge()]);
    const lastFlowRead = ref.venue === VENUE.ORDERLY ? this.orderlyLastFlowAt(ref) : Promise.resolve(0);
    const [
      state,
      mandate,
      killed,
      killReason,
      netExposureUsd,
      deployedValueUsd,
      insuranceEquityUsd,
      inTransitUsd,
      valuationAt,
      hedgeNotionalUsd,
      deskValueUsd,
      vaultIdleUsd,
      unfundedClaimsUsd,
      perf,
      nav,
      capitalShort,
    ] = await Promise.all([
      p.readContract({ address: k.book, abi: bookAbi, functionName: "state" }),
      p.readContract({ address: k.mandate, abi: mMMandateAbi, functionName: "getMandate" }),
      p.readContract({ address: k.mandate, abi: mMMandateAbi, functionName: "killed" }),
      p.readContract({ address: k.mandate, abi: mMMandateAbi, functionName: "killReason" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "netExposureUsd" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "deployedValueUsd" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "insuranceEquityUsd" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "inTransitUsd" }),
      p.readContract({ address: k.adapter, abi: poolEngineAdapterAbi, functionName: "valuationAt" }),
      // both revert StalePrice (registry.valueUsd -> oracle.priceOf) once a held token's price is
      // older than maxPriceAge: caught here and re-valued at the last attested price below, so a
      // degraded oracle never blinds the venue-exposure limits or the kill path
      p.readContract({ address: k.desk, abi: bookrunnerDeskAbi, functionName: "hedgeNotionalUsd" }).catch(() => null),
      p.readContract({ address: k.desk, abi: bookrunnerDeskAbi, functionName: "valueUsd" }).catch(() => null),
      p.readContract({ address: k.vault, abi: underwritingVaultAbi, functionName: "idle" }),
      p.readContract({ address: k.book, abi: bookAbi, functionName: "unfundedClaims" }),
      p.readContract({ address: k.book, abi: bookAbi, functionName: "perfIndex" }),
      p.readContract({ address: k.book, abi: bookAbi, functionName: "trancheNav" }),
      // fix round 2 (Info 4): false on a book without the view (older deployment) or a failed read
      p.readContract({ address: k.book, abi: bookAbi, functionName: "capitalShort" }).catch(() => false),
    ]);
    const [chainOracle, maxPriceAgeSec] = await oracleRead;
    const nowSec = Math.floor(this.now() / 1000);
    // pull oracle (LOW_GAS §1): the signed print supersedes an older stored price; staleness off-chain
    const signedUnderlying = pickSignedPrice(prices, ref.priceId, BigInt(chainOracle?.publishedAt ?? 0), BigInt(nowSec));
    const oracle = signedUnderlying ? oracleFromSigned(signedUnderlying, nowSec, maxPriceAgeSec) : chainOracle;
    let desk: ChainObservation["desk"];
    if (prices && prices.size > 0) desk = await this.deskAtNewestPrices(ref, prices, nowSec, maxPriceAgeSec);
    else
      desk =
        hedgeNotionalUsd !== null && deskValueUsd !== null
          ? { hedgeNotionalUsd, valueUsd: deskValueUsd, priceStale: false }
          : await this.deskAtLastPrice(ref);
    const lossBudget = ref.venue === VENUE.POOL_ENGINE ? await this.engineLossBudget(ref) : undefined;
    let adapter = { netExposureUsd, deployedValueUsd, insuranceEquityUsd };
    let adapterSource: NonNullable<ChainObservation["adapter"]["source"]> = "onchain";
    if (ref.venue === VENUE.POOL_ENGINE && signedUnderlying) {
      const v = await this.engineAtSignedPrice(ref, signedUnderlying);
      if (v) {
        adapter = v;
        adapterSource = "engine_signed_price";
      }
    }
    return {
      bookState: BOOK_STATE[state] ?? "Subscription",
      mandate: { ...mandate },
      killed,
      killReason,
      adapter: {
        ...adapter,
        inTransitUsd,
        valuationAt: Number(valuationAt),
        lastFlowAt: await lastFlowRead,
        ...(adapterSource !== "onchain" ? { source: adapterSource } : {}),
      },
      desk,
      vaultIdleUsd,
      unfundedClaimsUsd,
      seniorNavUsd: nav[0],
      juniorNavUsd: nav[1],
      perfIndexWad: perf[0],
      highWaterWad: perf[1],
      oracle,
      maxPriceAgeSec,
      ...(lossBudget !== undefined ? { lossBudget } : {}),
      ...(capitalShort ? { capitalShort: true } : {}),
    };
  }

  /** PoolEngine.lossBudget for the book's market (Task 7); null when unreadable (never fails the tick). */
  private async engineLossBudget(ref: BookRef): Promise<EngineLossBudget | null> {
    const a = ref.components.adapter;
    try {
      const [marketId, engine] = await Promise.all([
        this.pub.readContract({ address: a, abi: poolEngineAdapterAbi, functionName: "marketId" }),
        this.pub.readContract({ address: a, abi: poolEngineAdapterAbi, functionName: "engine" }).catch(() => this.c.poolEngine),
      ]);
      const [budgetBps, period, anchorEquityUsd, lossUsd, budgetUsd, blocked] = await this.pub.readContract({ address: engine, abi: poolEngineAbi, functionName: "lossBudget", args: [marketId] });
      return { budgetBps: Number(budgetBps), period: Number(period), anchorEquityUsd, lossUsd, budgetUsd, blocked };
    } catch {
      return null;
    }
  }

  /**
   * Desk valuation from the signed bundle (LOW_GAS §1): every held token through StockTokenRegistry.valueUsdAt
   * at its newest price (the signed print when newer than the stored one), plus the desk's USDC. Never the
   * strict desk views, which revert StalePrice whenever no update landed lately (a quiet pull-oracle market).
   */
  private async deskAtNewestPrices(ref: BookRef, prices: SignedPriceMap, nowSec: number, maxPriceAgeSec: number): Promise<ChainObservation["desk"]> {
    const [holdings, usdc] = await Promise.all([
      this.deskHoldings(ref, prices),
      this.pub.readContract({ address: this.c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [ref.components.desk] }),
    ]);
    const held = holdings.filter((h) => h.qtyRaw > 0n);
    const hedge = held.reduce((sum, h) => sum + h.valueUsd, 0n);
    const priceStale = held.some((h) => !h.publishedAt || nowSec - h.publishedAt > maxPriceAgeSec);
    return { hedgeNotionalUsd: hedge, valueUsd: usdc + hedge, priceStale, signedPrices: held.some((h) => h.signed === true), ...splitFlags(held) };
  }

  /**
   * In-house engine: the adapter's pool views after AttestedOracle.update(signed print) in ONE eth_call
   * (nothing sent; services/mark/src/adapters/priceSim.ts). null keeps the stored-price views.
   */
  private async engineAtSignedPrice(ref: BookRef, p: SignedPrice): Promise<{ netExposureUsd: bigint; deployedValueUsd: bigint; insuranceEquityUsd: bigint } | null> {
    const a = ref.components.adapter;
    let blockTs: bigint | null = null;
    try {
      blockTs = (await this.pub.getBlock({ blockTag: "latest" })).timestamp;
    } catch {
      blockTs = null;
    }
    const res = await readAfterPriceUpdate(this.raw, {
      oracle: this.c.oracle,
      priceData: encodePriceData([p]),
      ...(blockTs !== null && p.publishedAt > blockTs ? { time: p.publishedAt } : {}),
      views: [
        { address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [ref.priceId] },
        { address: a, abi: poolEngineAdapterAbi, functionName: "netExposureUsd" },
        { address: a, abi: poolEngineAdapterAbi, functionName: "deployedValueUsd" },
        { address: a, abi: poolEngineAdapterAbi, functionName: "insuranceEquityUsd" },
      ],
    });
    if (!res || BigInt((res[0] as { publishedAt: bigint | number }).publishedAt) !== p.publishedAt) return null;
    return { netExposureUsd: res[1] as bigint, deployedValueUsd: res[2] as bigint, insuranceEquityUsd: res[3] as bigint };
  }

  /**
   * Desk valuation when the on-chain views revert (stale price): every held token valued through
   * the registry at its last attested price (valueUsdAt; multiplier applied exactly once there),
   * plus the desk's USDC. Flagged priceStale so dashboards show the degraded valuation.
   */
  private async deskAtLastPrice(ref: BookRef): Promise<ChainObservation["desk"]> {
    const [holdings, usdc] = await Promise.all([
      this.deskHoldings(ref),
      this.pub.readContract({ address: this.c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [ref.components.desk] }),
    ]);
    const hedge = holdings.reduce((sum, h) => sum + h.valueUsd, 0n);
    this.o.log.warn(
      { bookId: ref.bookId, hedgeUsd: hedge.toString(), tokens: holdings.length },
      "desk valuation reverted (stale oracle price); using the last attested prices",
    );
    return { hedgeNotionalUsd: hedge, valueUsd: usdc + hedge, priceStale: true, ...splitFlags(holdings.filter((h) => h.qtyRaw > 0n)) };
  }

  private async readOracle(priceId: Hex): Promise<OracleReading | null> {
    try {
      const [latest, stale] = await Promise.all([
        this.pub.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [priceId] }),
        this.pub.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "isStale", args: [priceId] }),
      ]);
      return oracleFromChain(latest, stale);
    } catch (err) {
      this.o.log.debug({ priceId, err: errMsg(err) }, "oracle read failed; falling back to redis");
      return null;
    }
  }

  private async readMaxPriceAge(): Promise<number> {
    const now = Date.now();
    if (this.maxPriceAge && now - this.maxPriceAge.at < MAX_PRICE_AGE_TTL_MS) return this.maxPriceAge.value;
    try {
      const v = await this.pub.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "maxPriceAge" });
      this.maxPriceAge = { value: Number(v), at: now };
      return Number(v);
    } catch {
      return this.maxPriceAge?.value ?? 300;
    }
  }

  async isKilled(ref: BookRef): Promise<boolean> {
    return this.pub.readContract({ address: ref.components.mandate, abi: mMMandateAbi, functionName: "killed" });
  }

  async latestKill(ref: BookRef): Promise<KillLog | null> {
    const latest = await this.pub.getBlockNumber();
    const start = BigInt(Math.max(0, this.deployment.startBlock ?? 0));
    const lookback = BigInt(this.o.killLogLookbackBlocks);
    const fromBlock = lookback > 0n && latest - lookback > start ? latest - lookback : start;
    const logs = await this.pub.getContractEvents({
      address: ref.components.mandate,
      abi: mMMandateAbi,
      eventName: "Kill",
      fromBlock,
      toBlock: latest,
    });
    const last = logs.at(-1);
    if (!last || !last.transactionHash) return null;
    return {
      txHash: last.transactionHash,
      reason: last.args.reason ?? zeroHash,
      by: last.args.by ?? "0x0000000000000000000000000000000000000000",
      blockNumber: last.blockNumber ?? 0n,
    };
  }

  async deskHoldings(ref: BookRef, prices?: SignedPriceMap): Promise<Holding[]> {
    const desk = ref.components.desk;
    const tokens = await this.pub.readContract({ address: desk, abi: bookrunnerDeskAbi, functionName: "heldTokens" });
    const nowSec = BigInt(Math.floor(this.now() / 1000));
    return Promise.all(
      tokens.map(async (token): Promise<Holding> => {
        const [qtyRaw, info] = await Promise.all([
          this.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [desk] }),
          this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "getToken", args: [token] }),
        ]);
        let priceWad = 0n;
        let publishedAt = 0;
        let held = false;
        try {
          const l = await this.pub.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [info.priceId] });
          priceWad = l.priceWad;
          publishedAt = Number(l.publishedAt);
          held = l.held;
        } catch (err) {
          this.o.log.warn({ token, err: errMsg(err) }, "no oracle price for desk token");
        }
        // pull oracle: the signed print when it is newer than the stored one
        const signed = pickSignedPrice(prices, info.priceId, BigInt(publishedAt), nowSec);
        if (signed) {
          priceWad = signed.priceWad;
          publishedAt = Number(signed.publishedAt);
          held = signed.held;
        }
        const split = priceWad > 0n && qtyRaw > 0n ? await this.splitWindowOf(token, info.priceId, { held, publishedAt: BigInt(publishedAt) }) : null;
        if (split) {
          // audit M-2: the price predates the multiplier change; valued at the multiplier of its basis (or 0),
          // never at the new one, and flagged so no kill / flatten acts on it
          const valueUsd = split.multiplierWad === null ? 0n : valueAtMultiplier(qtyRaw, split.multiplierWad, priceWad, info.decimals);
          return { token, qtyRaw, valueUsd, priceWad, multiplierWad: split.multiplierWad ?? 0n, decimals: info.decimals, publishedAt, splitWindow: true, ...(split.multiplierWad === null ? { splitValuationUnknown: true } : {}), ...(signed ? { signed: true } : {}) };
        }
        let valueUsd = 0n;
        if (priceWad > 0n && qtyRaw > 0n) {
          try {
            // registry valuation is normative (multiplier applied exactly once)
            valueUsd = await this.pub.readContract({
              address: this.c.stockRegistry,
              abi: stockTokenRegistryAbi,
              functionName: "valueUsdAt",
              args: [token, qtyRaw, priceWad],
            });
          } catch {
            valueUsd = stockValueUsd(qtyRaw, info.multiplierWad, priceWad, info.decimals);
          }
        }
        return { token, qtyRaw, valueUsd, priceWad, multiplierWad: info.multiplierWad, decimals: info.decimals, publishedAt, ...(signed ? { signed: true } : {}) };
      }),
    );
  }

  /**
   * Audit M-2 split window of a held token (the shared rule, packages/shared/src/splitWindow.ts): null when
   * outside it, else the multiplier in force at the price's basis from the registry's on-chain
   * basisMultiplier (null = unknown: the valuation is then untrusted). A failed read fails closed for this tick
   * (in the window, untrusted: no flatten of the token, desk-dependent breaches wait for the next tick).
   */
  private async splitWindowOf(token: Address, priceId: Hex, p: { held: boolean; publishedAt: bigint }): Promise<{ multiplierWad: bigint | null } | null> {
    try {
      const [changedAt, lastLiveAt] = await Promise.all([
        this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "multiplierChangedAt", args: [token] }),
        this.pub.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "lastLiveAt", args: [priceId] }),
      ]);
      const basis = priceBasisAt({ held: p.held, publishedAt: p.publishedAt, lastLiveAt: BigInt(lastLiveAt) });
      if (!inSplitWindow({ multiplierChangedAt: changedAt, priceBasisAt: basis })) return null;
      const m = await this.pub.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "basisMultiplier", args: [token, basis] });
      this.o.log.warn({ token, basis: basis.toString(), multiplierChangedAt: changedAt.toString(), basisMultiplier: m.toString() }, "desk token in the split window (audit M-2): valued at the basis multiplier, never flattened");
      return { multiplierWad: m > 0n ? m : null };
    } catch (err) {
      this.o.log.warn({ token, err: errMsg(err) }, "split-window reads failed; the token is treated as in the window with an untrusted valuation this tick");
      return { multiplierWad: null };
    }
  }

  // ------------------------------------------------------------------ writes (RISK role)

  async setReduceOnly(ref: BookRef): Promise<Hex> {
    return this.submit(`adapter.setReduceOnly(book ${ref.bookId})`, async () => {
      const call = {
        address: ref.components.adapter,
        abi: poolEngineAdapterAbi,
        functionName: "setReduceOnly",
        args: [true],
        account: this.wallet.account,
      } as const;
      const { request } = await this.pub.simulateContract(call);
      return this.wallet.writeContract({ ...request, gas: bufferedGas(await this.pub.estimateContractGas(call)) });
    });
  }

  async flatten(ref: BookRef, order: FlattenOrder, poolFee: number): Promise<Hex> {
    const data = encodeAbiParameters(FLATTEN_PARAMS, [order.token, order.amountIn, order.minAmountOut, poolFee, HEDGE_VENUES.UNIV3]);
    return this.submit(`desk.execute(Flatten ${order.token}, book ${ref.bookId})`, async () => {
      const call = {
        address: ref.components.desk,
        abi: bookrunnerDeskAbi,
        functionName: "execute",
        args: [{ kind: ACTION_FLATTEN, data, proof: [] }],
        account: this.wallet.account,
      } as const;
      const { request } = await this.pub.simulateContract(call);
      return this.wallet.writeContract({ ...request, gas: bufferedGas(await this.pub.estimateContractGas(call)) });
    });
  }

  async mandateKill(ref: BookRef, reason: string): Promise<Hex> {
    const reasonBytes = strToBytes32(reason.slice(0, 32));
    return this.submit(`mandate.kill(${reason}, book ${ref.bookId})`, async () => {
      const call = {
        address: ref.components.mandate,
        abi: mMMandateAbi,
        functionName: "kill",
        args: [reasonBytes],
        account: this.wallet.account,
      } as const;
      const { request } = await this.pub.simulateContract(call);
      return this.wallet.writeContract({ ...request, gas: bufferedGas(await this.pub.estimateContractGas(call)) });
    });
  }

  private submit(label: string, send: () => Promise<Hex>): Promise<Hex> {
    return this.mutex.run(async () => {
      const hash = await send();
      this.o.log.info({ tx: hash, op: label, from: this.riskAddress }, "tx sent");
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.o.txTimeoutMs });
      if (receipt.status !== "success") throw new Error(`${label} reverted in ${hash}`);
      this.o.log.info({ tx: hash, op: label, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() }, "tx confirmed");
      return hash;
    });
  }
}

/**
 * Gas limit from an eth_estimateGas result: +30% + 30k. Kill-path txs (mandate.kill revokes every
 * key, desk Flatten swaps through the executor, adapter.setReduceOnly reaches the engine) are
 * nested calls whose inner frames get only 63/64 of the remaining gas; a tight estimate made at a
 * different state can OOG them exactly when they matter.
 */
export const bufferedGas = (estimate: bigint): bigint => (estimate * 13n) / 10n + 30_000n;

function safeStr(b: Hex): string {
  try {
    return bytes32ToStr(b) || b;
  } catch {
    return b;
  }
}

/** Desk split-window flags (audit M-2): any held token in the window; any valued without a basis multiplier. */
function splitFlags(held: readonly Holding[]): { splitWindow?: true; splitUntrusted?: true } {
  return {
    ...(held.some((h) => h.splitWindow === true) ? { splitWindow: true as const } : {}),
    ...(held.some((h) => h.splitValuationUnknown === true) ? { splitUntrusted: true as const } : {}),
  };
}
