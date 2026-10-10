// Message rendering, webhook formats, the deliverer and the config / env parsing.
import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { ethToWei, loadConfig, networkOf, parsePairs } from "../src/config";
import type { Notice } from "../src/dedupe";
import { createDeliverer, pingHeartbeat, scrub } from "../src/deliver";
import { noticeLine, renderBatch, renderDigest, webhookBody, webhookFormat } from "../src/format";

const T = Date.UTC(2026, 9, 10, 12, 0, 0);
const n = (over: Partial<Notice> = {}): Notice => ({ kind: "firing", key: "mark_overdue:3", rule: "mark_overdue", severity: "warning", summary: "book 3 NVDA: late", at: T, ...over });

describe("format", () => {
  test("lines and subject: counts, critical first, resolved last", () => {
    const m = renderBatch("BookRunner testnet", [n(), n({ kind: "resolved", key: "api_health", rule: "api_health", firedForMs: 600_000 }), n({ key: "risk_breach:3", rule: "risk_breach", severity: "critical" })], T);
    expect(m.subject).toBe("[BookRunner testnet] 2 firing (1 critical), 1 resolved: mark_overdue …");
    const lines = m.text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("FIRING [critical] risk_breach");
    expect(lines[2]).toBe("- RESOLVED api_health: book 3 NVDA: late (was firing 10m)");
    expect(noticeLine(n({ kind: "escalated", severity: "critical" }))).toStartWith("ESCALATED [critical]");
  });

  test("digest", () => {
    const m = renderDigest("BR", [], [n(), n({ kind: "resolved" })], T);
    expect(m.subject).toBe("[BR] daily digest: all clear");
    expect(m.text).toContain("1 alerts fired, 1 resolved");
  });

  test("webhook format by host, and bodies", () => {
    expect(webhookFormat("https://hooks.slack.com/services/T/B/x", "auto")).toBe("slack");
    expect(webhookFormat("https://discord.com/api/webhooks/1/x", "auto")).toBe("discord");
    expect(webhookFormat("https://api.telegram.org/bot1:abc/sendMessage", "auto")).toBe("telegram");
    expect(webhookFormat("https://ops.example.com/hook", "auto")).toBe("json");
    expect(webhookFormat("https://ops.example.com/hook", "slack")).toBe("slack");
    const m = renderBatch("BR", [n({ summary: "x".repeat(5000) })], T);
    expect(Object.keys(webhookBody("slack", m, null))).toEqual(["text"]);
    expect((webhookBody("discord", m, null).content as string).length).toBe(2000);
    expect(webhookBody("telegram", m, "-100")).toMatchObject({ chat_id: "-100" });
    expect((webhookBody("telegram", m, "-100").text as string).length).toBe(4000);
    expect(webhookBody("json", m, null)).toMatchObject({ subject: m.subject, alerts: m.notices });
  });
});

describe("deliverer", () => {
  const delivery = (over = {}) => ({ label: "BR", email: null, webhook: null, heartbeatUrl: null, minIntervalSec: 60, maxPerHour: 20, clearSec: 120, digestHourUtc: null, ...over });
  const m = renderBatch("BR", [n()], T);

  test("webhook POSTs the format's JSON; HTTP errors are reported without the URL", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const url = "https://hooks.slack.com/services/T000/B000/SECRETTOKEN";
    const d = createDeliverer(delivery({ webhook: { url, format: "auto", telegramChatId: null } }), {
      fetch: (async (u: string, init: RequestInit) => {
        calls.push({ url: u, body: JSON.parse(init.body as string) });
        return new Response("ok", { status: calls.length === 1 ? 200 : 500 });
      }) as unknown as typeof fetch,
      sendMail: async () => {},
    });
    expect(d.channels).toEqual(["webhook (slack)"]);
    expect(await d.deliver(m)).toEqual([{ channel: "webhook", ok: true }]);
    expect(calls[0]!.body).toEqual({ text: `${m.subject}\n\n${m.text}` });
    expect(await d.deliver(m)).toEqual([{ channel: "webhook", ok: false, error: "HTTP 500" }]);
  });

  test("email goes through sendMail with the configured mailbox; failures are scrubbed", async () => {
    const mails: unknown[] = [];
    const email = { to: ["ops@bookrunner.tech"], from: "alerts@bookrunner.tech", host: "mail.use-cert.com", port: 587, user: "alerts@bookrunner.tech", pass: "p4ss" };
    const d = createDeliverer(delivery({ email }), {
      fetch,
      sendMail: async (o) => {
        mails.push(o);
        if (mails.length > 1) throw new Error("535 auth failed for p4ss");
      },
    });
    expect(d.channels[0]).toBe("email -> ops@bookrunner.tech via mail.use-cert.com:587");
    expect((await d.deliver(m))[0]!.ok).toBe(true);
    expect(mails[0]).toMatchObject({ host: "mail.use-cert.com", port: 587, user: "alerts@bookrunner.tech", to: ["ops@bookrunner.tech"], subject: m.subject });
    const fail = (await d.deliver(m))[0]!;
    expect(fail.ok).toBe(false);
    expect(fail.error).not.toContain("p4ss");
  });

  test("telegram needs a chat id", async () => {
    const d = createDeliverer(delivery({ webhook: { url: "https://api.telegram.org/bot1:x/sendMessage", format: "auto", telegramChatId: null } }), { fetch, sendMail: async () => {} });
    const r = (await d.deliver(m))[0]!;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ALERT_TELEGRAM_CHAT_ID");
  });

  test("scrub removes URLs / bot tokens; heartbeat ping", async () => {
    expect(scrub("fetch https://x/y failed", ["https://x/y"])).toBe("fetch <redacted> failed");
    expect(scrub("bot123:AA-bb_cc", [])).toBe("bot<redacted>");
    expect(await pingHeartbeat(null)).toBe(true);
    expect(await pingHeartbeat("https://hc/x", (async () => new Response("", { status: 200 })) as unknown as typeof fetch)).toBe(true);
    expect(await pingHeartbeat("https://hc/x", (async () => Promise.reject(new Error("x"))) as unknown as typeof fetch)).toBe(false);
  });
});

