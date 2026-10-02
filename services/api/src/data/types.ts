// Data-access ports. Routers depend only on these interfaces; `drizzle.ts` implements them on the
// shared schema, tests use in-memory fakes.
import type {
  agentKeys,
  books,
  charters,
  committee,
  events,
  fills,
  hedges,
  juryVerdicts,
  killEvents,
  limits,
  marks,
  oraclePrices,
  receiptRoots,
  receipts,
  redemptions,
  settlements,
  webhookDeliveries,
  webhookSubscriptions,
} from "@bookrunner/db/schema";

export type CharterRow = typeof charters.$inferSelect;
export type JuryVerdictRow = typeof juryVerdicts.$inferSelect;
export type CommitteeRow = typeof committee.$inferSelect;
export type BookRow = typeof books.$inferSelect;
export type MarkRow = typeof marks.$inferSelect;
export type LimitsRow = typeof limits.$inferSelect;
export type SettlementRow = typeof settlements.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;
export type ReceiptRootRow = typeof receiptRoots.$inferSelect;
export type FillRow = typeof fills.$inferSelect;
export type HedgeRow = typeof hedges.$inferSelect;
export type AgentKeyRow = typeof agentKeys.$inferSelect;
export type RedemptionRow = typeof redemptions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type KillEventRow = typeof killEvents.$inferSelect;
export type OraclePriceRow = typeof oraclePrices.$inferSelect;
export type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

export interface Page {
  limit: number;
  /** Exclusive upper bound on the row id (descending pagination). */
  beforeId?: number;
}

/** Keyset position in the fills feed (hypertable, no id): rows strictly older than (ts, venueTradeId). */
export interface FillCursor {
  ts: Date;
  venueTradeId: string;
}

/** Payload field that links a fill / hedge row to its receipt leaf (agent + risk receipt payloads). */
export type ReceiptLinkField = "venueTradeId" | "txHash";

/** One bucket of the limits time series (Timescale time_bucket aggregation). */
export interface LimitsBucket {
  bucket: Date;
  inventoryUtilMax: number;
  skewUtilMax: number;
  hedgeRatioAvg: number | null;
  drawdownMin: number;
  state: string; // state of the last sample in the bucket
  breaching: boolean; // any sample in state breach/killed
  samples: number;
}

export interface ReadModel {
  ping(): Promise<boolean>;

  // charters / committee
  listCharters(q: { status?: string; sponsor?: string } & Page): Promise<CharterRow[]>;
  getCharter(id: number): Promise<CharterRow | null>;
  latestJuryVerdict(charterId: number): Promise<JuryVerdictRow | null>;
  juryVerdictsFor(charterIds: number[]): Promise<JuryVerdictRow[]>;
  committeeMembers(): Promise<CommitteeRow[]>;

  // books
  listBooks(): Promise<BookRow[]>;
  getBook(id: number): Promise<BookRow | null>;

  // marks
  latestMarks(bookIds: number[]): Promise<MarkRow[]>; // newest mark per book
  listMarks(bookId: number, q: Page & { from?: Date; to?: Date }): Promise<MarkRow[]>; // newest first
  getMark(id: number): Promise<MarkRow | null>;
  /** First mark of the book whose period end is strictly after `t` (the mark covering `t`). */
  markCovering(bookId: number, t: Date): Promise<MarkRow | null>;

  // limits
  latestLimits(bookIds: number[]): Promise<LimitsRow[]>; // newest row per book
  limitsSeries(bookId: number, from: Date, to: Date, bucketSeconds: number): Promise<LimitsBucket[]>;
  recentKills(bookId: number, limit: number): Promise<KillEventRow[]>;

  // settlements
  listSettlements(bookId: number, q: Page): Promise<SettlementRow[]>;

