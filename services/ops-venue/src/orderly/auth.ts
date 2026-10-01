// Orderly REST request signing (ed25519) — confirmed against
// https://orderly.network/docs/build-on-omnichain/api-authentication (2026-10):
//   orderly-key       "ed25519:" + base58(publicKey32)
//   orderly-timestamp unix ms
//   orderly-signature base64url(ed25519_sign(`${timestamp}${METHOD}${pathname}${search}${body}`, secretKey))
// Secret keys are 32-byte ed25519 seeds, stored base58-encoded (Orderly's ORDERLY_SECRET convention).
// The verification side is services/mock-orderly/src/auth.ts (cross-checked in test/auth.test.ts).
import * as ed from "@noble/ed25519";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_IDX: Record<string, number> = Object.fromEntries([...B58].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of s) {
    const v = B58_IDX[c];
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

export interface Ed25519Key {
  secretKey: Uint8Array; // 32-byte seed
  publicKey: Uint8Array; // 32 bytes
  orderlyKey: string; // "ed25519:<base58 pub>"
}

export const formatOrderlyKey = (pub: Uint8Array): string => `ed25519:${base58Encode(pub)}`;

/** Never log or persist more than this of a key outside the key store. */
export const keyPrefix = (orderlyKey: string, n = 16): string => orderlyKey.slice(0, n);

export async function generateKey(): Promise<Ed25519Key> {
  const { secretKey, publicKey } = await ed.keygenAsync();
  return { secretKey, publicKey, orderlyKey: formatOrderlyKey(publicKey) };
}

/** Accepts a 32-byte seed as Uint8Array, base58 string (optionally "ed25519:"-prefixed) or 0x-hex. */
export async function keyFromSecret(secret: Uint8Array | string): Promise<Ed25519Key> {
  let sk: Uint8Array;
  if (typeof secret === "string") {
    const s = secret.startsWith("ed25519:") ? secret.slice(8) : secret;
    sk = /^0x[0-9a-fA-F]{64}$/.test(s) ? Uint8Array.from(Buffer.from(s.slice(2), "hex")) : base58Decode(s);
  } else sk = secret;
  if (sk.length === 64) sk = sk.slice(0, 32); // seed||pub layout
  if (sk.length !== 32) throw new Error(`ed25519 secret must be 32 bytes, got ${sk.length}`);
  const publicKey = await ed.getPublicKeyAsync(sk);
  return { secretKey: sk, publicKey, orderlyKey: formatOrderlyKey(publicKey) };
}

export const secretToString = (k: Ed25519Key): string => base58Encode(k.secretKey);

export function signatureMessage(timestamp: string | number, method: string, pathWithQuery: string, body: string): string {
  return `${timestamp}${method.toUpperCase()}${pathWithQuery}${body}`;
}

export async function signMessage(key: Ed25519Key, message: string): Promise<string> {
  const sig = await ed.signAsync(new TextEncoder().encode(message), key.secretKey);
  return Buffer.from(sig).toString("base64url");
}

export interface SignedHeaders {
  "orderly-account-id": string;
  "orderly-key": string;
  "orderly-timestamp": string;
  "orderly-signature": string;
}

export async function signRequest(
  key: Ed25519Key,
  accountId: string,
  p: { method: string; pathWithQuery: string; body: string; timestamp?: number },
): Promise<SignedHeaders> {
  const ts = String(p.timestamp ?? Date.now());
  return {
    "orderly-account-id": accountId,
    "orderly-key": key.orderlyKey,
    "orderly-timestamp": ts,
    "orderly-signature": await signMessage(key, signatureMessage(ts, p.method, p.pathWithQuery, p.body)),
  };
}
