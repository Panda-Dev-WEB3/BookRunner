// Content addressing for jury verdicts: canonicalJson -> UTF-8 bytes -> CIDv1 (raw codec, sha2-256).
// The on-chain `cid` (RiskCommittee.postJuryVerdict / MarketCharter juryCid) is the bare 32-byte
// sha2-256 digest; the full CID string is recoverable from it because codec + hash are fixed.
import { canonicalJson } from "@bookrunner/shared";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import * as Digest from "multiformats/hashes/digest";
import { sha256 } from "multiformats/hashes/sha2";
import { type Hex, bytesToHex, hexToBytes } from "viem";

export interface ContentId {
  cid: string; // base32 CIDv1, e.g. "bafkrei..."
  digest: Hex; // bytes32 sha2-256 digest posted on-chain
}

export async function cidOfBytes(bytes: Uint8Array): Promise<ContentId> {
  const mh = await sha256.digest(bytes);
  const cid = CID.create(1, raw.code, mh);
  return { cid: cid.toString(), digest: bytesToHex(mh.digest) };
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export async function cidOfJson(value: unknown): Promise<ContentId & { bytes: Uint8Array }> {
  const bytes = canonicalBytes(value);
  return { ...(await cidOfBytes(bytes)), bytes };
}

/** bytes32 digest (as stored on-chain) -> CIDv1 raw sha2-256 string. */
export function cidFromDigest(digest: Hex): string {
  const bytes = hexToBytes(digest);
  if (bytes.length !== 32) throw new Error(`digest must be 32 bytes: ${digest}`);
  return CID.create(1, raw.code, Digest.create(sha256.code, bytes)).toString();
}

/** CID string -> bytes32 digest; throws unless it is CIDv1 / raw / sha2-256. */
export function digestFromCid(cid: string): Hex {
  const parsed = CID.parse(cid);
  if (parsed.version !== 1 || parsed.code !== raw.code || parsed.multihash.code !== sha256.code) {
    throw new Error(`not a CIDv1 raw sha2-256: ${cid}`);
  }
  return bytesToHex(parsed.multihash.digest);
}
