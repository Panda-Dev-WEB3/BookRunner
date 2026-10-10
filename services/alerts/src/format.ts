// Message rendering (pure): one batch of notices -> subject + plain text, and the webhook bodies for the
// Slack / Discord / Telegram / generic JSON formats.
import type { Notice, Tracked } from "./dedupe";
import { dur } from "./rules";

export interface Message {
  subject: string;
  text: string;
  /** structured copy for the generic JSON webhook */
  notices: Notice[];
}

const TAG: Record<Notice["kind"], string> = { firing: "FIRING", escalated: "ESCALATED", resolved: "RESOLVED" };

export function noticeLine(n: Notice): string {
  const sev = n.kind === "resolved" ? "" : ` [${n.severity}]`;
  const tail = n.kind === "resolved" && n.firedForMs !== undefined ? ` (was firing ${dur(n.firedForMs / 1000)})` : "";
  return `${TAG[n.kind]}${sev} ${n.rule}: ${n.summary}${tail}`;
}

export function renderBatch(label: string, batch: Notice[], now: number): Message {
  const fire = batch.filter((n) => n.kind !== "resolved");
  const res = batch.filter((n) => n.kind === "resolved");
  const crit = fire.filter((n) => n.severity === "critical").length;
  const parts: string[] = [];
  if (fire.length) parts.push(`${fire.length} firing${crit ? ` (${crit} critical)` : ""}`);
  if (res.length) parts.push(`${res.length} resolved`);
  const lead = fire[0] ?? res[0];
  const subject = `[${label}] ${parts.join(", ")}${lead ? `: ${lead.rule}${batch.length > 1 ? " …" : ""}` : ""}`;
  // most severe first, resolved last
  const order = (n: Notice) => (n.kind === "resolved" ? 3 : n.severity === "critical" ? 0 : n.kind === "escalated" ? 1 : 2);
  const lines = [...batch].sort((a, b) => order(a) - order(b) || a.at - b.at).map(noticeLine);
  const text = [`${label} alerts at ${new Date(now).toISOString()}`, "", ...lines.map((l) => `- ${l}`)].join("\n");
  return { subject, text, notices: batch };
}

export function renderDigest(label: string, firingNow: Tracked[], last24h: Notice[], now: number): Message {
  const fired = last24h.filter((n) => n.kind === "firing").length;
  const resolved = last24h.filter((n) => n.kind === "resolved").length;
  const subject = `[${label}] daily digest: ${firingNow.length ? `${firingNow.length} firing` : "all clear"}`;
  const lines = [
    `${label} daily digest, ${new Date(now).toISOString()}`,
    "",
    firingNow.length ? "Firing now:" : "Nothing firing.",
    ...firingNow.map((t) => `- [${t.severity}] ${t.rule}: ${t.summary} (since ${new Date(t.firedAt ?? t.since).toISOString()})`),
    "",
    `Last 24 h: ${fired} alerts fired, ${resolved} resolved.`,
  ];
  return { subject, text: lines.join("\n"), notices: [] };
}

export type WebhookFormat = "slack" | "discord" | "telegram" | "json";

/** auto: by host (hooks.slack.com, discord.com/discordapp.com webhooks, api.telegram.org), else generic JSON. */
export function webhookFormat(url: string, configured: "auto" | WebhookFormat): WebhookFormat {
  if (configured !== "auto") return configured;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "json";
  }
  if (host === "hooks.slack.com") return "slack";
  if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) return "discord";
  if (host === "api.telegram.org") return "telegram";
  return "json";
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Request body per format (text limits: Discord 2000, Telegram 4096, Slack ~40k). */
export function webhookBody(fmt: WebhookFormat, m: Message, telegramChatId: string | null): Record<string, unknown> {
  const full = `${m.subject}\n\n${m.text}`;
  switch (fmt) {
    case "slack":
      return { text: clip(full, 39_000) };
    case "discord":
      return { content: clip(full, 2000), allowed_mentions: { parse: [] } };
    case "telegram":
      return { chat_id: telegramChatId, text: clip(full, 4000), disable_web_page_preview: true };
    case "json":
      // `text` (Slack-compatible receivers, Mattermost, Rocket.Chat) and `content` (Discord-compatible) both set
      return { subject: m.subject, text: clip(full, 39_000), content: clip(full, 2000), alerts: m.notices };
  }
}
