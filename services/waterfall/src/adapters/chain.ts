// viem adapter for the waterfall: reads (book, router, adapter, config, registry) and KEEPER writes.
import { type Deployment, type SplitResult, VENUE } from "@bookrunner/shared";
import {
  bkrnFeeRouterAbi,
  bookAbi,
  bookrunnerConfigAbi,
  markRegistryAbi,
  mockSwapRouterAbi,
  orderlyAdapterAbi,
  poolEngineAbi,
  poolEngineAdapterAbi,
  revenueRouterAbi,
  underwritingVaultAbi,
} from "@bookrunner/shared/abi";
import { type Address, BaseError, type Hex, type PublicClient, type TransactionReceipt, erc20Abi, isAddressEqual, parseAbi, parseEventLogs, zeroAddress } from "viem";
import { engineWithdrawableUsd } from "../domain/recall";
import { amountsToSplit } from "../domain/split";
import { type BookRef, bookStateName } from "../kit/books";
import { scanEvents } from "../kit/logs";
import type { TxSender } from "../kit/tx";
import type { BuybackChain, DistributedLog, FeeForwarding, KeeperChain, KeeperSnapshot, SettlementChain, SettlementReceivedLog, SplitParams } from "../ports";
import { type CandidateSource, pendingShares } from "./redemptions";

/** Pre-A5-02 BkrnFeeRouter (the live testnet until a redeploy): the keeper passed the pool fee tier. */
const legacyFeeRouterAbi = parseAbi(["function executeBuyback(uint256 amountIn, uint256 minBkrnOut, uint24 poolFee) returns (uint256 bkrnOut)"]);

/** True when a read reverted on-chain (e.g. an unknown selector), as opposed to a transport failure. */
function isOnChainRevert(err: unknown): boolean {
  return err instanceof BaseError && !!err.walk((e) => e instanceof BaseError && (e.name === "ContractFunctionRevertedError" || e.name === "ContractFunctionZeroDataError"));
}

export interface ChainAdapterOptions {
  pc: PublicClient;
  sender: TxSender;
  deployment: Deployment;
  candidates: CandidateSource;
  /** eth_getLogs chunk size and lookback (0 = from deployment.startBlock). */
  logChunk: bigint;
  logLookback: bigint;
}

export class WaterfallChainAdapter implements SettlementChain, KeeperChain, BuybackChain {
  private markInterval: number | null = null;
  private buybackTokens: { usdc: Address; bkrn: Address } | null = null;
  private legacyFeeRouter: boolean | null = null;
  private distributedCache = new Map<string, DistributedLog>();
  private blockTs = new Map<bigint, Date>();
  /** FeesSwept (amount, position) per earmark tx: immutable once mined. */
  private earmarks = new Map<Hex, { amount: bigint; blockNumber: bigint; logIndex: number }>();

  constructor(private readonly o: ChainAdapterOptions) {}

  private get pc() {
    return this.o.pc;
  }

  private async fromBlock(): Promise<bigint> {
    const start = BigInt(this.o.deployment.startBlock ?? 0);
    if (this.o.logLookback <= 0n) return start;
    const head = await this.pc.getBlockNumber();
    const lb = head > this.o.logLookback ? head - this.o.logLookback : 0n;
    return lb > start ? lb : start;
  }

  private async tsOf(blockNumber: bigint): Promise<Date> {
    const hit = this.blockTs.get(blockNumber);
    if (hit) return hit;
    const b = await this.pc.getBlock({ blockNumber });
    const d = new Date(Number(b.timestamp) * 1000);
    if (this.blockTs.size > 1000) this.blockTs.clear();
    this.blockTs.set(blockNumber, d);
    return d;
  }

  async getMarkInterval(): Promise<number> {
    this.markInterval ??= Number(await this.pc.readContract({ address: this.o.deployment.contracts.config, abi: bookrunnerConfigAbi, functionName: "markInterval" }));
    return this.markInterval;
  }

  // ---------------------------------------------------------------- SettlementChain
  async bookState(ref: BookRef) {
    return bookStateName(Number(await this.pc.readContract({ address: ref.components.book, abi: bookAbi, functionName: "state" })));
  }

