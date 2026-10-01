// REST CRUD for webhook subscriptions: /v1/webhooks. The secret is returned only on create and on
// rotate. When API_ADMIN_TOKEN is set, every route requires `authorization: Bearer <token>`.
import { WEBHOOK_EVENTS, type WebhookEventType } from "@bookrunner/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { WebhookDeliveryRow, WebhookSubscriptionRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { generateWebhookSecret } from "./signature";

const urlSchema = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "url must be an absolute http(s) URL");

const eventTypesSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);
const bookIdSchema = z.number().int().positive().nullable();

export const createSchema = z.object({
  url: urlSchema,
  eventTypes: eventTypesSchema.default([...WEBHOOK_EVENTS]),
  bookId: bookIdSchema.default(null),
  secret: z.string().min(16).max(256).optional(),
});

export const patchSchema = z.object({
  url: urlSchema.optional(),
  eventTypes: eventTypesSchema.optional(),
  bookId: bookIdSchema.optional(),
  active: z.boolean().optional(),
});

export interface SubscriptionView {
  id: number;
  url: string;
  eventTypes: WebhookEventType[];
  bookId: number | null;
  active: boolean;
  createdAt: string;
}

export const subscriptionView = (s: WebhookSubscriptionRow): SubscriptionView => ({
  id: s.id,
  url: s.url,
  eventTypes: s.eventTypes.filter((t): t is WebhookEventType => (WEBHOOK_EVENTS as readonly string[]).includes(t)),
  bookId: s.bookId,
  active: s.active,
  createdAt: s.createdAt.toISOString(),
});

const deliveryView = (d: WebhookDeliveryRow) => ({
  id: d.id,
  eventId: d.eventId,
  status: d.status,
  attempts: d.attempts,
  responseCode: d.responseCode,
  lastError: d.lastError,
  deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
  createdAt: d.createdAt.toISOString(),
});

const err = (c: Context, status: 400 | 401 | 404 | 500, code: string, message: string, issues?: unknown) =>
  c.json({ error: { code, message, ...(issues ? { issues } : {}) } }, status);

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function parseId(c: Context): number | null {
  const id = c.req.param("id") ?? "";
  return /^\d+$/.test(id) ? Number(id) : null;
}

export function webhookRoutes(deps: ApiDeps): Hono {
  const r = new Hono();
  const store = deps.webhooks;

  r.use("*", async (c, next) => {
    const token = deps.settings.adminToken;
    if (token && c.req.header("authorization") !== `Bearer ${token}`) return err(c, 401, "UNAUTHORIZED", "admin token required");
    await next();
  });

  r.onError((e, c) => {
    deps.log.error({ err: e }, "webhook route failed");
    return err(c, 500, "INTERNAL_SERVER_ERROR", "internal error");
  });

  r.get("/event-types", (c) => c.json({ items: [...WEBHOOK_EVENTS] }));

  r.post("/", async (c) => {
    const parsed = createSchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return err(c, 400, "BAD_REQUEST", "invalid webhook subscription", parsed.error.issues);
    const secret = parsed.data.secret ?? generateWebhookSecret();
    const row = await store.createSubscription({ url: parsed.data.url, secret, eventTypes: parsed.data.eventTypes, bookId: parsed.data.bookId });
    deps.log.info({ id: row.id, url: row.url, eventTypes: row.eventTypes, bookId: row.bookId }, "webhook subscription created");
    return c.json({ subscription: subscriptionView(row), secret }, 201);
  });

  r.get("/", async (c) => c.json({ items: (await store.listSubscriptions()).map(subscriptionView) }));

  r.get("/:id", async (c) => {
    const id = parseId(c);
    const row = id === null ? null : await store.getSubscription(id);
    if (!row) return err(c, 404, "NOT_FOUND", "webhook subscription not found");
    const deliveries = await store.listDeliveries(row.id, 20);
    return c.json({ subscription: subscriptionView(row), deliveries: deliveries.map(deliveryView) });
  });

  r.get("/:id/deliveries", async (c) => {
    const id = parseId(c);
    const row = id === null ? null : await store.getSubscription(id);
    if (!row) return err(c, 404, "NOT_FOUND", "webhook subscription not found");
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    return c.json({ items: (await store.listDeliveries(row.id, limit)).map(deliveryView) });
  });

  r.patch("/:id", async (c) => {
    const id = parseId(c);
    if (id === null) return err(c, 404, "NOT_FOUND", "webhook subscription not found");
    const parsed = patchSchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return err(c, 400, "BAD_REQUEST", "invalid webhook subscription patch", parsed.error.issues);
    const row = await store.updateSubscription(id, parsed.data);
    if (!row) return err(c, 404, "NOT_FOUND", "webhook subscription not found");
    return c.json({ subscription: subscriptionView(row) });
  });

  r.post("/:id/rotate-secret", async (c) => {
    const id = parseId(c);
    const secret = generateWebhookSecret();
    const row = id === null ? null : await store.updateSubscription(id, { secret });
    if (!row) return err(c, 404, "NOT_FOUND", "webhook subscription not found");
    return c.json({ subscription: subscriptionView(row), secret });
  });

  r.delete("/:id", async (c) => {
    const id = parseId(c);
    const ok = id !== null && (await store.deleteSubscription(id));
    if (!ok) return err(c, 404, "NOT_FOUND", "webhook subscription not found");
    return c.body(null, 204);
  });

  return r;
}
