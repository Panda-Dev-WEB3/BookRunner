// Chain adapter (viem). Reads book/adapter state, decodes adapter + mandate logs, and sends every
// write with the OPS_VENUE role account (simulate -> send -> wait for receipt; serialised through a
// single tx mutex to keep nonces ordered). Tx hashes are logged.
//
// Crash/timeout safety: every saga write takes an optional `onSent(tx)` callback that receives the tx hash
// and nonce right after broadcast, BEFORE the receipt is awaited, so the saga can persist it. On retry the
// saga inspects that tx (`txState`) instead of re-sending; a dropped tx is replaced with its own nonce
// (`opts.nonce`), so at most one of the two can ever be mined.
import { BOOK_STATE, type BookState, bytes32ToStr, type Deployment, type Logger, publicClientFor, VENUE, walletClientFor } from "@bookrunner/shared";
import { bookAbi, bookFactoryAbi, bookrunnerConfigAbi, mMMandateAbi, mockERC20Abi, orderlyAdapterAbi } from "@bookrunner/shared/abi";
import {
  type Abi,
  type Address,
  type Chain,
  decodeEventLog,
  type Hex,
  type LocalAccount,
  parseAbi,
  type PublicClient,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Transport,
  type WalletClient,
} from "viem";
import { errMsg, Mutex } from "./util";

/** MockOrderlyVault surface beyond IOrderlyVault (ARCHITECTURE §2.9). VERIFY against the A-orderly implementation. */
export const mockVaultExtraAbi = parseAbi([
  "function operatorWithdraw(bytes32 accountId, address to, uint256 amount)",
  "function creditFees(bytes32 accountId, uint256 amount)",
  "function accountOwner(bytes32 accountId) view returns (address)",
  "function tokenHash() view returns (bytes32)",
  "function totalLedger() view returns (uint256)",
  "struct VaultDepositFE { bytes32 accountId; bytes32 brokerHash; bytes32 tokenHash; uint128 tokenAmount; }",
  "function deposit(VaultDepositFE data) payable",
]);
const LEDGER_VIEW_CANDIDATES = ["balanceOf", "balances", "ledger", "accountBalance"] as const;
const ledgerViewAbi = (name: string) => parseAbi([`function ${name}(bytes32 accountId) view returns (uint256)`]) as Abi;

export interface OrderlyBook {
  bookId: number;
  book: Address;
  adapter: Address;
  mandate: Address;
  vault: Address;
  router: Address;
  symbol: string;
  baseAsset: string;
  sessions: Hex;
  underlying: Hex;
  ifTargetUsd: bigint;
  mmInventoryUsd: bigint;
}

export type AdapterLog =
  | { kind: "WithdrawRequested"; adapter: Address; account: number; amount: bigint; nonce: bigint; block: bigint; txHash: Hex; logIndex: number }
  | { kind: "FeesSwept"; adapter: Address; period: bigint; amount: bigint; block: bigint; txHash: Hex; logIndex: number };

export type MandateLog =
  | { kind: "Kill"; mandate: Address; reason: Hex; block: bigint; txHash: Hex }
  | { kind: "Remandated"; mandate: Address; block: bigint; txHash: Hex };

export interface TxResult {
  txHash: Hex;
  logs: Array<{ address: Address; topics: readonly Hex[]; data: Hex; logIndex: number }>;
}

export type SimResult = { ok: true } | { ok: false; error: string };

/** A broadcast tx, recorded before its receipt is awaited. */
export interface SentTx {
  hash: Hex;
  nonce: number;
  at: number; // ms
}

export interface WriteOpts {
  /** Called right after broadcast, before the receipt wait: persist it. */
  onSent?: (tx: SentTx) => void;
  /** Re-use this account nonce (replacing a dropped tx: at most one of the two can be mined). */
  nonce?: number;
}

/**
 * What became of a recorded tx: mined (`success` | `reverted`), still in the mempool (`pending`), gone from
 * the mempool with its nonce still unused (`dropped`: re-send with the same nonce) or gone with its nonce
 * consumed by another tx (`replaced`: it can never be mined; re-send with a fresh nonce).
 */
export type TxState = "success" | "reverted" | "pending" | "dropped" | "replaced";

