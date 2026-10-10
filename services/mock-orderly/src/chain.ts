// Chain -> simulator: credits USDC holdings from MockOrderlyVault deposits.
//
// The MockOrderlyVault implementation is written in parallel (A-orderly cluster) and the generated
// ABI only covers IOrderlyVault (no events), so deposits are decoded defensively, in order:
//   1. vault logs matching any known deposit-event shape (Orderly's AccountDeposit/AccountDepositTo,
//      plus plausible mock shapes) -> accountId + amount straight from the event;
//   2. vault logs of unknown shape in a tx sent directly to the vault -> decode the tx calldata as
//      IOrderlyVault.deposit/depositTo(VaultDepositFE);
//   3. OrderlyAdapter.VenueDeposit(account, amount) (frozen IVenueAdapter event) -> accountId via
//      adapter.accountId(account) — covers adapter-routed deposits whatever the vault emits.
// Dedupe: one credit per (tx, accountId, amount); every credit is idempotent per log ref.
import { ACCOUNT, type Deployment, type Logger, publicClientFor, tryLoadDeployment, VENUE } from "@bookrunner/shared";
import { bookFactoryAbi, mockOrderlyVaultAbi, orderlyAdapterAbi } from "@bookrunner/shared/abi";
import { type Abi, type Address, decodeEventLog, decodeFunctionData, type Hex, type Log, parseAbi, type PublicClient } from "viem";
import type { MockVenue } from "./venue";

const DEPOSIT_EVENT_CANDIDATES: Abi[] = [
  "event AccountDeposit(bytes32 indexed accountId, address indexed userAddress, uint64 indexed depositNonce, bytes32 tokenHash, uint128 tokenAmount)",
  "event AccountDepositTo(bytes32 indexed accountId, address indexed userAddress, uint64 indexed depositNonce, bytes32 tokenHash, uint128 tokenAmount)",
  "event Deposit(bytes32 indexed accountId, address indexed from, uint256 amount)",
  "event Deposit(bytes32 indexed accountId, address indexed from, bytes32 tokenHash, uint256 amount)",
  "event Deposit(bytes32 indexed accountId, uint256 amount)",
  "event Deposited(bytes32 indexed accountId, address indexed from, uint256 amount)",
  "event Deposited(bytes32 indexed accountId, address indexed from, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount)",
  "event Deposited(bytes32 indexed accountId, uint256 amount)",
  "event MockDeposit(bytes32 indexed accountId, address indexed from, uint256 amount)",
].map((sig) => parseAbi([sig]) as Abi);

export interface DecodedDeposit {
  accountId: string;
  amount: bigint;
}

/** Try every known deposit-event shape against a raw log. */
export function decodeVaultDepositLog(log: { topics: readonly Hex[]; data: Hex }): DecodedDeposit | null {
  if (log.topics.length === 0) return null;
  for (const abi of DEPOSIT_EVENT_CANDIDATES) {
    try {
      const ev = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
      const args = ev.args as unknown as Record<string, unknown>;
      const accountId = args.accountId as Hex | undefined;
      const amount = (args.tokenAmount ?? args.amount) as bigint | undefined;
      if (accountId && typeof amount === "bigint" && amount > 0n) return { accountId: accountId.toLowerCase(), amount };
    } catch {
      /* not this shape */
    }
  }
  return null;
}

/** Decode IOrderlyVault.deposit / depositTo calldata. */
export function decodeVaultDepositCalldata(input: Hex): DecodedDeposit | null {
  try {
    const fn = decodeFunctionData({ abi: mockOrderlyVaultAbi, data: input });
    if (fn.functionName === "deposit") {
      const [d] = fn.args;
      return { accountId: d.accountId.toLowerCase(), amount: d.tokenAmount };
    }
    if (fn.functionName === "depositTo") {
      const [, d] = fn.args;
      return { accountId: d.accountId.toLowerCase(), amount: d.tokenAmount };
    }
  } catch {
    /* not a deposit call */
  }
  return null;
}

