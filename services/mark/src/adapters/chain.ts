// viem adapter for the mark service. All valuation reads use one fixed blockNumber.
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
import { type BookRef, type TxSender, bookStateName, scanEvents } from "@bookrunner/waterfall";
import { type Address, type Hex, type PublicClient, erc20Abi, isAddressEqual, parseEventLogs } from "viem";
import type { DeskPosition, MarkSnapshot } from "../domain/types";
import type { CommittedMark, MarkAppliedEvent, MarkChain } from "../ports";

const TICKER_RE = /^[A-Z0-9._-]{1,27}$/;

export class MarkChainAdapter implements MarkChain {
  private interval: number | null = null;
  private maxAge: number | null = null;
  private tickers = new Map<string, string>();

  constructor(
    private readonly pc: PublicClient,
    private readonly sender: TxSender,
    private readonly deployment: Deployment,
  ) {
    for (const [ticker, t] of Object.entries(deployment.stockTokens ?? {})) this.tickers.set(t.token.toLowerCase(), ticker);
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
    const ev = parseEventLogs({ abi: bookAbi, eventName: "MarkApplied", logs: out.receipt.logs }).find((l) => isAddressEqual(l.address, ref.components.book));
    if (!ev) throw new Error(`applyMark tx ${out.hash} emitted no MarkApplied`);
    const a = ev.args;
    return { hash: out.hash, applied: { markId: a.markId, navUsd: a.navUsd, pnlUsd: a.pnlUsd, seniorNav: a.seniorNav, juniorNav: a.juniorNav, seniorPrice: a.seniorPrice, juniorPrice: a.juniorPrice } };
  }

  async snapshot(ref: BookRef, blockNumber: bigint): Promise<MarkSnapshot> {
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
    const [vaultIdle, vaultIdleView, seniorSupply, juniorSupply, backstopBalance, mandateTerms, killed] = await Promise.all([
      this.pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault], ...b }),
      this.pc.readContract({ address: vault, abi: underwritingVaultAbi, functionName: "idle", ...b }).catch(() => null),
      this.pc.readContract({ address: senior, abi: erc20Abi, functionName: "totalSupply", ...b }),
      this.pc.readContract({ address: junior, abi: erc20Abi, functionName: "totalSupply", ...b }),
      this.pc.readContract({ address: this.c.backstop, abi: backstopAbi, functionName: "balance", ...b }),
      this.pc.readContract({ address: mandate, abi: mMMandateAbi, functionName: "getMandate", ...b }),
      this.pc.readContract({ address: mandate, abi: mMMandateAbi, functionName: "killed", ...b }),
    ]);
    const [insuranceUsd, marginUsd, netExposureUsd, inTransitUsd, deployedValueUsd, valuationAt] = await Promise.all([
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "insuranceEquityUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "marginEquityUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "netExposureUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "inTransitUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "deployedValueUsd", ...b }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "valuationAt", ...b }),
    ]);

    let poolCashUsd: bigint | null = null;
    let poolEquityUsd: bigint | null = null;
    if (ref.venue === VENUE.POOL_ENGINE) {
      const marketId = await this.pc.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "marketId", ...b });
      const [st, eq] = await Promise.all([
        this.pc.readContract({ address: this.c.poolEngine, abi: poolEngineAbi, functionName: "state", args: [marketId], ...b }),
        this.pc.readContract({ address: this.c.poolEngine, abi: poolEngineAbi, functionName: "poolEquityUsd", args: [marketId], ...b }),
      ]);
      poolCashUsd = st.poolCashUsd;
      poolEquityUsd = eq;
    }

    const [deskUsdc, held, deskValue, hedgeNotional] = await Promise.all([
      this.pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [desk], ...b }),
      this.pc.readContract({ address: desk, abi: bookrunnerDeskAbi, functionName: "heldTokens", ...b }),
      this.pc.readContract({ address: desk, abi: bookrunnerDeskAbi, functionName: "valueUsd", ...b }).catch(() => null),
      this.pc.readContract({ address: desk, abi: bookrunnerDeskAbi, functionName: "hedgeNotionalUsd", ...b }).catch(() => null),
    ]);
    const positions: DeskPosition[] = [];
    for (const token of held) {
      positions.push(await this.position(token, desk, blockNumber));
    }

    let underlyingPrice: MarkSnapshot["underlyingPrice"] = null;
    try {
      const priceId = await this.pc.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "priceIdOf", args: [charter.underlying], ...b });
      const p = await this.pc.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [priceId], ...b });
      underlyingPrice = { priceId, priceWad: p.priceWad, publishedAt: Number(p.publishedAt), held: p.held };
    } catch {
      underlyingPrice = null;
    }

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
      blockTimestamp: Number(block.timestamp),
      usdc,
      vaultIdle,
      vaultIdleView,
      unfundedClaims,
      flowNonce: BigInt(flowNonce),
      venue: { insuranceUsd, marginUsd, netExposureUsd, inTransitUsd, deployedValueUsd, valuationAt: Number(valuationAt), poolCashUsd, poolEquityUsd },
      desk: { usdc: deskUsdc, positions, onchainValueUsd: deskValue, hedgeNotionalUsd: hedgeNotional },
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
    };
  }

  /** Stock Token position valued by the registry (multiplier applied there exactly once). */
  private async position(token: Address, desk: Address, blockNumber: bigint): Promise<DeskPosition> {
    const b = { blockNumber } as const;
    const [qtyRaw, info] = await Promise.all([
      this.pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [desk], ...b }),
      this.pc.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "getToken", args: [token], ...b }),
    ]);
    const latest = await this.pc.readContract({ address: this.c.oracle, abi: attestedOracleAbi, functionName: "latest", args: [info.priceId], ...b });
    let valueUsd: bigint;
    let priceStale = false;
    try {
      valueUsd = await this.pc.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "valueUsd", args: [token, qtyRaw], ...b });
    } catch {
      // StalePrice: value at the last attested price (still via the registry: multiplier applied once there)
      priceStale = true;
      valueUsd = await this.pc.readContract({ address: this.c.stockRegistry, abi: stockTokenRegistryAbi, functionName: "valueUsdAt", args: [token, qtyRaw, latest.priceWad], ...b });
    }
    return {
      token,
      ticker: this.tickerOf(token, info.priceId),
      qtyRaw,
      priceWad: latest.priceWad,
      multiplierWad: info.multiplierWad,
      decimals: Number(info.decimals),
      valueUsd,
      priceStale,
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