/** OrderlyAdapter.WithdrawStatus. */
export const WITHDRAW_STATUS = { None: 0, Requested: 1, Confirmed: 2, Cancelled: 3, Failed: 4 } as const;
export const withdrawStatusName = (s: number) => Object.entries(WITHDRAW_STATUS).find(([, v]) => v === s)?.[0] ?? `Unknown(${s})`;

export interface WithdrawRequestView {
  status: number; // WITHDRAW_STATUS
  amount: bigint;
  account: number;
  requestedAt: bigint; // unix seconds
}

/** Adapter flow state read by the reporter and the sagas. */
export interface AdapterFlowState {
  lastFlowAt: bigint; // unix seconds of the last on-chain venue flow (deposit / confirmation / failure)
  pendingWithdrawUsd: bigint; // requested, not yet confirmed (IF + MM)
  inTransitUsd: bigint;
  pendingFeesUsd: bigint;
  usdcBalance: bigint;
}

/** What the workers need from the chain (faked in unit tests). */
export interface ChainPort {
  readonly opsAddress: Address;
  readonly usdc: Address;
  readonly startBlock: bigint;
  listBookIds(): Promise<number[]>;
  loadOrderlyBook(bookId: number): Promise<OrderlyBook | null>;
  bookState(book: Address): Promise<BookState>;
  accountIds(adapter: Address): Promise<{ if: Hex; mm: Hex }>;
  mandateKilled(mandate: Address): Promise<boolean>;
  maxFeeSweepPerPeriod(adapter: Address): Promise<bigint>;
  markInterval(): Promise<number>;
  usdcBalance(who: Address): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  adapterLogs(adapters: Address[], from: bigint, to: bigint): Promise<AdapterLog[]>;
  mandateLogs(mandates: Address[], from: bigint, to: bigint): Promise<MandateLog[]>;
  /** adapter.withdrawRequest(nonce): the on-chain status is the authority for every withdraw step. */
  withdrawStatus(adapter: Address, nonce: bigint): Promise<WithdrawRequestView>;
  adapterFlowState(adapter: Address): Promise<AdapterFlowState>;
  feeSweptForPeriod(adapter: Address, period: bigint): Promise<bigint>;
  forwardableFees(adapter: Address): Promise<bigint>;
  /** What became of a tx recorded via `onSent` (see TxState). */
  txState(tx: SentTx): Promise<TxState>;
  report(adapter: Address, insuranceUsd: bigint, marginUsd: bigint, netExposureUsd: bigint, asOf: bigint): Promise<Hex>;
  confirmWithdraw(adapter: Address, nonce: bigint, opts?: WriteOpts): Promise<Hex>;
  cancelWithdraw(adapter: Address, nonce: bigint, opts?: WriteOpts): Promise<Hex>;
  failWithdraw(adapter: Address, nonce: bigint, opts?: WriteOpts): Promise<Hex>;
  sweepToVault(adapter: Address, opts?: WriteOpts): Promise<Hex | null>;
  /** Earmarks `amount` as the period's fee flow (FeesSwept) and forwards whatever earmarked USDC is already there. */
  sweepFees(adapter: Address, period: bigint, amount: bigint, opts?: WriteOpts): Promise<{ txHash: Hex; logIndex: number }>;
  forwardPendingFees(adapter: Address, opts?: WriteOpts): Promise<{ txHash: Hex; forwarded: bigint }>;
  vaultLedger(accountId: Hex): Promise<bigint | null>;
  /** Devnet mock: mint `amount` mock USDC to MockOrderlyVault (unallocated; then `vaultCreditFees`). */
  mockVaultMint(amount: bigint, opts?: WriteOpts): Promise<Hex>;
  /** Devnet mock: credit `amount` of unallocated MockOrderlyVault USDC to `accountId`. */
  vaultCreditFees(accountId: Hex, amount: bigint, opts?: WriteOpts): Promise<Hex>;
  vaultOperatorWithdraw(accountId: Hex, to: Address, amount: bigint, opts?: WriteOpts): Promise<Hex>;
  usdcTransfer(to: Address, amount: bigint, opts?: WriteOpts): Promise<Hex>;
  headTimestamp(): Promise<bigint>;
  ensureMockAccount(accountId: Hex, brokerFrom: Address): Promise<void>;
}

