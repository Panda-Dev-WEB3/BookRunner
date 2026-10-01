// Bookrunner data model (Backend spec §4) + tables the flows require.
// Conventions:
//   - USD amounts / shares: numeric(38,6) decimal strings in human units ("25000.000000").
//     Convert with dbUsd.toDb/fromDb from @bookrunner/shared (raw 6dp bigint <-> string).
//   - Raw token quantities: numeric(78,0). Prices in analytics tables: double precision.
//   - Addresses lowercase hex text. Timestamps timestamptz.
//   - Hypertables (Timescale, see migrations/0001_timescale.sql): quotes, fills, limits, oracle_prices.
//     Hypertables have no single-column PK (time must be part of any unique index).
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const usd = (name: string) => numeric(name, { precision: 38, scale: 6 });
const raw = (name: string) => numeric(name, { precision: 78, scale: 0 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------- charters / committee
export const charters = pgTable(
  "charters",
  {
    id: bigint("id", { mode: "number" }).primaryKey(), // on-chain charter id
    sponsor: text("sponsor").notNull(),
    structJson: jsonb("struct_json").notNull(), // BRTypes.Charter, bigint as strings
    status: text("status").notNull(), // CharterStatus
    juryCid: text("jury_cid"), // full CIDv1 string
    decidedAt: ts("decided_at"),
    bondTx: text("bond_tx"), // tx that filed + locked the bond
    // extensions
    underlying: text("underlying").notNull(),
    symbol: text("symbol").notNull(),
    venue: smallint("venue").notNull(),
    feeUsd: usd("fee_usd"),
    bondBkrn: numeric("bond_bkrn", { precision: 78, scale: 0 }),
    filedAt: ts("filed_at").notNull(),
    bookAddr: text("book_addr"),
    meta: jsonb("meta"), // intake metadata (name, description, sponsor kind)
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("charters_status_idx").on(t.status)],
);

export const juryVerdicts = pgTable("jury_verdicts", {
  id: serial("id").primaryKey(),
  charterId: bigint("charter_id", { mode: "number" }).notNull(),
  cid: text("cid").notNull(), // CIDv1 (raw codec, sha2-256) of verdict JSON
  digest: text("digest").notNull(), // bytes32 sha2-256 digest posted on-chain
  recommendApprove: boolean("recommend_approve").notNull(),
  verdict: jsonb("verdict").notNull(), // { models: [{model, vote, rationale, risks}], rule_checks, summary }
  postedTx: text("posted_tx"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const committee = pgTable("committee", {
  member: text("member").primaryKey(),
  bond: numeric("bond", { precision: 78, scale: 0 }).notNull().default("0"),
  votesJson: jsonb("votes_json").notNull().default(sql`'[]'::jsonb`), // [{charterId, approve, tx, ts}]
  seat: smallint("seat"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------- books
export const books = pgTable("books", {
  id: bigint("id", { mode: "number" }).primaryKey(), // bookId == charterId
  charterId: bigint("charter_id", { mode: "number" }).notNull(),
  seniorAddr: text("senior_addr").notNull(),
  juniorAddr: text("junior_addr").notNull(),
  vaultAddr: text("vault_addr").notNull(),
  venue: smallint("venue").notNull(),
  symbol: text("symbol").notNull(),
  createdAt: ts("created_at").notNull(),
  // extensions
  bookAddr: text("book_addr").notNull(),
  mandateAddr: text("mandate_addr").notNull(),
  routerAddr: text("router_addr").notNull(),
  deskAddr: text("desk_addr").notNull(),
  adapterAddr: text("adapter_addr").notNull(),
  underlying: text("underlying").notNull(),
  name: text("name"),
  state: text("state").notNull().default("Subscription"), // BookState
  subscriptionEnds: ts("subscription_ends"),
  seniorNav: usd("senior_nav"),
  juniorNav: usd("junior_nav"),
  navUsd: usd("nav_usd"),
  lastMarkId: bigint("last_mark_id", { mode: "number" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    tranche: text("tranche").notNull(), // senior | junior
    wallet: text("wallet").notNull(),
    shares: usd("shares").notNull().default("0"),
    ts: ts("ts").notNull(),
    // extensions
    kind: text("kind").notNull(), // commit | allocation | refund | cancelled_refund
    assets: usd("assets").notNull().default("0"),
    round: integer("round").notNull().default(0),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [uniqueIndex("subscriptions_tx_log").on(t.txHash, t.logIndex), index("subscriptions_book_wallet").on(t.bookId, t.wallet)],
);

export const redemptions = pgTable(
  "redemptions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    tranche: text("tranche").notNull(),
    wallet: text("wallet").notNull(), // controller
    shares: usd("shares").notNull(),
    noticeAt: ts("notice_at").notNull(), // request time
    honouredMarkId: bigint("honoured_mark_id", { mode: "number" }),
    // extensions
    requestId: text("request_id").notNull(), // bucket index
    eligibleAt: ts("eligible_at").notNull(),
    assets: usd("assets"),
    claimedAt: ts("claimed_at"),
    requestTx: text("request_tx").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [uniqueIndex("redemptions_tx_log").on(t.requestTx, t.logIndex), index("redemptions_book_bucket").on(t.bookId, t.tranche, t.requestId)],
);

export const venueAccounts = pgTable(
  "venue_accounts",
  {
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    kind: text("kind").notNull(), // if | mm | builder
    accountId: text("account_id").notNull(),
    keyPrefix: text("key_prefix"), // trade-only key prefix (never the full key)
    status: text("status").notNull(), // active | revoked | pending
    // extensions
    createdAt: ts("created_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.kind, t.accountId] })],
);

/** On-chain desk session keys (agent.register / agent.revoke). */
export const agentKeys = pgTable(
  "agent_keys",
  {
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    key: text("key").notNull(),
    operator: text("operator").notNull(),
    validUntil: ts("valid_until"),
    inventoryTierUsd: usd("inventory_tier_usd"),
    status: text("status").notNull(), // active | revoked
    registeredTx: text("registered_tx"),
    revokedTx: text("revoked_tx"),
    revokedReason: text("revoked_reason"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.key] })],
);

// ---------------------------------------------------------------- time series (hypertables)
export const quotes = pgTable(
  "quotes",
  {
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    ts: ts("ts").notNull(),
    bid: doublePrecision("bid"),
    ask: doublePrecision("ask"),
    size: doublePrecision("size").notNull(),
    inventoryUsd: doublePrecision("inventory_usd").notNull(),
    skewBps: doublePrecision("skew_bps").notNull(),
    // extensions
    mid: doublePrecision("mid"),
    oracle: doublePrecision("oracle"),
    widthBps: doublePrecision("width_bps"),
  },
  (t) => [index("quotes_book_ts").on(t.bookId, t.ts)],
);

export const fills = pgTable(
  "fills",
  {
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    ts: ts("ts").notNull(),
    side: text("side").notNull(), // buy | sell (book's perspective)
    qty: doublePrecision("qty").notNull(),
    px: doublePrecision("px").notNull(),
    feeUsd: doublePrecision("fee_usd").notNull(),
    venueTradeId: text("venue_trade_id").notNull(),
    // extensions
    maker: boolean("maker").notNull().default(true),
    trader: text("trader"),
  },
  (t) => [uniqueIndex("fills_book_trade_ts").on(t.bookId, t.venueTradeId, t.ts), index("fills_book_ts").on(t.bookId, t.ts)],
);

export const hedges = pgTable(
  "hedges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    ts: ts("ts").notNull(),
    asset: text("asset").notNull(),
    qtyRaw: raw("qty_raw").notNull(), // signed: + buy, - sell
    px: doublePrecision("px").notNull(),
    mult: doublePrecision("mult").notNull(),
    txHash: text("tx_hash").notNull(),
    // extensions
    venue: text("venue").notNull().default("UNIV3"),
    valueUsd: usd("value_usd"),
  },
  (t) => [index("hedges_book_ts").on(t.bookId, t.ts)],
);

export const limits = pgTable(
  "limits",
  {
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    ts: ts("ts").notNull(),
    inventoryUtil: doublePrecision("inventory_util").notNull(),
    skewUtil: doublePrecision("skew_util").notNull(),
    hedgeRatio: doublePrecision("hedge_ratio"), // bps; null below enforcement threshold
    drawdownBps: doublePrecision("drawdown_bps").notNull(),
    state: text("state").notNull(), // LimitState
    // extensions
    offHours: boolean("off_hours").notNull().default(false),
    breaches: jsonb("breaches"),
    netExposureUsd: doublePrecision("net_exposure_usd"),
    liveNavUsd: doublePrecision("live_nav_usd"),
  },
  (t) => [index("limits_book_ts").on(t.bookId, t.ts)],
);

export const oraclePrices = pgTable(
  "oracle_prices",
  {
    priceId: text("price_id").notNull(),
    ts: ts("ts").notNull(),
    price: doublePrecision("price").notNull(),
    held: boolean("held").notNull(),
    sourceCount: integer("source_count").notNull(),
    sources: jsonb("sources").notNull(),
    sourcesHash: text("sources_hash").notNull(),
    signature: text("signature").notNull(),
    pushedTx: text("pushed_tx"),
  },
  (t) => [index("oracle_prices_id_ts").on(t.priceId, t.ts)],
);

// ---------------------------------------------------------------- marks / settlements / receipts
export const marks = pgTable(
  "marks",
  {
    id: bigint("id", { mode: "number" }).primaryKey(), // on-chain markId
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    periodEnd: ts("period_end").notNull(),
    navUsd: usd("nav_usd").notNull(),
    seniorNav: usd("senior_nav"),
    juniorNav: usd("junior_nav"),
    pnlJson: jsonb("pnl_json").notNull(), // MarkPnl
    receiptsRoot: text("receipts_root").notNull(),
    txHash: text("tx_hash").notNull(),
    // extensions
    inventoryRoot: text("inventory_root").notNull(),
    pnlJsonHash: text("pnl_json_hash").notNull(),
    deployedValueUsd: usd("deployed_value_usd").notNull(),
    flowNonce: bigint("flow_nonce", { mode: "number" }).notNull(),
    signer: text("signer").notNull(),
    signature: text("signature").notNull(),
    appliedTx: text("applied_tx"),
    seniorPrice: doublePrecision("senior_price"),
    juniorPrice: doublePrecision("junior_price"),
    pnlUsd: usd("pnl_usd"),
    committedAt: ts("committed_at").notNull(),
  },
  (t) => [uniqueIndex("marks_book_period").on(t.bookId, t.periodEnd)],
);

export const settlements = pgTable(
  "settlements",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    ts: ts("ts").notNull(),
    source: text("source").notNull(), // distribution | venue_taker_share | engine_fees | funding | liquidation
    grossUsd: usd("gross_usd").notNull(),
    expensesUsd: usd("expenses_usd").notNull().default("0"),
    carryUsd: usd("carry_usd").notNull().default("0"),
    seniorUsd: usd("senior_usd").notNull().default("0"),
    juniorUsd: usd("junior_usd").notNull().default("0"),
    // extensions
    period: bigint("period", { mode: "number" }),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [uniqueIndex("settlements_tx_log").on(t.txHash, t.logIndex), index("settlements_book_ts").on(t.bookId, t.ts)],
);

/** Individual receipt leaves (quotes, fills, hedges, decisions) for hourly roots + proofs. */
export const receipts = pgTable(
  "receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    kind: smallint("kind").notNull(), // RECEIPT_KIND
    ts: ts("ts").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    hourStart: ts("hour_start").notNull(),
  },
  (t) => [index("receipts_book_hour").on(t.bookId, t.hourStart)],
);

export const receiptRoots = pgTable(
  "receipt_roots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bookId: bigint("book_id", { mode: "number" }).notNull(),
    hourStart: ts("hour_start").notNull(),
    root: text("root").notNull(),
    leafCount: integer("leaf_count").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("receipt_roots_book_hour").on(t.bookId, t.hourStart)],
);

// ---------------------------------------------------------------- events / webhooks / indexer
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    bookId: bigint("book_id", { mode: "number" }),
    payload: jsonb("payload").notNull(),
    dedupeKey: text("dedupe_key"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("events_type_created").on(t.type, t.createdAt), uniqueIndex("events_dedupe").on(t.dedupeKey)],
);

export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: serial("id").primaryKey(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  eventTypes: text("event_types").array().notNull(),
  bookId: bigint("book_id", { mode: "number" }), // null = all books
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    subscriptionId: integer("subscription_id").notNull(),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    status: text("status").notNull(), // pending | delivered | failed
    attempts: integer("attempts").notNull().default(0),
    responseCode: integer("response_code"),
    lastError: text("last_error"),
    deliveredAt: ts("delivered_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("webhook_deliveries_sub_event").on(t.subscriptionId, t.eventId)],
);

export const chainCursor = pgTable("chain_cursor", {
  name: text("name").primaryKey(),
  blockNumber: bigint("block_number", { mode: "number" }).notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const killEvents = pgTable("kill_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  bookId: bigint("book_id", { mode: "number" }).notNull(),
  ts: ts("ts").notNull(),
  reason: text("reason").notNull(),
  breaches: jsonb("breaches").notNull(),
  actions: jsonb("actions").notNull(), // ["cancel_all", "flatten", "revoke_venue_key", "revoke_desk_keys", "mandate_kill"]
  txHashes: jsonb("tx_hashes").notNull(),
});