export interface IndexerStatus {
  deployment: boolean;
  vault: string | null;
  cursor: string | null;
  head: string | null;
  adapters: number;
  credited: number;
  lastError: string | null;
  lastPollAt: number | null;
}

export interface DepositIndexerOptions {
  venue: MockVenue;
  chainId: number;
  rpcUrl: string;
  deploymentFile?: string;
  log: Logger;
  maxRange?: bigint;
  /** Injected for tests. */
  client?: PublicClient;
  loadDeployment?: () => Deployment | null;
}

export class DepositIndexer {
  cursor: bigint | null = null;
  private client: PublicClient | null;
  private adapters = new Map<string, { if: string; mm: string; bookId: number }>();
  private lastDiscovery = 0;
  readonly status: IndexerStatus = { deployment: false, vault: null, cursor: null, head: null, adapters: 0, credited: 0, lastError: null, lastPollAt: null };

  constructor(private readonly o: DepositIndexerOptions) {
    this.client = o.client ?? null;
  }

  private deployment(): Deployment | null {
    return this.o.loadDeployment ? this.o.loadDeployment() : tryLoadDeployment(this.o.deploymentFile);
  }

  private pc(): PublicClient {
    if (!this.client) this.client = publicClientFor(this.o.chainId, this.o.rpcUrl);
    return this.client;
  }

