// Test helpers: ABI-encoded fake logs, an in-memory IndexerStore with the DB's uniqueness rules,
// and a fake chain.
import { type BookComponents, type CharterStatus, dbUsd } from "@bookrunner/shared";
import { type Abi, type AbiEvent, type Address, type Hex, encodeAbiParameters, encodeEventTopics, keccak256, toHex } from "viem";
import type { CharterRecordLite, IndexerChain } from "../src/chain";
import type { RawLog } from "../src/decode";
import type {
  AgentKeyRow,
  BookPatch,
  BookRow,
  CharterFiledRow,
  IndexerStore,
  KillRow,
  MarkAppliedPatch,
  MarkRow,
  PendingEvent,
  RedemptionRow,
  SettlementRow,
  SubscriptionRow,
  VoteEntry,
} from "../src/store";

export const txHash = (n: number): Hex => keccak256(toHex(`tx-${n}`));

export function makeLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  meta: { address: Address; block: number; logIndex: number; tx: number },
): RawLog {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent | undefined;
  if (!ev) throw new Error(`no event ${eventName}`);
  const indexedArgs: Record<string, unknown> = {};
  for (const i of ev.inputs) if (i.indexed && i.name) indexedArgs[i.name] = args[i.name];
  const topics = encodeEventTopics({ abi: [ev], eventName, args: indexedArgs } as never) as Hex[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name ?? ""]) as never);
  return {
    address: meta.address,
    topics,
    data,
    blockNumber: BigInt(meta.block),
    logIndex: meta.logIndex,
    transactionHash: txHash(meta.tx),
    blockHash: keccak256(toHex(`block-${meta.block}`)),
    removed: false,
  };
}

// ---------------------------------------------------------------- fake chain

export class FakeChain implements IndexerChain {
  logs: RawLog[] = [];
  head = 0n;
  charters = new Map<bigint, CharterRecordLite>();
  bookCharters = new Map<string, Record<string, unknown>>();
  failCharterIds = new Set<bigint>();
  getLogsCalls: Array<{ addresses: Address[]; from: bigint; to: bigint }> = [];

  async headBlock() {
    return this.head;
  }
  async getLogs(addresses: Address[], from: bigint, to: bigint) {
    this.getLogsCalls.push({ addresses, from, to });
    const set = new Set(addresses.map((a) => a.toLowerCase()));
    return this.logs.filter((l) => set.has(l.address.toLowerCase()) && l.blockNumber! >= from && l.blockNumber! <= to);
  }
  async blockTimestamp(n: bigint) {
    return 1_790_000_000 + Number(n) * 2;
  }
  async charterRecord(id: bigint) {
    if (this.failCharterIds.has(id)) throw new Error(`MarketCharter.get(${id}) reverted`);
    return this.charters.get(id) ?? null;
  }
  async bookCharter(book: Address) {
    return this.bookCharters.get(book.toLowerCase()) ?? null;
  }
  async bookSubscriptionEnds() {
    return 1_790_000_600;
  }
  async bookLastMarkId() {
    return 1n;
  }
  async mark() {
    return { flowNonce: 3n, committedAt: 1_790_000_100 };
  }
  async commitSignature() {
    return "0x1234" as Hex;
  }
  async mandateKeyOperator() {
    return "0x00000000000000000000000000000000000000f1" as Address;
  }
}

// ---------------------------------------------------------------- in-memory store

interface MemState {
  cursors: Record<string, number>;
  charters: Record<number, CharterFiledRow & { status: string; decidedAt?: string; juryCid?: string; bookAddr?: string; meta?: { slashes?: unknown[] } }>;
  verdicts: Array<{ charterId: number; digest: string; cid: string; recommendApprove: boolean; postedTx: string | null; placeholder: boolean }>;
  committee: Record<string, { seat: number | null; bond: string; votes: VoteEntry[] }>;
  books: Record<number, BookRow & { state: string; seniorNav?: string; juniorNav?: string; navUsd?: string; lastMarkId?: number }>;
  subscriptions: Record<string, SubscriptionRow>;
  redemptions: Record<string, RedemptionRow & { assets?: string; honouredMarkId?: number | null; claimedAt?: string }>;
  settlements: Record<string, SettlementRow>;
  agentKeys: Record<string, AgentKeyRow & { status: string; revokedTx?: string; revokedReason?: string }>;
  kills: KillRow[];
  marks: Record<number, MarkRow & { appliedTx?: string } & MarkAppliedPatch>;
  events: Record<string, { id: number; type: string; bookId: number | null; payload: Record<string, unknown>; createdAt: string }>;
  nextEventId: number;
}

