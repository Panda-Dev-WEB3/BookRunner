import { describe, expect, test } from "bun:test";
import { CHANNELS, WEBHOOK_EVENTS, type WebhookJob } from "@bookrunner/shared";
import type { EventRow, WebhookSubscriptionRow } from "../src/data/types";
import { deliverWebhook } from "../src/webhooks/deliver";
import { CATCHUP_MARGIN, WebhookDispatcher } from "../src/webhooks/dispatcher";
import {
  EVENTS_CURSOR,
  WEBHOOK_MAX_ATTEMPTS,
  backoffDelayMs,
  deliveryJobId,
  eventBookId,
  matchesSubscription,
  retrySchedule,
  webhookBody,
  webhookJobOptions,
} from "../src/webhooks/policy";
import { computeSignature, generateWebhookSecret, parseSignatureHeader, signatureHeader, verifyWebhookSignature } from "../src/webhooks/signature";
import { createApp } from "../src/app";
import { FakeWebhookStore, silentLog } from "./fakes";
import { NOW, makeWorld } from "./fixtures";

const KNOWN_BODY = '{"id":1,"type":"mark.committed","createdAt":"2026-10-02T12:00:00.000Z","data":{"bookId":1}}';
// openssl: printf '%s' "1700000000.$KNOWN_BODY" | openssl dgst -sha256 -hmac whsec_test_secret
const KNOWN_SIG = "7f34d9f62736e606b5019d575503b8df10288220ea3428822f9cd196bd6da66d";

const sub = (over: Partial<WebhookSubscriptionRow> = {}): WebhookSubscriptionRow => ({
  id: 1,
  url: "https://hooks.example.test/bkrn",
  secret: "whsec_test_secret",
  eventTypes: [...WEBHOOK_EVENTS],
  bookId: null,
  active: true,
  createdAt: new Date(NOW - 60_000),
  ...over,
});

const ev = (over: Partial<EventRow> = {}): EventRow => ({
  id: 1,
  type: "mark.committed",
  bookId: 1,
  payload: { bookId: 1, markId: 7 },
  dedupeKey: null,
  createdAt: new Date(NOW),
  ...over,
});

