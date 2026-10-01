// CID computation: CIDv1, raw codec (0x55), sha2-256 (0x12, 32 bytes), base32 multibase "b".
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type Hex, bytesToHex } from "viem";
import { canonicalBytes, cidFromDigest, cidOfBytes, cidOfJson, digestFromCid } from "../src/domain/cid";

/** Independent reference: RFC 4648 base32 lowercase, no padding, multibase prefix "b". */
function referenceCid(bytes: Uint8Array): { cid: string; digest: Hex } {
  const digest = createHash("sha256").update(bytes).digest();
  const cidBytes = new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of cidBytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return { cid: `b${out}`, digest: bytesToHex(digest) };
}

describe("verdict CID", () => {
  test("known vector: empty block", async () => {
    const r = await cidOfBytes(new Uint8Array());
    expect(r.cid).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    expect(r.digest).toBe("0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("known vector: 'hello world'", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const r = await cidOfBytes(bytes);
    expect(r.digest).toBe("0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    expect(r).toEqual(referenceCid(bytes));
    expect(r.cid).toBe("bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e");
  });

  test("matches the independent reference for arbitrary JSON", async () => {
    const verdict = { charterId: 3, models: [{ model: "m", vote: "approve" }], summary: "ok", createdAt: "2026-10-02T00:00:00.000Z" };
    const r = await cidOfJson(verdict);
    expect({ cid: r.cid, digest: r.digest }).toEqual(referenceCid(canonicalBytes(verdict)));
  });

  test("canonical JSON: key order does not change the CID", async () => {
    const a = await cidOfJson({ b: 1, a: { y: [1, 2], x: "s" } });
    const b = await cidOfJson({ a: { x: "s", y: [1, 2] }, b: 1 });
    expect(a.cid).toBe(b.cid);
  });

  test("digest <-> CID round trip (on-chain bytes32 recovers the full CID)", async () => {
    const r = await cidOfJson({ hello: "jury" });
    expect(cidFromDigest(r.digest)).toBe(r.cid);
    expect(digestFromCid(r.cid)).toBe(r.digest);
  });

  test("rejects non raw/sha2-256 CIDs", () => {
    // CIDv0 (dag-pb) — QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG is the empty unixfs dir
    expect(() => digestFromCid("QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn")).toThrow();
    expect(() => digestFromCid("not-a-cid")).toThrow();
  });
});
