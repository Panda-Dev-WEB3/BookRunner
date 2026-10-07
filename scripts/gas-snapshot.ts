// Gas actually paid per role key: snapshot ETH balance + nonce of every role key, diff later.
//   bun scripts/gas-snapshot.ts save <file>      bun scripts/gas-snapshot.ts diff <file>
// Testnet (bun auto-loads the devnet .env, so pass the network explicitly):
//   CHAIN_ID=46630 RPC_URL=https://rpc.testnet.chain.robinhood.com bun --env-file=.env.testnet scripts/gas-snapshot.ts diff <file>
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, formatEther, http } from "viem";
import { chainFor } from "../packages/shared/src/chains";
import { DEV_ROLE_INDEX, type DevRole, roleAccount } from "../packages/shared/src/devkeys";

const [cmd, file] = process.argv.slice(2);
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const pub = createPublicClient({ chain: chainFor(CHAIN_ID, RPC), transport: http(RPC) });
// roles this env can derive (the admin key is not derivable from the service mnemonic on testnet unless
// BKRN_ALLOW_ADMIN_KEY=1 or DEPLOYER_PRIVATE_KEY is set; without it the deployer is left out)
const roles = (Object.keys(DEV_ROLE_INDEX) as DevRole[]).filter((r) => {
  try {
    return !!roleAccount(r);
  } catch {
    return false;
  }
});
const now: Record<string, { address: string; wei: string; nonce: number; ts: number }> = {};
const ts = Math.floor(Date.now() / 1000);
for (const r of roles) {
  const a = roleAccount(r).address;
  const [wei, nonce] = await Promise.all([pub.getBalance({ address: a }), pub.getTransactionCount({ address: a })]);
  now[r] = { address: a, wei: wei.toString(), nonce, ts };
}
if (cmd === "save") {
  writeFileSync(file!, JSON.stringify(now, null, 1));
  console.log(`saved ${roles.length} role balances -> ${file}`);
} else {
  const prev = JSON.parse(readFileSync(file!, "utf8")) as typeof now;
  let spent = 0n;
  let txs = 0;
  let protocolSpent = 0n;
  const hours = (ts - (Object.values(prev)[0]?.ts ?? ts)) / 3600;
  console.log(`window ${(hours * 60).toFixed(1)} min`);
  for (const r of roles) {
    if (!prev[r]) continue;
    const d = BigInt(prev[r]!.wei) - BigInt(now[r]!.wei);
    const n = now[r]!.nonce - prev[r]!.nonce;
    if (n === 0 && d === 0n) continue;
    // the deployer and the funder only move gas to the other keys: not protocol spend
    if (r !== "deployer" && r !== "funder") { spent += d; txs += n; if (!/^trader/.test(r)) protocolSpent += d; }
    console.log(`${r.padEnd(14)} txs ${String(n).padStart(5)}   spent ${formatEther(d).padStart(22)} ETH`);
  }
  const perDay = 24 / (hours || 1);
  console.log(`TOTAL (excl. deployer) ${txs} txs, ${formatEther(spent)} ETH  => ${(Number(formatEther(spent)) * perDay).toFixed(6)} ETH/day`);
  console.log(`PROTOCOL (excl. deployer + simulated traders) => ${(Number(formatEther(protocolSpent)) * perDay).toFixed(6)} ETH/day`);
}
