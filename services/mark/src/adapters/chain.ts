// viem adapter for the mark service. All valuation reads use one fixed blockNumber.
//
// Low-gas (docs/LOW_GAS.md): valuation prefers the oracle's SIGNED prices (passed in by the pipeline) over
// the stored on-chain ones whenever they are newer — desk tokens through StockTokenRegistry.valueUsdAt (pure:
// the multiplier is applied there, once), the in-house engine pool by re-reading its views in ONE eth_call
// after AttestedOracle.update(priceData) (deployless Multicall3 aggregate, nothing is sent). The mark tx is
// MarkRegistry.commitAndApply when the registry has it (feature-detected on its bytecode), else commit +
// Book.applyMark.
import { type Deployment, type Mandate, type MarkInput, VENUE, bytes32ToStr } from "@bookrunner/shared";
import {
  attestedOracleAbi,
  backstopAbi,
  bookAbi,
  bookrunnerConfigAbi,
  bookrunnerDeskAbi,
  markRegistryAbi,
  mMMandateAbi,
  orderlyAdapterAbi,
  poolEngineAbi,
  poolEngineAdapterAbi,
  stockTokenRegistryAbi,
  underwritingVaultAbi,
} from "@bookrunner/shared/abi";
import { type BookRef, type TxSender, bookStateName, codeHasSelector, describeRevert, scanEvents } from "@bookrunner/waterfall";
import { type Abi, type Address, type Hex, type PublicClient, encodeFunctionData, erc20Abi, isAddressEqual, parseEventLogs, zeroHash } from "viem";
import type { AdapterReportState } from "../../../ops-venue/src/report712";
import { type SignedPrice, encodePriceData, pickSignedPrice, valuationRefTs } from "../domain/prices";
import type { DeskPosition, MarkSnapshot } from "../domain/types";
import type { AtomicMarkResult, CommittedMark, MarkAppliedEvent, MarkChain, SimulationResult } from "../ports";
import { COMMIT_AND_APPLY_SELECTOR } from "./lowgasAbi";
import { readAfterPriceUpdate, unbatchedClient } from "./priceSim";

const TICKER_RE = /^[A-Z0-9._-]{1,27}$/;
const EMPTY_MARK: MarkInput = {
  bookId: 0n,
  periodEnd: 0n,
  navUsd: 0n,
  deployedValueUsd: 0n,
  flowNonce: 0n,
  inventoryRoot: zeroHash,
  pnlJsonHash: zeroHash,
  receiptsRoot: zeroHash,
};
const ERRORS_ABI = [...markRegistryAbi, ...bookAbi, ...attestedOracleAbi, ...orderlyAdapterAbi] as Abi;

type EngineViews = { insuranceUsd: bigint; marginUsd: bigint; netExposureUsd: bigint; deployedValueUsd: bigint; poolCashUsd: bigint; poolEquityUsd: bigint };

export class MarkChainAdapter implements MarkChain {
  private interval: number | null = null;
  private maxAge: number | null = null;
  private maxPriceAgeSec: number | null = null;
  private atomic: boolean | null = null;
  private tickers = new Map<string, string>();
  /** Non-batching client for the deployless aggregate (batched multicall would split the calls). */
  private readonly raw: PublicClient;

  constructor(
    private readonly pc: PublicClient,
    private readonly sender: TxSender,
    private readonly deployment: Deployment,
    /** wall clock (ms): the valuation reference time for signed prices is max(snapshot block, now) */
    private readonly now: () => number = Date.now,
  ) {
    for (const [ticker, t] of Object.entries(deployment.stockTokens ?? {})) this.tickers.set(t.token.toLowerCase(), ticker);
    this.raw = unbatchedClient(pc);
  }

  private get c() {
    return this.deployment.contracts;
  }

  async head() {
    const b = await this.pc.getBlock();
    return { blockNumber: b.number, timestamp: Number(b.timestamp) };
  }

