// In-memory fakes for the data ports and the chain gateway (unit tests need no infra).
import type { Charter, Deployment, Logger } from "@bookrunner/shared";
import { dbUsd } from "@bookrunner/shared";
import pino from "pino";
import { type Address, type Hex, getAddress, zeroHash } from "viem";
import type {
  BookChainState,
  ChainGateway,
  CharterChainRecord,
  CommitteeState,
  MandateChainState,
  ProtocolParams,
  TrancheWalletState,
} from "../src/chain/gateway";
import type {
  AgentKeyRow,
  BookRow,
  CharterRow,
  CommitteeRow,
  DeliveryUpdate,
  EventRow,
  FillCursor,
  FillRow,
  HedgeRow,
  JuryVerdictRow,
  KillEventRow,
  LimitsBucket,
  LimitsRow,
  MarkRow,
  NewWebhookSubscription,
  OraclePriceRow,
  Page,
  ReadModel,
  ReceiptLinkField,
  ReceiptRootRow,
  ReceiptRow,
  RedemptionRow,
  SettlementRow,
  WebhookDeliveryRow,
  WebhookStore,
  WebhookSubscriptionPatch,
  WebhookSubscriptionRow,
} from "../src/data/types";

export const silentLog = pino({ level: "silent" }) as unknown as Logger;

const desc = <T>(xs: T[], key: (t: T) => number) => [...xs].sort((a, b) => key(b) - key(a));
const page = <T>(xs: T[], p: Page, id: (t: T) => number) => xs.filter((x) => p.beforeId === undefined || id(x) < p.beforeId).slice(0, p.limit);

export interface SubscriptionCommit {
  bookId: number;
  tranche: string;
  wallet: string;
  kind: string;
  round: number;
  assets: string;
}

export class FakeReadModel implements ReadModel {
  charters: CharterRow[] = [];
  juryVerdicts: JuryVerdictRow[] = [];
  committee: CommitteeRow[] = [];
  books: BookRow[] = [];
  marks: MarkRow[] = [];
  limits: LimitsRow[] = [];
  kills: KillEventRow[] = [];
  settlements: SettlementRow[] = [];
  fills: FillRow[] = [];
  hedges: HedgeRow[] = [];
  receipts: ReceiptRow[] = [];
  receiptRoots: ReceiptRootRow[] = [];
  agentKeys: AgentKeyRow[] = [];
  redemptions: RedemptionRow[] = [];
  subscriptions: SubscriptionCommit[] = [];
  events: EventRow[] = [];
  oraclePrices: OraclePriceRow[] = [];
  failPing = false;
  /** Makes receiptLinks throw (feeds must still be served, without receipt ids). */
  failReceiptLinks = false;

