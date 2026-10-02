// Gas keeper (public test chains): refills every protocol role key from the deployer when it drops below a
// trigger, up to a target, and warns when the deployer itself runs low. Without it the busiest keys (desk
// keys hedging, traders, the mark signer) run dry within days and a book whose agent cannot hedge gets
// HEDGE_BAND-killed. Test ETH only: never runs on devnet 31337 (anvil keys are pre-funded) or mainnet 4663.
//   bun scripts/gas-keeper.ts              # one pass
//   bun scripts/gas-keeper.ts --loop       # every GAS_KEEPER_INTERVAL_SECONDS (default 600); dev.ts runs this
import { type Address, createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { chainFor } from "../packages/shared/src/chains";
import { type DevRole, roleAccount } from "../packages/shared/src/devkeys";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const LOOP = process.argv.includes("--loop");
const INTERVAL_MS = Number(process.env.GAS_KEEPER_INTERVAL_SECONDS ?? 600) * 1000;
const DEPLOYER_RESERVE = parseEther(process.env.GAS_KEEPER_RESERVE_ETH ?? "0.02");
const DEPLOYER_WARN = parseEther(process.env.GAS_KEEPER_WARN_ETH ?? "0.1");

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, time: Date.now(), service: "gas-keeper", ...extra, msg }));

/** [role, trigger, target] in ETH. Sized from measured testnet burn (0.01 gwei): RHX5 desk ~0.0035 ETH/day. */
export const GAS_PLAN: Array<[DevRole, string, string]> = [
  ["deskKeyIndex", "0.008", "0.03"],
  ["deskKeyNvda", "0.004", "0.015"],
  ["deskKeyTsla", "0.004", "0.015"],
  ["trader0", "0.003", "0.01"],
  ["trader1", "0.003", "0.01"],
  ["trader2", "0.003", "0.01"],
  ["trader3", "0.003", "0.01"],
  ["markSigner", "0.003", "0.01"],
  ["keeper", "0.002", "0.008"],
  ["opsVenue", "0.002", "0.008"],
  ["risk", "0.001", "0.004"],
  ["oracleSigner", "0.001", "0.004"],
  ["jury", "0.0005", "0.002"],
  ["sponsor", "0.0005", "0.002"],
  ["committee0", "0.0005", "0.002"],
  ["committee1", "0.0005", "0.002"],
  ["committee2", "0.0005", "0.002"],
  ["agentOperator", "0.0005", "0.002"],
];

async function pass(): Promise<void> {
  const chain = chainFor(CHAIN_ID, RPC);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const deployer = roleAccount("deployer");
  const wallet = createWalletClient({ chain, transport: http(RPC), account: deployer });
  const gaps: Array<{ role: DevRole; to: Address; value: bigint; bal: bigint }> = [];
  for (const [role, trigger, target] of GAS_PLAN) {
    const to = roleAccount(role).address;
    const bal = await pub.getBalance({ address: to });
    if (bal < parseEther(trigger)) gaps.push({ role, to, value: parseEther(target) - bal, bal });
  }
  let have = await pub.getBalance({ address: deployer.address });
  if (have < DEPLOYER_WARN) log("warn", "deployer gas low: fund it from the faucet", { deployer: deployer.address, eth: formatEther(have), faucet: "https://faucet.testnet.chain.robinhood.com" });
  for (const g of gaps) {
    if (have - g.value < DEPLOYER_RESERVE) {
      log("error", "deployer cannot cover a top-up without dipping below its reserve", { role: g.role, key: g.to, keyEth: formatEther(g.bal), deployerEth: formatEther(have) });
      continue;
    }
    const hash = await wallet.sendTransaction({ to: g.to, value: g.value });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`top-up to ${g.role} reverted (${hash})`);
    have -= g.value + r.gasUsed * r.effectiveGasPrice;
    log("info", "key topped up", { role: g.role, key: g.to, fromEth: formatEther(g.bal), addedEth: formatEther(g.value), tx: hash });
  }
  if (!gaps.length) log("info", "all keys above their trigger", { deployerEth: formatEther(have) });
}

if (import.meta.main) {
  if (CHAIN_ID === 31337 || CHAIN_ID === 4663) {
    log("info", `gas keeper disabled on chain ${CHAIN_ID} (test chains only)`);
    process.exit(0);
  }
  do {
    try {
      await pass();
    } catch (err) {
      log("error", "gas keeper pass failed", { err: (err as Error).message.split("\n")[0] });
      if (!LOOP) process.exit(1);
    }
    if (LOOP) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  } while (LOOP);
}