export class ViemChain implements ChainPort {
  readonly pc: PublicClient;
  readonly wc: WalletClient<Transport, Chain, LocalAccount>;
  private readonly txMutex = new Mutex();
  private ledgerView: string | null | undefined;
  private markIntervalCache: number | null = null;

  constructor(
    readonly dep: Deployment,
    readonly account: LocalAccount,
    private readonly log: Logger,
    o: { chainId: number; rpcUrl: string; confirmations?: number; fallbackMarkInterval: number; txPollMs?: number },
  ) {
    this.pc = publicClientFor(o.chainId, o.rpcUrl);
    this.wc = walletClientFor(o.chainId, o.rpcUrl, account) as WalletClient<Transport, Chain, LocalAccount>;
    this.confirmations = o.confirmations ?? 0;
    this.fallbackMarkInterval = o.fallbackMarkInterval;
    this.txPollMs = o.txPollMs ?? 500;
  }
  private readonly confirmations: number;
  private readonly fallbackMarkInterval: number;
  private readonly txPollMs: number;

  get opsAddress(): Address {
    return this.account.address;
  }
  get usdc(): Address {
    return this.dep.contracts.usdc;
  }
  get startBlock(): bigint {
    return BigInt(this.dep.startBlock);
  }

  async listBookIds(): Promise<number[]> {
    const ids = new Set(this.dep.books.map((b) => b.bookId));
    try {
      const onchain = await this.pc.readContract({ address: this.dep.contracts.factory, abi: bookFactoryAbi, functionName: "bookIds" });
      for (const id of onchain) ids.add(Number(id));
    } catch (err) {
      this.log.debug({ err: errMsg(err) }, "factory.bookIds unavailable; using deployment.books");
    }
    return [...ids].sort((a, b) => a - b);
  }

  async loadOrderlyBook(bookId: number): Promise<OrderlyBook | null> {
    const fromDep = this.dep.books.find((b) => b.bookId === bookId)?.components;
    const comps = fromDep ?? (await this.pc.readContract({ address: this.dep.contracts.factory, abi: bookFactoryAbi, functionName: "componentsOf", args: [BigInt(bookId)] }));
    const charter = await this.pc.readContract({ address: comps.book, abi: bookAbi, functionName: "getCharter" });
    if (charter.venue !== VENUE.ORDERLY) return null;
    const symbol = bytes32ToStr(charter.symbol);
    const m = /^PERP_(.+)_USDC$/.exec(symbol);
    return {
      bookId,
      book: comps.book,
      adapter: comps.adapter,
      mandate: comps.mandate,
      vault: comps.vault,
      router: comps.router,
      symbol,
      baseAsset: m?.[1] ?? symbol,
      sessions: charter.sessions,
      underlying: charter.underlying,
      ifTargetUsd: charter.ifTargetUsd,
      mmInventoryUsd: charter.mmInventoryUsd,
    };
  }

  async bookState(book: Address): Promise<BookState> {
    const s = await this.pc.readContract({ address: book, abi: bookAbi, functionName: "state" });
    return BOOK_STATE[Number(s)] ?? "Subscription";
  }

