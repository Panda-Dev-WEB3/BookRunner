// BullMQ queue names, Redis pub/sub channels and keys, and job payloads shared across services.

export const QUEUES = {
  jury: "bkrn-jury", // charter -> model jury
  venueOps: "bkrn-venue-ops", // symbol creation, IF funding, withdrawals, reports (ops-venue)
  marks: "bkrn-marks", // mark per book per period (mark)
  receipts: "bkrn-receipts", // hourly receipts root per book (receipts)
  settlements: "bkrn-settlements", // settlement sweep + distribute per book per period (waterfall)
  webhooks: "bkrn-webhooks", // webhook deliveries (api)
  events: "bkrn-events", // domain events fan-out (indexer/api)
} as const;

export const CHANNELS = {
  oraclePrice: (priceId: string) => `bkrn:oracle:price:${priceId}`,
  quotes: (bookId: number | bigint) => `bkrn:agent:quotes:${bookId}`,
  fills: (bookId: number | bigint) => `bkrn:agent:fills:${bookId}`,
  riskState: (bookId: number | bigint) => `bkrn:risk:state:${bookId}`,
  kill: (bookId: number | bigint) => `bkrn:risk:kill:${bookId}`,
  domainEvents: "bkrn:events",
} as const;

export const KEYS = {
  oracleLast: (priceId: string) => `bkrn:oracle:last:${priceId}`, // JSON OraclePriceMsg
  riskState: (bookId: number | bigint) => `bkrn:risk:state:${bookId}`, // JSON LimitsSnapshot + meta
  agentHeartbeat: (bookId: number | bigint) => `bkrn:agent:hb:${bookId}`, // unix ms
  agentQuote: (bookId: number | bigint) => `bkrn:agent:quote:${bookId}`, // JSON QuoteMsg (latest)
  liveNav: (bookId: number | bigint) => `bkrn:nav:live:${bookId}`, // JSON LiveNav (risk/mark estimate)
} as const;

export interface OraclePriceMsg {
  priceId: string; // e.g. "NVDA" or index name
  underlying: `0x${string}`;
  priceWad: string;
  price: number;
  publishedAt: number; // unix seconds
  held: boolean;
  sourceCount: number;
  sources: Array<{ name: string; price: number; ts: number }>;
  sourcesHash: `0x${string}`;
  signature: `0x${string}`;
}

export interface QuoteMsg {
  bookId: number;
  ts: number; // unix ms
  bid: number;
  ask: number;
  size: number; // units of underlying per side
  mid: number;
  oracle: number;
  inventoryUsd: number; // signed
  skewBps: number;
  widthBps: number;
  sides: { bid: boolean; ask: boolean };
}

export interface FillMsg {
  bookId: number;
  ts: number;
  side: "buy" | "sell"; // from the BOOK's perspective
  qty: number;
  px: number;
  feeUsd: number;
  venueTradeId: string;
  maker: boolean;
}

export interface KillMsg {
  bookId: number;
  ts: number;
  reason: string;
  breaches: string[];
}

// ---- job payloads ----
export interface JuryJob {
  charterId: number;
}
export interface VenueOpsJob {
  kind: "create_symbol" | "fund_if" | "deposit_mm" | "execute_withdraw" | "report" | "sweep_fees" | "revoke_key";
  bookId: number;
  amountUsd?: string;
  requestNonce?: string;
  period?: number;
}
export interface MarkJob {
  bookId: number;
  periodEnd: number;
}
export interface ReceiptsJob {
  bookId: number;
  hourStart: number;
}
export interface SettlementJob {
  bookId: number;
  period: number;
}
export interface WebhookJob {
  eventId: number;
  subscriptionId: number;
}
