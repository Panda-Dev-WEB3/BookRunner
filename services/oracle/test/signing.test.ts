import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type PriceUpdate, devAccount, priceId, priceTypedData, roleAccount } from "@bookrunner/shared";
import { concat, encodeAbiParameters, hashTypedData, keccak256, recoverTypedDataAddress, stringToHex } from "viem";
import { toPriceWad } from "../src/domain/price";
import { sourcesHash } from "../src/domain/sources-hash";
import { accountSigner, priceDigest, recoverPriceSigner } from "../src/signing";
import { ORACLE_ADDR } from "./fakes";

const update: PriceUpdate = {
  underlying: priceId("NVDA"),
  priceWad: toPriceWad(190.12345678),
  publishedAt: 1_790_000_000n,
  held: false,
  sourceCount: 3,
  sourcesHash: sourcesHash([{ name: "synthetic-a", price: 190.1, ts: 1 }]),
};

describe("EIP-712 price signatures", () => {
  test("recovers to the oracleSigner role account", async () => {
    const acct = roleAccount("oracleSigner", { CHAIN_ID: "31337" });
    expect(acct.address).toBe(devAccount("oracleSigner").address);
    const signer = accountSigner(acct);
    const sig = await signer.sign(31337, ORACLE_ADDR, update);
    expect(await recoverTypedDataAddress({ ...priceTypedData(31337, ORACLE_ADDR, update), signature: sig })).toBe(acct.address);
    expect(await recoverPriceSigner(31337, ORACLE_ADDR, update, sig)).toBe(acct.address);
  });

  test("domain separation: other chain / contract / field values do not recover to the signer", async () => {
    const acct = devAccount("oracleSigner");
    const sig = await accountSigner(acct).sign(31337, ORACLE_ADDR, update);
    expect(await recoverPriceSigner(4663, ORACLE_ADDR, update, sig)).not.toBe(acct.address);
    expect(await recoverPriceSigner(31337, "0x00000000000000000000000000000000000000bb", update, sig)).not.toBe(acct.address);
    expect(await recoverPriceSigner(31337, ORACLE_ADDR, { ...update, held: true }, sig)).not.toBe(acct.address);
    expect(await recoverPriceSigner(31337, ORACLE_ADDR, { ...update, priceWad: update.priceWad + 1n }, sig)).not.toBe(acct.address);
  });

  test("digest equals the Solidity encoding with the frozen PRICE_TYPEHASH (IAttestedOracle.sol)", () => {
    const sol = readFileSync(resolve(import.meta.dir, "../../../contracts/src/interfaces/IAttestedOracle.sol"), "utf8");
    const typeString = /PRICE_TYPEHASH = keccak256\("([^"]+)"\)/.exec(sol)?.[1];
    expect(typeString).toBe("Price(bytes32 underlying,uint256 priceWad,uint64 publishedAt,bool held,uint32 sourceCount,bytes32 sourcesHash)");
    const typehash = keccak256(stringToHex(typeString!));
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "bool" }, { type: "uint32" }, { type: "bytes32" }],
        [typehash, update.underlying, update.priceWad, update.publishedAt, update.held, update.sourceCount, update.sourcesHash],
      ),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(stringToHex("Bookrunner AttestedOracle")),
          keccak256(stringToHex("1")),
          31337n,
          ORACLE_ADDR,
        ],
      ),
    );
    const digest = keccak256(concat(["0x1901", domainSeparator, structHash]));
    expect(priceDigest(31337, ORACLE_ADDR, update)).toBe(digest);
    expect(hashTypedData(priceTypedData(31337, ORACLE_ADDR, update))).toBe(digest);
  });

  test("priceWad is exact for 8-decimal prices", () => {
    expect(toPriceWad(190)).toBe(190n * 10n ** 18n);
    expect(toPriceWad(190.12345678)).toBe(190_123_456_780_000_000_000n);
    expect(toPriceWad(0.1 + 0.2)).toBe(300_000_000_000_000_000n);
  });
});
