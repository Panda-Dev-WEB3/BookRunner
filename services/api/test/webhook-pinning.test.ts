// Webhook DNS pinning: the delivery connects to the address the SSRF check approved, with the URL's
// name kept for the Host header and (https) the TLS SNI + certificate check.
import { describe, expect, test } from "bun:test";
import { WEBHOOK_EVENTS } from "@bookrunner/shared";
import { deliverWebhook } from "../src/webhooks/deliver";
import { checkResolvedTarget, pinnedRequest } from "../src/webhooks/target";
import { FakeWebhookStore, silentLog } from "./fakes";
import { NOW } from "./fixtures";

type TlsInit = { serverName: string; checkServerIdentity: (host: string, cert: unknown) => Error | undefined };

describe("checkResolvedTarget returns the address to pin", () => {
  test("a name pins its (checked) first answer; an IP literal pins itself; an allow-listed host is not pinned", async () => {
    expect(await checkResolvedTarget("https://hooks.example.com/x", new Set(), async () => ["93.184.216.34", "93.184.216.35"])).toEqual({ ok: true, address: "93.184.216.34" });
    expect(await checkResolvedTarget("https://93.184.216.34/x", new Set(), async () => [])).toEqual({ ok: true, address: "93.184.216.34" });
    expect(await checkResolvedTarget("http://localhost:9000/x", new Set(["localhost"]), async () => ["127.0.0.1"])).toEqual({ ok: true, address: null });
    const bad = await checkResolvedTarget("https://hooks.example.com/x", new Set(), async () => ["93.184.216.34", "10.0.0.1"]);
    expect(bad.ok).toBe(false);
  });
});

describe("pinnedRequest", () => {
  test("https: IP in the URL, Host header + SNI + certificate identity = the name, no connection reuse", () => {
    const p = pinnedRequest("https://hooks.example.com:8443/path?q=1", "93.184.216.34");
    expect(p.url).toBe("https://93.184.216.34:8443/path?q=1");
    expect(p.headers).toEqual({ host: "hooks.example.com:8443" });
    expect(p.init.keepalive).toBe(false);
    const tls = p.init.tls as TlsInit;
    expect(tls.serverName).toBe("hooks.example.com");
    // a certificate for another name is refused even though the connection goes to the pinned IP
    const otherCert = { subject: { CN: "evil.example" }, subjectaltname: "DNS:evil.example" };
    expect(tls.checkServerIdentity("93.184.216.34", otherCert)).toBeInstanceOf(Error);
    const goodCert = { subject: { CN: "hooks.example.com" }, subjectaltname: "DNS:hooks.example.com" };
    expect(tls.checkServerIdentity("93.184.216.34", goodCert)).toBeUndefined();
  });

  test("IPv6 answers are bracketed; http has no TLS options", () => {
    const p = pinnedRequest("http://hooks.example.com/x", "2606:2800:220:1::1");
    expect(p.url).toBe("http://[2606:2800:220:1::1]/x");
    expect(p.headers).toEqual({ host: "hooks.example.com" });
    expect(p.init.tls).toBeUndefined();
  });

  test("IP-literal URLs and unpinned (allow-listed) hosts are fetched as they are", () => {
    expect(pinnedRequest("https://93.184.216.34/x", "93.184.216.34")).toEqual({ url: "https://93.184.216.34/x", headers: {}, init: {} });
    expect(pinnedRequest("http://localhost:9000/x", null)).toEqual({ url: "http://localhost:9000/x", headers: {}, init: {} });
  });

  test("real Bun fetch: the pinned request reaches the pinned address with the name as Host", async () => {
    let seenHost: string | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        seenHost = req.headers.get("host");
        return new Response("ok");
      },
    });
    try {
      const p = pinnedRequest(`http://hooks.example.test:${server.port}/hook`, "127.0.0.1");
      const res = await fetch(p.url, { ...p.init, method: "POST", headers: { ...p.headers, "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(200);
      expect(seenHost as string | null).toBe(`hooks.example.test:${server.port}`);
    } finally {
      server.stop(true);
    }
  });
});

describe("deliverWebhook pins the checked address", () => {
  test("fetch gets the IP URL, the original Host and the TLS server name", async () => {
    const store = new FakeWebhookStore(() => NOW);
    store.subs.push({ id: 1, url: "https://hooks.example.com/in", secret: "whsec_test_secret", eventTypes: [...WEBHOOK_EVENTS], bookId: null, active: true, createdAt: new Date(NOW - 60_000) });
    store.events.push({ id: 1, type: "mark.committed", bookId: 1, payload: { bookId: 1 }, dedupeKey: null, createdAt: new Date(NOW) });
    await store.createDeliveries(1, [1]);
    const calls: Array<{ url: string; init: RequestInit & { tls?: TlsInit } }> = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const out = await deliverWebhook({ store, fetch: fetchImpl, now: () => NOW, timeoutMs: 1000, log: silentLog, resolveHost: async () => ["93.184.216.34"] }, { subscriptionId: 1, eventId: 1 }, 1, 8);
    expect(out.status).toBe("delivered");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://93.184.216.34/in");
    expect((calls[0]!.init.headers as Record<string, string>).host).toBe("hooks.example.com");
    expect(calls[0]!.init.tls?.serverName).toBe("hooks.example.com");
    expect(calls[0]!.init.redirect).toBe("manual");
  });
});