describe("config", () => {
  test("network from NETWORK, else CHAIN_ID", () => {
    expect(networkOf({ NETWORK: "testnet" })).toBe("testnet");
    expect(networkOf({ CHAIN_ID: "4663" })).toBe("mainnet");
    expect(networkOf({ CHAIN_ID: "46630" })).toBe("testnet");
    expect(networkOf({})).toBe("devnet");
  });

  test("per-network defaults: mark grace, funder threshold", () => {
    expect(loadConfig({ NETWORK: "testnet" }).rules.markGraceSec).toBe(900);
    expect(loadConfig({ NETWORK: "mainnet", CHAIN_ID: "4663" }).rules.markGraceSec).toBe(3600);
    expect(loadConfig({ NETWORK: "testnet" }).rules.funderMinWei).toBe(parseEther("0.1"));
    expect(loadConfig({ NETWORK: "testnet", ALERT_MARK_GRACE_SECONDS: "60" }).rules.markGraceSec).toBe(60);
  });

  test("role addresses + balance overrides", () => {
    const c = loadConfig({ NETWORK: "testnet", ALERT_ROLE_ADDRESSES: "markSigner=0x00000000000000000000000000000000000000aa,funder=0x00000000000000000000000000000000000000bb", ALERT_BALANCE_MIN_ETH: "markSigner=0.5,*=0.01" });
    expect(c.roles.map((r) => r.role)).toEqual(["markSigner", "funder"]);
    expect(c.rules.roleMinWei.markSigner).toBe(parseEther("0.5"));
    expect(c.rules.roleMinWei["*"]).toBe(parseEther("0.01"));
    expect(c.rules.roleMinWei.keeper).toBe(parseEther("0.001")); // default kept
    expect(() => loadConfig({ ALERT_ROLE_ADDRESSES: "markSigner=nope" })).toThrow(/not an address/);
  });

  test("channels only when complete", () => {
    expect(loadConfig({ ALERT_EMAIL_TO: "a@b.c" }).delivery.email).toBeNull(); // no SMTP credentials
    const c = loadConfig({ ALERT_EMAIL_TO: "a@b.c, d@e.f", ALERT_SMTP_USER: "alerts@bookrunner.tech", ALERT_SMTP_PASS: "x" });
    expect(c.delivery.email).toMatchObject({ to: ["a@b.c", "d@e.f"], host: "mail.use-cert.com", port: 587, from: "alerts@bookrunner.tech" });
    expect(loadConfig({ ALERT_WEBHOOK_URL: "https://x" }).delivery.webhook).toMatchObject({ format: "auto" });
  });

  test("parsePairs / ethToWei", () => {
    expect(parsePairs("a=1, b=2;c=3 bad =x")).toEqual({ a: "1", b: "2", c: "3" });
    expect(ethToWei("0.0015")).toBe(1_500_000_000_000_000n);
    expect(ethToWei("2")).toBe(2n * 10n ** 18n);
    expect(() => ethToWei("1e5")).toThrow();
  });
});
