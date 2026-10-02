// On-chain activity report: every transaction in a block window, grouped by target contract + function,
// with gas used and a per-day extrapolation. Reads the chain itself (not service logs).
//   bun scripts/gas-report.ts                    # last 900 blocks of the devnet
//   bun scripts/gas-report.ts --blocks 3000
//   CHAIN_ID=46630 RPC_URL=https://rpc.testnet.chain.robinhood.com DEPLOYMENT_FILE=contracts/deployments/46630.json \
//     bun scripts/gas-report.ts --since-block 127488963
import { type Abi, type Address, type Hex, createPublicClient, formatEther, http, toFunctionSelector } from "viem";
import * as abis from "../packages/shared/src/abi";
import { chainFor } from "../packages/shared/src/chains";
import { loadDeployment } from "../packages/shared/src/deployments";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const pub = createPublicClient({ chain: chainFor(CHAIN_ID, RPC), transport: http(RPC) });
const dep = loadDeployment();

// address -> label
const names = new Map<string, string>();
for (const [k, v] of Object.entries(dep.contracts)) if (v) names.set(String(v).toLowerCase(), k);
for (const b of dep.books ?? []) for (const [k, v] of Object.entries(b.components)) names.set(String(v).toLowerCase(), `${b.name}.${k}`);
for (const [t, s] of Object.entries(dep.stockTokens ?? {})) names.set(s.token.toLowerCase(), `token:${t}`);

// selector -> function name (all ABIs)
const fns = new Map<string, string>();
for (const abi of Object.values(abis) as Abi[]) {
  for (const item of abi) {
    if (item.type !== "function") continue;
    const sig = `${item.name}(${item.inputs.map((i) => (i.type.startsWith("tuple") ? tupleType(i as never) : i.type)).join(",")})`;
    fns.set(toFunctionSelector(sig), item.name);
  }
}
function tupleType(p: { type: string; components?: Array<{ type: string; components?: unknown[] }> }): string {
  const inner = (p.components ?? []).map((c) => (c.type.startsWith("tuple") ? tupleType(c as never) : c.type)).join(",");
  return `(${inner})${p.type.slice("tuple".length)}`;
}

const head = await pub.getBlockNumber();
const from = opt("--since-block") ? BigInt(opt("--since-block")!) : head - BigInt(opt("--blocks") ?? 900);
const rows = new Map<string, { n: number; gas: bigint; fee: bigint }>();
let t0 = 0n;
let t1 = 0n;
for (let b = from; b <= head; b++) {
  const blk = await pub.getBlock({ blockNumber: b, includeTransactions: true });
  if (b === from) t0 = blk.timestamp;
  t1 = blk.timestamp;
  for (const tx of blk.transactions) {
    if (typeof tx === "string") continue;
    const r = await pub.getTransactionReceipt({ hash: tx.hash as Hex });
    const to = (tx.to ?? "0x").toLowerCase() as Address;
    const label = tx.to ? (names.get(to) ?? `${to.slice(0, 10)}…`) : "create";
    const fn = tx.input && tx.input.length >= 10 ? (fns.get(tx.input.slice(0, 10)) ?? tx.input.slice(0, 10)) : "transfer";
    const k = `${label}.${fn}`;
    const row = rows.get(k) ?? { n: 0, gas: 0n, fee: 0n };
    row.n++;
    row.gas += r.gasUsed;
    row.fee += r.gasUsed * (r.effectiveGasPrice ?? 0n);
    rows.set(k, row);
  }
}
const secs = Number(t1 - t0) || 1;
const perDay = 86_400 / secs;
const sorted = [...rows.entries()].sort((a, b) => Number(b[1].gas - a[1].gas));
let totalGas = 0n;
let totalN = 0;
console.log(`blocks ${from}..${head} (${(secs / 60).toFixed(1)} min), chain ${CHAIN_ID}`);
console.log("contract.function".padEnd(46), "txs".padStart(6), "avg gas".padStart(9), "txs/day".padStart(9), "gas/day".padStart(12));
for (const [k, v] of sorted) {
  totalGas += v.gas;
  totalN += v.n;
  console.log(k.slice(0, 46).padEnd(46), String(v.n).padStart(6), String(v.gas / BigInt(v.n)).padStart(9), String(Math.round(v.n * perDay)).padStart(9), `${(Number(v.gas) * perDay / 1e6).toFixed(1)}M`.padStart(12));
}
const gasDay = Number(totalGas) * perDay;
console.log(`TOTAL ${totalN} txs, ${(gasDay / 1e6).toFixed(0)}M gas/day => at 0.01 gwei: ${(gasDay * 1e-11).toFixed(5)} ETH/day`);
void formatEther;
