// Read-only chain checks and record edits for scripts/deploy-testnet.sh (no host `cast` / `node` needed: bun + viem,
// as the stack user). Every RPC call is an eth_call / eth_getCode / eth_getBalance / eth_chainId.
//   bun scripts/deploy-check.ts chain-id    --rpc <url>
//   bun scripts/deploy-check.ts balance     --rpc <url> --address <0x…>          # ETH, decimal
//   bun scripts/deploy-check.ts start-block --record <file> [--broadcast <run-latest.json>]
//   bun scripts/deploy-check.ts verify      --rpc <url> --record <file> [--live-token <0x…> --live-vault <0x…>]
//   bun scripts/deploy-check.ts senders     --expect <0x…> [--broadcast <run-latest.json>]   # every broadcast tx from it
// Exit 0 ok, 4 = a verification failed, 2 = usage / RPC error.
import { readFileSync, writeFileSync } from "node:fs";
import { type Address, createPublicClient, formatEther, getAddress, http, parseAbi, stringToHex } from "viem";

const opt = (argv: string[], n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const need = (argv: string[], n: string) => {
  const v = opt(argv, n);
  if (!v) throw new Error(`--${n} is required`);
  return v;
};

/** Pure: startBlock = the first receipt's block - 1 (on Arbitrum Orbit block.number is the PARENT chain's). */
export function startBlockOf(broadcast: { receipts?: Array<{ blockNumber?: string }> }): number {
  const b = (broadcast.receipts ?? []).map((x) => Number.parseInt(x.blockNumber ?? "", 16)).filter((n) => Number.isFinite(n) && n > 0);
  if (!b.length) throw new Error("no receipts in the broadcast file");
  return Math.min(...b) - 1;
}

/**
 * Pure: the senders of a forge broadcast file. The deployment must have been signed by the deployer the checks ran on
 * (a mnemonic other than the checked one, e.g. the public stack's, must never deploy unnoticed).
 */
export function broadcastSendersProblem(broadcast: { transactions?: Array<{ transaction?: { from?: string } }> }, expect: string): string | null {
  const txs = broadcast.transactions ?? [];
  if (txs.length === 0) return "the broadcast file lists no transaction";
  const others = [...new Set(txs.map((t) => (t.transaction?.from ?? "?").toLowerCase()).filter((f) => f !== expect.toLowerCase()))];
  return others.length ? `broadcast signed by ${others.join(", ")}, not by the checked deployer ${expect}` : null;
}

const abi = parseAbi([
  "function tokens() view returns (address[])",
  "function implementation(bytes32) view returns (address)",
  "function usdc() view returns (address)",
  "function orderlyVault() view returns (address)",
]);

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === "start-block") {
    const rec = need(argv, "record");
    const bc = opt(argv, "broadcast") ?? "contracts/broadcast/Deploy.s.sol/46630/run-latest.json";
    const d = JSON.parse(readFileSync(rec, "utf8")) as { startBlock?: number };
    d.startBlock = startBlockOf(JSON.parse(readFileSync(bc, "utf8")));
    writeFileSync(rec, `${JSON.stringify(d, null, 2)}\n`);
    console.log(`    startBlock ${d.startBlock}`);
    return;
  }
  if (cmd === "senders") {
    const expect = getAddress(need(argv, "expect"));
    const bc = opt(argv, "broadcast") ?? "contracts/broadcast/Deploy.s.sol/46630/run-latest.json";
    const problem = broadcastSendersProblem(JSON.parse(readFileSync(bc, "utf8")), expect);
    if (problem) {
      console.log(`!! ${problem}`);
      process.exit(4);
    }
    console.log(`    ok: every broadcast transaction was sent by ${expect}`);
    return;
  }
  const pc = createPublicClient({ transport: http(need(argv, "rpc"), { timeout: 20_000 }) });
  if (cmd === "chain-id") {
    console.log(await pc.getChainId());
    return;
  }
  if (cmd === "balance") {
    console.log(formatEther(await pc.getBalance({ address: getAddress(need(argv, "address")) })));
    return;
  }
  if (cmd === "verify") {
    const d = JSON.parse(readFileSync(need(argv, "record"), "utf8")) as { contracts: Record<string, Address> };
    const field = (n: string): Address => {
      const v = d.contracts[n];
      if (!v) throw new Error(`record has no contracts.${n}`);
      return getAddress(v);
    };
    const c = { config: field("config"), stockRegistry: field("stockRegistry"), factory: field("factory") };
    const fail = (m: string) => {
      console.log(m);
      process.exit(4);
    };
    const code = await pc.getCode({ address: c.config });
    if (!code || code.length <= 10) fail(`config has no code at ${c.config}`);
    const tokens = await pc.readContract({ address: c.stockRegistry, abi, functionName: "tokens" });
    if (tokens.length < 5) fail(`stock registry has ${tokens.length} tokens (expected 5) — broadcast incomplete`);
    const bookKind = stringToHex("BOOK", { size: 32 });
    const impl = await pc.readContract({ address: c.factory, abi, functionName: "implementation", args: [bookKind] });
    if (/^0x0{40}$/i.test(impl)) fail("factory implementations not set");
    const token = opt(argv, "live-token");
    const vault = opt(argv, "live-vault");
    if (token && vault) {
      const [u, v] = await Promise.all([pc.readContract({ address: c.config, abi, functionName: "usdc" }), pc.readContract({ address: c.config, abi, functionName: "orderlyVault" })]);
      if (u.toLowerCase() !== token.toLowerCase()) fail(`config.usdc() is ${u}, not ${token}`);
      if (v.toLowerCase() !== vault.toLowerCase()) fail(`config.orderlyVault() is ${v}, not ${vault}`);
      console.log(`    ok: config.usdc() = ${token}, config.orderlyVault() = ${vault} (no mock venue)`);
    }
    console.log(`    ok: config, ${tokens.length} stock tokens, factory implementations (config ${c.config})`);
    return;
  }
  throw new Error(`unknown command ${cmd ?? ""} (chain-id | balance | start-block | verify | senders)`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[deploy-check] ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    process.exit(2);
  });
}
