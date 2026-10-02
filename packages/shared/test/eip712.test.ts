// Pull-oracle priceData + signed venue report encodings (docs/LOW_GAS.md §1-§2).
import { describe, expect, test } from "bun:test";
import { type Hex, encodeAbiParameters, encodeFunctionData, hashStruct, keccak256, recoverTypedDataAddress, toHex } from "viem";
import { attestedOracleAbi } from "../src/abi";
import { priceId } from "../src/bytes32";
import { devAccount } from "../src/devkeys";
import {
  EMPTY_PRICE_DATA,
  type PriceUpdate,
  type VenueReport,
  decodePriceData,
  decodeVenueReport,
  encodePriceData,
  encodeVenueReport,
  priceTypedData,
  priceUpdateFromMsg,
  venueReportTypedData,
  venueReportTypes,
} from "../src/eip712";
import { KEYS, type OraclePriceMsg } from "../src/queues";

const ORACLE = "0x00000000000000000000000000000000000000aa" as const;
const ADAPTER = "0x00000000000000000000000000000000000000bb" as const;

const upd = (id: string, price: bigint, at: number, held = false): PriceUpdate => ({
  underlying: priceId(id),
  priceWad: price,
  publishedAt: BigInt(at),
  held,
  sourceCount: 3,
  sourcesHash: keccak256(toHex(id)),
});

async function signed(updates: PriceUpdate[]) {
  const signer = devAccount("oracleSigner");
  const sigs = await Promise.all(updates.map((u) => signer.signTypedData(priceTypedData(31337, ORACLE, u))));
  return { sigs, signer };
}

describe("encodePriceData / decodePriceData", () => {
  test("round-trips updates and signatures (order preserved, signatures still recover)", async () => {
    const updates = [upd("NVDA", 190_120000000000000000n, 1_790_000_000), upd("RHX5", 315n * 10n ** 18n, 1_790_000_001, true)];
    const { sigs, signer } = await signed(updates);
    const data = encodePriceData(updates, sigs);
    const back = decodePriceData(data);
    expect(back.updates).toEqual(updates);
    expect(back.sigs).toEqual(sigs);
    for (let i = 0; i < updates.length; i++) {
      expect(await recoverTypedDataAddress({ ...priceTypedData(31337, ORACLE, back.updates[i]!), signature: back.sigs[i]! })).toBe(signer.address);
    }
  });

  test("layout is abi.encode(IAttestedOracle.PriceUpdate[], bytes[]) — the pushMany argument tuple", async () => {
    const updates = [upd("NVDA", 190n * 10n ** 18n, 1_790_000_000), upd("TSLA", 440n * 10n ** 18n, 1_790_000_000)];
    const { sigs } = await signed(updates);
    const calldata = encodeFunctionData({ abi: attestedOracleAbi, functionName: "pushMany", args: [updates, sigs] });
    expect(`0x${calldata.slice(10)}`).toBe(encodePriceData(updates, sigs));
  });

  test("no updates encode to empty bytes and decode back to nothing", () => {
    expect(encodePriceData([], [])).toBe(EMPTY_PRICE_DATA);
    expect(decodePriceData("0x")).toEqual({ updates: [], sigs: [] });
  });

  test("rejects a signature count mismatch on both sides and malformed bytes", async () => {
    const updates = [upd("NVDA", 1n, 1)];
    const { sigs } = await signed(updates);
    expect(() => encodePriceData(updates, [])).toThrow(/1 updates but 0 signatures/);
    expect(() => encodePriceData([], sigs)).toThrow();
    const mismatched = encodeAbiParameters(
      [
        { type: "tuple[]", components: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "bool" }, { type: "uint32" }, { type: "bytes32" }] },
        { type: "bytes[]" },
      ],
      [[[updates[0]!.underlying, 1n, 1n, false, 3, updates[0]!.sourcesHash]], [sigs[0]!, sigs[0]!]],
    );
    expect(() => decodePriceData(mismatched)).toThrow(/1 updates but 2 signatures/);
    expect(() => decodePriceData("0x1234")).toThrow();
  });

  test("priceUpdateFromMsg rebuilds the signed struct from an OraclePriceMsg", async () => {
    const u = upd("NVDA", 190_5n * 10n ** 17n, 1_790_000_123, true);
    const { sigs, signer } = await signed([u]);
    const msg: OraclePriceMsg = {
      priceId: "NVDA",
      underlying: u.underlying,
      priceWad: u.priceWad.toString(),
      price: 190.5,
      publishedAt: Number(u.publishedAt),
      held: true,
      sourceCount: 3,
      sources: [],
      sourcesHash: u.sourcesHash,
      signature: sigs[0]!,
    };
    expect(priceUpdateFromMsg(msg)).toEqual(u);
    expect(await recoverTypedDataAddress({ ...priceTypedData(31337, ORACLE, priceUpdateFromMsg(msg)), signature: msg.signature })).toBe(signer.address);
  });
});

describe("signed venue reports", () => {
  const report: VenueReport = { insuranceUsd: 25_000_000_000n, marginUsd: -1_234_567n, netExposureUsd: -40_000_000_000n, asOf: 1_790_000_000n };

  test("typed data matches REPORT_TYPEHASH and the domain of LOW_GAS.md §2", () => {
    const typehash = keccak256(toHex("VenueReport(uint256 insuranceUsd,int256 marginUsd,int256 netExposureUsd,uint64 asOf)"));
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "int256" }, { type: "int256" }, { type: "uint64" }],
        [typehash, report.insuranceUsd, report.marginUsd, report.netExposureUsd, report.asOf],
      ),
    );
    expect(hashStruct({ data: report as unknown as Record<string, unknown>, primaryType: "VenueReport", types: venueReportTypes })).toBe(expected);
    expect(venueReportTypedData(46630, ADAPTER, report).domain).toEqual({ name: "Bookrunner OrderlyAdapter", version: "1", chainId: 46630, verifyingContract: ADAPTER });
  });

  test("encodeVenueReport round-trips and the signature recovers to the OPS_VENUE key", async () => {
    const ops = devAccount("opsVenue");
    const sig: Hex = await ops.signTypedData(venueReportTypedData(31337, ADAPTER, report));
    const data = encodeVenueReport(report, sig);
    const back = decodeVenueReport(data)!;
    expect(back.report).toEqual(report);
    expect(back.sig).toBe(sig);
    expect(await recoverTypedDataAddress({ ...venueReportTypedData(31337, ADAPTER, back.report), signature: back.sig })).toBe(ops.address);
    expect(decodeVenueReport("0x")).toBeNull();
  });

  test("redis keys", () => {
    expect(KEYS.oracleBundle).toBe("bkrn:oracle:bundle");
    expect(KEYS.venueReport(3)).toBe("bkrn:venue:report:3");
  });
});
