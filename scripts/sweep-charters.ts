// Sweep stale charters: MarketCharter.expire(id) for every charter still Filed after its decision deadline. expire
// refunds the sponsor's fee and releases its bond; anyone may call it once block.timestamp >= decisionDeadline(id)
// (stored at filing, audit 2026-10 D). Needed after a MarketCharter / committee repoint (audit 2026-10 review M-7): the
// committee keys its ballots by config.charter(), so charters still Filed on the OLD MarketCharter can no longer be
// decided and stay Filed (fee and bond locked) until someone expires them. Also periodic housekeeping.
//   bun scripts/sweep-charters.ts                         # dry run on the deployment's MarketCharter: what would expire
//   bun scripts/sweep-charters.ts --charter 0x<old>       # an old MarketCharter (after a repoint)
//   bun scripts/sweep-charters.ts --send                  # send expire(id) for each, signed by the KEEPER role signer
//   bun scripts/sweep-charters.ts --from 10 --to 40       # id range (default 1..count())
//   CHAIN_ID=46630 RPC_URL=https://rpc.testnet.chain.robinhood.com DEPLOYMENT_FILE=contracts/deployments/46630.json \
//     bun --env-file=.env.testnet scripts/sweep-charters.ts
// The deadline is read from the chain (decisionDeadline; a charter deployed before audit 2026-10 D has none: filedAt +
// the config's current committeeWindow, the rule that charter applies) and compared with the head block's timestamp.
// Each expire is simulated before it is sent; a refusal is reported and the sweep goes on.
import { type Abi, type Address, createPublicClient, createWalletClient, http, isAddress } from "viem";
import { bookrunnerConfigAbi, marketCharterAbi } from "../packages/shared/src/abi";
import { chainFor } from "../packages/shared/src/chains";
import { loadDeployment } from "../packages/shared/src/deployments";
import { roleSigner } from "../packages/shared/src/signer";
import { CHARTER_STATUS, type CharterStatus } from "../packages/shared/src/types";

export interface CharterRow {
  id: number;
  status: CharterStatus;
  /** unix s; null when unknown (the sweep then leaves the charter alone) */
  deadline: number | null;
}

export interface SweepPlan {
  /** Filed and past the deadline: expire */
  expire: number[];
  /** Filed and still within the decision window */
  open: Array<{ id: number; deadline: number }>;
  /** Filed with an unknown deadline (reported, never sent) */
  unknown: number[];
}

/** Pure: which charters to expire at chain time `nowSec` (the contract's rule: block.timestamp >= deadline). */
export function planSweep(rows: readonly CharterRow[], nowSec: number): SweepPlan {
  const plan: SweepPlan = { expire: [], open: [], unknown: [] };
  for (const r of rows) {
    if (r.status !== "Filed") continue;
    if (r.deadline === null || !(r.deadline > 0)) plan.unknown.push(r.id);
    else if (nowSec >= r.deadline) plan.expire.push(r.id);
    else plan.open.push({ id: r.id, deadline: r.deadline });
  }
  return plan;
}

/** Pure: CLI options. */
export function parseArgs(argv: readonly string[]): { charter: Address | null; send: boolean; from: number | null; to: number | null } {
  const val = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const charter = val("--charter");
  if (charter !== undefined && !isAddress(charter)) throw new Error(`--charter: not an address: ${charter}`);
  const int = (k: string) => {
    const v = val(k);
    if (v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${k}: expected a charter id >= 1, got ${v}`);
    return n;
  };
  return { charter: (charter as Address | undefined) ?? null, send: argv.includes("--send"), from: int("--from"), to: int("--to") };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
  const chain = chainFor(Number(process.env.CHAIN_ID ?? 31337), RPC);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const dep = loadDeployment();
  const charter = opts.charter ?? (dep.contracts.charter as Address);
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  const count = Number(await read<bigint>(charter, marketCharterAbi as Abi, "count"));
  const from = opts.from ?? 1;
  const to = Math.min(opts.to ?? count, count);
  let window: number | null = null; // fallback for a charter without decisionDeadline
  const rows: CharterRow[] = [];
  for (let id = from; id <= to; id++) {
    const r = await read<{ status: number; filedAt: bigint }>(charter, marketCharterAbi as Abi, "get", [BigInt(id)]);
    const status = CHARTER_STATUS[r.status] ?? "None";
    let deadline: number | null = null;
    if (status === "Filed") {
      deadline = await read<bigint>(charter, marketCharterAbi as Abi, "decisionDeadline", [BigInt(id)]).then(Number, () => null);
      if (!deadline) {
        window ??= await read<bigint>(dep.contracts.config as Address, bookrunnerConfigAbi as Abi, "committeeWindow").then(Number, () => null);
        deadline = window === null ? null : Number(r.filedAt) + window;
      }
    }
    rows.push({ id, status, deadline });
  }
  const head = await pub.getBlock({ blockTag: "latest" });
  const nowSec = Number(head.timestamp);
  const plan = planSweep(rows, nowSec);
  console.log(`[sweep-charters] MarketCharter ${charter}: ids ${from}..${to} of ${count}, chain time ${new Date(nowSec * 1000).toISOString()}`);
  console.log(`[sweep-charters] to expire: ${plan.expire.length ? plan.expire.join(", ") : "none"}`);
  for (const o of plan.open) console.log(`[sweep-charters] #${o.id} still open until ${new Date(o.deadline * 1000).toISOString()}`);
  if (plan.unknown.length) console.log(`[sweep-charters] deadline unknown (not swept): ${plan.unknown.join(", ")}`);
  if (!opts.send || plan.expire.length === 0) {
    if (!opts.send && plan.expire.length) console.log("[sweep-charters] dry run: add --send to expire them");
    return;
  }
  const account = await roleSigner("keeper");
  const wallet = createWalletClient({ chain, transport: http(RPC), account });
  let failed = 0;
  for (const id of plan.expire) {
    try {
      const { request } = await pub.simulateContract({ address: charter, abi: marketCharterAbi as Abi, functionName: "expire", args: [BigInt(id)], account } as never);
      const hash = await wallet.writeContract(request as never);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`reverted in ${hash}`);
      console.log(`[sweep-charters] #${id} expired (fee refunded, bond released) ${hash}`);
    } catch (err) {
      failed++;
      console.error(`[sweep-charters] #${id} not expired: ${(err as { shortMessage?: string }).shortMessage ?? String(err)}`);
    }
  }
  if (failed) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
