// Lane C1 — launch the three studio-sponsored books on devnet (ARCHITECTURE §7):
//   NVDA (Orderly mock), TSLA (Orderly mock), RHX5 Stock-Token index (in-house PoolEngine).
// Flow per book: sponsor files charter (fee + bond) -> model jury verdict (charter service; fallback
// posts a launch verdict if the service is not running) -> committee 2-of-3 -> BookFactory.create ->
// subscriptions (sponsor >= 10% Junior + allocators) -> desk session keys (operator consent + sponsor
// registerKey) -> window close (keeper service, fallback here) -> books appended to the deployment file.
//   bun scripts/launch-devnet.ts            (idempotent: exits if books already launched)
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
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
import { localChain } from "../packages/shared/src/chains";
import { devAccount } from "../packages/shared/src/devkeys";
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

const chain = { ...localChain, rpcUrls: { default: { http: [RPC] } } };
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

async function fundParticipants(d: Deployment) {
  const c = d.contracts;
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
  for (const [who, amount] of mints) await send(acct.deployer, c.usdc, mockERC20Abi as Abi, "mint", [who.address, usd(amount)]);
  // BKRN from the deployer's allocations to committee members and the agent operator
  const bk = 10n ** 18n;
  for (const who of [acct.c0, acct.c1, acct.c2]) await send(acct.deployer, c.bkrn, bkrnTokenAbi as Abi, "transfer", [who.address, 300_000n * bk]);
  await send(acct.deployer, c.bkrn, bkrnTokenAbi as Abi, "transfer", [acct.operator.address, 300_000n * bk]);

  // staking: sponsor bonds (3 charters), committee bonds, operator tier bonds (3 desk keys)
  const stakeAll = async (who: LocalAccount, amount: bigint) => {
    await send(who, c.bkrn, bkrnTokenAbi as Abi, "approve", [c.staking, amount]);
    await send(who, c.staking, bkrnStakingAbi as Abi, "stake", [amount]);
  };
  await stakeAll(acct.sponsor, 1_000_000n * bk);
  for (const who of [acct.c0, acct.c1, acct.c2]) {
    await stakeAll(who, 300_000n * bk);
    await send(who, c.committee, riskCommitteeAbi as Abi, "bond");
  }
  await stakeAll(acct.operator, 300_000n * bk);
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
