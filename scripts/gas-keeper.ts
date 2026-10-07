// Gas keeper (public test chains): refills every protocol role key from a dedicated FUNDER key when it drops
// below a trigger, up to a target, and warns when the funder itself runs low. Without it the busiest keys
// (desk keys hedging, traders, the mark signer) run dry within days and a book whose agent cannot hedge gets
// HEDGE_BAND-killed. Test ETH only: never runs on devnet 31337 (anvil keys are pre-funded) or mainnet 4663.
//
// The funder holds test ETH and no protocol role, so this always-on process never needs the admin
// (deployer) key: BKRN_TESTNET_FUNDER_PK when set, else index 22 of BKRN_TESTNET_MNEMONIC (devkeys "funder").
//   bun scripts/gas-keeper.ts              # one pass
//   bun scripts/gas-keeper.ts --loop       # every GAS_KEEPER_INTERVAL_SECONDS (default 600); dev.ts runs this
//   bun scripts/gas-keeper.ts --address    # print the funder address (fund it from the faucet)
//   BKRN_ALLOW_ADMIN_KEY=1 bun scripts/gas-keeper.ts --seed-funder 0.2
//                                          # operator, once: move 0.2 test ETH from the deployer to the funder
import { type Address, createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { chainFor } from "../packages/shared/src/chains";
import { type DevRole, roleAccount } from "../packages/shared/src/devkeys";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const LOOP = process.argv.includes("--loop");
const INTERVAL_MS = Number(process.env.GAS_KEEPER_INTERVAL_SECONDS ?? 600) * 1000;
const FUNDER_RESERVE = parseEther(process.env.GAS_KEEPER_RESERVE_ETH ?? "0.02");
const FUNDER_WARN = parseEther(process.env.GAS_KEEPER_WARN_ETH ?? "0.1");

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

const chain = () => chainFor(CHAIN_ID, RPC);

async function pass(): Promise<void> {
  const pub = createPublicClient({ chain: chain(), transport: http(RPC) });
  const funder = roleAccount("funder");
  const wallet = createWalletClient({ chain: chain(), transport: http(RPC), account: funder });
  const gaps: Array<{ role: DevRole; to: Address; value: bigint; bal: bigint }> = [];
  for (const [role, trigger, target] of GAS_PLAN) {
    const to = roleAccount(role).address;
    const bal = await pub.getBalance({ address: to });
    if (bal < parseEther(trigger)) gaps.push({ role, to, value: parseEther(target) - bal, bal });
  }
  let have = await pub.getBalance({ address: funder.address });
  if (have < FUNDER_WARN) log("warn", "funder gas low: fund it from the faucet", { funder: funder.address, eth: formatEther(have), faucet: "https://faucet.testnet.chain.robinhood.com" });
  for (const g of gaps) {
    if (have - g.value < FUNDER_RESERVE) {
      log("error", "funder cannot cover a top-up without dipping below its reserve", { role: g.role, key: g.to, keyEth: formatEther(g.bal), funderEth: formatEther(have), funder: funder.address });
      continue;
    }
    const hash = await wallet.sendTransaction({ to: g.to, value: g.value });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`top-up to ${g.role} reverted (${hash})`);
    have -= g.value + r.gasUsed * r.effectiveGasPrice;
    log("info", "key topped up", { role: g.role, key: g.to, fromEth: formatEther(g.bal), addedEth: formatEther(g.value), tx: hash });
  }
  if (!gaps.length) log("info", "all keys above their trigger", { funderEth: formatEther(have) });
}

/** Operator, once: the deployer (needs BKRN_ALLOW_ADMIN_KEY=1 or DEPLOYER_PRIVATE_KEY) funds the funder. */
async function seedFunder(eth: string): Promise<void> {
  const pub = createPublicClient({ chain: chain(), transport: http(RPC) });
  const deployer = roleAccount("deployer");
  const to = roleAccount("funder").address;
  const wallet = createWalletClient({ chain: chain(), transport: http(RPC), account: deployer });
  const hash = await wallet.sendTransaction({ to, value: parseEther(eth) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`funder seed reverted (${hash})`);
  log("info", "funder seeded from the deployer", { funder: to, eth, tx: hash });
}

if (import.meta.main) {
  // a top-up in flight is a single transfer; stopping between passes is always safe
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
  if (CHAIN_ID === 31337 || CHAIN_ID === 4663) {
    log("info", `gas keeper disabled on chain ${CHAIN_ID} (test chains only)`);
    process.exit(0);
  }
  if (process.argv.includes("--address")) {
    console.log(roleAccount("funder").address);
    process.exit(0);
  }
  const seedIdx = process.argv.indexOf("--seed-funder");
  if (seedIdx >= 0) {
    await seedFunder(process.argv[seedIdx + 1] ?? "0.2");
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