describe("webhook signature", () => {
  test("known vector (independently computed with openssl)", () => {
    expect(computeSignature("whsec_test_secret", 1_700_000_000, KNOWN_BODY)).toBe(KNOWN_SIG);
    expect(signatureHeader("whsec_test_secret", KNOWN_BODY, 1_700_000_000)).toBe(`t=1700000000,v1=${KNOWN_SIG}`);
  });

  test("verify: ok, tampered body, wrong secret, stale, malformed", () => {
    const h = `t=1700000000,v1=${KNOWN_SIG}`;
    expect(verifyWebhookSignature("whsec_test_secret", KNOWN_BODY, h, { nowSec: 1_700_000_100 })).toEqual({ ok: true, timestamp: 1_700_000_000 });
    expect(verifyWebhookSignature("whsec_test_secret", `${KNOWN_BODY} `, h, { nowSec: 1_700_000_100 })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWebhookSignature("other", KNOWN_BODY, h, { nowSec: 1_700_000_100 })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWebhookSignature("whsec_test_secret", KNOWN_BODY, h, { nowSec: 1_700_000_301 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyWebhookSignature("whsec_test_secret", KNOWN_BODY, "v1=abc", { nowSec: 1_700_000_000 })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyWebhookSignature("whsec_test_secret", KNOWN_BODY, null)).toEqual({ ok: false, reason: "malformed" });
  });

  test("header parsing tolerates multiple v1 values (secret rotation)", () => {
    const h = `t=1700000000,v1=${"0".repeat(64)},v1=${KNOWN_SIG}`;
    expect(parseSignatureHeader(h)?.v1).toHaveLength(2);
    expect(verifyWebhookSignature("whsec_test_secret", KNOWN_BODY, h, { nowSec: 1_700_000_000 }).ok).toBe(true);
  });

  test("generated secrets are unique and prefixed", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

describe("webhook policy", () => {
  test("only webhook-subscribable types, filtered by type list, book and creation time", () => {
    expect(matchesSubscription(sub(), ev())).toBe(true);
    expect(matchesSubscription(sub(), ev({ type: "book.live" }))).toBe(false); // internal type
    expect(matchesSubscription(sub({ eventTypes: ["kill.executed"] }), ev())).toBe(false);
    expect(matchesSubscription(sub({ bookId: 2 }), ev())).toBe(false);
    expect(matchesSubscription(sub({ bookId: 1 }), ev())).toBe(true);
    expect(matchesSubscription(sub({ active: false }), ev())).toBe(false);
    expect(matchesSubscription(sub({ createdAt: new Date(NOW + 1) }), ev())).toBe(false); // no history back-fill
    // charter.decided carries charterId (== bookId) and no book_id column
    expect(matchesSubscription(sub({ bookId: 5 }), ev({ type: "charter.decided", bookId: null, payload: { charterId: 5, approved: true } }))).toBe(true);
    expect(eventBookId({ bookId: null, payload: { bookId: "12" } })).toBe(12);
  });

  test("retry policy: exponential backoff, 8 attempts, deterministic job ids", () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(8);
    const o = webhookJobOptions(1000);
    expect(o.attempts).toBe(8);
    expect(o.backoff).toEqual({ type: "exponential", delay: 1000 });
    expect(retrySchedule(1000)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000]);
    expect(backoffDelayMs(3, 5000)).toBe(20000);
    expect(deliveryJobId(3, 42)).toBe("wh-3-42");
    expect(deliveryJobId(3, 42)).not.toContain(":");
  });

  test("wire body is {id, type, createdAt, data}", () => {
    expect(webhookBody(ev())).toEqual({ id: 1, type: "mark.committed", createdAt: new Date(NOW).toISOString(), data: { bookId: 1, markId: 7 } });
  });
});

function dispatcherWorld() {
  const store = new FakeWebhookStore(() => NOW);
  const queued: WebhookJob[] = [];
  const d = new WebhookDispatcher({ store, enqueue: async (j) => void queued.push(j), log: silentLog, now: () => NOW });
  return { store, queued, d };
}

describe("dispatcher", () => {
  test("dispatch creates deliveries only for matching subscriptions, idempotently", async () => {
    const { store, queued, d } = dispatcherWorld();
    store.subs.push(sub({ id: 1 }), sub({ id: 2, eventTypes: ["kill.executed"] }), sub({ id: 3, bookId: 2 }), sub({ id: 4, bookId: 1, eventTypes: ["mark.committed"] }));
    const e = ev();
    store.events.push(e);
    expect(await d.dispatch(e)).toBe(2);
    expect(queued).toEqual([
      { eventId: 1, subscriptionId: 1 },
      { eventId: 1, subscriptionId: 4 },
    ]);
    expect(await d.dispatch(e)).toBe(0); // unique (subscription, event)
    expect(queued).toHaveLength(2);
    expect(await d.dispatch(ev({ id: 2, type: "redemption.requested" }))).toBe(0);
  });

  test("pub/sub message -> stored event; malformed / internal messages ignored", async () => {
    const { store, queued, d } = dispatcherWorld();
    store.subs.push(sub());
    store.events.push(ev({ id: 9, type: "kill.executed" }));
    expect(await d.onMessage(JSON.stringify({ id: 9, type: "kill.executed", createdAt: "x", data: {} }))).toBe(1);
    expect(await d.onMessage("{not json")).toBe(0);
    expect(await d.onMessage(JSON.stringify({ id: 9, type: "book.created" }))).toBe(0);
    expect(await d.onMessage(JSON.stringify({ type: "kill.executed" }))).toBe(0); // no id: left to the sweep
    expect(queued).toEqual([{ eventId: 9, subscriptionId: 1 }]);
  });

  test("catch-up from the events table advances the cursor and re-scans a margin", async () => {
    const { store, queued, d } = dispatcherWorld();
    store.subs.push(sub());
    for (let i = 1; i <= 1200; i++) store.events.push(ev({ id: i, type: i % 3 === 0 ? "book.live" : "distribution.paid" }));
    const n = await d.catchUp();
    expect(n).toBe(800);
    expect(store.cursors.get(EVENTS_CURSOR)).toBe(1199);
    expect(new Set(queued.map((q) => q.eventId)).size).toBe(800);
    // a late-committed lower id within the margin is still picked up
    store.events.push(ev({ id: 1199 - CATCHUP_MARGIN + 1, type: "limit.breached" }));
    store.events.sort((a, b) => a.id - b.id);
    store.deliveries = store.deliveries.filter((x) => x.eventId !== 1199 - CATCHUP_MARGIN + 1);
    expect(await d.catchUp()).toBe(1);
  });

  test("start subscribes to the domain events channel and sweeps", async () => {
    const { store, queued, d } = dispatcherWorld();
    store.subs.push(sub());
    store.events.push(ev({ id: 1 }), ev({ id: 2, type: "kill.executed" }));
    let handler: ((c: string, m: string) => void) | null = null;
    const channels: string[] = [];
    await d.start({
      subscribe: async (c) => void channels.push(c),
      unsubscribe: async () => {},
      on: (_e, cb) => {
        handler = cb;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(channels).toEqual([CHANNELS.domainEvents]);
    expect(queued).toHaveLength(2);
    store.events.push(ev({ id: 3, type: "distribution.paid" }));
    handler!(CHANNELS.domainEvents, JSON.stringify({ id: 3, type: "distribution.paid" }));
    handler!("other", JSON.stringify({ id: 3, type: "distribution.paid" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(queued.map((q) => q.eventId)).toEqual([1, 2, 3]);
    await d.stop();
  });

  test("stale pending deliveries are re-enqueued", async () => {
    const { store, queued, d } = dispatcherWorld();
    store.deliveries.push({ id: 1, subscriptionId: 1, eventId: 5, status: "pending", attempts: 2, responseCode: 500, lastError: "x", deliveredAt: null, createdAt: new Date(NOW - 3_600_000) });
    store.deliveries.push({ id: 2, subscriptionId: 1, eventId: 6, status: "delivered", attempts: 1, responseCode: 200, lastError: null, deliveredAt: new Date(NOW), createdAt: new Date(NOW - 3_600_000) });
    expect(await d.requeueStale()).toBe(1);
    expect(queued).toEqual([{ eventId: 5, subscriptionId: 1 }]);
  });
});

describe("delivery attempts", () => {
  interface Seen {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  }
  function deliveryWorld(responder: () => Response) {
    const store = new FakeWebhookStore(() => NOW);
    store.subs.push(sub());
    store.events.push(ev());
    void store.createDeliveries(1, [1]);
    const requests: Seen[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return responder();
    }) as unknown as typeof fetch;
    return { store, requests, deps: { store, fetch: fetchImpl, now: () => NOW, timeoutMs: 1000, log: silentLog } };
  }

  test("2xx -> delivered; signed POST body {id,type,createdAt,data}", async () => {
    const { store, requests, deps } = deliveryWorld(() => new Response("ok", { status: 200 }));
    const out = await deliverWebhook(deps, { subscriptionId: 1, eventId: 1 }, 1, 8);
    expect(out).toEqual({ status: "delivered", responseCode: 200 });
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    const raw = req.body;
    expect(JSON.parse(raw)).toEqual({ id: 1, type: "mark.committed", createdAt: new Date(NOW).toISOString(), data: { bookId: 1, markId: 7 } });
    const v = verifyWebhookSignature("whsec_test_secret", raw, req.headers.get("x-bookrunner-signature"), { nowSec: NOW / 1000 });
    expect(v.ok).toBe(true);
    expect(req.headers.get("x-bookrunner-event")).toBe("mark.committed");
    expect(store.deliveries[0]).toMatchObject({ status: "delivered", attempts: 1, responseCode: 200 });
    // a re-run after success is a no-op
    expect(await deliverWebhook(deps, { subscriptionId: 1, eventId: 1 }, 2, 8)).toEqual({ status: "skipped" });
  });

  test("non-2xx -> retry until the final attempt, then failed", async () => {
    const { store, deps } = deliveryWorld(() => new Response("nope", { status: 503 }));
    expect(await deliverWebhook(deps, { subscriptionId: 1, eventId: 1 }, 1, 8)).toMatchObject({ status: "retry", responseCode: 503 });
    expect(store.deliveries[0]).toMatchObject({ status: "pending", attempts: 1, lastError: "HTTP 503" });
    expect(await deliverWebhook(deps, { subscriptionId: 1, eventId: 1 }, 8, 8)).toMatchObject({ status: "failed" });
    expect(store.deliveries[0]).toMatchObject({ status: "failed", attempts: 8 });
  });

  test("network errors are retried; inactive subscriptions are dropped", async () => {
    const { store, deps } = deliveryWorld(() => {
      throw new TypeError("connection refused");
    });
    expect(await deliverWebhook(deps, { subscriptionId: 1, eventId: 1 }, 1, 8)).toMatchObject({ status: "retry", responseCode: null });
    store.subs[0]!.active = false;
    expect(await deliverWebhook(deps, { subscriptionId: 1, eventId: 1 }, 2, 8)).toMatchObject({ status: "dropped" });
    expect(store.deliveries[0]!.status).toBe("failed");
  });
});

describe("webhooks REST CRUD", () => {
  test("create returns the secret once; list/get never expose it; patch, rotate, delete", async () => {
    const w = makeWorld();
    const app = createApp(w.deps, { origins: ["http://127.0.0.1:5180"] });
    const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const bad = await app.request("/v1/webhooks", json({ url: "ftp://x", eventTypes: ["book.live"] }));
    expect(bad.status).toBe(400);

    const created = await app.request("/v1/webhooks", json({ url: "https://hooks.example.test/a", eventTypes: ["mark.committed"], bookId: 1 }));
    expect(created.status).toBe(201);
    const c = (await created.json()) as { subscription: { id: number }; secret: string };
    expect(c.secret).toMatch(/^whsec_/);
    expect(c.subscription).toMatchObject({ eventTypes: ["mark.committed"], bookId: 1, active: true });

    const list = (await (await app.request("/v1/webhooks")).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(c.secret);
    const one = await (await app.request(`/v1/webhooks/${c.subscription.id}`)).text();
    expect(one).not.toContain(c.secret);

    const patched = await app.request(`/v1/webhooks/${c.subscription.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect(((await patched.json()) as { subscription: { active: boolean } }).subscription.active).toBe(false);

    const rotated = (await (await app.request(`/v1/webhooks/${c.subscription.id}/rotate-secret`, { method: "POST" })).json()) as { secret: string };
    expect(rotated.secret).not.toBe(c.secret);
    expect(w.store.subs[0]!.secret).toBe(rotated.secret);

    expect((await app.request(`/v1/webhooks/${c.subscription.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/v1/webhooks/${c.subscription.id}`, { method: "DELETE" })).status).toBe(404);
    expect(((await (await app.request("/v1/webhooks/event-types")).json()) as { items: string[] }).items).toEqual([...WEBHOOK_EVENTS]);
  });

  test("admin token is enforced when configured", async () => {
    const w = makeWorld();
    w.deps.settings.adminToken = "s3cret";
    const app = createApp(w.deps, { origins: [] });
    expect((await app.request("/v1/webhooks")).status).toBe(401);
    expect((await app.request("/v1/webhooks", { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
  });
});
