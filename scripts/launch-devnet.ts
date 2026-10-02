// Lane C1 — launch the three studio-sponsored books on devnet or Robinhood Chain testnet (ARCHITECTURE §7):
//   NVDA (Orderly mock), TSLA (Orderly mock), RHX5 Stock-Token index (in-house PoolEngine).
// Flow per book: sponsor files charter (fee + bond) -> model jury verdict (charter service; fallback
// posts a launch verdict if the service is not running) -> committee 2-of-3 -> BookFactory.create ->
// subscriptions (sponsor >= 10% Junior + allocators) -> desk session keys (operator consent + sponsor
// registerKey) -> window close (keeper service, fallback here) -> books appended to the deployment file.
//   bun scripts/launch-devnet.ts            (idempotent: exits if books already launched)
// Testnet (CHAIN_ID=46630): keys derive from BKRN_TESTNET_MNEMONIC; the deployer first distributes gas ETH
// to every role/participant key, and LAUNCH_USER_WALLET (if set) receives test USDC + BKRN + a little gas.
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  stringToHex,
} from "viem";
import type { LocalAccount } from "viem/accounts";
import {
  bkrnStakingAbi,
  bkrnTokenAbi,
  bookAbi,
  bookFactoryAbi,
  marketCharterAbi,
  mMMandateAbi,
  mockERC20Abi,
  riskCommitteeAbi,
  trancheAbi,
} from "../packages/shared/src/abi";
import { HEDGE_VENUES, indexUnderlying, strToBytes32, tokenUnderlying } from "../packages/shared/src/bytes32";
import { chainFor } from "../packages/shared/src/chains";
import { type DevRole, roleAccount } from "../packages/shared/src/devkeys";
import { deploymentPath, loadDeployment } from "../packages/shared/src/deployments";
import { hedgeAllowTree } from "../packages/shared/src/merkle";
import { SESSIONS_24X5, encodeSessions } from "../packages/shared/src/sessions";
import type { BookComponents, Deployment } from "../packages/shared/src/types";
import { usd } from "../packages/shared/src/units";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const WINDOW = Number(process.env.LAUNCH_WINDOW_SECONDS ?? 120);
const JUNIOR_NOTICE = BigInt(process.env.LAUNCH_JUNIOR_NOTICE_SECONDS ?? 900);
const JURY_WAIT_MS = Number(process.env.LAUNCH_JURY_WAIT_SECONDS ?? 90) * 1000;
const CLOSE_GRACE_MS = Number(process.env.LAUNCH_CLOSE_GRACE_SECONDS ?? 30) * 1000;

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const chain = chainFor(CHAIN_ID, RPC);
const PUBLIC_CHAIN = CHAIN_ID !== 31337;
const devAccount = (role: DevRole) => roleAccount(role); // network-aware (devnet anvil / testnet mnemonic)
const USER_WALLET = process.env.LAUNCH_USER_WALLET as Address | undefined;
const pub = createPublicClient({ chain, transport: http(RPC) });
const log = (...a: unknown[]) => console.log("[launch]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const acct = {
  deployer: devAccount("deployer"),
  jury: devAccount("jury"),
  keeper: devAccount("keeper"),
  sponsor: devAccount("sponsor"),
  c0: devAccount("committee0"),
  c1: devAccount("committee1"),
  c2: devAccount("committee2"),
  operator: devAccount("agentOperator"),
  a0: devAccount("allocator0"),
  a1: devAccount("allocator1"),
  a2: devAccount("allocator2"),
  t0: devAccount("trader0"),
  t1: devAccount("trader1"),
  t2: devAccount("trader2"),
  t3: devAccount("trader3"),
} satisfies Record<string, LocalAccount>;

async function send(who: LocalAccount, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const wallet = createWalletClient({ chain, transport: http(RPC), account: who });
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: who } as never);
  const hash = await wallet.writeContract(request as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  return receipt;
}

const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;

