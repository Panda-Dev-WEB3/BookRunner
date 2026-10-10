// Delivery channels: email (SMTP submission, smtp.ts) and one webhook (Slack / Discord / Telegram /
// generic JSON). A message counts as delivered when at least one channel accepted it; with no channel
// configured the message is only logged.
import type { DeliveryConfig } from "./config";
import { type Message, webhookBody, webhookFormat } from "./format";
import { type SmtpOptions, sendMail } from "./smtp";

export interface ChannelResult {
  channel: "email" | "webhook";
  ok: boolean;
  error?: string;
}

export interface Deliverer {
  readonly channels: string[];
  deliver(m: Message): Promise<ChannelResult[]>;
}

export interface DelivererDeps {
  fetch: typeof fetch;
  sendMail: (o: SmtpOptions) => Promise<void>;
  timeoutMs?: number;
}

/** Error text without the webhook URL (Slack / Discord / Telegram URLs embed their token). */
export function scrub(msg: string, secrets: Array<string | null | undefined>): string {
  let out = msg;
  for (const s of secrets) if (s) out = out.split(s).join("<redacted>");
  return out.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>").slice(0, 300);
}

export function createDeliverer(cfg: DeliveryConfig, deps: DelivererDeps = { fetch, sendMail }): Deliverer {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const channels: string[] = [];
  if (cfg.email) channels.push(`email -> ${cfg.email.to.join(", ")} via ${cfg.email.host}:${cfg.email.port}`);
  if (cfg.webhook) channels.push(`webhook (${webhookFormat(cfg.webhook.url, cfg.webhook.format)})`);
  const secrets = [cfg.webhook?.url, cfg.email?.pass];

  return {
    channels,
    async deliver(m) {
      const jobs: Array<Promise<ChannelResult>> = [];
      if (cfg.email) {
        const e = cfg.email;
        jobs.push(
          deps
            .sendMail({ host: e.host, port: e.port, user: e.user, pass: e.pass, from: e.from, to: e.to, subject: m.subject, text: m.text, timeoutMs: timeoutMs * 2 })
            .then(() => ({ channel: "email" as const, ok: true }))
            .catch((err: unknown) => ({ channel: "email" as const, ok: false, error: scrub(err instanceof Error ? err.message : String(err), secrets) })),
        );
      }
      if (cfg.webhook) {
        const w = cfg.webhook;
        const fmt = webhookFormat(w.url, w.format);
        jobs.push(
          (async (): Promise<ChannelResult> => {
            try {
              if (fmt === "telegram" && !w.telegramChatId) throw new Error("ALERT_TELEGRAM_CHAT_ID is required for a Telegram webhook");
              const res = await deps.fetch(w.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(webhookBody(fmt, m, w.telegramChatId)),
                signal: AbortSignal.timeout(timeoutMs),
                redirect: "error",
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return { channel: "webhook", ok: true };
            } catch (err) {
              return { channel: "webhook", ok: false, error: scrub(err instanceof Error ? err.message : String(err), secrets) };
            }
          })(),
        );
      }
      return Promise.all(jobs);
    },
  };
}

/** Dead-man's switch ping (e.g. healthchecks.io): an outside service alerts when these stop arriving. */
export async function pingHeartbeat(url: string | null, f: typeof fetch = fetch): Promise<boolean> {
  if (!url) return true;
  try {
    const r = await f(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}