  async ping() {
    if (this.failPing) throw new Error("db down");
    return true;
  }
  async listCharters(q: { status?: string; sponsor?: string } & Page) {
    const xs = desc(this.charters, (c) => c.id).filter((c) => (!q.status || c.status === q.status) && (!q.sponsor || c.sponsor === q.sponsor.toLowerCase()));
    return page(xs, q, (c) => c.id);
  }
  async getCharter(id: number) {
    return this.charters.find((c) => c.id === id) ?? null;
  }
  async latestJuryVerdict(charterId: number) {
    return desc(this.juryVerdicts.filter((v) => v.charterId === charterId), (v) => v.id)[0] ?? null;
  }
  async juryVerdictsFor(ids: number[]) {
    return this.juryVerdicts.filter((v) => ids.includes(v.charterId)).sort((a, b) => a.id - b.id);
  }
  async committeeMembers() {
    return [...this.committee];
  }
  async listBooks() {
    return [...this.books].sort((a, b) => a.id - b.id);
  }
  async getBook(id: number) {
    return this.books.find((b) => b.id === id) ?? null;
  }
  async latestMarks(ids: number[]) {
    return ids.flatMap((id) => desc(this.marks.filter((m) => m.bookId === id), (m) => m.periodEnd.getTime()).slice(0, 1));
  }
  async listMarks(bookId: number, q: Page & { from?: Date; to?: Date }) {
    const xs = desc(this.marks, (m) => m.periodEnd.getTime()).filter(
      (m) => m.bookId === bookId && (!q.from || m.periodEnd >= q.from) && (!q.to || m.periodEnd <= q.to),
    );
    return page(xs, q, (m) => m.id);
  }
  async getMark(id: number) {
    return this.marks.find((m) => m.id === id) ?? null;
  }
  async markCovering(bookId: number, t: Date) {
    return [...this.marks].filter((m) => m.bookId === bookId && m.periodEnd > t).sort((a, b) => a.periodEnd.getTime() - b.periodEnd.getTime())[0] ?? null;
  }
  async latestLimits(ids: number[]) {
    return ids.flatMap((id) => desc(this.limits.filter((l) => l.bookId === id), (l) => l.ts.getTime()).slice(0, 1));
  }
  async limitsSeries(bookId: number, from: Date, to: Date, bucketSeconds: number): Promise<LimitsBucket[]> {
    const rows = this.limits.filter((l) => l.bookId === bookId && l.ts >= from && l.ts < to).sort((a, b) => a.ts.getTime() - b.ts.getTime());
    const groups = new Map<number, LimitsRow[]>();
    for (const r of rows) {
      const b = Math.floor(r.ts.getTime() / 1000 / bucketSeconds) * bucketSeconds;
      groups.set(b, [...(groups.get(b) ?? []), r]);
    }
    return [...groups.entries()].map(([b, rs]) => {
      const hr = rs.map((r) => r.hedgeRatio).filter((x): x is number => x !== null);
      return {
        bucket: new Date(b * 1000),
        inventoryUtilMax: Math.max(...rs.map((r) => r.inventoryUtil)),
        skewUtilMax: Math.max(...rs.map((r) => r.skewUtil)),
        hedgeRatioAvg: hr.length ? hr.reduce((a, x) => a + x, 0) / hr.length : null,
        drawdownMin: Math.min(...rs.map((r) => r.drawdownBps)),
        state: rs[rs.length - 1]?.state ?? "ok",
        breaching: rs.some((r) => r.state === "breach" || r.state === "killed"),
        samples: rs.length,
      };
    });
  }
  async recentKills(bookId: number, limit: number) {
    return desc(this.kills.filter((k) => k.bookId === bookId), (k) => k.ts.getTime()).slice(0, limit);
  }
  async listSettlements(bookId: number, q: Page) {
    return page(desc(this.settlements.filter((s) => s.bookId === bookId), (s) => s.id), q, (s) => s.id);
  }
  async listFills(bookId: number, q: { limit: number; before?: FillCursor }) {
    const older = (f: FillRow, c: FillCursor) => f.ts < c.ts || (f.ts.getTime() === c.ts.getTime() && f.venueTradeId < c.venueTradeId);
    return this.fills
      .filter((f) => f.bookId === bookId && (!q.before || older(f, q.before)))
      .sort((a, b) => b.ts.getTime() - a.ts.getTime() || (a.venueTradeId < b.venueTradeId ? 1 : a.venueTradeId > b.venueTradeId ? -1 : 0))
      .slice(0, q.limit);
  }
  async listHedges(bookId: number, q: Page) {
    return page(desc(this.hedges.filter((h) => h.bookId === bookId), (h) => h.id), q, (h) => h.id);
  }
  async listReceipts(bookId: number, q: Page & { kind?: number }) {
    return page(desc(this.receipts.filter((r) => r.bookId === bookId && (q.kind === undefined || r.kind === q.kind)), (r) => r.id), q, (r) => r.id);
  }
  async receiptLinks(bookId: number, kind: number, field: ReceiptLinkField, values: string[], from: Date, to: Date) {
    if (this.failReceiptLinks) throw new Error("db down");
    const norm = (v: string) => (field === "txHash" ? v.toLowerCase() : v);
    const wanted = new Set(values.map(norm));
    return this.receipts
      .filter((r) => r.bookId === bookId && r.kind === kind && r.hourStart >= from && r.hourStart <= to)
      .map((r) => ({ id: r.id, raw: (r.payload as Record<string, unknown> | null)?.[field] }))
      .filter((r): r is { id: number; raw: string } => typeof r.raw === "string" && wanted.has(norm(r.raw)))
      .map((r) => ({ id: r.id, value: norm(r.raw) }))
      .sort((a, b) => a.id - b.id);
  }
  async getReceipt(id: number) {
    return this.receipts.find((r) => r.id === id) ?? null;
  }
  async receiptsInHour(bookId: number, hourStart: Date) {
    return this.receipts.filter((r) => r.bookId === bookId && r.hourStart.getTime() === hourStart.getTime()).sort((a, b) => a.id - b.id);
  }
  async receiptRoot(bookId: number, hourStart: Date) {
    return this.receiptRoots.find((r) => r.bookId === bookId && r.hourStart.getTime() === hourStart.getTime()) ?? null;
  }
  async receiptRootsBetween(bookId: number, from: Date, to: Date) {
    return this.receiptRoots
      .filter((r) => r.bookId === bookId && r.hourStart >= from && r.hourStart < to)
      .sort((a, b) => a.hourStart.getTime() - b.hourStart.getTime());
  }
  async listAgentKeys(bookId: number) {
    return this.agentKeys.filter((k) => k.bookId === bookId);
  }
  async listRedemptions(bookId: number, wallet: string) {
    return this.redemptions.filter((r) => r.bookId === bookId && r.wallet === wallet.toLowerCase());
  }
  async committedUsd(bookId: number, tranche: "senior" | "junior", wallet: string, round: number) {
    const sum = this.subscriptions
      .filter((s) => s.bookId === bookId && s.tranche === tranche && s.wallet === wallet.toLowerCase() && s.kind === "commit" && s.round === round)
      .reduce((a, s) => a + dbUsd.fromDb(s.assets), 0n);
    return dbUsd.toDb(sum);
  }
  async recentEvents(q: { type?: string; bookId?: number } & Page) {
    const xs = desc(this.events, (e) => e.id).filter((e) => (!q.type || e.type === q.type) && (q.bookId === undefined || e.bookId === q.bookId));
    return page(xs, q, (e) => e.id);
  }
  async latestOraclePrices(ids?: string[]) {
    const byId = new Map<string, OraclePriceRow>();
    for (const p of [...this.oraclePrices].sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
      if (!ids || ids.includes(p.priceId)) byId.set(p.priceId, p);
    }
    return [...byId.values()];
  }
}

