// Pluggable role signers (signer.ts) and the mainnet key policy (devkeys.ts / childenv.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { type Hex, bytesToHex, hexToBytes, parseGwei, recoverMessageAddress, recoverTypedDataAddress } from "viem";
import { english, generateMnemonic, privateKeyToAccount, sign } from "viem/accounts";
import { childEnv } from "../src/childenv";
import { assertDistinctRoleKeys, assertNoMnemonicOnMainnet, roleAccount } from "../src/devkeys";
import {
  KMS_ENV_FOR_ROLE,
  type KmsClientLike,
  SERVICE_ROLES,
  accountFromDigestSigner,
  addressFromSpki,
  clearRoleSignerCache,
  kmsDigestSigner,
  localDigestSigner,
  parseDerSignature,
  roleSigner,
  roleSignerSource,
} from "../src/signer";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const PK2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** DER SPKI of a secp256k1 key (what KMS GetPublicKey returns for ECC_SECG_P256K1). */
function spkiOf(pk: Hex, oid = "2b8104000a"): Uint8Array {
  const point = privateKeyToAccount(pk).publicKey.slice(2); // 04 || X || Y
  return hexToBytes(`0x3056301006072a8648ce3d0201060${oid === "2b8104000a" ? "5" : "8"}${oid}034200${point}`);
}

function derInt(v: bigint): string {
  let h = v.toString(16);
  if (h.length % 2) h = `0${h}`;
  if (Number.parseInt(h.slice(0, 2), 16) >= 0x80) h = `00${h}`;
  return `02${(h.length / 2).toString(16).padStart(2, "0")}${h}`;
}

/** A KMS stand-in backed by a local key; `highS` returns the (valid) high-s twin of every signature. */
function fakeKms(pk: Hex, opts: { highS?: boolean; oid?: string } = {}): KmsClientLike & { calls: number } {
  const kms = {
    calls: 0,
    async getPublicKey() {
      return spkiOf(pk, opts.oid);
    },
    async signDigest(_keyId: string, digest: Uint8Array) {
      kms.calls++;
      const s = await sign({ hash: bytesToHex(digest), privateKey: pk });
      let sv = BigInt(s.s);
      if (opts.highS) sv = N - sv;
      const body = derInt(BigInt(s.r)) + derInt(sv);
      return hexToBytes(`0x30${(body.length / 2).toString(16).padStart(2, "0")}${body}`);
    },
  };
  return kms;
}

const typedData = {
  domain: { name: "Bookrunner MarkRegistry", version: "1", chainId: 4663, verifyingContract: "0x0000000000000000000000000000000000001234" },
  types: { Mark: [{ name: "bookId", type: "uint256" }, { name: "navUsd", type: "uint256" }] },
  primaryType: "Mark",
  message: { bookId: 1n, navUsd: 1_000_000n },
} as const;

const tx1559 = {
  chainId: 4663,
  type: "eip1559",
  nonce: 7,
  to: "0x0000000000000000000000000000000000001234",
  value: 1n,
  gas: 21_000n,
  maxFeePerGas: parseGwei("0.1"),
  maxPriorityFeePerGas: 0n,
} as const;

afterEach(() => clearRoleSignerCache());

describe("accountFromDigestSigner (viem custom account)", () => {
  const local = privateKeyToAccount(PK);
  const custom = accountFromDigestSigner(localDigestSigner(PK, local.address));

  test("is a drop-in for privateKeyToAccount: identical message / typed-data / tx signatures", async () => {
    expect(custom.address).toBe(local.address);
    expect(custom.source).toBe("custom");
    expect(await custom.signMessage({ message: "hello" })).toBe(await local.signMessage({ message: "hello" }));
    expect(await custom.signTypedData(typedData)).toBe(await local.signTypedData(typedData));
    expect(await custom.signTransaction(tx1559)).toBe(await local.signTransaction(tx1559));
    const legacy = { chainId: 4663, type: "legacy", nonce: 1, to: tx1559.to, value: 0n, gas: 21_000n, gasPrice: parseGwei("0.1") } as const;
    expect(await custom.signTransaction(legacy)).toBe(await local.signTransaction(legacy));
  });
});

