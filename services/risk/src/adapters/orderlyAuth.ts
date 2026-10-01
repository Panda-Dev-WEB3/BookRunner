// Orderly REST request signing (VERIFY against https://orderly.network/docs before mainnet):
//   orderly-key        "ed25519:<base58 public key>"
//   orderly-timestamp  unix ms
//   orderly-signature  base64url(ed25519(`${timestamp}${METHOD}${pathWithQuery}${body}`))
import * as ed from "@noble/ed25519";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 character: ${ch}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** "ed25519:<base58>" | "<base58>" | "0x<hex>" -> 32-byte secret seed. */
export function parseOrderlySecret(secret: string): Uint8Array {
  const s = secret.trim().replace(/^ed25519:/, "");
  const bytes = /^0x[0-9a-fA-F]+$/.test(s) ? Uint8Array.from(Buffer.from(s.slice(2), "hex")) : base58Decode(s);
  // some exports carry seed||pubkey (64 bytes); the seed is the first half
  const seed = bytes.length === 64 ? bytes.slice(0, 32) : bytes;
  if (seed.length !== 32) throw new Error(`orderly secret must be 32 bytes, got ${seed.length}`);
  return seed;
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface OrderlySigner {
  readonly orderlyKey: string;
  sign(message: string): Promise<string>;
}

export async function createOrderlySigner(secret: string, publicKey?: string): Promise<OrderlySigner> {
  const seed = parseOrderlySecret(secret);
  const orderlyKey = publicKey?.trim() || `ed25519:${base58Encode(await ed.getPublicKeyAsync(seed))}`;
  return {
    orderlyKey,
    sign: async (message: string) => base64Url(await ed.signAsync(new TextEncoder().encode(message), seed)),
  };
}

export async function orderlyAuthHeaders(
  signer: OrderlySigner | null,
  accountId: string,
  method: string,
  pathWithQuery: string,
  body: string,
  nowMs: number,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "orderly-account-id": accountId };
  if (!signer) return headers; // mock-orderly is permissive in dev
  const ts = String(nowMs);
  headers["orderly-key"] = signer.orderlyKey;
  headers["orderly-timestamp"] = ts;
  headers["orderly-signature"] = await signer.sign(`${ts}${method.toUpperCase()}${pathWithQuery}${body}`);
  return headers;
}
