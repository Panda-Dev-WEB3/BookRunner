// REDEPLOY guard of the live-Orderly rehearsal record (scripts/deploy-testnet.sh ORDERLY_VENUE=live REDEPLOY=1).
// READ-ONLY (eth_call): a redeploy replaces contracts/deployments/46630.live.json, and with it the only record of the
// book / adapter addresses whose Orderly accounts may hold REAL testnet USDG. It is safe only when every book of the
// record (books + an unfinished launch's launch.launched) is Retired or Cancelled AND, for Orderly books, the adapter
// shows nothing venue-side or in flight (insurance, margin, in transit, pending IF / MM withdrawals all zero).
//   bun scripts/rehearsal-guard.ts --record contracts/deployments/46630.live.json [--rpc <url>]
// Exit 0 = safe to replace (the caller still archives the old record), 1 = NOT safe (funds or live books), 2 = error
// (an unreadable record or chain counts as not safe).
//   bun scripts/rehearsal-guard.ts --supervisor
// Is the testnet-live stack running? Reads its supervisor status key (bus namespace testnet-live) on its own Redis
// (REDIS_LIVE_URL, else 127.0.0.1:63791 db 0 with REDIS_LIVE_PASSWORD from the environment; never on a command line).
// Exit 0 = not running (no fresh status; an unreachable Redis counts as not running: the systemd check runs too),
// 1 = running, 2 = the live Redis refuses the password (cannot tell: refused by deploy-testnet.sh).
import { RedisClient } from "bun";
import { type Address, getAddress } from "viem";
import { bookAbi, orderlyAdapterAbi } from "../packages/shared/src/abi";
import { publicClientFor } from "../packages/shared/src/clients";
import { tryLoadDeployment } from "../packages/shared/src/deployments";
import type { Deployment } from "../packages/shared/src/types";
import { busNames } from "../packages/shared/src/queues";
import { SUPERVISOR_TTL_MS, parseSupervisorStatus } from "../packages/shared/src/supervisor";
import { variantRedisUrl } from "./network-profile";

/** Pure: is a supervisor status (raw Redis value) fresh, i.e. its stack running? */
export function supervisorRunning(raw: string | null, now: number, ttlMs = SUPERVISOR_TTL_MS): boolean {
  const s = parseSupervisorStatus(raw);
  return !!s && now - s.ts <= ttlMs;
}

async function supervisorCheck(): Promise<never> {
  const url = process.env.REDIS_LIVE_URL?.trim() || variantRedisUrl(process.env, "testnet-live");
  const key = busNames("testnet-live").KEYS.supervisorStatus;
  let raw: string | null = null;
  try {
    const c = new RedisClient(url, { connectionTimeout: 5_000, enableOfflineQueue: false, autoReconnect: false });
    await c.connect();
    raw = (await c.send("GET", [key])) as string | null;
    c.close();
  } catch (err) {
    const msg = (err as Error).message;
    // a wrong / missing password is not "not running": fail closed (deploy-testnet.sh refuses to archive)
    if (/NOAUTH|WRONGPASS|auth/i.test(msg)) {
      console.log(`[rehearsal-guard] the live Redis refuses the credentials (${msg}): cannot tell whether the stack runs`);
      process.exit(2);
    }
    console.log(`[rehearsal-guard] the live Redis is unreachable (${msg}): treated as not running`);
  }
  const running = supervisorRunning(raw, Date.now());
  console.log(`[rehearsal-guard] testnet-live supervisor: ${running ? "RUNNING (fresh status)" : "not running"}`);
  process.exit(running ? 1 : 0);
}

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
  if (argv.includes("--supervisor")) await supervisorCheck();
  const file = opt("record");
  if (!file) throw new Error("--record <file> (or --supervisor) is required");
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
