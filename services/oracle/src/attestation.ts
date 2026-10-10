// TEE signer attestation (VERIFY E1), platform-agnostic. Mirrors AttestedOracle exactly:
//   reportData = keccak256(abi.encode(REPORT_DATA_TYPEHASH, chainId, oracle, signer))
//     -> the enclave generates the signer key inside and puts these 32 bytes at the start of its quote's
//        report data (TDX / SEV-SNP REPORTDATA[0:32], Nitro attestation document user_data);
//   digest = keccak256(abi.encode(ATTESTATION_TYPEHASH, chainId, oracle, signer, platform, measurement,
//            keccak256(quote)))
//     -> recorded on-chain by the timelock's AttestedOracle.setAttestedSigner(signer, platform, measurement,
//        quoteHash), which only accepts an allow-listed measurement (setMeasurement).
// Off-chain (operator + anyone during the timelock delay): verify the quote's signature chain with the
// platform's own verifier (Intel DCAP QVL / AMD SEV-SNP VCEK chain / AWS Nitro root), compare the
// measurement with the reproducible build, and check that the quote carries reportData (checkAttestation).
import { attestedOracleAbi } from "@bookrunner/shared/abi";
import { strToBytes32 } from "@bookrunner/shared";
import { readFileSync } from "node:fs";
import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, toBytes } from "viem";
import { z } from "zod";

export const REPORT_DATA_TYPE = "BookrunnerOracleSigner(uint256 chainId,address oracle,address signer)";
export const ATTESTATION_TYPE =
  "SignerAttestation(uint256 chainId,address oracle,address signer,bytes32 platform,bytes32 measurement,bytes32 quoteHash)";
export const REPORT_DATA_TYPEHASH = keccak256(toBytes(REPORT_DATA_TYPE));
export const ATTESTATION_TYPEHASH = keccak256(toBytes(ATTESTATION_TYPE));

/** Platform tags (bytes32 right-padded ASCII); any non-empty tag is accepted on-chain. */
export const PLATFORMS = ["INTEL_TDX", "INTEL_SGX", "AMD_SEV_SNP", "AWS_NITRO"] as const;

export function platformTag(name: string): Hex {
  return strToBytes32(name);
}

export function reportDataFor(chainId: number, oracle: Address, signer: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }],
      [REPORT_DATA_TYPEHASH, BigInt(chainId), getAddress(oracle), getAddress(signer)],
    ),
  );
}

export interface AttestationFields {
  chainId: number;
  oracle: Address;
  signer: Address;
  platform: Hex;
  measurement: Hex;
  quoteHash: Hex;
}

export function attestationDigest(a: AttestationFields): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [ATTESTATION_TYPEHASH, BigInt(a.chainId), getAddress(a.oracle), getAddress(a.signer), a.platform, a.measurement, a.quoteHash],
    ),
  );
}

const hex = (len?: number) => z.string().regex(len ? new RegExp(`^0x[0-9a-fA-F]{${len}}$`) : /^0x([0-9a-fA-F]{2})+$/);

/**
 * The attestation document the enclave publishes (GET /attestation, ORACLE_ATTESTATION_FILE) and the
 * operator verifies before proposing the timelock call.
 */
export const attestationDocumentSchema = z.object({
  /** Platform name, e.g. INTEL_TDX | AMD_SEV_SNP | AWS_NITRO (bytes32 tag on-chain). */
  platform: z.string().min(1).max(31),
  /** Measurement digest (32 bytes) of the enclave build, as allow-listed on-chain. */
  measurement: hex(64),
  /** Raw quote / attestation document bytes. */
  quote: hex(),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.number().int().positive(),
  oracle: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** Free-form: build reference, verifier output, etc. */
  notes: z.string().optional(),
});
export type AttestationDocument = z.infer<typeof attestationDocumentSchema>;

export function loadAttestationDocument(path: string): AttestationDocument {
  const parsed = attestationDocumentSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`attestation document ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return parsed.data;
}

export interface AttestationCheck {
  platform: Hex;
  measurement: Hex;
  quoteHash: Hex;
  reportData: Hex;
  digest: Hex;
  /** Platform-agnostic checks only; the vendor signature chain is verified with the platform's tooling. */
  problems: string[];
}

/** What the contract will record, plus the binding checks any verifier can run without vendor tooling. */
export function checkAttestation(doc: AttestationDocument, expect: { chainId: number; oracle: Address; signer: Address }): AttestationCheck {
  const problems: string[] = [];
  if (doc.chainId !== expect.chainId) problems.push(`document chainId ${doc.chainId} != ${expect.chainId}`);
  if (getAddress(doc.oracle) !== getAddress(expect.oracle)) problems.push(`document oracle ${doc.oracle} != ${expect.oracle}`);
  if (getAddress(doc.signer) !== getAddress(expect.signer)) problems.push(`document signer ${doc.signer} != ${expect.signer}`);
  const reportData = reportDataFor(expect.chainId, expect.oracle, expect.signer);
  if (!doc.quote.toLowerCase().includes(reportData.slice(2).toLowerCase())) {
    problems.push("quote does not carry reportDataFor(chainId, oracle, signer): it is not bound to this signer key");
  }
  const platform = platformTag(doc.platform);
  const measurement = doc.measurement.toLowerCase() as Hex;
  const quoteHash = keccak256(doc.quote as Hex);
  const digest = attestationDigest({ chainId: expect.chainId, oracle: expect.oracle, signer: expect.signer, platform, measurement, quoteHash });
  return { platform, measurement, quoteHash, reportData, digest, problems };
}

/** Timelock calldata (AttestedOracle): allow the measurement, then register the attested signer. */
export function timelockCalls(oracle: Address, signer: Address, c: Pick<AttestationCheck, "platform" | "measurement" | "quoteHash">) {
  return [
    { to: getAddress(oracle), data: encodeFunctionData({ abi: attestedOracleAbi, functionName: "setMeasurement", args: [c.measurement, true] }), fn: "setMeasurement(measurement, true)" },
    {
      to: getAddress(oracle),
      data: encodeFunctionData({ abi: attestedOracleAbi, functionName: "setAttestedSigner", args: [getAddress(signer), c.platform, c.measurement, c.quoteHash] }),
      fn: "setAttestedSigner(signer, platform, measurement, quoteHash)",
    },
  ];
}