  async findDistributed(ref: BookRef, period: number): Promise<DistributedLog | null> {
    const k = `${ref.bookId}:${period}`;
    const hit = this.distributedCache.get(k);
    if (hit) return hit;
    const head = await this.pc.getBlockNumber();
    const logs = await scanEvents<{ bookId: bigint; period: bigint; amounts: readonly bigint[] }>(this.pc, {
      address: ref.components.router,
      abi: revenueRouterAbi,
      eventName: "Distributed",
      args: { bookId: BigInt(ref.bookId), period: BigInt(period) },
      fromBlock: await this.fromBlock(),
      toBlock: head,
      chunk: this.o.logChunk,
    });
    const l = logs[0];
    if (!l) return null;
    const d: DistributedLog = {
      bookId: ref.bookId,
      period,
      amounts: amountsToSplit(l.args.amounts),
      txHash: l.transactionHash,
      logIndex: l.logIndex,
      blockNumber: l.blockNumber,
      ts: await this.tsOf(l.blockNumber),
    };
    this.distributedCache.set(k, d);
    return d;
  }

  async feesSwept(ref: BookRef, period: number): Promise<Hex | null> {
    const head = await this.pc.getBlockNumber();
    const logs = await scanEvents(this.pc, {
      address: ref.components.adapter,
      abi: orderlyAdapterAbi,
      eventName: "FeesSwept",
      args: { period: BigInt(period) },
      fromBlock: await this.fromBlock(),
      toBlock: head,
      chunk: this.o.logChunk,
    });
    return logs[0]?.transactionHash ?? null;
  }

  async receivedInTx(ref: BookRef, txHash: Hex): Promise<SettlementReceivedLog[]> {
    return this.receivedFrom(ref, await this.pc.getTransactionReceipt({ hash: txHash }));
  }

  async feeForwarding(ref: BookRef, earmarkTx: Hex): Promise<FeeForwarding> {
    let mark = this.earmarks.get(earmarkTx);
    if (!mark) {
      const receipt = await this.pc.getTransactionReceipt({ hash: earmarkTx });
      const l = parseEventLogs({ abi: orderlyAdapterAbi, eventName: "FeesSwept", logs: receipt.logs }).find((x) => isAddressEqual(x.address, ref.components.adapter));
      if (!l) throw new Error(`tx ${earmarkTx} emitted no FeesSwept on adapter ${ref.components.adapter}`);
      mark = { amount: l.args.amount, blockNumber: receipt.blockNumber, logIndex: l.logIndex };
      if (this.earmarks.size > 100) this.earmarks.clear();
      this.earmarks.set(earmarkTx, mark);
    }
    const { blockNumber, logIndex } = mark;
    const head = await this.pc.getBlockNumber();
    const [logs, pendingFees] = await Promise.all([
      scanEvents<{ bookId: bigint; source: number; amount: bigint }>(this.pc, {
        address: ref.components.router,
        abi: revenueRouterAbi,
        eventName: "SettlementReceived",
        fromBlock: blockNumber,
        toBlock: head,
        chunk: this.o.logChunk,
      }),
      this.pc.readContract({ address: ref.components.adapter, abi: orderlyAdapterAbi, functionName: "pendingFeesUsd" }),
    ]);
    const after = logs.filter((l) => l.blockNumber > blockNumber || l.logIndex > logIndex);
    const received: SettlementReceivedLog[] = [];
    for (const l of after) {
      received.push({ source: Number(l.args.source), amount: l.args.amount, txHash: l.transactionHash, logIndex: l.logIndex, blockNumber: l.blockNumber, ts: await this.tsOf(l.blockNumber) });
    }
    return { earmarked: mark.amount, received, pendingFees };
  }

  async sweepEngineFees(ref: BookRef, period: number) {
    if (ref.venue !== VENUE.POOL_ENGINE) throw new Error("sweepEngineFees on a non-engine book");
    const out = await this.o.sender.send({
      address: ref.components.adapter,
      abi: poolEngineAdapterAbi,
      functionName: "sweepFees",
      args: [BigInt(period), 0n],
      label: `sweepFees(book=${ref.bookId}, period=${period})`,
      bookId: ref.bookId,
    });
    return { hash: out.hash, received: await this.receivedFrom(ref, out.receipt) };
  }

