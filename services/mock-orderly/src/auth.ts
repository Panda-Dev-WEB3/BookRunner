// Orderly REST request authentication (ed25519), verification side.
//
// Confirmed against https://orderly.network/docs/build-on-omnichain/api-authentication (2026-10):
//   headers   orderly-account-id, orderly-key ("ed25519:" + base58(pubkey32)), orderly-timestamp (ms),
//             orderly-signature = base64url(ed25519_sign(`${timestamp}${METHOD}${pathname}${search}${body}`))
//   body      JSON string exactly as sent (empty for GET/DELETE)
//   content-type: application/json for POST/PUT, application/x-www-form-urlencoded for GET/DELETE
// VERIFY: the accepted timestamp skew window (we use 300 s) and whether padded base64url is accepted.
//
// The signing side lives in services/ops-venue/src/orderly/auth.ts; the cross-check test in
// services/ops-venue/test/auth.test.ts proves both agree.
import * as ed from "@noble/ed25519";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = Object.fromEntries([...B58_ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP[c];
    if (v === undefined) throw new Error(`invalid base58 character '${c}'`);
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

/** Lenient base64url decoder (accepts standard base64 and padding). */
export function base64urlDecode(s: string): Uint8Array {
  const norm = s.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return new Uint8Array(Buffer.from(norm, "base64url"));
}

export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The exact message Orderly signs. `pathWithQuery` = url.pathname + url.search. */
export function signatureMessage(timestamp: string | number, method: string, pathWithQuery: string, body: string): string {
  return `${timestamp}${method.toUpperCase()}${pathWithQuery}${body}`;
}

/** "ed25519:<base58>" (or bare base58) -> 32-byte public key. */
export function parseOrderlyKey(key: string): Uint8Array {
  const raw = key.startsWith("ed25519:") ? key.slice("ed25519:".length) : key;
  const bytes = base58Decode(raw);
  if (bytes.length !== 32) throw new Error(`orderly key must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

export function formatOrderlyKey(publicKey: Uint8Array): string {
  return `ed25519:${base58Encode(publicKey)}`;
}

/** Canonical form used as the registry id ("ed25519:" prefix always present). */
export function normalizeOrderlyKey(key: string): string {
  return key.startsWith("ed25519:") ? key : `ed25519:${key}`;
}

export interface SignedRequestParts {
  orderlyKey: string;
  timestamp: string;
  method: string;
  pathWithQuery: string;
  body: string;
  signature: string;
}

export async function verifyOrderlySignature(p: SignedRequestParts): Promise<boolean> {
  try {
    const pub = parseOrderlyKey(p.orderlyKey);
    const sig = base64urlDecode(p.signature);
    if (sig.length !== 64) return false;
    const msg = new TextEncoder().encode(signatureMessage(p.timestamp, p.method, p.pathWithQuery, p.body));
    return await ed.verifyAsync(sig, msg, pub);
  } catch {
    return false;
  }
}

export interface AuthHeaders {
  accountId?: string;
  orderlyKey?: string;
  timestamp?: string;
  signature?: string;
}

export function readAuthHeaders(get: (name: string) => string | undefined): AuthHeaders {
  return {
    accountId: get("orderly-account-id") ?? undefined,
    orderlyKey: get("orderly-key") ?? undefined,
    timestamp: get("orderly-timestamp") ?? undefined,
    signature: get("orderly-signature") ?? undefined,
  };
}

/** |now - ts| within the window (ms). */
export function timestampFresh(ts: string | undefined, nowMs: number, windowMs = 300_000): boolean {
  if (!ts || !/^\d{10,16}$/.test(ts)) return false;
  return Math.abs(nowMs - Number(ts)) <= windowMs;
}