interface LaunchSpec {
  name: string;
  symbol: string;
  venue: 0 | 1;
  underlying: Hex;
  hedgeTokens: Address[];
  ifUsd: bigint;
  mmUsd: bigint;
  maxInventoryUsd: bigint;
  maxSkewBps: number;
  minQuoteWidthBps: number;
  hedgeRatioMinBps: number;
  hedgeRatioMaxBps: number;
  deskKey: LocalAccount;
  takerFeeBps: number;
}

function buildCharter(s: LaunchSpec) {
  const allow = hedgeAllowTree(s.hedgeTokens.map((t) => ({ asset: tokenUnderlying(t), venue: HEDGE_VENUES.UNIV3 })));
  return {
    underlying: s.underlying,
    venue: s.venue,
    oracle: 1, // attested multi-source oracle (builder oracle)
    sessions: encodeSessions(SESSIONS_24X5),
    ifTargetUsd: s.ifUsd,
    mmInventoryUsd: s.mmUsd,
    mandate: {
      maxInventoryUsd: s.maxInventoryUsd,
      maxSkewBps: s.maxSkewBps,
      minQuoteWidthBps: s.minQuoteWidthBps,
      maxHedgeLeverage: 100, // spot legs only (1.00x)
      hedgeRatioMinBps: s.hedgeRatioMinBps,
      hedgeRatioMaxBps: s.hedgeRatioMaxBps,
      noNewRiskOffHours: true,
      killAtDrawdownBps: -800,
      hedgeAllowRoot: allow.root,
    },
    seniorHurdleBps: 6000,
    seniorCapBps: 7000,
    subscriptionWindow: WINDOW,
    juniorNoticeSeconds: JUNIOR_NOTICE,
    sponsor: acct.sponsor.address,
    perWalletCapUsd: usd(250_000),
    symbol: strToBytes32(s.symbol),
    takerFeeBps: s.takerFeeBps,
    makerFeeBps: 0,
  };
}

/** Public chains only: the deployer tops every role/participant key up to a minimum gas balance (ETH). */
async function fundGas() {
  if (!PUBLIC_CHAIN) return;
  const scale = Number(process.env.LAUNCH_GAS_SCALE ?? 1);
  const need = (eth: string) => (parseEther(eth) * BigInt(Math.round(scale * 1000))) / 1000n;
  // At RHC testnet's ~0.01 gwei a 300k-gas oracle push costs ~3e-6 ETH: these cover days of operation.
  const plan: Array<[DevRole, bigint]> = [
    ["oracleSigner", need("0.008")], ["opsVenue", need("0.003")], ["markSigner", need("0.002")], ["keeper", need("0.002")],
    ["risk", need("0.0015")], ["jury", need("0.001")], ["sponsor", need("0.002")], ["committee0", need("0.0008")],
    ["committee1", need("0.0008")], ["committee2", need("0.0008")], ["agentOperator", need("0.0008")],
    ["deskKeyNvda", need("0.0015")], ["deskKeyTsla", need("0.0015")], ["deskKeyIndex", need("0.003")],
    ["allocator0", need("0.0008")], ["allocator1", need("0.0008")], ["allocator2", need("0.0008")],
    ["trader0", need("0.0015")], ["trader1", need("0.0015")], ["trader2", need("0.0015")], ["trader3", need("0.0015")],
  ];

  const deployer = acct.deployer;
  const wallet = createWalletClient({ chain, transport: http(RPC), account: deployer });
  const gaps: Array<[Address, bigint, string]> = [];
  for (const [role, min] of plan) {
    const a = devAccount(role).address;
    const bal = await pub.getBalance({ address: a });
    if (bal < min) gaps.push([a, min - bal, role]);
  }
  if (USER_WALLET) {
    const bal = await pub.getBalance({ address: USER_WALLET });
    if (bal < need("0.005")) gaps.push([USER_WALLET, need("0.005") - bal, "user wallet"]);
  }
  const total = gaps.reduce((t, [, v]) => t + v, 0n);
  const have = await pub.getBalance({ address: deployer.address });
  log(`gas: deployer ${deployer.address} holds ${formatEther(have)} ETH; topping up ${gaps.length} keys (${formatEther(total)} ETH)`);
  const reserve = parseEther("0.003");
  if (have < total + reserve) {
    // auto-scale to the available balance (faucet drips vary); refuse below 20% of the plan
    const avail = have > reserve ? have - reserve : 0n;
    const k = total === 0n ? 0n : (avail * 1000n) / total;
    if (k < 200n) {
      throw new Error(`deployer needs ~${formatEther(total + reserve)} ETH (has ${formatEther(have)}) — fund it from https://faucet.testnet.chain.robinhood.com`);
    }
    for (const g of gaps) g[1] = (g[1] * k) / 1000n;
    log(`gas: scaling top-ups to ${Number(k) / 10}% of plan to fit the deployer balance (re-run later to complete)`);
  }
  for (const [to, value, role] of gaps) {
    const hash = await wallet.sendTransaction({ to, value });
    await pub.waitForTransactionReceipt({ hash });
    log(`  ${role.padEnd(14)} ${to} +${formatEther(value)} ETH`);
  }
}