  async engineFeesAccrued(ref: BookRef): Promise<bigint | null> {
    if (ref.venue !== VENUE.POOL_ENGINE) return null;
    try {
      const adapter = ref.components.adapter;
      const [engine, marketId] = await Promise.all([
        this.pc.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "engine" }),
        this.pc.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "marketId" }),
      ]);
      const st = await this.pc.readContract({ address: engine, abi: poolEngineAbi, functionName: "state", args: [marketId] });
      return st.feesAccruedUsd;
    } catch {
      return null;
    }
  }

  private async receivedFrom(ref: BookRef, receipt: TransactionReceipt): Promise<SettlementReceivedLog[]> {
    const logs = parseEventLogs({ abi: revenueRouterAbi, eventName: "SettlementReceived", logs: receipt.logs }).filter((l) => isAddressEqual(l.address, ref.components.router));
    const ts = await this.tsOf(receipt.blockNumber);
    return logs.map((l) => ({ source: Number(l.args.source), amount: l.args.amount, txHash: receipt.transactionHash, logIndex: l.logIndex, blockNumber: receipt.blockNumber, ts }));
  }

  async splitParams(ref: BookRef): Promise<SplitParams> {
    const cfg = this.o.deployment.contracts.config;
    const [pendingGross, expenseCapBps, carryBps, charter, seniorSupply, juniorSupply] = await Promise.all([
      this.pc.readContract({ address: ref.components.router, abi: revenueRouterAbi, functionName: "pendingGross" }),
      this.pc.readContract({ address: cfg, abi: bookrunnerConfigAbi, functionName: "expenseCapBps" }),
      this.pc.readContract({ address: cfg, abi: bookrunnerConfigAbi, functionName: "carryBps" }),
      this.pc.readContract({ address: ref.components.book, abi: bookAbi, functionName: "getCharter" }),
      this.pc.readContract({ address: ref.components.senior, abi: erc20Abi, functionName: "totalSupply" }),
      this.pc.readContract({ address: ref.components.junior, abi: erc20Abi, functionName: "totalSupply" }),
    ]);
    return {
      pendingGross,
      expenseCapBps: BigInt(expenseCapBps),
      carryBps: BigInt(carryBps),
      seniorHurdleBps: BigInt(charter.seniorHurdleBps),
      seniorSupply,
      juniorSupply,
    };
  }

  async previewOnChain(ref: BookRef, gross: bigint, expenses: bigint): Promise<SplitResult | null> {
    try {
      const a = await this.pc.readContract({ address: ref.components.router, abi: revenueRouterAbi, functionName: "previewSplit", args: [gross, expenses] });
      return { gross: a.gross, expenses: a.expenses, carry: a.carry, senior: a.senior, junior: a.junior };
    } catch {
      return null;
    }
  }

  async distribute(ref: BookRef, period: number, expenses: bigint): Promise<{ hash: Hex; distributed: DistributedLog }> {
    const out = await this.o.sender.send({
      address: ref.components.router,
      abi: revenueRouterAbi,
      functionName: "distribute",
      args: [BigInt(period), expenses],
      label: `distribute(book=${ref.bookId}, period=${period})`,
      bookId: ref.bookId,
    });
    const logs = parseEventLogs({ abi: revenueRouterAbi, eventName: "Distributed", logs: out.receipt.logs }).filter((l) => isAddressEqual(l.address, ref.components.router));
    const l = logs[0];
    if (!l) throw new Error(`distribute tx ${out.hash} emitted no Distributed event`);
    const d: DistributedLog = {
      bookId: ref.bookId,
      period: Number(l.args.period),
      amounts: amountsToSplit(l.args.amounts),
      txHash: out.hash,
      logIndex: l.logIndex,
      blockNumber: out.receipt.blockNumber,
      ts: await this.tsOf(out.receipt.blockNumber),
    };
    this.distributedCache.set(`${ref.bookId}:${period}`, d);
    return { hash: out.hash, distributed: d };
  }

  // ---------------------------------------------------------------- KeeperChain
  async snapshot(ref: BookRef): Promise<KeeperSnapshot> {
    const { book, vault, adapter } = ref.components;
    const block = await this.pc.getBlock();
    const blockNumber = block.number;
    const [state, subscriptionEnds, unfundedClaims, lastMarkId, lastMarkPeriodEnd, seniorPrice, juniorPrice, vaultIdle, inTransit, insuranceEquity, marginEquity, netExposure, markInterval] =
      await Promise.all([
        this.pc.readContract({ address: book, abi: bookAbi, functionName: "state", blockNumber }),
        this.pc.readContract({ address: book, abi: bookAbi, functionName: "subscriptionEnds", blockNumber }),
        this.pc.readContract({ address: book, abi: bookAbi, functionName: "unfundedClaims", blockNumber }),
        this.pc.readContract({ address: book, abi: bookAbi, functionName: "lastMarkId", blockNumber }),
        this.pc.readContract({ address: book, abi: bookAbi, functionName: "lastMarkPeriodEnd", blockNumber }),
        this.pc.readContract({ address: book, abi: bookAbi, functionName: "sharePrice", args: [0], blockNumber }),
        this.pc.readContract({ address: book, abi: bookAbi, functionName: "sharePrice", args: [1], blockNumber }),
        this.pc.readContract({ address: vault, abi: underwritingVaultAbi, functionName: "idle", blockNumber }),
        this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "inTransitUsd", blockNumber }),
        this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "insuranceEquityUsd", blockNumber }),
        this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "marginEquityUsd", blockNumber }),
        this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "netExposureUsd", blockNumber }),
        this.getMarkInterval(),
      ]);
    // Orderly: requested-but-unconfirmed withdrawals are still venue-side in inTransitUsd's eyes;
    // the engine settles withdrawals synchronously but caps them (pool cash, required pool margin).
    let pendingWithdraw = 0n;
    let mmWithdrawable: bigint | null = null;
    if (ref.venue === VENUE.POOL_ENGINE) {
      const [engine, marketId] = await Promise.all([
        this.pc.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "engine", blockNumber }),
        this.pc.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "marketId", blockNumber }),
      ]);
      const [st, equity, required] = await Promise.all([
        this.pc.readContract({ address: engine, abi: poolEngineAbi, functionName: "state", args: [marketId], blockNumber }),
        this.pc.readContract({ address: engine, abi: poolEngineAbi, functionName: "poolEquityUsd", args: [marketId], blockNumber }),
        this.pc.readContract({ address: engine, abi: poolEngineAbi, functionName: "requiredPoolMarginUsd", args: [marketId], blockNumber }),
      ]);
      mmWithdrawable = engineWithdrawableUsd(st.poolCashUsd, equity, required);
    } else {
      const [pIf, pMm] = await Promise.all([
        this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "pendingWithdrawUsd", args: [0], blockNumber }),
        this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "pendingWithdrawUsd", args: [1], blockNumber }),
      ]);
      pendingWithdraw = pIf + pMm;
    }
    let lastMark: KeeperSnapshot["lastMark"] = null;
    if (lastMarkId > 0n) {
      const m = await this.pc.readContract({ address: this.o.deployment.contracts.markRegistry, abi: markRegistryAbi, functionName: "getMark", args: [lastMarkId], blockNumber });
      lastMark = { markId: lastMarkId, applied: m.applied, deployedValueUsd: m.input.deployedValueUsd };
    }
    return {
      state: bookStateName(Number(state)),
      nowSec: Number(block.timestamp),
      markInterval,
      subscriptionEnds: Number(subscriptionEnds),
      unfundedClaims,
      vaultIdle,
      inTransit,
      pendingWithdraw,
      mmWithdrawable,
      insuranceEquity,
      marginEquity,
      netExposure,
      sharePriceWad: { senior: seniorPrice, junior: juniorPrice },
      lastMarkPeriodEnd: Number(lastMarkPeriodEnd),
      lastMark,
    };
  }

  async pendingRedemptions(ref: BookRef, afterIndex: bigint, upToIndex: bigint) {
    const cands = await this.o.candidates.candidates(ref, afterIndex, upToIndex);
    if (!cands.length) return { senior: 0n, junior: 0n };
    return pendingShares(this.pc, ref, cands);
  }

  private async keeperSend(ref: BookRef, address: `0x${string}`, abi: typeof bookAbi | typeof underwritingVaultAbi, functionName: string, args: readonly unknown[], label: string) {
    const out = await this.o.sender.send({ address, abi, functionName, args, label: `${label}(book=${ref.bookId})`, bookId: ref.bookId });
    return out.hash;
  }

  closeWindow(ref: BookRef) {
    return this.keeperSend(ref, ref.components.book, bookAbi, "closeWindow", [], "closeWindow");
  }

  fundClaims(ref: BookRef) {
    return this.keeperSend(ref, ref.components.book, bookAbi, "fundClaims", [], "fundClaims");
  }

  recall(ref: BookRef, account: number, amount: bigint) {
    return this.keeperSend(ref, ref.components.vault, underwritingVaultAbi, "recall", [account, amount], `recall[${account === 0 ? "IF" : "MM"},${amount}]`);
  }

  finalizeRetirement(ref: BookRef) {
    return this.keeperSend(ref, ref.components.book, bookAbi, "finalizeRetirement", [], "finalizeRetirement");
  }

  // ---------------------------------------------------------------- BuybackChain
  private get feeRouter() {
    return this.o.deployment.contracts.feeRouter;
  }

  buybackPending() {
    return this.pc.readContract({ address: this.feeRouter, abi: bkrnFeeRouterAbi, functionName: "buybackPending" });
  }

  async quoteBuyback(amountIn: bigint): Promise<bigint | null> {
    const router = await this.pc.readContract({ address: this.feeRouter, abi: bkrnFeeRouterAbi, functionName: "buybackRouter" });
    if (isAddressEqual(router, zeroAddress)) return null;
    if (!this.buybackTokens) {
      const [usdc, bkrn] = await Promise.all([
        this.pc.readContract({ address: this.feeRouter, abi: bkrnFeeRouterAbi, functionName: "usdc" }),
        this.pc.readContract({ address: this.feeRouter, abi: bkrnFeeRouterAbi, functionName: "bkrn" }),
      ]);
      this.buybackTokens = { usdc, bkrn };
    }
    try {
      // MockSwapRouter (devnet/testnet) prices the swap itself; a real SwapRouter02 has no quote (-> null)
      return await this.pc.readContract({ address: router, abi: mockSwapRouterAbi, functionName: "quote", args: [this.buybackTokens.usdc, this.buybackTokens.bkrn, amountIn] });
    } catch {
      return null;
    }
  }

  async buybackBounds(): Promise<{ legacy: boolean; maxPerCall: bigint }> {
    try {
      const maxPerCall = await this.pc.readContract({ address: this.feeRouter, abi: bkrnFeeRouterAbi, functionName: "maxBuybackPerCall" });
      this.legacyFeeRouter = false;
      return { legacy: false, maxPerCall };
    } catch (err) {
      // a router deployed before the on-chain price bound has no maxBuybackPerCall(): legacy keeper call
      if (!isOnChainRevert(err)) throw err;
      this.legacyFeeRouter = true;
      return { legacy: true, maxPerCall: 0n };
    }
  }

  buybackFloor(amountIn: bigint) {
    return this.pc.readContract({ address: this.feeRouter, abi: bkrnFeeRouterAbi, functionName: "buybackFloor", args: [amountIn] });
  }

  async executeBuyback(amountIn: bigint, minBkrnOut: bigint, legacyPoolFee?: number) {
    const legacy = legacyPoolFee !== undefined && this.legacyFeeRouter === true;
    const out = await this.o.sender.send(
      legacy
        ? { address: this.feeRouter, abi: legacyFeeRouterAbi, functionName: "executeBuyback", args: [amountIn, minBkrnOut, legacyPoolFee], label: `executeBuyback(${amountIn}, min=${minBkrnOut}, fee=${legacyPoolFee}) [legacy router]` }
        : { address: this.feeRouter, abi: bkrnFeeRouterAbi, functionName: "executeBuyback", args: [amountIn, minBkrnOut], label: `executeBuyback(${amountIn}, min=${minBkrnOut})` },
    );
    const l = parseEventLogs({ abi: bkrnFeeRouterAbi, eventName: "BuybackExecuted", logs: out.receipt.logs }).find((x) => isAddressEqual(x.address, this.feeRouter));
    return { hash: out.hash, usdcIn: l?.args.usdcIn ?? null, bkrnOut: l?.args.bkrnOut ?? null };
  }
}