export class FakeWebhookStore implements WebhookStore {
  subs: WebhookSubscriptionRow[] = [];
  events: EventRow[] = [];
  deliveries: WebhookDeliveryRow[] = [];
  cursors = new Map<string, number>();
  private nextSub = 1;
  private nextDelivery = 1;
  constructor(private readonly now: () => number = Date.now) {}

  async createSubscription(s: NewWebhookSubscription) {
    const row: WebhookSubscriptionRow = { id: this.nextSub++, url: s.url, secret: s.secret, eventTypes: s.eventTypes, bookId: s.bookId, active: true, createdAt: new Date(this.now()) };
    this.subs.push(row);
    return row;
  }
  async listSubscriptions() {
    return [...this.subs];
  }
  async getSubscription(id: number) {
    return this.subs.find((s) => s.id === id) ?? null;
  }
  async updateSubscription(id: number, patch: WebhookSubscriptionPatch) {
    const s = this.subs.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return s;
  }
  async deleteSubscription(id: number) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.id !== id);
    return this.subs.length < before;
  }
  async activeSubscriptions() {
    return this.subs.filter((s) => s.active);
  }
  async getEvent(id: number) {
    return this.events.find((e) => e.id === id) ?? null;
  }
  async eventsAfter(afterId: number, types: readonly string[], limit: number) {
    return this.events
      .filter((e) => e.id > afterId && types.includes(e.type))
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
  }
  async createDeliveries(eventId: number, subscriptionIds: number[]) {
    const out: WebhookDeliveryRow[] = [];
    for (const subscriptionId of subscriptionIds) {
      if (this.deliveries.some((d) => d.subscriptionId === subscriptionId && d.eventId === eventId)) continue;
      const row: WebhookDeliveryRow = {
        id: this.nextDelivery++,
        subscriptionId,
        eventId,
        status: "pending",
        attempts: 0,
        responseCode: null,
        lastError: null,
        deliveredAt: null,
        createdAt: new Date(this.now()),
      };
      this.deliveries.push(row);
      out.push(row);
    }
    return out;
  }
  async getDelivery(subscriptionId: number, eventId: number) {
    return this.deliveries.find((d) => d.subscriptionId === subscriptionId && d.eventId === eventId) ?? null;
  }
  async updateDelivery(subscriptionId: number, eventId: number, u: DeliveryUpdate) {
    const d = this.deliveries.find((x) => x.subscriptionId === subscriptionId && x.eventId === eventId);
    if (d) Object.assign(d, u);
  }
  async listDeliveries(subscriptionId: number, limit: number) {
    return this.deliveries.filter((d) => d.subscriptionId === subscriptionId).slice(-limit).reverse();
  }
  async stalePendingDeliveries(olderThan: Date, limit: number) {
    return this.deliveries.filter((d) => d.status === "pending" && d.createdAt < olderThan).slice(0, limit);
  }
  async getCursor(name: string) {
    return this.cursors.get(name) ?? null;
  }
  async setCursor(name: string, value: number) {
    this.cursors.set(name, value);
  }
}

// ------------------------------------------------------------------ chain
export const A = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

export function fakeDeployment(): Deployment {
  return {
    chainId: 31337,
    startBlock: 1,
    contracts: {
      config: A(0xc0),
      timelock: A(0xc1),
      usdc: A(0xc2),
      bkrn: A(0xc3),
      staking: A(0xc4),
      feeRouter: A(0xc5),
      backstop: A(0xc6),
      markRegistry: A(0xc7),
      oracle: A(0xc8),
      stockRegistry: A(0xc9),
      charter: A(0xca),
      committee: A(0xcb),
      factory: A(0xcc),
      poolEngine: A(0xcd),
      hedgeExecutor: A(0xce),
      orderlyVault: A(0xcf),
    },
    stockTokens: {
      NVDA: { token: A(0x1001), priceId: "0x4e56444100000000000000000000000000000000000000000000000000000000", multiplierWad: "1000000000000000000" },
      TSLA: { token: A(0x1002), priceId: "0x54534c4100000000000000000000000000000000000000000000000000000000", multiplierWad: "1000000000000000000" },
    },
    books: [],
  };
}

