// VERIFY E1: TS mirror of AttestedOracle.reportDataOf / attestationDigest + the operator flow.
import { describe, expect, test } from "bun:test";
import { attestedOracleAbi } from "@bookrunner/shared/abi";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, decodeFunctionData, encodeAbiParameters, keccak256, toBytes } from "viem";
import {
  ATTESTATION_TYPEHASH,
  REPORT_DATA_TYPEHASH,
  attestationDigest,
  checkAttestation,
  platformTag,
  reportDataFor,
  timelockCalls,
} from "../src/attestation";
import { run } from "../src/cli/attest";
import { createApp } from "../src/http";
import { makeService } from "./fakes";

const ORACLE = "0x00000000000000000000000000000000000000AA" as Address;
const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const MEASUREMENT = keccak256(toBytes("bookrunner-oracle-enclave v1.0.0"));

const fakeQuote = (reportData: Hex): Hex => `0x0400${"ab".repeat(100)}${reportData.slice(2)}${"00".repeat(32)}${"cd".repeat(64)}` as Hex;

describe("attestation encoding (mirrors AttestedOracle)", () => {
  test("type hashes are byte-identical to the contract's", () => {
    // contracts/test/engine/AttestedOracleAttestation.t.sol pins the same strings
    expect(REPORT_DATA_TYPEHASH).toBe(keccak256(toBytes("BookrunnerOracleSigner(uint256 chainId,address oracle,address signer)")));
    expect(ATTESTATION_TYPEHASH).toBe(
      keccak256(toBytes("SignerAttestation(uint256 chainId,address oracle,address signer,bytes32 platform,bytes32 measurement,bytes32 quoteHash)")),
    );
  });

  test("reportData and digest = keccak256(abi.encode(...)), bound to chain + oracle + signer", () => {
    const rd = reportDataFor(4663, ORACLE, SIGNER);
    expect(rd).toBe(
      keccak256(
        encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }], [REPORT_DATA_TYPEHASH, 4663n, ORACLE, SIGNER]),
      ),
    );
    expect(reportDataFor(46630, ORACLE, SIGNER)).not.toBe(rd);
    const quoteHash = keccak256("0x01");
    const d = attestationDigest({ chainId: 4663, oracle: ORACLE, signer: SIGNER, platform: platformTag("INTEL_TDX"), measurement: MEASUREMENT, quoteHash });
    expect(d).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
          [ATTESTATION_TYPEHASH, 4663n, ORACLE, SIGNER, platformTag("INTEL_TDX"), MEASUREMENT, quoteHash],
        ),
      ),
    );
    expect(platformTag("INTEL_TDX")).toBe("0x494e54454c5f5444580000000000000000000000000000000000000000000000");
  });
});

describe("operator flow", () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    platform: "INTEL_TDX",
    measurement: MEASUREMENT,
    quote: fakeQuote(reportDataFor(4663, ORACLE, SIGNER)),
    signer: SIGNER,
    chainId: 4663,
    oracle: ORACLE,
    ...over,
  });

  test("checkAttestation: binding checks + what the timelock records", () => {
    const ok = checkAttestation(doc(), { chainId: 4663, oracle: ORACLE, signer: SIGNER });
    expect(ok.problems).toEqual([]);
    expect(ok.quoteHash).toBe(keccak256(doc().quote as Hex));
    const unbound = checkAttestation(doc({ quote: fakeQuote(reportDataFor(4663, ORACLE, ORACLE)) }), { chainId: 4663, oracle: ORACLE, signer: SIGNER });
    expect(unbound.problems.join()).toContain("not bound to this signer key");
    const wrong = checkAttestation(doc({ chainId: 46630 }), { chainId: 4663, oracle: ORACLE, signer: SIGNER });
    expect(wrong.problems.join()).toContain("chainId 46630 != 4663");
  });

  test("timelock calldata decodes to setMeasurement + setAttestedSigner", () => {
    const c = checkAttestation(doc(), { chainId: 4663, oracle: ORACLE, signer: SIGNER });
    const [allow, reg] = timelockCalls(ORACLE, SIGNER, c);
    expect(decodeFunctionData({ abi: attestedOracleAbi, data: allow!.data })).toMatchObject({ functionName: "setMeasurement", args: [MEASUREMENT, true] });
    expect(decodeFunctionData({ abi: attestedOracleAbi, data: reg!.data })).toMatchObject({
      functionName: "setAttestedSigner",
      args: [SIGNER, platformTag("INTEL_TDX"), MEASUREMENT, c.quoteHash],
    });
  });

  test("CLI: report-data and register (exit 1 on a binding problem)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bkrn-attest-"));
    const file = join(dir, "attestation.json");
    writeFileSync(file, JSON.stringify(doc()));
    expect(run(["report-data", "--chain", "4663", "--oracle", ORACLE, "--signer", SIGNER]).out.reportData).toBe(reportDataFor(4663, ORACLE, SIGNER));
    const r = run(["register", "--chain", "4663", "--oracle", ORACLE, "--doc", file]);
    expect(r.code).toBe(0);
    expect(r.out.attestationDigest).toBe(checkAttestation(doc(), { chainId: 4663, oracle: ORACLE, signer: SIGNER }).digest);
    writeFileSync(file, JSON.stringify(doc({ quote: "0x00" })));
    expect(run(["register", "--chain", "4663", "--oracle", ORACLE, "--doc", file]).code).toBe(1);
    expect(() => run(["nope", "--chain", "1", "--oracle", ORACLE])).toThrow("usage");
  });

  test("GET /attestation serves the document, its digest and the expected reportData", async () => {
    const { svc, signerAccount } = makeService({ sources: [] });
    await svc.setDeployment({ chainId: 4663, oracle: ORACLE, chain: null });
    const d = doc({ signer: signerAccount.address, quote: fakeQuote(reportDataFor(4663, ORACLE, signerAccount.address)) });
    const body = (await (await createApp(svc, d as never).request("/attestation")).json()) as Record<string, unknown> & { attestation: Record<string, unknown> };
    expect(body.reportData).toBe(reportDataFor(4663, ORACLE, signerAccount.address));
    expect(body.attestation).toMatchObject({ type: "INTEL_TDX", measurement: MEASUREMENT, problems: [] });
    expect(body.attestation.digest).toBe(checkAttestation(d as never, { chainId: 4663, oracle: ORACLE, signer: signerAccount.address }).digest);
  });
});
