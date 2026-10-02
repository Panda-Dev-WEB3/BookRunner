// REST CRUD for webhook subscriptions: /v1/webhooks. The secret is returned only on create and on
// rotate. Management (everything but GET /event-types) requires `authorization: Bearer
// <API_ADMIN_TOKEN>` and is disabled (403) while the token is unset. Mutations also refuse
// cross-site browser requests (Origin outside the web allow-list, Sec-Fetch-Site: cross-site) and
// non-JSON bodies, and subscription URLs must pass the SSRF target policy (./target.ts).
import { createHash, timingSafeEqual } from "node:crypto";
import { WEBHOOK_EVENTS, type WebhookEventType } from "@bookrunner/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { WebhookDeliveryRow, WebhookSubscriptionRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { generateWebhookSecret } from "./signature";
import { checkWebhookUrl } from "./target";

const urlSchemaFor = (allowHosts: ReadonlySet<string>) =>
  z
    .string()
    .max(2048)
    .superRefine((s, ctx) => {
      const r = checkWebhookUrl(s, allowHosts);
      if (!r.ok) ctx.addIssue({ code: "custom", message: r.reason });
    });

const eventTypesSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);
const bookIdSchema = z.number().int().positive().nullable();

export const createSchemaFor = (allowHosts: ReadonlySet<string> = new Set()) =>
  z.object({
    url: urlSchemaFor(allowHosts),
    eventTypes: eventTypesSchema.default([...WEBHOOK_EVENTS]),
    bookId: bookIdSchema.default(null),
    secret: z.string().min(16).max(256).optional(),
  });

export const patchSchemaFor = (allowHosts: ReadonlySet<string> = new Set()) =>
  z.object({
    url: urlSchemaFor(allowHosts).optional(),
    eventTypes: eventTypesSchema.optional(),
    bookId: bookIdSchema.optional(),
    active: z.boolean().optional(),
  });

export const createSchema = createSchemaFor();
export const patchSchema = patchSchemaFor();

/** Constant-time bearer check (digests first, so length differences leak nothing either). */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export interface WebhookRouteOptions {
  /** Browser origins allowed to call mutating routes (the CORS allow-list). */
  origins?: readonly string[];
}

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

const err = (c: Context, status: 400 | 401 | 403 | 404 | 415 | 500, code: string, message: string, issues?: unknown) =>
  c.json({ error: { code, message, ...(issues ? { issues } : {}) } }, status);

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Body-carrying routes only accept JSON: a cross-site "simple" request (text/plain, form) never parses. */
const isJson = (c: Context) => /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(c.req.header("content-type") ?? "");
const notJson = (c: Context) => err(c, 415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");

function parseId(c: Context): number | null {
  const id = c.req.param("id") ?? "";
  return /^\d+$/.test(id) ? Number(id) : null;
}

export function webhookRoutes(deps: ApiDeps, opts: WebhookRouteOptions = {}): Hono {
  const r = new Hono();
  const store = deps.webhooks;
  const allowHosts = new Set((deps.settings.webhookAllowHosts ?? []).map((h) => h.toLowerCase()));
  const createSchemaHere = createSchemaFor(allowHosts);
  const patchSchemaHere = patchSchemaFor(allowHosts);
  const origins = new Set((opts.origins ?? []).map((o) => o.replace(/\/+$/, "")));

  r.use("*", async (c, next) => {
    if (c.req.method === "GET" && c.req.path.endsWith("/event-types")) return next();
    const token = deps.settings.adminToken;
    if (!token) return err(c, 403, "FORBIDDEN", "webhook management is disabled: set API_ADMIN_TOKEN on the api service");
    if (!bearerMatches(c.req.header("authorization"), token)) return err(c, 401, "UNAUTHORIZED", "admin token required");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS") {
      // no cross-site browser writes, even with a leaked token in a page
      const origin = c.req.header("origin");
      if (origin !== undefined && !origins.has(origin.replace(/\/+$/, ""))) return err(c, 403, "FORBIDDEN", "cross-origin webhook management is not allowed");
      if (origin === undefined && c.req.header("sec-fetch-site") === "cross-site") return err(c, 403, "FORBIDDEN", "cross-site webhook management is not allowed");
    }
    await next();
  });

  r.onError((e, c) => {
    deps.log.error({ err: e }, "webhook route failed");
    return err(c, 500, "INTERNAL_SERVER_ERROR", "internal error");
  });

  r.get("/event-types", (c) => c.json({ items: [...WEBHOOK_EVENTS] }));

  r.post("/", async (c) => {
    if (!isJson(c)) return notJson(c);
    const parsed = createSchemaHere.safeParse((await readJson(c)) ?? {});
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
    if (!isJson(c)) return notJson(c);
    const parsed = patchSchemaHere.safeParse((await readJson(c)) ?? {});
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
