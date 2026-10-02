// Open a top-up round (new deposits into a Live book) as the sponsor: Book.openTopUp(window, seniorCap, juniorCap).
// Deposits made during the round stay in escrow and settle at the first mark whose period ends at or after
// the round END (not the next mark), and a round cannot be closed early (only retire() cancels it) — so keep
// rounds short: deposits become shares at most one mark interval after the round ends.
//   bun scripts/open-topup.ts                     # every Live book, 1 day, 100k Senior / 100k Junior
//   bun scripts/open-topup.ts NVDA --days 7 --senior 50000 --junior 50000
//   CHAIN_ID=46630 RPC_URL=https://rpc.testnet.chain.robinhood.com DEPLOYMENT_FILE=contracts/deployments/46630.json \
//     bun --env-file=.env.testnet scripts/open-topup.ts
import { type Abi, type Address, createPublicClient, createWalletClient, http } from "viem";
import { bookAbi } from "../packages/shared/src/abi";
import { chainFor } from "../packages/shared/src/chains";
import { loadDeployment } from "../packages/shared/src/deployments";
import { roleAccount } from "../packages/shared/src/devkeys";
import { usd } from "../packages/shared/src/units";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const chain = chainFor(Number(process.env.CHAIN_ID ?? 31337), RPC);
const pub = createPublicClient({ chain, transport: http(RPC) });
const args = process.argv.slice(2);
const opt = (k: string, d: number) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const names = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const windowSec = Math.round(opt("--days", 1) * 86_400);
const seniorCap = usd(opt("--senior", 100_000));
const juniorCap = usd(opt("--junior", 100_000));
const sponsor = roleAccount("sponsor");
const wallet = createWalletClient({ chain, transport: http(RPC), account: sponsor });
const STATES = ["Subscription", "Cancelled", "Live", "Retiring", "Retired"];

for (const b of loadDeployment().books ?? []) {
  if (names.length && !names.includes(b.name)) continue;
  const book = b.components.book as Address;
  const read = <T>(fn: string) => pub.readContract({ address: book, abi: bookAbi as Abi, functionName: fn } as never) as Promise<T>;
  const state = STATES[await read<number>("state")];
  const [open, endsAt] = await read<[boolean, bigint, bigint, bigint]>("topUp");
  if (state !== "Live") {
    console.log(`[topup] ${b.name}: ${state} — skipped (rounds are for Live books)`);
    continue;
  }
  if (open) {
    console.log(`[topup] ${b.name}: round already open until ${new Date(Number(endsAt) * 1000).toISOString()}`);
    continue;
  }
  const { request } = await pub.simulateContract({ address: book, abi: bookAbi as Abi, functionName: "openTopUp", args: [windowSec, seniorCap, juniorCap], account: sponsor } as never);
  const hash = await wallet.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${b.name}: openTopUp reverted (${hash})`);
  const [, ends] = await read<[boolean, bigint, bigint, bigint]>("topUp");
  console.log(`[topup] ${b.name}: round open until ${new Date(Number(ends) * 1000).toISOString()} (Senior ${opt("--senior", 100_000)} / Junior ${opt("--junior", 100_000)} USDC)  ${hash}`);
}
