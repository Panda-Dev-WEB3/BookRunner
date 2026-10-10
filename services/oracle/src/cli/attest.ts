// Operator CLI for TEE signer registration (VERIFY E1; docs/RUNBOOK.md "Oracle signer attestation").
// Offline: no RPC, no key, no transaction.
//
//   1) report data the enclave must embed for its signer key:
//        bun run --cwd services/oracle attest report-data --chain 4663 --oracle 0x<AttestedOracle> --signer 0x<key>
//   2) after verifying the quote with the platform verifier, what the timelock must record:
//        bun run --cwd services/oracle attest register --chain 4663 --oracle 0x... --doc attestation.json
//      prints quoteHash, the on-chain digest, the platform-agnostic binding checks and the timelock
//      calldata (setMeasurement + setAttestedSigner). Exit 1 when a binding check fails.
import { type Address, getAddress } from "viem";
import { checkAttestation, loadAttestationDocument, reportDataFor, timelockCalls } from "../attestation";

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function need(argv: readonly string[], name: string): string {
  const v = flag(argv, name);
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

export function run(argv: readonly string[]): { out: Record<string, unknown>; code: number } {
  const cmd = argv[0];
  const chainId = Number(need(argv, "--chain"));
  const oracle = getAddress(need(argv, "--oracle")) as Address;
  if (cmd === "report-data") {
    const signer = getAddress(need(argv, "--signer")) as Address;
    return { out: { chainId, oracle, signer, reportData: reportDataFor(chainId, oracle, signer) }, code: 0 };
  }
  if (cmd === "register") {
    const doc = loadAttestationDocument(need(argv, "--doc"));
    const signer = getAddress(doc.signer) as Address;
    const c = checkAttestation(doc, { chainId, oracle, signer });
    return {
      out: {
        chainId,
        oracle,
        signer,
        platform: doc.platform,
        platformTag: c.platform,
        measurement: c.measurement,
        quoteHash: c.quoteHash,
        reportData: c.reportData,
        attestationDigest: c.digest,
        bindingProblems: c.problems,
        reminder: "verify the quote signature chain and the measurement with the platform verifier before proposing",
        timelockCalls: timelockCalls(oracle, signer, c),
      },
      code: c.problems.length === 0 ? 0 : 1,
    };
  }
  throw new Error("usage: attest report-data|register --chain <id> --oracle <addr> (--signer <addr> | --doc <file>)");
}

if (import.meta.main) {
  try {
    const { out, code } = run(process.argv.slice(2));
    console.log(JSON.stringify(out, null, 2));
    process.exit(code);
  } catch (e) {
    console.error(`attest: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
