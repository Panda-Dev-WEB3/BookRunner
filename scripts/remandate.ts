// Re-mandate a killed book (docs/RUNBOOK.md "Re-mandate after a kill"), same terms unless changed below:
//   1. committee0 proposes REMANDATE(abi.encode(current mandate)) — the proposal counts as its approval
//   2. committee1 approves -> 2-of-3 -> mandate.remandate (clears the kill, revokes every key)
//   3. the operator re-consents and the sponsor re-registers the book's desk key
// The halted agent resumes by itself (kill cleared + desk key active); ops-venue re-issues the venue key.
//   bun scripts/remandate.ts NVDA
//   CHAIN_ID=46630 RPC_URL=https://rpc.testnet.chain.robinhood.com DEPLOYMENT_FILE=contracts/deployments/46630.json \
//     bun --env-file=.env.testnet scripts/remandate.ts NVDA
import { type Abi, type AbiFunction, type Address, createPublicClient, createWalletClient, encodeAbiParameters, http, parseEventLogs } from "viem";
import type { LocalAccount } from "viem/accounts";
import { mMMandateAbi, riskCommitteeAbi } from "../packages/shared/src/abi";
import { strToBytes32 } from "../packages/shared/src/bytes32";
import { chainFor } from "../packages/shared/src/chains";
import { loadDeployment } from "../packages/shared/src/deployments";
import { type DevRole, roleAccount } from "../packages/shared/src/devkeys";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const chain = chainFor(CHAIN_ID, RPC);
const pub = createPublicClient({ chain, transport: http(RPC) });
const log = (...a: unknown[]) => console.log("[remandate]", ...a);

const DESK_KEY_ROLE: Record<string, DevRole> = { NVDA: "deskKeyNvda", TSLA: "deskKeyTsla", RHX5: "deskKeyIndex" };
const name = process.argv[2];
const dep = loadDeployment();
const book = dep.books?.find((b) => b.name === name);
if (!name || !book || !DESK_KEY_ROLE[name]) {
  console.error(`usage: bun scripts/remandate.ts <${(dep.books ?? []).map((b) => b.name).join("|")}>`);
  process.exit(1);
}
const mandate = book.components.mandate as Address;
const committee = dep.contracts.committee as Address;

async function send(who: LocalAccount, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const wallet = createWalletClient({ chain, transport: http(RPC), account: who });
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: who } as never);
  const hash = await wallet.writeContract(request as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  log(`${functionName} ok  ${hash}`);
  return receipt;
}
const read = <T>(functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address: mandate, abi: mMMandateAbi as Abi, functionName, args } as never) as Promise<T>;

const killed = await read<boolean>("killed");
if (!killed) {
  log(`${name}: mandate is not killed — nothing to do`);
  process.exit(0);
}
const terms = await read<Record<string, unknown>>("getMandate");
const getMandate = (mMMandateAbi as Abi).find((i): i is AbiFunction => i.type === "function" && i.name === "getMandate")!;
const data = encodeAbiParameters(getMandate.outputs, [terms]);
log(`${name} (book ${book.bookId}): killed — proposing REMANDATE with unchanged terms`);

const c0 = roleAccount("committee0");
const c1 = roleAccount("committee1");
const proposed = await send(c0, committee, riskCommitteeAbi as Abi, "proposeAction", [BigInt(book.bookId), strToBytes32("REMANDATE"), data]);
const [ev] = parseEventLogs({ abi: riskCommitteeAbi as Abi, logs: proposed.logs, eventName: "ActionProposed" }) as unknown as Array<{ args: { actionId: bigint } }>;
if (!ev) throw new Error("ActionProposed not emitted");
await send(c1, committee, riskCommitteeAbi as Abi, "approveAction", [ev.args.actionId]);
if (await read<boolean>("killed")) throw new Error("approval did not execute the remandate (still killed)");
log(`${name}: re-mandated (action ${ev.args.actionId}), kill cleared`);

// keys were revoked by the remandate: operator consents again, sponsor re-registers (tier >= maxInventory)
const deskKey = roleAccount(DESK_KEY_ROLE[name]!);
const operator = roleAccount("agentOperator");
const validUntil = BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400);
await send(operator, mandate, mMMandateAbi as Abi, "consentKey", [deskKey.address, true]);
await send(roleAccount("sponsor"), mandate, mMMandateAbi as Abi, "registerKey", [deskKey.address, operator.address, validUntil, terms.maxInventoryUsd]);
log(`${name}: desk key ${deskKey.address} registered — the agent resumes on its next halt-watch tick`);