async function fundParticipants(d: Deployment) {
  const c = d.contracts;
  // Idempotent: a partially completed launch can be re-run (only missing balances/stakes/bonds are added).
  const balOf = (token: Address, who: Address) => read<bigint>(token, mockERC20Abi as Abi, "balanceOf", [who]);
  // USDC (devnet mock: open mint)
  const mints: Array<[LocalAccount, number]> = [
    [acct.sponsor, 2_000_000],
    [acct.a0, 500_000],
    [acct.a1, 500_000],
    [acct.a2, 500_000],
    [acct.t0, 100_000],
    [acct.t1, 100_000],
    [acct.t2, 100_000],
    [acct.t3, 100_000],
  ];
  for (const [who, amount] of mints) {
    if ((await balOf(c.usdc, who.address)) < usd(amount)) await send(acct.deployer, c.usdc, mockERC20Abi as Abi, "mint", [who.address, usd(amount)]);
  }
  // BKRN from the deployer's allocations to committee members and the agent operator
  const bk = 10n ** 18n;
  const stakedOf = (who: Address) => read<bigint>(c.staking, bkrnStakingAbi as Abi, "stakedOf", [who]);
  for (const who of [acct.c0, acct.c1, acct.c2, acct.operator]) {
    const have = (await balOf(c.bkrn, who.address)) + (await stakedOf(who.address));
    if (have < 300_000n * bk) await send(acct.deployer, c.bkrn, bkrnTokenAbi as Abi, "transfer", [who.address, 300_000n * bk - have]);
  }

  // staking: sponsor bonds (3 charters), committee bonds, operator tier bonds (3 desk keys)
  const stakeAll = async (who: LocalAccount, amount: bigint) => {
    const missing = amount - (await stakedOf(who.address));
    if (missing <= 0n) return;
    await send(who, c.bkrn, bkrnTokenAbi as Abi, "approve", [c.staking, missing]);
    await send(who, c.staking, bkrnStakingAbi as Abi, "stake", [missing]);
  };
  await stakeAll(acct.sponsor, 1_000_000n * bk);
  for (const who of [acct.c0, acct.c1, acct.c2]) {
    await stakeAll(who, 300_000n * bk);
    if (!(await read<boolean>(c.committee, riskCommitteeAbi as Abi, "isBonded", [who.address]))) await send(who, c.committee, riskCommitteeAbi as Abi, "bond");
  }
  await stakeAll(acct.operator, 300_000n * bk);
  if (USER_WALLET) {
    if ((await balOf(c.usdc, USER_WALLET)) < usd(1_000_000)) await send(acct.deployer, c.usdc, mockERC20Abi as Abi, "mint", [USER_WALLET, usd(1_000_000)]);
    if ((await balOf(c.bkrn, USER_WALLET)) < 1_000_000n * bk) await send(acct.deployer, c.bkrn, bkrnTokenAbi as Abi, "transfer", [USER_WALLET, 1_000_000n * bk]);
    log(`user wallet ${USER_WALLET}: +1,000,000 test USDC, +1,000,000 BKRN`);
  }
  log("participants funded, staked and committee bonded");
}

