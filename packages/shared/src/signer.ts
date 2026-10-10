// Pluggable signers for the services' role keys. A service never needs the key material itself: it needs a
// viem LocalAccount whose signMessage / signTypedData / signTransaction end in "sign this 32-byte digest".
// That one operation is the plug (DigestSigner):
//   - local: an in-process private key (devnet / testnet, or an explicit *_PRIVATE_KEY) — roleAccount();
//   - kms:   an AWS KMS asymmetric key (ECC_SECG_P256K1, SIGN_VERIFY): the private key never leaves the HSM.
// roleSigner(role) picks KMS when `<ROLE>_KMS_KEY_ID` is set, else falls back to roleAccount (devkeys.ts, which
// refuses every mnemonic on mainnet). @aws-sdk/client-kms is NOT a dependency of this repo: it is imported
// lazily, only when a KMS key id is configured (mainnet host: `bun add @aws-sdk/client-kms`, see
// deploy/server/MAINNET.md). Everything else here is plain viem, so it is tested without AWS.
import {
  type Address,
  type Hex,
  type LocalAccount,
  bytesToHex,
  getAddress,
  hashMessage,
  hashTypedData,
  hexToBigInt,
  hexToBytes,
  keccak256,
  numberToHex,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
} from "viem";
import { sign, toAccount } from "viem/accounts";
import { type DevRole, ENV_FOR_ROLE, MAINNET_CHAIN_ID, roleAccount } from "./devkeys";

/** secp256k1 signature of a digest, EIP-2 normalised (low s). */
export interface DigestSignature {
  r: Hex;
  s: Hex;
  yParity: 0 | 1;
}

/** The pluggable part: an address and "sign this 32-byte digest". */
export interface DigestSigner {
  readonly kind: string;
  readonly address: Address;
  signDigest(hash: Hex): Promise<DigestSignature>;
}

/** viem custom account (source "custom") over any DigestSigner: drop-in for privateKeyToAccount(). */
export function accountFromDigestSigner(signer: DigestSigner): LocalAccount {
  const sig = async (hash: Hex) => serializeSignature(await signer.signDigest(hash));
  return toAccount({
    address: signer.address,
    async sign({ hash }) {
      return sig(hash);
    },
    async signMessage({ message }) {
      return sig(hashMessage(message));
    },
    async signTypedData(typedData) {
      return sig(hashTypedData(typedData as Parameters<typeof hashTypedData>[0]));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      // EIP-4844: sign the payload body without the sidecars (as viem's own signTransaction does)
      const signable = transaction.type === "eip4844" ? { ...transaction, sidecars: false } : transaction;
      const { r, s, yParity } = await signer.signDigest(keccak256(await serializer(signable as typeof transaction)));
      // legacy serialisation reads v (27/28, EIP-155-adjusted by viem); typed transactions read yParity
      return (await serializer(transaction, { r, s, yParity, v: 27n + BigInt(yParity) })) as Hex;
    },
  }) as LocalAccount;
}

/** In-process private key as a DigestSigner (devnet / testnet / an explicit *_PRIVATE_KEY). */
export function localDigestSigner(privateKey: Hex, address: Address): DigestSigner {
  return {
    kind: "local",
    address,
    async signDigest(hash) {
      const s = await sign({ hash, privateKey });
      return { r: s.r, s: s.s, yParity: (s.yParity ?? 0) as 0 | 1 };
    },
  };
}

// ------------------------------------------------------------------------------------------------- KMS