  // activity feeds (newest first)
  /** Fills ordered by (ts, venueTradeId) descending. */
  listFills(bookId: number, q: { limit: number; before?: FillCursor }): Promise<FillRow[]>;
  /** Hedges ordered by id descending. */
  listHedges(bookId: number, q: Page): Promise<HedgeRow[]>;

  // receipts
  /** Receipts of a book ordered by id descending, optionally of one kind. */
  listReceipts(bookId: number, q: Page & { kind?: number }): Promise<ReceiptRow[]>;
  /**
   * Receipts of `kind` whose payload[field] is one of `values` (txHash compared case-insensitively),
   * with from <= hour_start <= to (bounds the scan to the receipts_book_hour index).
   */
  receiptLinks(bookId: number, kind: number, field: ReceiptLinkField, values: string[], from: Date, to: Date): Promise<Array<{ id: number; value: string }>>;
  getReceipt(id: number): Promise<ReceiptRow | null>;
  receiptsInHour(bookId: number, hourStart: Date): Promise<ReceiptRow[]>;
  receiptRoot(bookId: number, hourStart: Date): Promise<ReceiptRootRow | null>;
  /** Hourly roots with from <= hour_start < to, ascending. */
  receiptRootsBetween(bookId: number, from: Date, to: Date): Promise<ReceiptRootRow[]>;

  // agents / subscriptions / redemptions
  listAgentKeys(bookId: number): Promise<AgentKeyRow[]>;
  listRedemptions(bookId: number, wallet: string): Promise<RedemptionRow[]>;
  /** Sum (6dp string) of `commit` rows for a wallet in a tranche round. */
  committedUsd(bookId: number, tranche: "senior" | "junior", wallet: string, round: number): Promise<string>;

  // events / oracle
  recentEvents(q: { type?: string; bookId?: number } & Page): Promise<EventRow[]>;
  latestOraclePrices(priceIds?: string[]): Promise<OraclePriceRow[]>;
}

export interface NewWebhookSubscription {
  url: string;
  secret: string;
  eventTypes: string[];
  bookId: number | null;
}

export interface WebhookSubscriptionPatch {
  url?: string;
  eventTypes?: string[];
  bookId?: number | null;
  active?: boolean;
  secret?: string;
}

export interface DeliveryUpdate {
  status: "pending" | "delivered" | "failed";
  attempts: number;
  responseCode: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
}

export interface WebhookStore {
  createSubscription(s: NewWebhookSubscription): Promise<WebhookSubscriptionRow>;
  listSubscriptions(): Promise<WebhookSubscriptionRow[]>;
  getSubscription(id: number): Promise<WebhookSubscriptionRow | null>;
  updateSubscription(id: number, patch: WebhookSubscriptionPatch): Promise<WebhookSubscriptionRow | null>;
  deleteSubscription(id: number): Promise<boolean>;
  activeSubscriptions(): Promise<WebhookSubscriptionRow[]>;

  getEvent(id: number): Promise<EventRow | null>;
  /** Events with id > afterId of the given types, ascending, at most `limit`. */
  eventsAfter(afterId: number, types: readonly string[], limit: number): Promise<EventRow[]>;

  /** Inserts pending deliveries (ON CONFLICT DO NOTHING); returns only the newly created rows. */
  createDeliveries(eventId: number, subscriptionIds: number[]): Promise<WebhookDeliveryRow[]>;
  getDelivery(subscriptionId: number, eventId: number): Promise<WebhookDeliveryRow | null>;
  updateDelivery(subscriptionId: number, eventId: number, u: DeliveryUpdate): Promise<void>;
  listDeliveries(subscriptionId: number, limit: number): Promise<WebhookDeliveryRow[]>;
  /** Pending deliveries created before `olderThan` (re-enqueue after a Redis loss). */
  stalePendingDeliveries(olderThan: Date, limit: number): Promise<WebhookDeliveryRow[]>;

  getCursor(name: string): Promise<number | null>;
  setCursor(name: string, value: number): Promise<void>;
}