describe("KMS signer (DER / SPKI handling, no AWS)", () => {
  const local = privateKeyToAccount(PK);

  test("address from the SPKI; secp256k1 only", () => {
    expect(addressFromSpki(spkiOf(PK))).toBe(local.address);
    expect(() => addressFromSpki(spkiOf(PK, "2a8648ce3d030107"))).toThrow(/secp256k1/); // P-256 OID
  });

  test("DER parse normalises high s (EIP-2)", () => {
    const low = parseDerSignature(hexToBytes(`0x3006${derInt(5n)}${derInt(7n)}`));
    expect(low).toEqual({ r: 5n, s: 7n });
    const high = parseDerSignature(hexToBytes(`0x3026${derInt(5n)}${derInt(N - 7n)}`));
    expect(high.s).toBe(7n);
    expect(() => parseDerSignature(hexToBytes("0x31"))).toThrow();
  });

  for (const highS of [false, true]) {
    test(`signatures recover to the KMS key and match the local key (KMS high-s: ${highS})`, async () => {
      const acct = accountFromDigestSigner(await kmsDigestSigner("alias/bkrn-mark", fakeKms(PK, { highS })));
      expect(acct.address).toBe(local.address);
      const msgSig = await acct.signMessage({ message: "mark" });
      expect(await recoverMessageAddress({ message: "mark", signature: msgSig })).toBe(local.address);
      const tdSig = await acct.signTypedData(typedData);
      expect(await recoverTypedDataAddress({ ...typedData, signature: tdSig })).toBe(local.address);
      // RFC 6979 + low-s: byte-identical to the local key's transaction
      expect(await acct.signTransaction(tx1559)).toBe(await local.signTransaction(tx1559));
    });
  }

  test("a KMS key returning someone else's signatures is refused", async () => {
    const lying = fakeKms(PK2);
    lying.getPublicKey = async () => spkiOf(PK);
    const acct = accountFromDigestSigner(await kmsDigestSigner("k", lying));
    await expect(acct.signMessage({ message: "x" })).rejects.toThrow(/does not recover/);
  });
});

describe("roleSigner (KMS when <ROLE>_KMS_KEY_ID is set, else roleAccount)", () => {
  test("KMS id wins, one GetPublicKey per process (cached)", async () => {
    const kms = fakeKms(PK);
    let created = 0;
    const factory = async () => {
      created++;
      return kms;
    };
    const env = { CHAIN_ID: "4663", MARK_SIGNER_KMS_KEY_ID: "alias/bkrn-mark" };
    const a = await roleSigner("markSigner", env, { kms: factory });
    const b = await roleSigner("markSigner", env, { kms: factory });
    expect(a.address).toBe(privateKeyToAccount(PK).address);
    expect(b).toBe(a);
    expect(created).toBe(1);
    expect(roleSignerSource("markSigner", env)).toBe("kms");
  });

  test("falls back to the explicit private key / devnet derivation", async () => {
    expect((await roleSigner("risk", { CHAIN_ID: "4663", RISK_PRIVATE_KEY: PK })).address).toBe(privateKeyToAccount(PK).address);
    expect((await roleSigner("risk", { CHAIN_ID: "31337" })).address).toBe(roleAccount("risk", { CHAIN_ID: "31337" }).address);
  });

  test("a role with both a private key and a KMS id is ambiguous", async () => {
    expect(() => roleSignerSource("keeper", { CHAIN_ID: "4663", KEEPER_PRIVATE_KEY: PK, KEEPER_KMS_KEY_ID: "k" })).toThrow(/pick one/);
  });

  test("every service role has a KMS env name; the deployer never does", () => {
    for (const r of SERVICE_ROLES) expect(KMS_ENV_FOR_ROLE[r]).toMatch(/_KMS_KEY_ID$/);
    expect(KMS_ENV_FOR_ROLE.deployer).toBeUndefined();
  });

  test("mainnet without a key for the role is 'missing', never derived", () => {
    expect(roleSignerSource("oracleSigner", { CHAIN_ID: "4663" })).toBe("missing");
    expect(roleSignerSource("oracleSigner", { CHAIN_ID: "31337" })).toBe("derived");
  });
});

