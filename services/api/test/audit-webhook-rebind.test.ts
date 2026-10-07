// AUDIT (area 6, off-chain): webhook SSRF guard is check-then-use. deliverWebhook resolves the host
// (checkResolvedTarget) and then hands the HOSTNAME url to fetch, which resolves it AGAIN. A DNS name with a
// 0-TTL answer that flips public -> 169.254.169.254 / 127.0.0.1 between the two lookups (DNS rebinding)
// passes the check and the signed POST (and its response code / error text, readable back through
// GET /v1/webhooks/:id) reaches the internal address. Secure behaviour asserted here: the connection goes
// to the address that was checked (pinned), never to a second, unchecked resolution.
import { describe, expect, test } from "bun:test";
import { WEBHOOK_EVENTS } from "@bookrunner/shared";
import { deliverWebhook } from "../src/webhooks/deliver";
import { isBlockedAddress } from "../src/webhooks/target";
import { FakeWebhookStore, silentLog } from "./fakes";
import { NOW } from "./fixtures";

describe("audit: webhook DNS rebinding", () => {
  test("the POST connects only to the address the SSRF check approved", async () => {
    const store = new FakeWebhookStore(() => NOW);
    store.subs.push({
      id: 1,
      url: "https://rebind.attacker.test/hook",
      secret: "whsec_test_secret",
      eventTypes: [...WEBHOOK_EVENTS],
      bookId: null,
      active: true,
      createdAt: new Date(NOW - 60_000),
    });
    store.events.push({ id: 1, type: "mark.committed", bookId: 1, payload: { bookId: 1 }, dedupeKey: null, createdAt: new Date(NOW) });
    await store.createDeliveries(1, [1]);

    // attacker DNS: first answer public, every later answer the cloud metadata address (TTL 0)
    let lookups = 0;
    const resolveHost = async (_host: string) => (lookups++ === 0 ? ["93.184.216.34"] : ["169.254.169.254"]);

    // a fetch that behaves like the real one: a hostname URL is resolved again at connect time
    const connectedTo: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const host = new URL(String(url)).hostname.replace(/^\[|\]$/g, "");
      const ip = /^[\d.]+$/.test(host) || host.includes(":") ? host : (await resolveHost(host))[0]!;
      connectedTo.push(ip);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await deliverWebhook({ store, fetch: fetchImpl, now: () => NOW, timeoutMs: 1000, log: silentLog, resolveHost }, { subscriptionId: 1, eventId: 1 }, 1, 8);
    expect(connectedTo.filter((ip) => isBlockedAddress(ip))).toEqual([]);
  });
});