  async accountIds(adapter: Address) {
    const [ifId, mmId] = await Promise.all([
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "accountId", args: [0] }),
      this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "accountId", args: [1] }),
    ]);
    return { if: ifId.toLowerCase() as Hex, mm: mmId.toLowerCase() as Hex };
  }

  mandateKilled(mandate: Address): Promise<boolean> {
    return this.pc.readContract({ address: mandate, abi: mMMandateAbi, functionName: "killed" });
  }

  maxFeeSweepPerPeriod(adapter: Address): Promise<bigint> {
    return this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "maxFeeSweepPerPeriodUsd" });
  }

  async markInterval(): Promise<number> {
    if (this.markIntervalCache) return this.markIntervalCache;
    try {
      this.markIntervalCache = Number(await this.pc.readContract({ address: this.dep.contracts.config, abi: bookrunnerConfigAbi, functionName: "markInterval" }));
    } catch {
      return this.fallbackMarkInterval;
    }
    return this.markIntervalCache;
  }

  usdcBalance(who: Address): Promise<bigint> {
    return this.pc.readContract({ address: this.usdc, abi: mockERC20Abi, functionName: "balanceOf", args: [who] });
  }

  blockNumber(): Promise<bigint> {
    return this.pc.getBlockNumber({ cacheTime: 0 });
  }

  async adapterLogs(adapters: Address[], from: bigint, to: bigint): Promise<AdapterLog[]> {
    if (adapters.length === 0 || from > to) return [];
    const logs = await this.pc.getLogs({ address: adapters, fromBlock: from, toBlock: to });
    const out: AdapterLog[] = [];
    for (const l of logs) {
      if (!l.transactionHash || l.logIndex === null || l.blockNumber === null) continue;
      try {
        const ev = decodeEventLog({ abi: orderlyAdapterAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
        if (ev.eventName === "WithdrawRequested") {
          out.push({ kind: "WithdrawRequested", adapter: l.address, account: ev.args.account, amount: ev.args.amount, nonce: ev.args.requestNonce, block: l.blockNumber, txHash: l.transactionHash, logIndex: l.logIndex });
        } else if (ev.eventName === "FeesSwept") {
          out.push({ kind: "FeesSwept", adapter: l.address, period: ev.args.period, amount: ev.args.amount, block: l.blockNumber, txHash: l.transactionHash, logIndex: l.logIndex });
        }
      } catch {
        /* other adapter events */
      }
    }
    return out;
  }

  async mandateLogs(mandates: Address[], from: bigint, to: bigint): Promise<MandateLog[]> {
    if (mandates.length === 0 || from > to) return [];
    const logs = await this.pc.getLogs({ address: mandates, fromBlock: from, toBlock: to });
    const out: MandateLog[] = [];
    for (const l of logs) {
      if (!l.transactionHash || l.blockNumber === null) continue;
      try {
        const ev = decodeEventLog({ abi: mMMandateAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
        if (ev.eventName === "Kill") out.push({ kind: "Kill", mandate: l.address, reason: ev.args.reason, block: l.blockNumber, txHash: l.transactionHash });
        else if (ev.eventName === "Remandated") out.push({ kind: "Remandated", mandate: l.address, block: l.blockNumber, txHash: l.transactionHash });
      } catch {
        /* other mandate events */
      }
    }
    return out;
  }

  async withdrawStatus(adapter: Address, nonce: bigint): Promise<WithdrawRequestView> {
    const r = await this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "withdrawRequest", args: [nonce] });
    return { status: Number(r.status), amount: r.amount, account: Number(r.account), requestedAt: BigInt(r.requestedAt) };
  }

  async adapterFlowState(adapter: Address): Promise<AdapterFlowState> {
    const read = (functionName: string, args: readonly unknown[] = []) => this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName, args } as never) as Promise<bigint>;
    const [lastFlowAt, pIf, pMm, inTransitUsd, pendingFeesUsd, usdcBalance] = await Promise.all([
      read("lastFlowAt"),
      read("pendingWithdrawUsd", [0]),
      read("pendingWithdrawUsd", [1]),
      read("inTransitUsd"),
      read("pendingFeesUsd"),
      this.usdcBalance(adapter),
    ]);
    return { lastFlowAt: BigInt(lastFlowAt), pendingWithdrawUsd: pIf + pMm, inTransitUsd, pendingFeesUsd, usdcBalance };
  }

  feeSweptForPeriod(adapter: Address, period: bigint): Promise<bigint> {
    return this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "feeSweptForPeriod", args: [period] });
  }

  forwardableFees(adapter: Address): Promise<bigint> {
    return this.pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "forwardableFees" });
  }

  async txState(tx: SentTx): Promise<TxState> {
    const receipt = async () => {
      try {
        return await this.pc.getTransactionReceipt({ hash: tx.hash });
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err; // RPC trouble is not "not found": never conclude "dropped" from it
      }
    };
    let r = await receipt();
    if (r) return r.status === "success" ? "success" : "reverted";
    try {
      await this.pc.getTransaction({ hash: tx.hash });
      return "pending";
    } catch (err) {
      if (!(err instanceof TransactionNotFoundError)) throw err;
    }
    const used = await this.pc.getTransactionCount({ address: this.account.address, blockTag: "latest" });
    if (used <= tx.nonce) return "dropped";
    r = await receipt(); // mined between the reads?
    if (r) return r.status === "success" ? "success" : "reverted";
    return "replaced";
  }

  // ------------------------------------------------------------------ writes
  private async send(label: string, req: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }, opts?: WriteOpts): Promise<TxResult> {
    return this.txMutex.run(async () => {
      const { request } = await this.pc.simulateContract({ ...req, account: this.account } as never);
      const nonce = opts?.nonce ?? (await this.pc.getTransactionCount({ address: this.account.address, blockTag: "pending" }));
      const txHash = await this.wc.writeContract({ ...(request as object), nonce } as never);
      this.log.info({ tx: txHash, call: label, to: req.address, nonce }, "tx sent");
      opts?.onSent?.({ hash: txHash, nonce, at: Date.now() });
      const rcpt = await this.pc.waitForTransactionReceipt({ hash: txHash, confirmations: Math.max(1, this.confirmations), pollingInterval: this.txPollMs, timeout: 120_000 });
      if (rcpt.status !== "success") throw new Error(`${label} reverted (tx ${txHash})`);
      this.log.info({ tx: txHash, call: label, block: rcpt.blockNumber.toString(), gasUsed: rcpt.gasUsed.toString() }, "tx confirmed");
      return { txHash, logs: rcpt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) };
    });
  }

  async report(adapter: Address, insuranceUsd: bigint, marginUsd: bigint, netExposureUsd: bigint, asOf: bigint): Promise<Hex> {
    return (await this.send("adapter.report", { address: adapter, abi: orderlyAdapterAbi, functionName: "report", args: [insuranceUsd, marginUsd, netExposureUsd, asOf] })).txHash;
  }

  async confirmWithdraw(adapter: Address, nonce: bigint, opts?: WriteOpts): Promise<Hex> {
    return (await this.send("adapter.confirmWithdraw", { address: adapter, abi: orderlyAdapterAbi, functionName: "confirmWithdraw", args: [nonce] }, opts)).txHash;
  }

  async cancelWithdraw(adapter: Address, nonce: bigint, opts?: WriteOpts): Promise<Hex> {
    return (await this.send("adapter.cancelWithdraw", { address: adapter, abi: orderlyAdapterAbi, functionName: "cancelWithdraw", args: [nonce] }, opts)).txHash;
  }

  async failWithdraw(adapter: Address, nonce: bigint, opts?: WriteOpts): Promise<Hex> {
    return (await this.send("adapter.failWithdraw", { address: adapter, abi: orderlyAdapterAbi, functionName: "failWithdraw", args: [nonce] }, opts)).txHash;
  }

  async sweepToVault(adapter: Address, opts?: WriteOpts): Promise<Hex | null> {
    if ((await this.usdcBalance(adapter)) === 0n) return null;
    return (await this.send("adapter.sweepToVault", { address: adapter, abi: orderlyAdapterAbi, functionName: "sweepToVault", args: [] }, opts)).txHash;
  }

  async forwardPendingFees(adapter: Address, opts?: WriteOpts): Promise<{ txHash: Hex; forwarded: bigint }> {
    const r = await this.send("adapter.forwardPendingFees", { address: adapter, abi: orderlyAdapterAbi, functionName: "forwardPendingFees", args: [] }, opts);
    let forwarded = 0n;
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== adapter.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: orderlyAdapterAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
        if (ev.eventName === "FeesForwarded") forwarded += ev.args.amount;
      } catch {
        /* ignore */
      }
    }
    return { txHash: r.txHash, forwarded };
  }

  async sweepFees(adapter: Address, period: bigint, amount: bigint, opts?: WriteOpts): Promise<{ txHash: Hex; logIndex: number }> {
    const r = await this.send("adapter.sweepFees", { address: adapter, abi: orderlyAdapterAbi, functionName: "sweepFees", args: [period, amount] }, opts);
    let logIndex = 0;
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== adapter.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: orderlyAdapterAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
        if (ev.eventName === "FeesSwept") logIndex = l.logIndex;
      } catch {
        /* ignore */
      }
    }
    return { txHash: r.txHash, logIndex };
  }

  /** MockOrderlyVault per-account ledger, if the mock exposes a view (probes common names once). */
  async vaultLedger(accountId: Hex): Promise<bigint | null> {
    const vault = this.dep.contracts.orderlyVault;
    const tryView = async (name: string) => (await this.pc.readContract({ address: vault, abi: ledgerViewAbi(name), functionName: name, args: [accountId] })) as bigint;
    if (this.ledgerView === null) return null;
    if (this.ledgerView) return tryView(this.ledgerView);
    for (const name of LEDGER_VIEW_CANDIDATES) {
      try {
        const v = await tryView(name);
        this.ledgerView = name;
        return v;
      } catch {
        /* next */
      }
    }
    this.ledgerView = null;
    return null;
  }

  /** Chain head timestamp (unix seconds). Report asOf must be <= block.timestamp of the simulation block. */
  async headTimestamp(): Promise<bigint> {
    return (await this.pc.getBlock({ blockTag: "latest" })).timestamp;
  }

  /**
   * Devnet mock only: makes `accountId` exist in MockOrderlyVault (a 1-unit deposit by the ops EOA, which
   * becomes the account owner — mirroring the builder admin account on Orderly) so fee credits and
   * owner-only withdrawals work. No-op when the account already exists.
   */
  async ensureMockAccount(accountId: Hex, brokerFrom: Address): Promise<void> {
    const vault = this.dep.contracts.orderlyVault;
    const owner = (await this.pc.readContract({ address: vault, abi: mockVaultExtraAbi, functionName: "accountOwner", args: [accountId] })) as Address;
    if (owner && !/^0x0{40}$/i.test(owner)) return;
    const brokerHash = (await this.pc.readContract({ address: brokerFrom, abi: orderlyAdapterAbi, functionName: "brokerHash" })) as Hex;
    const tokenHash = (await this.pc.readContract({ address: vault, abi: mockVaultExtraAbi, functionName: "tokenHash" })) as Hex;
    await this.send("usdc.mint", { address: this.usdc, abi: mockERC20Abi, functionName: "mint", args: [this.account.address, 1n] });
    await this.send("usdc.approve", { address: this.usdc, abi: mockERC20Abi, functionName: "approve", args: [vault, 1n] });
    await this.send("mockVault.deposit", { address: vault, abi: mockVaultExtraAbi, functionName: "deposit", args: [{ accountId, brokerHash, tokenHash, tokenAmount: 1n }] });
    this.log.info({ accountId, owner: this.account.address }, "mock vault account registered");
  }

  // MockOrderlyVault credits only unallocated USDC. Callers mint exactly `amount` first (devnet mock USDC,
  // open mint), then credit it: no read-then-mint, so concurrent fee/withdraw sagas cannot race each other's
  // free balance. Two separate txs so the saga can record each one and never repeat it.
  async mockVaultMint(amount: bigint, opts?: WriteOpts): Promise<Hex> {
    return (await this.send("usdc.mint", { address: this.usdc, abi: mockERC20Abi, functionName: "mint", args: [this.dep.contracts.orderlyVault, amount] }, opts)).txHash;
  }

  async vaultCreditFees(accountId: Hex, amount: bigint, opts?: WriteOpts): Promise<Hex> {
    return (await this.send("mockVault.creditFees", { address: this.dep.contracts.orderlyVault, abi: mockVaultExtraAbi, functionName: "creditFees", args: [accountId, amount] }, opts)).txHash;
  }

  async vaultOperatorWithdraw(accountId: Hex, to: Address, amount: bigint, opts?: WriteOpts): Promise<Hex> {
    return (await this.send("mockVault.operatorWithdraw", { address: this.dep.contracts.orderlyVault, abi: mockVaultExtraAbi, functionName: "operatorWithdraw", args: [accountId, to, amount] }, opts)).txHash;
  }

  async usdcTransfer(to: Address, amount: bigint, opts?: WriteOpts): Promise<Hex> {
    return (await this.send("usdc.transfer", { address: this.usdc, abi: mockERC20Abi, functionName: "transfer", args: [to, amount] }, opts)).txHash;
  }
}
