// Lane C1 — launch the three studio-sponsored books on devnet or Robinhood Chain testnet (ARCHITECTURE §7):
//   NVDA (Orderly mock), TSLA (Orderly mock), RHX5 Stock-Token index (in-house PoolEngine).
// Flow per book: sponsor files charter (fee + bond) -> model jury verdict (charter service; fallback
// posts a launch verdict if the service is not running) -> committee 2-of-3 -> BookFactory.create ->
// subscriptions (sponsor >= 10% Junior + allocators) -> desk session keys (operator consent + sponsor
// registerKey) -> window close (keeper service, fallback here) -> books appended to the deployment file.
//   bun scripts/launch-devnet.ts            (idempotent: exits if books already launched; a launch that stopped part way
//                                            resumes: launch.launched in the record, the book in progress from its charter)
// Testnet (CHAIN_ID=46630): keys derive from BKRN_TESTNET_MNEMONIC; the deployer first distributes gas ETH
// to every role/participant key, and LAUNCH_USER_WALLET (if set) receives test USDC + BKRN + a little gas.
// The deployer is a protocol-admin key: on testnet it derives from the mnemonic only with
// BKRN_ALLOW_ADMIN_KEY=1 (scripts/dev.ts sets it for this one-shot process; set it yourself when running
// this by hand) or from DEPLOYER_PRIVATE_KEY.
// Live venue (deployment record orderly.venue = "live": Deploy.s.sol DEPLOY_ORDERLY_VAULT / DEPLOY_SETTLEMENT_TOKEN, the
// real Orderly testnet vault + real testnet USDG): only NVDA and TSLA by default, at rehearsal sizes, and the deployer
// TRANSFERS the settlement token to the sponsor / allocators (no mint; refused up front if it holds too little); no
// trader or user-wallet funding. Sizes / books: scripts/launch-plan.ts (LAUNCH_BOOKS, LAUNCH_IF_USD, LAUNCH_MM_USD, ...).
// Insurance pool (2026-10, deployment record contracts.insurancePool): the books are chartered with ifFromPool on (the
// pool funds each IF at closeWindow, the window raises only the MM inventory; LAUNCH_IF_FROM_POOL=0 turns it off); the
// deployer (config.timelock() on devnet / testnet) sets demo pool parameters (1-day epochs, 1 h cooldown and grace;
// LAUNCH_POOL_PARAMS=0 keeps the defaults), the treasury (deployer) seeds the first-loss slice large enough to fund every
// IF at window close (queued deposits count only once their epoch is processed), and on the mock venue two test
// allocators queue deposits for the first epoch.
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
  insurancePoolAbi,
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
import { type BookComponents, type Deployment, liveVenueDeployment } from "../packages/shared/src/types";
import { usd } from "../packages/shared/src/units";
import { ensureDeskKeys } from "./desk-keys";
import {
  type BookProgress,
  type BookSize,
  type Commit,
  POOL_DEMO_PARAMS,
  POOL_TEST_DEPOSITS,
  type Participant,
  commitPlan,
  launchBooks,
  launchSizes,
  poolSeedUsd,
  raiseOf,
  settlementNeeds,
  testDepositTiming,
  transferPlan,
} from "./launch-plan";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const WINDOW = Number(process.env.LAUNCH_WINDOW_SECONDS ?? 120);
// at least one on-chain mark interval: MarketCharter.validate rejects a shorter notice (audit M-1)
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
  /** 2026-10: the InsurancePool funds the IF (window raises only the MM inventory) */
  ifFromPool: boolean;
}

/** Whole USD the window raises for a spec (scripts/launch-plan.ts raiseOf). */
const raiseFor = (s: LaunchSpec) => raiseOf({ ifUsd: Number(s.ifUsd / 1_000_000n), mmUsd: Number(s.mmUsd / 1_000_000n), ifFromPool: s.ifFromPool });

