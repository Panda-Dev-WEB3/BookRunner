// Domain events: persisted to `events`, fanned out on CHANNELS.domainEvents, delivered as webhooks.
// Webhook body: { id, type, createdAt, data }. Header `x-bookrunner-signature: t=<unix>,v1=<hex>` where
// v1 = HMAC-SHA256(secret, `${t}.${rawBody}`).

export const WEBHOOK_EVENTS = [
  "charter.decided",
  "limit.breached",
  "kill.executed",
  "mark.committed",
  "distribution.paid",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

// Additional internal event types (not webhook-subscribable).
export type InternalEventType =
  | "charter.filed"
  | "book.created"
  | "book.window_closed"
  | "book.live"
  | "book.retired"
  | "agent.registered"
  | "agent.revoked"
  | "redemption.requested"
  | "redemption.honoured";

export type DomainEventType = WebhookEventType | InternalEventType;

export interface DomainEventPayloads {
  "charter.decided": { charterId: number; approved: boolean; juryCid: string; book?: string; txHash: string };
  "limit.breached": { bookId: number; breaches: string[]; snapshot: Record<string, unknown> };
  "kill.executed": { bookId: number; reason: string; actions: string[]; txHashes: string[] };
  "mark.committed": { bookId: number; markId: number; periodEnd: number; navUsd: string; seniorNav: string; juniorNav: string; receiptsRoot: string; txHash: string };
  "distribution.paid": { bookId: number; period: number; grossUsd: string; expensesUsd: string; carryUsd: string; seniorUsd: string; juniorUsd: string; txHash: string };
  "charter.filed": { charterId: number; sponsor: string; symbol: string };
  "book.created": { bookId: number; book: string };
  "book.window_closed": { bookId: number; seniorAllocated: string; juniorAllocated: string };
  "book.live": { bookId: number };
  "book.retired": { bookId: number; finalNav: string };
  "agent.registered": { bookId: number; key: string; operator: string };
  "agent.revoked": { bookId: number; key: string; reason: string };
  "redemption.requested": { bookId: number; tranche: "senior" | "junior"; wallet: string; shares: string; requestId: string };
  "redemption.honoured": { bookId: number; markId: number; tranche: "senior" | "junior"; shares: string; assets: string };
}

export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  id?: number;
  type: T;
  createdAt: string;
  data: DomainEventPayloads[T];
}