  /** Register Orderly adapters' IF/MM accounts with the simulator (owner = adapter.accountOwner). */
  async discover(dep: Deployment): Promise<void> {
    const pc = this.pc();
    const comps = new Map<number, Address>();
    for (const b of dep.books) if (b.venue === VENUE.ORDERLY) comps.set(b.bookId, b.components.adapter);
    try {
      const ids = (await pc.readContract({ address: dep.contracts.factory, abi: bookFactoryAbi, functionName: "bookIds" })) as readonly bigint[];
      for (const id of ids) {
        if (comps.has(Number(id))) continue;
        const c = await pc.readContract({ address: dep.contracts.factory, abi: bookFactoryAbi, functionName: "componentsOf", args: [id] });
        const kind = await pc.readContract({ address: c.adapter, abi: orderlyAdapterAbi, functionName: "venueKind" }).catch(() => null);
        if (kind === VENUE.ORDERLY) comps.set(Number(id), c.adapter);
      }
    } catch (err) {
      this.o.log.debug({ err: String(err) }, "factory discovery unavailable; using deployment.books only");
    }
    for (const [bookId, adapter] of comps) {
      const key = adapter.toLowerCase();
      if (this.adapters.has(key)) continue;
      try {
        const [ifId, mmId] = await Promise.all([
          pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "accountId", args: [ACCOUNT.IF] }),
          pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "accountId", args: [ACCOUNT.MM] }),
        ]);
        // v3 adapters: the IF account belongs to the book's OrderlyIFAccount (accountOwner); pre-v3: the adapter
        const ifOwnerRaw: unknown = await pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName: "accountOwner", args: [ACCOUNT.IF] }).catch(() => adapter);
        const ifOwner = typeof ifOwnerRaw === "string" && /^0x[0-9a-fA-F]{40}$/.test(ifOwnerRaw) ? ifOwnerRaw : adapter;
        this.o.venue.ensureAccount(ifId, { kind: "if", owner: ifOwner });
        this.o.venue.ensureAccount(mmId, { kind: "mm", owner: adapter });
        this.adapters.set(key, { if: ifId.toLowerCase(), mm: mmId.toLowerCase(), bookId });
        this.o.log.info({ bookId, adapter, ifAccountId: ifId, mmAccountId: mmId }, "registered book venue accounts");
      } catch (err) {
        this.o.log.warn({ bookId, adapter, err: String(err) }, "adapter accountId read failed");
      }
    }
    this.status.adapters = this.adapters.size;
  }

  async pollOnce(): Promise<void> {
    const dep = this.deployment();
    this.status.lastPollAt = Date.now();
    if (!dep) {
      this.status.deployment = false;
      return;
    }
    this.status.deployment = true;
    this.status.vault = dep.contracts.orderlyVault;
    const pc = this.pc();
    if (Date.now() - this.lastDiscovery > 30_000) {
      await this.discover(dep);
      this.lastDiscovery = Date.now();
    }
    const head = await pc.getBlockNumber({ cacheTime: 0 });
    this.status.head = head.toString();
    let from = this.cursor ?? BigInt(dep.startBlock);
    if (from > head + 1n) {
      this.o.log.warn({ cursor: from.toString(), head: head.toString() }, "cursor ahead of chain head (chain reset?) — rescanning from deployment.startBlock");
      from = BigInt(dep.startBlock);
    }
    if (from > head) return;
    const to = head < from + (this.o.maxRange ?? 2000n) - 1n ? head : from + (this.o.maxRange ?? 2000n) - 1n;
    const addresses = [dep.contracts.orderlyVault, ...[...this.adapters.keys()].map((a) => a as Address)];
    const logs = await pc.getLogs({ address: addresses, fromBlock: from, toBlock: to });
    await this.processLogs(logs, dep.contracts.orderlyVault);
    this.cursor = to + 1n;
    this.status.cursor = this.cursor.toString();
    this.status.lastError = null;
  }

  async processLogs(logs: Log[], vault: Address): Promise<number> {
    const credited = new Set<string>();
    const unknownVaultTx = new Set<Hex>();
    let n = 0;
    const credit = (accountId: string, amount: bigint, txHash: Hex, ref: string) => {
      const k = `${txHash}:${accountId}:${amount}`;
      if (credited.has(k)) return;
      credited.add(k);
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.o.log.error({ accountId, amount: amount.toString() }, "deposit too large for the simulator; skipped");
        return;
      }
      if (this.o.venue.credit(accountId, Number(amount), ref)) {
        n++;
        this.status.credited++;
        this.o.log.info({ accountId, amountUsd: Number(amount) / 1e6, txHash }, "deposit credited");
      }
    };
    const vaultLc = vault.toLowerCase();
    for (const l of logs) {
      if (l.address.toLowerCase() !== vaultLc || !l.transactionHash) continue;
      const d = decodeVaultDepositLog(l);
      if (d) credit(d.accountId, d.amount, l.transactionHash, `${l.transactionHash}:${l.logIndex}`);
      else unknownVaultTx.add(l.transactionHash);
    }
    for (const tx of unknownVaultTx) {
      try {
        const t = await this.pc().getTransaction({ hash: tx });
        if (t.to?.toLowerCase() !== vaultLc) continue;
        const d = decodeVaultDepositCalldata(t.input);
        if (d) credit(d.accountId, d.amount, tx, `${tx}:calldata`);
      } catch (err) {
        this.o.log.debug({ tx, err: String(err) }, "calldata fallback failed");
      }
    }
    for (const l of logs) {
      const a = this.adapters.get(l.address.toLowerCase());
      if (!a || !l.transactionHash) continue;
      try {
        const ev = decodeEventLog({ abi: orderlyAdapterAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
        if (ev.eventName !== "VenueDeposit") continue;
        const { account, amount } = ev.args as { account: number; amount: bigint };
        const accountId = account === ACCOUNT.IF ? a.if : a.mm;
        credit(accountId, amount, l.transactionHash, `${l.transactionHash}:${l.logIndex}`);
      } catch {
        /* other adapter events */
      }
    }
    return n;
  }

  /** Poll forever with backoff; never throws. */
  async run(signal: AbortSignal, pollMs: number): Promise<void> {
    let backoff = pollMs;
    let lastWarn = 0;
    while (!signal.aborted) {
      try {
        await this.pollOnce();
        if (!this.status.deployment && Date.now() - lastWarn > 60_000) {
          this.o.log.info("no deployment file yet — deposits credited only via POST /mock/credit (retrying)");
          lastWarn = Date.now();
        }
        backoff = pollMs;
      } catch (err) {
        this.status.lastError = String((err as Error).message ?? err);
        this.o.log.warn({ err: this.status.lastError, backoffMs: backoff }, "deposit indexer poll failed");
        backoff = Math.min(backoff * 2, 60_000);
      }
      await sleep(backoff, signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