/** The two KMS calls a signer needs (DER in, DER out). `awsKmsClient` adapts @aws-sdk/client-kms; tests fake it. */
export interface KmsClientLike {
  /** DER SubjectPublicKeyInfo of the key. */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  /** DER ECDSA signature (SEQUENCE{INTEGER r, INTEGER s}) of a 32-byte digest (MessageType DIGEST). */
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;
/** DER OID 1.3.132.0.10 (secp256k1): KMS ECC_SECG_P256K1 keys only; a P-256 key is refused. */
const SECP256K1_OID = [0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a];

function includesSeq(hay: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Ethereum address of a DER SPKI secp256k1 public key (the trailing 65-byte uncompressed point). */
export function addressFromSpki(spki: Uint8Array): Address {
  if (!includesSeq(spki, SECP256K1_OID)) throw new Error("KMS key is not secp256k1 (key spec must be ECC_SECG_P256K1)");
  const point = spki.slice(spki.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error("KMS public key: expected an uncompressed secp256k1 point");
  return getAddress(`0x${keccak256(point.slice(1)).slice(-40)}`);
}

/** Parses a DER ECDSA signature into (r, s) and normalises s to the low half (EIP-2). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const byte = () => {
    const b = der[i++];
    if (b === undefined) throw new Error("DER signature truncated");
    return b;
  };
  const len = () => {
    const l = byte();
    if (l < 0x80) return l;
    let n = 0;
    for (let k = 0; k < (l & 0x7f); k++) n = (n << 8) | byte();
    return n;
  };
  const int = () => {
    if (byte() !== 0x02) throw new Error("DER signature: expected INTEGER");
    const l = len();
    const v = der.slice(i, i + l);
    if (v.length !== l) throw new Error("DER signature truncated");
    i += l;
    return v.length === 0 ? 0n : hexToBigInt(bytesToHex(v));
  };
  if (byte() !== 0x30) throw new Error("DER signature: expected SEQUENCE");
  len();
  const r = int();
  let s = int();
  if (r === 0n || s === 0n || r >= SECP256K1_N || s >= SECP256K1_N) throw new Error("DER signature out of range");
  if (s > SECP256K1_HALF_N) s = SECP256K1_N - s;
  return { r, s };
}

/** KMS-backed DigestSigner. Reads the public key once; recovers yParity locally (KMS returns only r, s). */
export async function kmsDigestSigner(keyId: string, client: KmsClientLike): Promise<DigestSigner> {
  const address = addressFromSpki(await client.getPublicKey(keyId));
  return {
    kind: "kms",
    address,
    async signDigest(hash) {
      const { r, s } = parseDerSignature(await client.signDigest(keyId, hexToBytes32(hash)));
      const rs = { r: numberToHex(r, { size: 32 }), s: numberToHex(s, { size: 32 }) };
      for (const yParity of [0, 1] as const) {
        if ((await recoverAddress({ hash, signature: { ...rs, yParity } })) === address) return { ...rs, yParity };
      }
      throw new Error(`KMS signature for ${keyId} does not recover to ${address}`);
    },
  };
}

function hexToBytes32(hash: Hex): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("digest must be 32 bytes");
  return hexToBytes(hash);
}

/** Module name in a variable: TypeScript and bundlers never try to resolve the optional dependency. */
const AWS_KMS_MODULE = "@aws-sdk/client-kms";

/** Lazy @aws-sdk/client-kms adapter (credentials: the default AWS chain — instance role on the host). */
export async function awsKmsClient(region?: string): Promise<KmsClientLike> {
  let mod: Record<string, new (...a: unknown[]) => unknown>;
  try {
    mod = (await import(AWS_KMS_MODULE)) as typeof mod;
  } catch {
    throw new Error(`${AWS_KMS_MODULE} is not installed: on the signing host run \`bun add ${AWS_KMS_MODULE}\` (optional dependency, deploy/server/MAINNET.md)`);
  }
  const KMSClient = mod.KMSClient!;
  const client = new KMSClient(region ? { region } : {}) as { send(cmd: unknown): Promise<Record<string, unknown>> };
  return {
    async getPublicKey(keyId) {
      const out = await client.send(new mod.GetPublicKeyCommand!({ KeyId: keyId }));
      if (!(out.PublicKey instanceof Uint8Array)) throw new Error(`KMS GetPublicKey(${keyId}) returned no key`);
      return out.PublicKey;
    },
    async signDigest(keyId, digest) {
      const out = await client.send(
        new mod.SignCommand!({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
      );
      if (!(out.Signature instanceof Uint8Array)) throw new Error(`KMS Sign(${keyId}) returned no signature`);
      return out.Signature;
    },
  };
}

// ------------------------------------------------------------------------------------------------- roles

/** `<ROLE>_KMS_KEY_ID`: the KMS key (id / ARN / alias) of a role. Only the service roles; never the deployer. */
export const KMS_ENV_FOR_ROLE: Partial<Record<DevRole, string>> = {
  markSigner: "MARK_SIGNER_KMS_KEY_ID",
  risk: "RISK_KMS_KEY_ID",
  opsVenue: "OPS_VENUE_KMS_KEY_ID",
  jury: "JURY_KMS_KEY_ID",
  keeper: "KEEPER_KMS_KEY_ID",
  oracleSigner: "ORACLE_SIGNER_KMS_KEY_ID",
};

/** The roles a mainnet service stack signs with (scripts/dev.ts --network mainnet requires each one). */
export const SERVICE_ROLES = ["markSigner", "risk", "opsVenue", "jury", "keeper", "oracleSigner"] as const satisfies readonly DevRole[];

export interface RoleSignerOptions {
  /** KMS client factory (default: lazy @aws-sdk/client-kms in AWS_REGION / SIGNER_KMS_REGION). */
  kms?: () => Promise<KmsClientLike>;
}

/** Where a role's key comes from, without loading anything (preflight checks). */
export function roleSignerSource(role: DevRole, env: Record<string, string | undefined> = process.env): "kms" | "private-key" | "derived" | "missing" {
  const kmsEnv = KMS_ENV_FOR_ROLE[role];
  const pkEnv = ENV_FOR_ROLE[role];
  const hasKms = !!(kmsEnv && env[kmsEnv]);
  const hasPk = !!(pkEnv && env[pkEnv]);
  if (hasKms && hasPk) throw new Error(`role ${role}: both ${kmsEnv} and ${pkEnv} are set — pick one signer`);
  if (hasKms) return "kms";
  if (hasPk) return "private-key";
  const chainId = Number(env.CHAIN_ID ?? 31337);
  if (chainId === MAINNET_CHAIN_ID) return "missing";
  try {
    roleAccount(role, env);
    return "derived";
  } catch {
    return "missing";
  }
}

const cache = new Map<string, Promise<LocalAccount>>();

/**
 * The account a service signs with for `role`: KMS when `<ROLE>_KMS_KEY_ID` is set, else roleAccount()
 * (explicit private key, or the devnet / testnet mnemonic; refused on mainnet). KMS accounts are cached per
 * key id (one GetPublicKey per process).
 */
export async function roleSigner(role: DevRole, env: Record<string, string | undefined> = process.env, opts: RoleSignerOptions = {}): Promise<LocalAccount> {
  const source = roleSignerSource(role, env);
  if (source !== "kms") return roleAccount(role, env);
  const keyId = env[KMS_ENV_FOR_ROLE[role]!]!;
  const region = env.SIGNER_KMS_REGION || env.AWS_REGION;
  const key = `${keyId}@${region ?? ""}@${opts.kms ? "custom" : "aws"}`;
  let account = cache.get(key);
  if (!account) {
    account = (async () => accountFromDigestSigner(await kmsDigestSigner(keyId, await (opts.kms ?? (() => awsKmsClient(region)))())))();
    cache.set(key, account);
    account.catch(() => cache.delete(key));
  }
  return account;
}

/** Test helper: forget cached KMS accounts. */
export function clearRoleSignerCache(): void {
  cache.clear();
}