const emptyState = (): MemState => ({
  cursors: {},
  charters: {},
  verdicts: [],
  committee: {},
  books: {},
  subscriptions: {},
  redemptions: {},
  settlements: {},
  agentKeys: {},
  kills: [],
  marks: {},
  events: {},
  nextEventId: 1,
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const lc = (s: string) => s.toLowerCase();
const WAD = 10n ** 18n;
const toRaw = dbUsd.fromDb;
const toDb = dbUsd.toDb;

export class MemoryIndexerStore implements IndexerStore {
  s: MemState = emptyState();

  async transaction<T>(fn: (s: IndexerStore) => Promise<T>): Promise<T> {
    const snap = clone(this.s);
    try {
      return await fn(this);
    } catch (e) {
      this.s = snap;
      throw e;
    }
  }
  savepoint<T>(fn: (s: IndexerStore) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async getCursor(name: string) {
    return this.s.cursors[name] ?? null;
  }
  async setCursor(name: string, block: number) {
    this.s.cursors[name] = block;
  }
  async loadBooks(): Promise<Array<{ bookId: number; components: BookComponents }>> {
    return Object.values(this.s.books).map((b) => ({
      bookId: b.id,
      components: { book: b.bookAddr, senior: b.seniorAddr, junior: b.juniorAddr, vault: b.vaultAddr, mandate: b.mandateAddr, router: b.routerAddr, desk: b.deskAddr, adapter: b.adapterAddr } as BookComponents,
    }));
  }
  async getCharterStruct(id: number) {
    return this.s.charters[id]?.structJson ?? null;
  }
  async getBookState(id: number) {
    return this.s.books[id]?.state ?? null;
  }

  async upsertCharterFiled(r: CharterFiledRow) {
    const prev = this.s.charters[r.id];
    this.s.charters[r.id] = { ...prev, ...clone(r), status: prev?.status ?? "Filed" };
  }
  async setCharterStatus(id: number, status: CharterStatus, p: { decidedAt?: Date; juryCid?: string; bookAddr?: string; from?: CharterStatus[] }) {
    const c = this.s.charters[id];
    if (!c || (p.from?.length && !p.from.includes(c.status as CharterStatus))) return false;
    c.status = status;
    if (p.decidedAt) c.decidedAt = p.decidedAt.toISOString();
    if (p.juryCid) c.juryCid = p.juryCid;
    if (p.bookAddr) c.bookAddr = lc(p.bookAddr);
    return true;
  }
  async setCharterJuryCid(id: number, cid: string) {
    const c = this.s.charters[id];
    if (c) c.juryCid = cid;
  }
  async setCharterBook(id: number, bookAddr: string) {
    const c = this.s.charters[id];
    if (c) c.bookAddr = lc(bookAddr);
  }
  async appendCharterSlash(id: number, entry: { tx: string; logIndex: number } & Record<string, unknown>) {
    const c = this.s.charters[id];
    if (!c) return false;
    const slashes = (c.meta?.slashes ?? []) as Array<{ tx: string; logIndex: number }>;
    if (slashes.some((x) => x.tx === entry.tx && x.logIndex === entry.logIndex)) return false;
    c.meta = { ...c.meta, slashes: [...slashes, entry] };
    return true;
  }

  async recordVerdictPosted(p: { charterId: number; digest: string; cid: string; recommendApprove: boolean; txHash: string }) {
    const row = this.s.verdicts.find((v) => v.charterId === p.charterId && v.digest === lc(p.digest));
    if (row && (row.postedTx === null || row.postedTx === p.txHash)) {
      row.postedTx = p.txHash;
      return "updated" as const;
    }
    if (row) return "unchanged" as const;
    this.s.verdicts.push({ charterId: p.charterId, digest: lc(p.digest), cid: p.cid, recommendApprove: p.recommendApprove, postedTx: p.txHash, placeholder: true });
    return "inserted" as const;
  }
  private member(m: string) {
    const k = lc(m);
    this.s.committee[k] ??= { seat: null, bond: "0", votes: [] };
    return this.s.committee[k]!;
  }
  async setCommitteeSeat(member: string, seat: number) {
    for (const [k, v] of Object.entries(this.s.committee)) if (v.seat === seat && k !== lc(member)) v.seat = null;
    this.member(member).seat = seat;
  }
  async clearCommitteeSeat(seat: number) {
    for (const v of Object.values(this.s.committee)) if (v.seat === seat) v.seat = null;
  }
  async setCommitteeBond(member: string, bond: bigint) {
    this.member(member).bond = bond.toString();
  }
  async reduceCommitteeBond(member: string, amount: bigint) {
    const m = this.member(member);
    const b = BigInt(m.bond) - amount;
    m.bond = (b > 0n ? b : 0n).toString();
  }
  async appendCommitteeVote(member: string, vote: VoteEntry) {
    const m = this.member(member);
    if (m.votes.some((v) => v.tx === vote.tx && v.logIndex === vote.logIndex)) return false;
    m.votes.push(vote);
    return true;
  }

  async upsertBook(r: BookRow) {
    const prev = this.s.books[r.id];
    this.s.books[r.id] = { ...prev, ...clone(r), name: r.name ?? prev?.name ?? null, state: prev?.state ?? "Subscription" };
  }
  async updateBook(id: number, patch: BookPatch) {
    const b = this.s.books[id];
    if (!b) return;
    if (patch.lastMarkId !== undefined && b.lastMarkId !== undefined && b.lastMarkId > patch.lastMarkId) return;
    Object.assign(b, patch);
  }

  async insertSubscription(r: SubscriptionRow) {
    const k = `${lc(r.txHash)}:${r.logIndex}`;
    if (this.s.subscriptions[k]) return false;
    this.s.subscriptions[k] = clone(r);
    return true;
  }
  async insertRedemption(r: RedemptionRow) {
    const k = `${lc(r.requestTx)}:${r.logIndex}`;
    if (this.s.redemptions[k]) return false;
    this.s.redemptions[k] = clone(r);
    return true;
  }
  async settleRedemptions(p: { bookId: number; tranche: string; requestId: string; priceWad: bigint; markId: number | null }) {
    let n = 0;
    for (const r of Object.values(this.s.redemptions)) {
      if (r.bookId !== p.bookId || r.tranche !== p.tranche || r.requestId !== p.requestId || r.assets !== undefined) continue;
      r.assets = toDb((toRaw(r.shares) * p.priceWad) / WAD);
      r.honouredMarkId = p.markId;
      n++;
    }
    return n;
  }
  async claimRedemptions(p: { bookId: number; tranche: string; wallet: string; at: Date }) {
    let n = 0;
    for (const r of Object.values(this.s.redemptions)) {
      if (r.bookId === p.bookId && r.tranche === p.tranche && r.wallet === lc(p.wallet) && r.assets !== undefined && !r.claimedAt) {
        r.claimedAt = p.at.toISOString();
        n++;
      }
    }
    return n;
  }
  async insertSettlement(r: SettlementRow) {
    const k = `${lc(r.txHash)}:${r.logIndex}`;
    if (this.s.settlements[k]) return false;
    this.s.settlements[k] = clone(r);
    return true;
  }
  async upsertAgentKey(r: AgentKeyRow) {
    this.s.agentKeys[`${r.bookId}:${lc(r.key)}`] = { ...clone(r), status: "active" };
  }
  async revokeAgentKey(p: { bookId: number; key: string; operator: string; revokedTx: string; reason: string }) {
    const k = `${p.bookId}:${lc(p.key)}`;
    const prev = this.s.agentKeys[k];
    this.s.agentKeys[k] = {
      ...(prev ?? { bookId: p.bookId, key: lc(p.key), operator: p.operator, validUntil: null, inventoryTierUsd: null, registeredTx: "" }),
      status: "revoked",
      revokedTx: p.revokedTx,
      revokedReason: p.reason,
    };
  }
  async insertKillIfAbsent(r: KillRow) {
    if (this.s.kills.some((k) => k.bookId === r.bookId && k.txHash === r.txHash)) return false;
    this.s.kills.push(clone(r));
    return true;
  }
  async insertMarkIfAbsent(r: MarkRow) {
    if (this.s.marks[r.id] || Object.values(this.s.marks).some((m) => m.bookId === r.bookId && String(m.periodEnd) === JSON.parse(JSON.stringify(r.periodEnd)))) return false;
    this.s.marks[r.id] = clone(r);
    return true;
  }
  async setMarkApplied(markId: number, tx: string, patch?: MarkAppliedPatch) {
    const m = this.s.marks[markId];
    if (m) Object.assign(m, { appliedTx: tx, ...patch });
  }
  async insertEvent(e: PendingEvent) {
    if (this.s.events[e.dedupeKey]) return null;
    const id = this.s.nextEventId++;
    const createdAt = new Date(1_790_000_000_000 + id * 1000);
    this.s.events[e.dedupeKey] = { id, type: e.type, bookId: e.bookId, payload: clone(e.payload), createdAt: createdAt.toISOString() };
    return { id, createdAt };
  }
}
