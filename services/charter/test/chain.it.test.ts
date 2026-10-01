// Integration (BKRN_IT=1 + BKRN_ANVIL_URL): the JURY-role write path. RiskCommittee is stood in by an
// accept-all contract set via anvil_setCode; we check signer, calldata and receipt handling.
// Run against a PRIVATE anvil, e.g. `anvil --port 18547 --silent`.
import { describe, expect, test } from "bun:test";
import { type Deployment, createLogger, devAccount } from "@bookrunner/shared";
import { riskCommitteeAbi } from "@bookrunner/shared/abi";
import { type Address, createPublicClient, decodeFunctionData, http } from "viem";
import { CharterChain } from "../src/adapters/chain";
import { cidOfJson } from "../src/domain/cid";

const rpc = process.env.BKRN_ANVIL_URL ?? "";
const IT = process.env.BKRN_IT === "1" && rpc !== "";
const COMMITTEE = "0x00000000000000000000000000000000000c0c01" as Address;
const ACCEPT_ALL = "0x00"; // STOP: every call succeeds with empty return data

describe.skipIf(!IT)("CharterChain.postJuryVerdict (anvil)", () => {
  test("signs with the jury role key, waits for the receipt, sends postJuryVerdict(id, digest, rec)", async () => {
    const pub = createPublicClient({ transport: http(rpc), pollingInterval: 50 });
    await pub.request({ method: "anvil_setCode" as never, params: [COMMITTEE, ACCEPT_ALL] as never });
    const deployment = { chainId: 31337, startBlock: 0, contracts: { committee: COMMITTEE } as Deployment["contracts"], stockTokens: {}, books: [] } as Deployment;
    const chain = new CharterChain(deployment, { chainId: 31337, rpcUrl: rpc, env: { CHAIN_ID: "31337" }, logger: createLogger("charter-it", "silent") });
    const { digest } = await cidOfJson({ charterId: 42 });
    const hash = await chain.postJuryVerdict(42, digest, true);
    const tx = await pub.getTransaction({ hash });
    expect(tx.from.toLowerCase()).toBe(devAccount("jury").address.toLowerCase());
    expect(tx.to?.toLowerCase()).toBe(COMMITTEE);
    const call = decodeFunctionData({ abi: riskCommitteeAbi, data: tx.input });
    expect(call.functionName).toBe("postJuryVerdict");
    expect(call.args).toEqual([42n, digest, true]);
  }, 60_000);
});