function buildCharter(s: LaunchSpec, markInterval: bigint) {
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
    juniorNoticeSeconds: JUNIOR_NOTICE > markInterval ? JUNIOR_NOTICE : markInterval,
    sponsor: acct.sponsor.address,
    perWalletCapUsd: usd(250_000),
    symbol: strToBytes32(s.symbol),
    takerFeeBps: s.takerFeeBps,
    makerFeeBps: 0,
    ifFromPool: s.ifFromPool,
    premiumBps: 0, // the pool's floor (12%), fixed into the charter at filing
    ifPoolFallback: false, // a pool that cannot fund the IF cancels the window (fix round 2 V-3)
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

const configUint = (c: Deployment["contracts"], name: string, args: readonly unknown[] = [], inputs: Array<{ name: string; type: string }> = []) =>
  read<bigint>(c.config, [{ type: "function", name, inputs, outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }], name, args);

/** Live venue: the settlement token is real (no mint): the deployer transfers each participant's need, all or nothing. */
/** Resume: what a previous run already did for each book still to launch (charter filed = fee paid; commits made). */
async function launchProgress(d: Deployment, specs: LaunchSpec[]): Promise<Record<string, BookProgress>> {
  const c = d.contracts;
  const out: Record<string, BookProgress> = {};
  const who: Record<Commit["who"], LocalAccount> = { sponsor: acct.sponsor, a0: acct.a0, a1: acct.a1, a2: acct.a2 };
  for (const s of specs) {
    const prior = await existingCharter(c, s);
    if (!prior) continue;
    const done = new Set<Commit["who"]>();
    const comps = await read<BookComponents>(c.factory, bookFactoryAbi as Abi, "componentsOf", [prior.id]);
    if (comps.book && !BYTES32_ZERO.test(comps.book)) {
      const open = (await read<number>(comps.book, bookAbi as Abi, "state")) === 0;
      for (const k of commitPlan(raiseFor(s))) {
        const tranche = k.tranche === "junior" ? comps.junior : comps.senior;
        // a closed window takes no commitment any more; an open one skips the commits already made (launchBook)
        if (!open || (await read<bigint>(tranche, trancheAbi as Abi, "balanceOf", [who[k.who].address])) > 0n) done.add(k.who);
      }
    }
    out[s.name] = { feePaid: true, done };
  }
  return out;
}

async function fundSettlementLive(d: Deployment, sizes: BookSize[], progress: Record<string, BookProgress>) {
  const c = d.contracts;
  const balOf = (who: Address) => read<bigint>(c.usdc, mockERC20Abi as Abi, "balanceOf", [who]);
  const fee = Number(await configUint(c, "charterFeeUsd")) / 1e6;
  const needs = settlementNeeds(sizes, fee, progress);
  const who: Record<Participant, LocalAccount> = { sponsor: acct.sponsor, a0: acct.a0, a1: acct.a1, a2: acct.a2 };
  const parts = Object.keys(who) as Participant[];
  const balances = Object.fromEntries(await Promise.all(parts.map(async (p) => [p, await balOf(who[p].address)] as const))) as Record<Participant, bigint>;
  const { transfers, total } = transferPlan(needs, balances);
  const have = await balOf(acct.deployer.address);
  log(`live venue: settlement token ${c.usdc} (not mintable); needs ${JSON.stringify(needs)} USD (incl. charter fee ${fee} per book); deployer holds ${Number(have) / 1e6}, transfers ${Number(total) / 1e6}`);
  if (have < total) {
    throw new Error(
      `deployer ${acct.deployer.address} holds ${Number(have) / 1e6} of the settlement token, the launch needs ${Number(total) / 1e6}: fund it first (testnet USDG source: docs/VERIFY.md O17) or lower LAUNCH_IF_USD / LAUNCH_MM_USD / DEPLOY_CHARTER_FEE_USD`,
    );
  }
  for (const [p, amount] of transfers) await send(acct.deployer, c.usdc, mockERC20Abi as Abi, "transfer", [who[p].address, amount]);
}

async function fundParticipants(d: Deployment, sizes: BookSize[], progress: Record<string, BookProgress> = {}) {
  const c = d.contracts;
  // Idempotent: a partially completed launch can be re-run (only missing balances/stakes/bonds are added).
  const balOf = (token: Address, who: Address) => read<bigint>(token, mockERC20Abi as Abi, "balanceOf", [who]);
  if (liveVenueDeployment(d)) {
    await fundSettlementLive(d, sizes, progress);
  } else {
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
  if (USER_WALLET && liveVenueDeployment(d)) {
    log(`user wallet ${USER_WALLET}: no settlement token on the live venue (real USDG cannot be minted)`);
  } else if (USER_WALLET) {
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

const BYTES32_ZERO = /^0x0+$/;

/**
 * Resume: the latest charter of this spec (same symbol, our sponsor) still Filed or Approved, when a previous launch
 * stopped part way through this book; null when there is none (file a new one).
 */
async function existingCharter(c: Deployment["contracts"], s: LaunchSpec): Promise<{ id: bigint; status: number } | null> {
  const count = await read<bigint>(c.charter, marketCharterAbi as Abi, "count");
  const sym = strToBytes32(s.symbol).toLowerCase();
  for (let id = count; id >= 1n; id--) {
    const r = await read<{ charter: { symbol: Hex; sponsor: Address }; status: number }>(c.charter, marketCharterAbi as Abi, "get", [id]);
    if (r.charter.symbol.toLowerCase() === sym && r.charter.sponsor.toLowerCase() === acct.sponsor.address.toLowerCase() && (r.status === 1 || r.status === 2)) {
      return { id, status: r.status };
    }
  }
  return null;
}

/** One book, idempotent per step (a re-run after a failure continues where it stopped, never pays a second charter fee). */
async function launchBook(d: Deployment, s: LaunchSpec) {
  const c = d.contracts;
  const prior = await existingCharter(c, s);
  let id: bigint;
  if (prior) {
    id = prior.id;
    log(`${s.name}: resuming charter ${id} (${prior.status === 2 ? "approved" : "filed"})`);
  } else {
    // audit M-1: the Junior notice is at least one on-chain mark interval
    const markInterval = await read<number>(c.config, [{ type: "function", name: "markInterval", inputs: [], outputs: [{ type: "uint32" }], stateMutability: "view" }], "markInterval");
    const charter = buildCharter(s, BigInt(markInterval));
    const fee = await configUint(c, "charterFeeUsd");
    await send(acct.sponsor, c.usdc, mockERC20Abi as Abi, "approve", [c.charter, fee]);
    const filed = await send(acct.sponsor, c.charter, marketCharterAbi as Abi, "file", [charter]);
    const ev = parseEventLogs({ abi: marketCharterAbi as Abi, logs: filed.logs, eventName: "CharterFiled" })[0] as unknown as { args: { id: bigint } };
    id = ev.args.id;
    log(`${s.name}: charter ${id} filed (fee ${Number(fee) / 1e6} USDC, bond locked)`);
  }

  let comps = await read<BookComponents>(c.factory, bookFactoryAbi as Abi, "componentsOf", [id]);
  if (!comps.book || BYTES32_ZERO.test(comps.book)) {
    await waitJury(c.committee, id);
    for (const m of [acct.c0, acct.c1]) {
      if (!(await read<boolean>(c.committee, riskCommitteeAbi as Abi, "hasVoted", [id, m.address]))) await send(m, c.committee, riskCommitteeAbi as Abi, "vote", [id, true]);
    }
    comps = await read<BookComponents>(c.factory, bookFactoryAbi as Abi, "componentsOf", [id]);
  }
  if (!comps.book || BYTES32_ZERO.test(comps.book)) throw new Error(`${s.name}: book not created after committee approval`);
  log(`${s.name}: approved 2-of-3 -> book ${comps.book}`);

  // subscriptions (scripts/launch-plan.ts commitPlan: the same amounts the up-front funding check used); a commit
  // already made (tranche shares held) is not repeated
  const raise = raiseFor(s);
  if ((await read<number>(comps.book, bookAbi as Abi, "state")) === 0) {
    const who: Record<Commit["who"], LocalAccount> = { sponsor: acct.sponsor, a0: acct.a0, a1: acct.a1, a2: acct.a2 };
    for (const k of commitPlan(raise)) {
      const tranche = k.tranche === "junior" ? comps.junior : comps.senior;
      if ((await read<bigint>(tranche, trancheAbi as Abi, "balanceOf", [who[k.who].address])) > 0n) continue;
      await send(who[k.who], c.usdc, mockERC20Abi as Abi, "approve", [tranche, usd(k.usd)]);
      await send(who[k.who], tranche, trancheAbi as Abi, "deposit", [usd(k.usd), who[k.who].address]);
    }
    log(`${s.name}: subscriptions committed (raise ${raise.toLocaleString()} USDC)`);
  } else {
    log(`${s.name}: subscription window already closed — commitments left as they are`);
  }

  // desk session key: operator consents to bond its stake, sponsor registers (tier >= maxInventory)
  if (!(await read<boolean>(comps.mandate, mMMandateAbi as Abi, "isActiveKey", [s.deskKey.address]))) {
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400);
    await send(acct.operator, comps.mandate, mMMandateAbi as Abi, "consentKey", [s.deskKey.address, true]);
    await send(acct.sponsor, comps.mandate, mMMandateAbi as Abi, "registerKey", [s.deskKey.address, acct.operator.address, validUntil, s.maxInventoryUsd]);
  }
  log(`${s.name}: desk key ${s.deskKey.address} registered`);
  return { bookId: Number(id), name: s.name, symbol: s.symbol, venue: s.venue, components: comps };
}

// ---------------------------------------------------------------- insurance pool (2026-10)
/** InsurancePool PARAM_* keys: bytes32 short strings ("epochLength"). */
const POOL_PARAM = (name: string) => strToBytes32(name);

/**
 * Demo parameters (deployer = config.timelock() on devnet / testnet), then the treasury's first-loss slice: topped up
 * to poolSeedUsd(sizes) so every pool-funded IF can be allocated at window close (idempotent).
 */
async function setupPool(d: Deployment, sizes: BookSize[], live: boolean) {
  const pool = d.contracts.insurancePool as Address;
  const c = d.contracts;
  const timelock = await read<Address>(c.config, [{ type: "function", name: "timelock", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }], "timelock");
  if (process.env.LAUNCH_POOL_PARAMS !== "0" && timelock.toLowerCase() === acct.deployer.address.toLowerCase()) {
    const p = await read<readonly [number, number, number, number, number, number, number, number]>(pool, insurancePoolAbi as Abi, "params");
    const want: Array<[string, number, number]> = [
      ["cooldown", Number(p[4]), POOL_DEMO_PARAMS.cooldown],
      ["processGrace", Number(p[6]), POOL_DEMO_PARAMS.processGrace],
      // applied once the queue is idle (it is at launch): never moves a queued request
      ["epochLength", Number(p[7]) || Number(p[5]), POOL_DEMO_PARAMS.epochLength],
    ];
    for (const [key, have, value] of want) {
      if (have === value) continue;
      await send(acct.deployer, pool, insurancePoolAbi as Abi, "setParam", [POOL_PARAM(key), BigInt(value)]);
      log(`pool: ${key} ${have}s -> ${value}s`);
    }
  }
  const seed = usd(poolSeedUsd(sizes));
  const have = await read<bigint>(pool, insurancePoolAbi as Abi, "firstLossAssets");
  if (seed === 0n || have >= seed) {
    log(`pool ${pool}: first-loss slice ${Number(have) / 1e6} (needs ${Number(seed) / 1e6})`);
    return;
  }
  const missing = seed - have;
  const bal = await read<bigint>(c.usdc, mockERC20Abi as Abi, "balanceOf", [acct.deployer.address]);
  if (bal < missing) {
    if (live) throw new Error(`treasury (deployer ${acct.deployer.address}) holds ${Number(bal) / 1e6} of the settlement token, the pool's first-loss slice needs ${Number(missing) / 1e6} more`);
    await send(acct.deployer, c.usdc, mockERC20Abi as Abi, "mint", [acct.deployer.address, missing - bal]);
  }
  await send(acct.deployer, c.usdc, mockERC20Abi as Abi, "approve", [pool, missing]);
  await send(acct.deployer, pool, insurancePoolAbi as Abi, "depositFirstLoss", [missing]);
  log(`pool ${pool}: treasury seeded the first-loss slice +${Number(missing) / 1e6} (now ${Number(seed) / 1e6}: funds every IF at window close)`);
}

/** Mock venue: test allocators queue deposits for the open epoch (once per allocator; idempotent). */
async function poolTestDeposits(d: Deployment) {
  const pool = d.contracts.insurancePool as Address;
  const who = { a0: acct.a0, a1: acct.a1 } as const;
  // review I-4: never queue the demo deposits into the weekly first epoch (testDepositTiming)
  const [p, q, ledger, block] = await Promise.all([
    read<readonly [number, number, number, number, number, number, number, number]>(pool, insurancePoolAbi as Abi, "params"),
    read<readonly [bigint, bigint, bigint, bigint, bigint]>(pool, insurancePoolAbi as Abi, "queue"),
    read<readonly [bigint, bigint, bigint, bigint, bigint]>(pool, insurancePoolAbi as Abi, "ledger"),
    pub.getBlock(),
  ]);
  const timing = testDepositTiming({
    nowSec: Number(block.timestamp),
    epochLength: Number(p[5]),
    pendingEpochLength: Number(p[7]),
    procEndsAt: Number(q[1]),
    queueIdle: q[3] === 0n && ledger[2] === 0n,
    demoEpochLength: POOL_DEMO_PARAMS.epochLength,
  });
  if (!timing.deposit) {
    log(
      `pool: test deposits deferred until the first (weekly-grid) epoch ends at ${new Date(timing.after * 1000).toISOString()}: the 1-day epoch applies from then; re-run bun scripts/launch-devnet.ts after it`,
    );
    return;
  }
  // the pool has no deposit counter view: walk depositInfo(1..) until an unused id (bounded; a launch makes two)
  const owners = new Set<string>();
  for (let i = 1n; i <= 1_000n; i++) {
    const info = await read<{ owner: Address }>(pool, insurancePoolAbi as Abi, "depositInfo", [i]);
    if (/^0x0{40}$/i.test(info.owner)) break;
    owners.add(info.owner.toLowerCase());
  }
  for (const dep of POOL_TEST_DEPOSITS) {
    const a = who[dep.who];
    if (owners.has(a.address.toLowerCase())) continue;
    await send(a, d.contracts.usdc, mockERC20Abi as Abi, "approve", [pool, usd(dep.usd)]);
    await send(a, pool, insurancePoolAbi as Abi, "requestDeposit", [usd(dep.usd)]);
    log(`pool: ${dep.who} queued ${dep.usd.toLocaleString()} for the open epoch (shares at its processing)`);
  }
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
  if (d.books.length > 0 && d.launch?.complete !== false) {
    log(`already launched (${d.books.map((b) => b.name).join(", ")}) — registering missing desk keys only`);
    // review I-4: the pool's test deposits were deferred until the 1-day epoch applies (idempotent)
    const pa = d.contracts.insurancePool;
    if (pa && !/^0x0{40}$/i.test(pa) && !liveVenueDeployment(d) && process.env.LAUNCH_IF_FROM_POOL !== "0") {
      await poolTestDeposits(d).catch((err) => log(`pool test deposits: FAILED (${err instanceof Error ? err.message : String(err)})`));
    }
    await ensureDeskKeys({ send: true, log: (m) => log(`desk keys: ${m}`) }).catch((err) => log(`desk keys: FAILED (${err instanceof Error ? err.message : String(err)}); run bun scripts/desk-keys.ts --send`));
    return;
  }
  // resume: books a previous run already chartered (launch.launched) are kept; a book it stopped in the middle of is
  // picked up from its charter (launchBook); the rest is launched now
  const launched = [...(d.launch?.launched ?? [])];

  const t = (sym: string) => {
    const e = d.stockTokens[sym];
    if (!e) throw new Error(`stock token ${sym} missing from deployment`);
    return e.token;
  };
  // sizes and books: scripts/launch-plan.ts (demo sizes on the mock venue, rehearsal sizes in real USDG on the live venue)
  const live = liveVenueDeployment(d);
  const minIfOf = async (venue: 0 | 1) => Number(await configUint(d.contracts, "venueMinIfUsd", [venue], [{ name: "venue", type: "uint8" }])) / 1e6;
  const minIf = { 0: await minIfOf(0), 1: await minIfOf(1) };
  // 2026-10: books are chartered with a pool-funded IF when the deployment has an InsurancePool
  const poolAddr = d.contracts.insurancePool;
  const ifFromPool = !!poolAddr && !/^0x0{40}$/i.test(poolAddr) && process.env.LAUNCH_IF_FROM_POOL !== "0";
  const sizes = launchSizes(live, launchBooks(live), (v) => minIf[v]).map((z) => ({ ...z, ifFromPool }));
  const sized = (s: Omit<LaunchSpec, "ifUsd" | "mmUsd" | "maxInventoryUsd" | "ifFromPool">): LaunchSpec | null => {
    const z = sizes.find((x) => x.name === s.name);
    return z ? { ...s, ifUsd: usd(z.ifUsd), mmUsd: usd(z.mmUsd), maxInventoryUsd: usd(z.maxInventoryUsd), ifFromPool } : null;
  };
  // audit M-3: maxSkewBps <= minQuoteWidthBps / 2 (MarketCharter.validate)
  const specs: LaunchSpec[] = [
    sized({
      name: "NVDA", symbol: "PERP_NVDA_USDC", venue: 0, underlying: tokenUnderlying(t("NVDA")), hedgeTokens: [t("NVDA")],
      maxSkewBps: 4, minQuoteWidthBps: 8, hedgeRatioMinBps: 5000, hedgeRatioMaxBps: 12000, deskKey: devAccount("deskKeyNvda"), takerFeeBps: 0,
    }),
    sized({
      name: "TSLA", symbol: "PERP_TSLA_USDC", venue: 0, underlying: tokenUnderlying(t("TSLA")), hedgeTokens: [t("TSLA")],
      maxSkewBps: 6, minQuoteWidthBps: 12, hedgeRatioMinBps: 5000, hedgeRatioMaxBps: 12000, deskKey: devAccount("deskKeyTsla"), takerFeeBps: 0,
    }),
    sized({
      name: "RHX5", symbol: "RHX5-PERP", venue: 1, underlying: indexUnderlying("RHX5"),
      hedgeTokens: ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"].map(t),
      maxSkewBps: 5, minQuoteWidthBps: 10, hedgeRatioMinBps: 4000, hedgeRatioMaxBps: 12000, deskKey: devAccount("deskKeyIndex"), takerFeeBps: 6,
    }),
  ].filter((s): s is LaunchSpec => s !== null);

  log(`network: chain ${CHAIN_ID} via ${RPC}; ${live ? "LIVE Orderly venue (real settlement token)" : "mock venue"}; books ${sizes.map((s) => `${s.name} (IF ${s.ifUsd}, MM ${s.mmUsd})`).join(", ")}`);
  const todo = specs.filter((s) => !launched.some((b) => b.name === s.name));
  if (launched.length) log(`resuming: already chartered ${launched.map((b) => b.name).join(", ")}; to do ${todo.map((s) => s.name).join(", ") || "none"}`);
  await fundGas();
  // a book a previous run left half done is funded only for what is still missing (never twice)
  await fundParticipants(d, sizes.filter((z) => todo.some((s) => s.name === z.name)), await launchProgress(d, todo));
  // the pool must be able to fund every pool-funded IF at window close (all launch books, resumed ones included)
  if (ifFromPool) await setupPool(d, sizes, live);
  const path = deploymentPath();
  const saveProgress = (complete: boolean) => {
    const fresh = JSON.parse(readFileSync(path, "utf8")) as Deployment;
    if (complete) {
      fresh.books = launched;
      fresh.launch = { complete: true };
    } else {
      fresh.launch = { complete: false, launched };
    }
    writeFileSync(path, `${JSON.stringify(fresh, null, 2)}\n`);
  };
  saveProgress(false);
  for (const s of todo) {
    launched.push(await launchBook(d, s));
    saveProgress(false); // a failure after this point resumes with the next book
  }
  if (ifFromPool && !live) await poolTestDeposits(d);
  await closeWindows(launched);
  saveProgress(true);
  log(`launched ${launched.length} books -> ${path}`);
  // every book needs an active desk key to quote new risk (Task 7b): books chartered outside this launch included
  await ensureDeskKeys({ send: true, log: (m) => log(`desk keys: ${m}`) }).catch((err) => log(`desk keys: FAILED (${err instanceof Error ? err.message : String(err)}); run bun scripts/desk-keys.ts --send`));
}

main().catch((err) => {
  console.error("[launch] failed:", err);
  process.exit(1);
});
