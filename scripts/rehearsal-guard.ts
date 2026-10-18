// REDEPLOY guard of the live-Orderly rehearsal record (scripts/deploy-testnet.sh ORDERLY_VENUE=live REDEPLOY=1).
// READ-ONLY (eth_call): a redeploy replaces contracts/deployments/46630.live.json, and with it the only record of the
// book / adapter addresses whose Orderly accounts may hold REAL testnet USDG. It is safe only when every book of the
// record (books + an unfinished launch's launch.launched) is Retired or Cancelled AND, for Orderly books, the adapter
// shows nothing venue-side or in flight (insurance, margin, in transit, pending IF / MM withdrawals all zero).
//   bun scripts/rehearsal-guard.ts --record contracts/deployments/46630.live.json [--rpc <url>]
// Exit 0 = safe to replace (the caller still archives the old record), 1 = NOT safe (funds or live books), 2 = error
// (an unreadable record or chain counts as not safe).
import { type Address, getAddress } from "viem";
import { bookAbi, orderlyAdapterAbi } from "../packages/shared/src/abi";
import { publicClientFor } from "../packages/shared/src/clients";
import { tryLoadDeployment } from "../packages/shared/src/deployments";
import type { Deployment } from "../packages/shared/src/types";

export const SAFE_STATES = new Set([1, 4]); // Cancelled, Retired
const STATE_NAMES = ["Subscription", "Cancelled", "Live", "Retiring", "Retired"];

export interface BookFacts {
  bookId: number;
  name: string;
  venue: number;
  /** Book.state(); null = unreadable */
  state: number | null;
  /** Orderly books: insurance, margin, in transit, pending IF, pending MM (6 dp); null = unreadable */
  amounts: bigint[] | null;
}

/** Pure verdict: every book Retired / Cancelled and every Orderly adapter empty. */
export function redeployVerdict(books: BookFacts[]): { safe: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const b of books) {
    const tag = `book ${b.bookId} ${b.name}`;
    if (b.state === null) problems.push(`${tag}: state unreadable`);
    else if (!SAFE_STATES.has(b.state)) problems.push(`${tag}: ${STATE_NAMES[b.state] ?? `state ${b.state}`} (retire it first)`);
    if (b.venue === 0) {
      if (b.amounts === null) problems.push(`${tag}: adapter balances unreadable`);
      else if (b.amounts.some((x) => x !== 0n)) problems.push(`${tag}: adapter not empty (IF / MM / in transit / pending: ${b.amounts.map((x) => (Number(x) / 1e6).toString()).join(" / ")} USDG)`);
    }
  }
  return { safe: problems.length === 0, problems };
}

/** Every book a record knows: books plus an unfinished launch's launch.launched (deduplicated by id). */
export function recordBooks(d: Pick<Deployment, "books" | "launch">): Deployment["books"] {
  const all = [...(d.books ?? []), ...(d.launch?.launched ?? [])];
  return all.filter((b, i) => all.findIndex((x) => x.bookId === b.bookId) === i);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = opt("record");
  if (!file) throw new Error("--record <file> is required");
  const dep = tryLoadDeployment(file);
  if (!dep) throw new Error(`${file}: not readable`);
  const pc = publicClientFor(dep.chainId, opt("rpc") ?? process.env.RHC_TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com");
  const facts: BookFacts[] = [];
  for (const b of recordBooks(dep)) {
    const state = await pc.readContract({ address: getAddress(b.components.book), abi: bookAbi, functionName: "state" } as never).then((x) => Number(x)).catch(() => null);
    let amounts: bigint[] | null = null;
    if (b.venue === 0) {
      const adapter = getAddress(b.components.adapter) as Address;
      const r = (functionName: string, args: readonly unknown[] = []) => pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName, args } as never) as Promise<bigint>;
      amounts = await Promise.all([r("insuranceEquityUsd"), r("marginEquityUsd"), r("inTransitUsd"), r("pendingWithdrawUsd", [0]), r("pendingWithdrawUsd", [1])]).catch(() => null);
    }
    facts.push({ bookId: b.bookId, name: b.name, venue: b.venue, state, amounts });
  }
  const v = redeployVerdict(facts);
  if (v.safe) {
    console.log(`[rehearsal-guard] ${file}: ${facts.length} book(s), all Retired / Cancelled and empty: safe to replace`);
    process.exit(0);
  }
  console.log(`[rehearsal-guard] ${file}: NOT safe to replace (${v.problems.length} problem(s)):`);
  for (const p of v.problems) console.log(`[rehearsal-guard]   - ${p}`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[rehearsal-guard] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