describe("mainnet key policy (4663)", () => {
  const mnemonic = generateMnemonic(english);

  test("roleAccount refuses any mnemonic on mainnet, even with an explicit key", () => {
    expect(() => roleAccount("markSigner", { CHAIN_ID: "4663", BKRN_TESTNET_MNEMONIC: mnemonic })).toThrow(/mnemonic/);
    expect(() => roleAccount("markSigner", { CHAIN_ID: "4663", DEV_MNEMONIC: mnemonic, MARK_SIGNER_PRIVATE_KEY: PK })).toThrow(/mnemonic/);
    expect(() => roleAccount("markSigner", { CHAIN_ID: "4663", SOME_OTHER_MNEMONIC: mnemonic })).toThrow(/mnemonic/);
    expect(roleAccount("markSigner", { CHAIN_ID: "4663", MARK_SIGNER_PRIVATE_KEY: PK }).address).toBe(privateKeyToAccount(PK).address);
  });

  test("roleAccount without an explicit key throws on mainnet", () => {
    expect(() => roleAccount("keeper", { CHAIN_ID: "4663" })).toThrow(/KEEPER_PRIVATE_KEY/);
  });

  test("the deployer and the gas funder are never loaded on mainnet, even with a key", () => {
    expect(() => roleAccount("deployer", { CHAIN_ID: "4663", DEPLOYER_PRIVATE_KEY: PK })).toThrow(/never loaded/);
    expect(() => roleAccount("funder", { CHAIN_ID: "4663", BKRN_TESTNET_FUNDER_PK: PK })).toThrow(/never loaded/);
  });

  test("empty mnemonic vars are tolerated; testnet is unaffected", () => {
    expect(() => assertNoMnemonicOnMainnet({ CHAIN_ID: "4663", DEV_MNEMONIC: "" })).not.toThrow();
    expect(() => assertNoMnemonicOnMainnet({ CHAIN_ID: "46630", BKRN_TESTNET_MNEMONIC: mnemonic })).not.toThrow();
  });

  test("childEnv refuses to build any child env on mainnet while a mnemonic is present", () => {
    expect(() => childEnv("api", { CHAIN_ID: "4663", DEV_MNEMONIC: mnemonic })).toThrow(/mnemonic/);
    expect(() => childEnv("api", { CHAIN_ID: "4663" }, { BKRN_TESTNET_MNEMONIC: mnemonic })).toThrow(/mnemonic/);
    expect(() => childEnv("api", { CHAIN_ID: "4663" })).not.toThrow();
  });

  test("each KMS key id reaches only the process signing for that role", () => {
    const base: Record<string, string> = { CHAIN_ID: "4663", AWS_REGION: "eu-central-1", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "t" };
    for (const r of SERVICE_ROLES) base[KMS_ENV_FOR_ROLE[r]!] = `alias/${r}`;
    const kmsOf = (p: string) => Object.keys(childEnv(p, base)).filter((k) => k.endsWith("_KMS_KEY_ID")).sort();
    expect(kmsOf("mark")).toEqual(["MARK_SIGNER_KMS_KEY_ID"]);
    expect(kmsOf("oracle")).toEqual(["ORACLE_SIGNER_KMS_KEY_ID"]);
    expect(kmsOf("charter")).toEqual(["JURY_KMS_KEY_ID"]);
    expect(kmsOf("ops-venue")).toEqual(["OPS_VENUE_KMS_KEY_ID"]);
    expect(kmsOf("risk")).toEqual(["RISK_KMS_KEY_ID"]);
    expect(kmsOf("waterfall")).toEqual(["KEEPER_KMS_KEY_ID"]);
    for (const p of ["api", "indexer", "receipts", "web", "agent:NVDA"]) {
      expect(kmsOf(p)).toEqual([]);
      expect(childEnv(p, base).AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(childEnv(p, base).AWS_SESSION_TOKEN).toBeUndefined();
    }
    expect(childEnv("mark", base).AWS_SECRET_ACCESS_KEY).toBe("s");
    expect(childEnv("api", base).AWS_REGION).toBe("eu-central-1"); // not a secret
  });

  test("two roles sharing one key are refused", () => {
    const roles = ["markSigner", "keeper"] as const;
    expect(() => assertDistinctRoleKeys(roles, { MARK_SIGNER_PRIVATE_KEY: PK, KEEPER_PRIVATE_KEY: PK.toUpperCase().replace("0X", "0x") })).toThrow(/share one key/);
    expect(() => assertDistinctRoleKeys(roles, { MARK_SIGNER_KMS_KEY_ID: "k1", KEEPER_KMS_KEY_ID: "k1" }, KMS_ENV_FOR_ROLE)).toThrow(/share one key/);
    expect(() => assertDistinctRoleKeys(roles, { MARK_SIGNER_PRIVATE_KEY: PK, KEEPER_PRIVATE_KEY: PK2 })).not.toThrow();
  });
});