export const defaultParams = (): ProtocolParams => ({
  charterFeeUsd: 5_000_000_000n,
  sponsorBondBkrn: 100_000n * 10n ** 18n,
  committeeBondBkrn: 250_000n * 10n ** 18n,
  markInterval: 300,
  maxPriceAge: 300,
  newBooksPaused: false,
  venueMinIfUsd: [25_001_000_000n, 10_000_000_000n],
});

export const emptyWallet = (): TrancheWalletState => ({
  shares: 0n,
  totalSupply: 0n,
  committed: 0n,
  totalCommitted: 0n,
  depositsOpen: true,
  paused: false,
  claimableShares: 0n,
  claimableRefund: 0n,
  claimableAssets: 0n,
  navValue: 0n,
  buckets: [],
});

export class FakeChain implements ChainGateway {
  readonly chainId = 31337;
  readonly deployment = fakeDeployment();
  params_ = defaultParams();
  validateReason: Hex = zeroHash;
  validated: Charter[] = [];
  knownUnderlying = true;
  records = new Map<number, CharterChainRecord>();
  committee: CommitteeState = {
    members: [A(0xa8), A(0xa9), A(0xaa)],
    juryVerdict: { cid: zeroHash, recommendApprove: false, posted: false },
    approvals: 0,
    rejections: 0,
    memberStatus: [A(0xa8), A(0xa9), A(0xaa)].map((member) => ({ member, bonded: true, voted: false })),
  };
  stake = new Map<string, bigint>();
  tierBond = 25_000n * 10n ** 18n;
  usdc = { balance: 1_000_000_000_000n, allowance: 0n };
  /** Tranche escrow + vault idle USDC a redemption claim can draw on. */
  liquidity = 10n ** 18n;
  books = new Map<string, BookChainState>();
  wallets = new Map<string, TrancheWalletState>(); // key: tranche|wallet (lowercase)
  mandates = new Map<string, MandateChainState>();
  /** `${mandate}|${operator}|${key}` (lowercase) -> consent */
  consents = new Set<string>();
  failAll = false;

  private guard() {
    if (this.failAll) throw new Error("rpc down");
  }
  async params() {
    this.guard();
    return this.params_;
  }
  async validateCharter(c: Charter) {
    this.guard();
    this.validated.push(c);
    return this.validateReason;
  }
  async underlyingKnown() {
    this.guard();
    return this.knownUnderlying;
  }
  async charterRecord(id: number) {
    this.guard();
    return this.records.get(id) ?? null;
  }
  async committeeState() {
    this.guard();
    return this.committee;
  }
  async stakeAvailable(a: Address) {
    this.guard();
    return this.stake.get(a.toLowerCase()) ?? 0n;
  }
  async agentTierBond() {
    this.guard();
    return this.tierBond;
  }
  async usdcState() {
    this.guard();
    return this.usdc;
  }
  async bookState(book: Address) {
    this.guard();
    const s = this.books.get(book.toLowerCase());
    if (!s) throw new Error(`no book ${book}`);
    return s;
  }
  async trancheWallet(tranche: Address, wallet: Address, requestIds: bigint[]) {
    this.guard();
    const w = this.wallets.get(`${tranche.toLowerCase()}|${wallet.toLowerCase()}`) ?? emptyWallet();
    const known = new Map(w.buckets.map((b) => [b.requestId.toString(), b]));
    return { ...w, buckets: requestIds.map((id) => known.get(id.toString()) ?? { requestId: id, pendingShares: 0n, claimableShares: 0n }) };
  }
  async mandateState(mandate: Address) {
    this.guard();
    const m = this.mandates.get(mandate.toLowerCase());
    if (!m) throw new Error(`no mandate ${mandate}`);
    return m;
  }
  async claimLiquidity() {
    this.guard();
    return this.liquidity;
  }
  async operatorConsent(mandate: Address, operator: Address, key: Address) {
    this.guard();
    return this.consents.has(`${mandate}|${operator}|${key}`.toLowerCase());
  }
  setWallet(tranche: Address, wallet: Address, w: Partial<TrancheWalletState>) {
    this.wallets.set(`${tranche.toLowerCase()}|${wallet.toLowerCase()}`, { ...emptyWallet(), ...w });
  }
}