async function waitJury(committee: Address, id: bigint): Promise<void> {
  const deadline = Date.now() + JURY_WAIT_MS;
  while (Date.now() < deadline) {
    const [, , posted] = await read<[Hex, boolean, boolean]>(committee, riskCommitteeAbi as Abi, "juryVerdict", [id]);
    if (posted) return;
    await sleep(2000);
  }
  // Fallback: the charter service is not running. Post a launch verdict so the devnet can proceed.
  const verdict = { charterId: Number(id), source: "launch-fallback", recommendApprove: true, note: "studio launch book; charter service offline" };
  const digest = keccak256(stringToHex(JSON.stringify(verdict)));
  log(`charter ${id}: no jury verdict after ${JURY_WAIT_MS / 1000}s — posting launch fallback verdict (start the charter service for the model jury)`);
  await send(acct.jury, committee, riskCommitteeAbi as Abi, "postJuryVerdict", [id, digest, true]);
}

async function launchBook(d: Deployment, s: LaunchSpec) {
  const c = d.contracts;
  const charter = buildCharter(s);
  const fee = await read<bigint>(c.config, [{ type: "function", name: "charterFeeUsd", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }], "charterFeeUsd");
  await send(acct.sponsor, c.usdc, mockERC20Abi as Abi, "approve", [c.charter, fee]);
  const filed = await send(acct.sponsor, c.charter, marketCharterAbi as Abi, "file", [charter]);
  const ev = parseEventLogs({ abi: marketCharterAbi as Abi, logs: filed.logs, eventName: "CharterFiled" })[0] as unknown as { args: { id: bigint } };
  const id = ev.args.id;
  log(`${s.name}: charter ${id} filed (fee ${Number(fee) / 1e6} USDC, bond locked)`);

  await waitJury(c.committee, id);
  await send(acct.c0, c.committee, riskCommitteeAbi as Abi, "vote", [id, true]);
  await send(acct.c1, c.committee, riskCommitteeAbi as Abi, "vote", [id, true]);
  const comps = await read<BookComponents>(c.factory, bookFactoryAbi as Abi, "componentsOf", [id]);
  if (!comps.book || /^0x0+$/.test(comps.book)) throw new Error(`${s.name}: book not created after committee approval`);
  log(`${s.name}: approved 2-of-3 -> book ${comps.book}`);

  // subscriptions (senior oversubscribed to show pro-rata; sponsor ~29% of Junior commitments)
  const commit = async (who: LocalAccount, tranche: Address, amount: number) => {
    await send(who, c.usdc, mockERC20Abi as Abi, "approve", [tranche, usd(amount)]);
    await send(who, tranche, trancheAbi as Abi, "deposit", [usd(amount), who.address]);
  };
  const raise = Number((s.ifUsd + s.mmUsd) / 1_000_000n);
  await commit(acct.sponsor, comps.junior, Math.round(raise * 0.12));
  await commit(acct.a2, comps.junior, Math.round(raise * 0.3));
  await commit(acct.a0, comps.senior, Math.round(raise * 0.5));
  await commit(acct.a1, comps.senior, Math.round(raise * 0.4));
  log(`${s.name}: subscriptions committed (raise ${raise.toLocaleString()} USDC)`);

  // desk session key: operator consents to bond its stake, sponsor registers (tier >= maxInventory)
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400);
  await send(acct.operator, comps.mandate, mMMandateAbi as Abi, "consentKey", [s.deskKey.address, true]);
  await send(acct.sponsor, comps.mandate, mMMandateAbi as Abi, "registerKey", [s.deskKey.address, acct.operator.address, validUntil, s.maxInventoryUsd]);
  log(`${s.name}: desk key ${s.deskKey.address} registered`);
  return { bookId: Number(id), name: s.name, symbol: s.symbol, venue: s.venue, components: comps };
}