  async markInterval() {
    this.interval ??= Number(await this.pc.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "markInterval" }));
    return this.interval;
  }

  async maxMarkAge() {
    this.maxAge ??= Number(await this.pc.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "maxMarkAge" }));
    return this.maxAge;
  }

  private async maxPriceAge(): Promise<number> {
    if (this.maxPriceAgeSec === null) {
      try {
        this.maxPriceAgeSec = Number(await this.pc.readContract({ address: this.c.config, abi: bookrunnerConfigAbi, functionName: "maxPriceAge" }));
      } catch {
        return 300;
      }
    }
    return this.maxPriceAgeSec;
  }

  async flowNonce(ref: BookRef) {
    return this.pc.readContract({ address: ref.components.book, abi: bookAbi, functionName: "flowNonce" });
  }

  async lastMarkPeriodEnd(ref: BookRef) {
    return Number(await this.pc.readContract({ address: ref.components.book, abi: bookAbi, functionName: "lastMarkPeriodEnd" }));
  }

  async latestCommitted(ref: BookRef): Promise<CommittedMark | null> {
    const id = await this.pc.readContract({ address: this.c.markRegistry, abi: markRegistryAbi, functionName: "latestMarkId", args: [BigInt(ref.bookId)] });
    if (id === 0n) return null;
    const m = await this.pc.readContract({ address: this.c.markRegistry, abi: markRegistryAbi, functionName: "getMark", args: [id] });
    return { markId: id, periodEnd: Number(m.input.periodEnd), applied: m.applied, input: { ...m.input }, signer: m.signer };
  }

  async hashMark(input: MarkInput): Promise<Hex | null> {
    try {
      return await this.pc.readContract({ address: this.c.markRegistry, abi: markRegistryAbi, functionName: "hashMark", args: [input] });
    } catch {
      return null;
    }
  }

  async commit(input: MarkInput, signature: Hex) {
    const out = await this.sender.send({
      address: this.c.markRegistry,
      abi: markRegistryAbi,
      functionName: "commit",
      args: [input, signature],
      label: `MarkRegistry.commit(book=${input.bookId}, periodEnd=${input.periodEnd})`,
      bookId: Number(input.bookId),
    });
    const ev = parseEventLogs({ abi: markRegistryAbi, eventName: "MarkCommitted", logs: out.receipt.logs }).find((l) => isAddressEqual(l.address, this.c.markRegistry));
    if (!ev) throw new Error(`commit tx ${out.hash} emitted no MarkCommitted`);
    const block = await this.pc.getBlock({ blockNumber: out.receipt.blockNumber });
    return { hash: out.hash, markId: ev.args.markId, committedAt: new Date(Number(block.timestamp) * 1000) };
  }

  async commitTxOf(markId: bigint): Promise<Hex | null> {
    const logs = await scanEvents(this.pc, {
      address: this.c.markRegistry,
      abi: markRegistryAbi,
      eventName: "MarkCommitted",
      args: { markId },
      fromBlock: BigInt(this.deployment.startBlock ?? 0),
      toBlock: await this.pc.getBlockNumber(),
    });
    return logs[0]?.transactionHash ?? null;
  }

  async applyMark(ref: BookRef, markId: bigint): Promise<{ hash: Hex; applied: MarkAppliedEvent }> {
    const out = await this.sender.send({
      address: ref.components.book,
      abi: bookAbi,
      functionName: "applyMark",
      args: [markId],
      label: `Book.applyMark(book=${ref.bookId}, mark=${markId})`,
      bookId: ref.bookId,
    });
    return { hash: out.hash, applied: this.appliedFrom(ref, out.hash, out.receipt.logs) };
  }

  private appliedFrom(ref: BookRef, hash: Hex, logs: Parameters<typeof parseEventLogs>[0]["logs"]): MarkAppliedEvent {
    const ev = parseEventLogs({ abi: bookAbi, eventName: "MarkApplied", logs }).find((l) => isAddressEqual(l.address, ref.components.book));
    if (!ev) throw new Error(`tx ${hash} emitted no MarkApplied`);
    const a = ev.args;
    return { markId: a.markId, navUsd: a.navUsd, pnlUsd: a.pnlUsd, seniorNav: a.seniorNav, juniorNav: a.juniorNav, seniorPrice: a.seniorPrice, juniorPrice: a.juniorPrice };
  }

  // ------------------------------------------------------------------ commitAndApply (LOW_GAS §3)

  async supportsCommitAndApply(): Promise<boolean> {
    this.atomic ??= await this.probeCommitAndApply();
    return this.atomic;
  }

  /**
   * eth_call of commitAndApply with an empty mark: a registry that has the function reverts with its own
   * error data (InvalidSignature for the empty signature); one deployed before it reverts with NO data (no
   * selector match, no fallback). No revert data can also mean an RPC that strips it: then the
   * registry's bytecode decides (its dispatcher pushes every external selector).
   */
  private async probeCommitAndApply(): Promise<boolean> {
    const data = encodeFunctionData({ abi: markRegistryAbi, functionName: "commitAndApply", args: [EMPTY_MARK, "0x", "0x", "0x"] });
    try {
      await this.pc.call({ to: this.c.markRegistry, data });
      return true;
    } catch (err) {
      if (describeRevert(err, ERRORS_ABI).selector) return true;
      return codeHasSelector(this.pc, this.c.markRegistry, COMMIT_AND_APPLY_SELECTOR);
    }
  }

  private atomicCall(ref: BookRef, input: MarkInput, signature: Hex, priceData: Hex, venueReport: Hex) {
    return {
      address: this.c.markRegistry,
      abi: markRegistryAbi,
      functionName: "commitAndApply",
      args: [input, signature, priceData, venueReport],
      label: `MarkRegistry.commitAndApply(book=${ref.bookId}, periodEnd=${input.periodEnd}, prices=${priceData !== "0x"}, venueReport=${venueReport !== "0x"})`,
      bookId: ref.bookId,
    };
  }

  async simulateCommitAndApply(ref: BookRef, input: MarkInput, signature: Hex, priceData: Hex, venueReport: Hex): Promise<SimulationResult> {
    try {
      await this.sender.simulate(this.atomicCall(ref, input, signature, priceData, venueReport));
      return { ok: true };
    } catch (err) {
      const info = describeRevert(err, ERRORS_ABI);
      // no revert data at all + no selector in the dispatcher = the function does not exist (old registry)
      const unsupported = !info.selector && !(await codeHasSelector(this.pc, this.c.markRegistry, COMMIT_AND_APPLY_SELECTOR).catch(() => true));
      if (unsupported) this.atomic = false;
      return { ok: false, error: info.errorName ?? info.reason ?? info.message, unsupported };
    }
  }

  async commitAndApply(ref: BookRef, input: MarkInput, signature: Hex, priceData: Hex, venueReport: Hex): Promise<AtomicMarkResult> {
    const out = await this.sender.send(this.atomicCall(ref, input, signature, priceData, venueReport));
    const ev = parseEventLogs({ abi: markRegistryAbi, eventName: "MarkCommitted", logs: out.receipt.logs }).find((l) => isAddressEqual(l.address, this.c.markRegistry));
    if (!ev) throw new Error(`commitAndApply tx ${out.hash} emitted no MarkCommitted`);
    const block = await this.pc.getBlock({ blockNumber: out.receipt.blockNumber });
    return { hash: out.hash, markId: ev.args.markId, committedAt: new Date(Number(block.timestamp) * 1000), applied: this.appliedFrom(ref, out.hash, out.receipt.logs) };
  }

  async adapterReportState(ref: BookRef): Promise<AdapterReportState | null> {
    if (ref.venue !== VENUE.ORDERLY) return null;
    const a = ref.components.adapter;
    const [valuationAt, lastFlowAt, pIf, pMm] = await Promise.all([
      this.pc.readContract({ address: a, abi: orderlyAdapterAbi, functionName: "valuationAt" }),
      this.pc.readContract({ address: a, abi: orderlyAdapterAbi, functionName: "lastFlowAt" }),
      this.pc.readContract({ address: a, abi: orderlyAdapterAbi, functionName: "pendingWithdrawUsd", args: [0] }),
      this.pc.readContract({ address: a, abi: orderlyAdapterAbi, functionName: "pendingWithdrawUsd", args: [1] }),
    ]);
    return { valuationAt: BigInt(valuationAt), lastFlowAt: BigInt(lastFlowAt), pendingWithdrawUsd: pIf + pMm };
  }

  // ------------------------------------------------------------------ snapshot

  async snapshot(ref: BookRef, blockNumber: bigint, prices?: ReadonlyMap<string, SignedPrice>): Promise<MarkSnapshot> {
    const { book, vault, adapter, desk, senior, junior, mandate } = ref.components;
    const b = { blockNumber } as const;
    const usdc = this.c.usdc;
    const [block, state, flowNonce, unfundedClaims, trancheNav, seniorImpairment, perf, lastMarkPeriodEnd, charter] = await Promise.all([
      this.pc.getBlock({ blockNumber }),
      this.pc.readContract({ address: book, abi: bookAbi, functionName: "state", ...b }),
      this.pc.readContract({ address: book, abi: bookAbi, functionName: "flowNonce", ...b }),
      this.pc.readContract({ address: book, abi: bookAbi, functionName: "unfundedClaims", ...b }),
      this.pc.readContract({ address: book, abi: bookAbi, functionName: "trancheNav", ...b }),
      this.pc.readContract({ address: book, abi: bookAbi, functionName: "seniorImpairment", ...b }),
      this.pc.readContract({ address: book, abi: bookAbi, functionName: "perfIndex", ...b }),
      this.pc.readContract({ address: book, abi: bookAbi, functionName: "lastMarkPeriodEnd", ...b }),
      this.pc.readContract({ address: book, abi: bookAbi, functionName: "getCharter", ...b }),
    ]);
    const blockTs = block.timestamp;
    // signed prices are exogenous: value at the newest one (an idle chain's head may lag the wall clock)
    const refTs = valuationRefTs(blockTs, this.now());
    const used = new Map<string, SignedPrice>();
    const [vaultIdle, vaultIdleView, seniorSupply, juniorSupply, backstopBalance, mandateTerms, killed] = await Promise.all([
      this.pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault], ...b }),
      this.pc.readContract({ address: vault, abi: underwritingVaultAbi, functionName: "idle", ...b }).catch(() => null),
      this.pc.readContract({ address: senior, abi: erc20Abi, functionName: "totalSupply", ...b }),
      this.pc.readContract({ address: junior, abi: erc20Abi, functionName: "totalSupply", ...b }),
      this.pc.readContract({ address: this.c.backstop, abi: backstopAbi, functionName: "balance", ...b }),
      this.pc.readContract({ address: mandate, abi: mMMandateAbi, functionName: "getMandate", ...b }),
      this.pc.readContract({ address: mandate, abi: mMMandateAbi, functionName: "killed", ...b }),
    ]);
    let [insuranceUsd, marginUsd, netExposureUsd, inTransitUsd, deployedValueUsd, valuationAt] = await Promise.all([
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "insuranceEquityUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "marginEquityUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "netExposureUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "inTransitUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "deployedValueUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "valuationAt", ...b }),
    ]);

    let underlyingPrice: MarkSnapshot["underlyingPrice"] = null;
    let underlyingPriceId: Hex | null = null;
    let onchainUnderlying: { priceWad: bigint; publishedAt: bigint; held: boolean } | null = null;
    try {
      underlyingPriceId = await this.pc.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "priceIdOf", args: [charter.underlying], ...b });
      const p = await this.pc.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [underlyingPriceId], ...b });
      onchainUnderlying = { priceWad: p.priceWad, publishedAt: BigInt(p.publishedAt), held: p.held };
      underlyingPrice = { priceId: underlyingPriceId, priceWad: p.priceWad, publishedAt: Number(p.publishedAt), held: p.held };
    } catch {
      underlyingPrice = null;
    }
    const signedUnderlying = underlyingPriceId ? pickSignedPrice(prices, underlyingPriceId, onchainUnderlying?.publishedAt ?? 0n, refTs) : null;
    if (signedUnderlying && underlyingPriceId) {
      underlyingPrice = { priceId: underlyingPriceId, priceWad: signedUnderlying.priceWad, publishedAt: Number(signedUnderlying.publishedAt), held: signedUnderlying.held };
    }

    let poolCashUsd: bigint | null = null;
    let poolEquityUsd: bigint | null = null;
    let lastFlowAt = 0;
    let pendingWithdrawUsd = 0n;
    let source: NonNullable<MarkSnapshot["venue"]["source"]> = "adapter";
    if (ref.venue === VENUE.POOL_ENGINE) {
      const [marketId, engine] = await Promise.all([
        this.pc.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "marketId", ...b }),
        this.pc.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "engine", ...b }).catch(() => this.c.poolEngine),
      ]);
      const [st, eq] = await Promise.all([
        this.pc.readContract({ address: engine, abi: poolEngineAbi, functionName: "state", args: [marketId], ...b }),
        this.pc.readContract({ address: engine, abi: poolEngineAbi, functionName: "poolEquityUsd", args: [marketId], ...b }),
      ]);
      poolCashUsd = st.poolCashUsd;
      poolEquityUsd = eq;
      // pool mark-to-market at the signed price (the engine views read the stored oracle price)
      if (signedUnderlying && underlyingPriceId) {
        const v = await this.engineAtSignedPrice({ adapter, engine, marketId, priceId: underlyingPriceId, price: signedUnderlying, blockNumber, blockTs });
        if (v) {
          ({ insuranceUsd, marginUsd, netExposureUsd, deployedValueUsd, poolCashUsd, poolEquityUsd } = v);
          source = "engine_signed_price";
          used.set(signedUnderlying.underlying.toLowerCase(), signedUnderlying);
        }
      }
    } else {
      const [lf, pIf, pMm] = await Promise.all([
        this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "lastFlowAt", ...b }).catch(() => 0n),
        this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "pendingWithdrawUsd", args: [0], ...b }).catch(() => 0n),
        this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "pendingWithdrawUsd", args: [1], ...b }).catch(() => 0n),
      ]);
      lastFlowAt = Number(lf);
      pendingWithdrawUsd = pIf + pMm;
    }

    const [deskUsdc, held, deskValue, hedgeNotional] = await Promise.all([
      this.pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [desk], ...b }),
      this.pc.readContract({ address: desk, abi: bookrunnerDeskAbi, functionName: "heldTokens", ...b }),
      this.pc.readContract({ address: desk, abi: bookrunnerDeskAbi, functionName: "valueUsd", ...b }).catch(() => null),
      this.pc.readContract({ address: desk, abi: bookrunnerDeskAbi, functionName: "hedgeNotionalUsd", ...b }).catch(() => null),
    ]);
    const maxPriceAge = BigInt(await this.maxPriceAge());
    const positions: DeskPosition[] = [];
    for (const token of held) {
      const { position, signed } = await this.position(token, desk, blockNumber, refTs, maxPriceAge, prices);
      positions.push(position);
      if (signed) used.set(signed.underlying.toLowerCase(), signed);
    }
    const deskSigned = positions.some((p) => p.signedPrice);

    const m: Mandate = {
      maxInventoryUsd: mandateTerms.maxInventoryUsd,
      maxSkewBps: Number(mandateTerms.maxSkewBps),
      minQuoteWidthBps: Number(mandateTerms.minQuoteWidthBps),
      maxHedgeLeverage: Number(mandateTerms.maxHedgeLeverage),
      hedgeRatioMinBps: Number(mandateTerms.hedgeRatioMinBps),
      hedgeRatioMaxBps: Number(mandateTerms.hedgeRatioMaxBps),
      noNewRiskOffHours: mandateTerms.noNewRiskOffHours,
      killAtDrawdownBps: Number(mandateTerms.killAtDrawdownBps),
      hedgeAllowRoot: mandateTerms.hedgeAllowRoot,
    };

    return {
      bookId: ref.bookId,
      blockNumber,
      blockTimestamp: Number(blockTs),
      usdc,
      vaultIdle,
      vaultIdleView,
      unfundedClaims,
      flowNonce: BigInt(flowNonce),
      venue: {
        insuranceUsd,
        marginUsd,
        netExposureUsd,
        inTransitUsd,
        deployedValueUsd,
        valuationAt: Number(valuationAt),
        poolCashUsd,
        poolEquityUsd,
        lastFlowAt,
        pendingWithdrawUsd,
        source,
      },
      // the desk views value at the STORED prices: no cross-check against them once a signed price was used
      desk: { usdc: deskUsdc, positions, onchainValueUsd: deskSigned ? null : deskValue, hedgeNotionalUsd: deskSigned ? null : hedgeNotional },
      book: {
        state: bookStateName(Number(state)),
        seniorNav: trancheNav[0],
        juniorNav: trancheNav[1],
        seniorImpairment,
        perfIndex: perf[0],
        highWater: perf[1],
        seniorSupply,
        juniorSupply,
        lastMarkPeriodEnd: Number(lastMarkPeriodEnd),
      },
      backstopBalance,
      mandate: m,
      killed,
      underlyingPrice,
      signedPrices: [...used.values()],
    };
  }

  /**
   * Engine pool views after AttestedOracle.update(priceData) in the same eth_call (deployless Multicall3 at
   * the snapshot block; nothing is sent). A print dated after the snapshot block is applied with the call's
   * block time overridden to its publishedAt (the oracle refuses prints > 5 s ahead of block.timestamp).
   * null when the oracle has no `update` (pre-low-gas), the update did not take, the RPC refuses the
   * override, or the call fails: the caller keeps the stored-price views.
   */
  private async engineAtSignedPrice(o: {
    adapter: Address;
    engine: Address;
    marketId: bigint;
    priceId: Hex;
    price: SignedPrice;
    blockNumber: bigint;
    blockTs: bigint;
  }): Promise<EngineViews | null> {
    const res = await readAfterPriceUpdate(this.raw, {
      oracle: this.c.oracle,
      priceData: encodePriceData([o.price]),
      blockNumber: o.blockNumber,
      ...(o.price.publishedAt > o.blockTs ? { time: o.price.publishedAt } : {}),
      views: [
        { address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [o.priceId] },
        { address: o.adapter, abi: poolEngineAdapterAbi, functionName: "insuranceEquityUsd" },
        { address: o.adapter, abi: poolEngineAdapterAbi, functionName: "marginEquityUsd" },
        { address: o.adapter, abi: poolEngineAdapterAbi, functionName: "netExposureUsd" },
        { address: o.adapter, abi: poolEngineAdapterAbi, functionName: "deployedValueUsd" },
        { address: o.engine, abi: poolEngineAbi, functionName: "state", args: [o.marketId] },
        { address: o.engine, abi: poolEngineAbi, functionName: "poolEquityUsd", args: [o.marketId] },
      ],
    });
    if (!res) return null;
    const latest = res[0] as { publishedAt: bigint | number };
    if (BigInt(latest.publishedAt) !== o.price.publishedAt) return null; // the update was skipped
    const st = res[5] as { poolCashUsd: bigint };
    return {
      insuranceUsd: res[1] as bigint,
      marginUsd: res[2] as bigint,
      netExposureUsd: res[3] as bigint,
      deployedValueUsd: res[4] as bigint,
      poolCashUsd: st.poolCashUsd,
      poolEquityUsd: res[6] as bigint,
    };
  }

  /**
   * Stock Token position valued through StockTokenRegistry.valueUsdAt (pure; the multiplier is applied there,
   * exactly once) at the newest price: the signed one when newer than the stored on-chain one, else the
   * stored one. Never through the strict valueUsd view (it reverts StalePrice when no update landed lately).
   */
  private async position(
    token: Address,
    desk: Address,
    blockNumber: bigint,
    refTs: bigint,
    maxPriceAge: bigint,
    prices?: ReadonlyMap<string, SignedPrice>,
  ): Promise<{ position: DeskPosition; signed: SignedPrice | null }> {
    const b = { blockNumber } as const;
    const [qtyRaw, info] = await Promise.all([
      this.pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [desk], ...b }),
      this.pc.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "getToken", args: [token], ...b }),
    ]);
    const latest = await this.pc.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [info.priceId], ...b });
    const signed = pickSignedPrice(prices, info.priceId, BigInt(latest.publishedAt), refTs);
    const priceWad = signed ? signed.priceWad : latest.priceWad;
    const publishedAt = signed ? signed.publishedAt : BigInt(latest.publishedAt);
    const valueUsd = await this.pc.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "valueUsdAt", args: [token, qtyRaw, priceWad], ...b });
    const priceStale = publishedAt === 0n || refTs > publishedAt + maxPriceAge;
    return {
      position: {
        token,
        ticker: this.tickerOf(token, info.priceId),
        qtyRaw,
        priceWad,
        multiplierWad: info.multiplierWad,
        decimals: Number(info.decimals),
        valueUsd,
        priceStale,
        ...(signed ? { signedPrice: true } : {}),
      },
      signed: signed && qtyRaw > 0n ? signed : null,
    };
  }

  private tickerOf(token: Address, priceId: Hex): string {
    const known = this.tickers.get(token.toLowerCase());
    if (known) return known;
    try {
      const s = bytes32ToStr(priceId);
      if (TICKER_RE.test(s)) return s;
    } catch {
      // not ASCII
    }
    return token.slice(2, 10).toUpperCase();
  }
}
