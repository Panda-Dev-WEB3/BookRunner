// Webhook signing (packages/shared/src/events.ts):
//   x-bookrunner-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
// Receivers verify with `verifyWebhookSignature` (constant-time compare + timestamp tolerance).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-bookrunner-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function signatureHeader(secret: string, rawBody: string, timestamp: number): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

export function parseSignatureHeader(header: string | null | undefined): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const v = rest.join("=");
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: "malformed" | "stale" | "mismatch" };

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  opts: { nowSec?: number; toleranceSec?: number } = {},
): VerifyResult {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.t) > (opts.toleranceSec ?? DEFAULT_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };
  const expected = Buffer.from(computeSignature(secret, parsed.t, rawBody), "hex");
  const match = parsed.v1.some((sig) => {
    const got = Buffer.from(sig, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return match ? { ok: true, timestamp: parsed.t } : { ok: false, reason: "mismatch" };
}

/** New per-subscription secret ("whsec_" + 32 random bytes hex). Returned to the creator once. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}