async function closeWindows(books: Array<{ name: string; components: BookComponents }>) {
  const ends = await Promise.all(books.map((b) => read<bigint>(b.components.book, bookAbi as Abi, "subscriptionEnds")));
  const last = Number(ends.reduce((m, e) => (e > m ? e : m), 0n)) * 1000;
  const waitMs = Math.max(0, last - Date.now()) + CLOSE_GRACE_MS;
  log(`waiting ${Math.round(waitMs / 1000)}s for subscription windows to close (keeper service closes them; fallback here)`);
  await sleep(waitMs);
  for (const b of books) {
    const state = await read<number>(b.components.book, bookAbi as Abi, "state");
    if (state === 0) {
      await send(acct.keeper, b.components.book, bookAbi as Abi, "closeWindow");
    }
    const after = await read<number>(b.components.book, bookAbi as Abi, "state");
    log(`${b.name}: state ${["Subscription", "Cancelled", "Live", "Retiring", "Retired"][after]}`);
  }
}

async function main() {
  const d = loadDeployment();
  if (d.books.length > 0) {
    log(`already launched (${d.books.map((b) => b.name).join(", ")}) — nothing to do`);
    return;
  }
  const count = await read<bigint>(d.contracts.charter, marketCharterAbi as Abi, "count");
  if (count > 0n) throw new Error(`MarketCharter already has ${count} charters but the deployment lists no books — redeploy (bun run deploy:local)`);

  const t = (sym: string) => {
    const e = d.stockTokens[sym];
    if (!e) throw new Error(`stock token ${sym} missing from deployment`);
    return e.token;
  };
  const specs: LaunchSpec[] = [
    {
      name: "NVDA", symbol: "PERP_NVDA_USDC", venue: 0, underlying: tokenUnderlying(t("NVDA")), hedgeTokens: [t("NVDA")],
      ifUsd: usd(30_000), mmUsd: usd(75_000), maxInventoryUsd: usd(50_000), maxSkewBps: 25, minQuoteWidthBps: 8,
      hedgeRatioMinBps: 5000, hedgeRatioMaxBps: 12000, deskKey: devAccount("deskKeyNvda"), takerFeeBps: 0,
    },
    {
      name: "TSLA", symbol: "PERP_TSLA_USDC", venue: 0, underlying: tokenUnderlying(t("TSLA")), hedgeTokens: [t("TSLA")],
      ifUsd: usd(30_000), mmUsd: usd(75_000), maxInventoryUsd: usd(50_000), maxSkewBps: 30, minQuoteWidthBps: 12,
      hedgeRatioMinBps: 5000, hedgeRatioMaxBps: 12000, deskKey: devAccount("deskKeyTsla"), takerFeeBps: 0,
    },
    {
      name: "RHX5", symbol: "RHX5-PERP", venue: 1, underlying: indexUnderlying("RHX5"),
      hedgeTokens: ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"].map(t),
      ifUsd: usd(30_000), mmUsd: usd(100_000), maxInventoryUsd: usd(75_000), maxSkewBps: 25, minQuoteWidthBps: 10,
      hedgeRatioMinBps: 4000, hedgeRatioMaxBps: 12000, deskKey: devAccount("deskKeyIndex"), takerFeeBps: 6,
    },
  ];

  log(`network: chain ${CHAIN_ID} via ${RPC}`);
  await fundGas();
  await fundParticipants(d);
  const books = [];
  for (const s of specs) books.push(await launchBook(d, s));
  await closeWindows(books);

  const path = deploymentPath();
  const fresh = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  fresh.books = books;
  writeFileSync(path, `${JSON.stringify(fresh, null, 2)}\n`);
  log(`launched ${books.length} books -> ${path}`);
}

main().catch((err) => {
  console.error("[launch] failed:", err);
  process.exit(1);
});
