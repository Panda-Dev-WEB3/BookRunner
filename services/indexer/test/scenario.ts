// A full charter -> book -> marks scenario as raw logs (used by unit + integration tests).
import { strToBytes32, tokenUnderlying } from "@bookrunner/shared";
import { bookAbi, bookFactoryAbi, mMMandateAbi, markRegistryAbi, marketCharterAbi, revenueRouterAbi, riskCommitteeAbi, trancheAbi } from "@bookrunner/shared/abi";
import { type Abi, type Address, encodeAbiParameters, keccak256, toHex } from "viem";
import { FakeChain, makeLog } from "./helpers";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

export const ADDR = {
  charter: a(0xc1),
  committee: a(0xc2),
  factory: a(0xc3),
  markRegistry: a(0xc4),
  book: a(0xb1),
  senior: a(0xb2),
  junior: a(0xb3),
  vault: a(0xb4),
  mandate: a(0xb5),
  router: a(0xb6),
  desk: a(0xb7),
  adapter: a(0xb8),
  sponsor: a(0x77),
  memberA: a(0x88),
  memberB: a(0x89),
  wallet: a(0x15),
  key: a(0x12),
  operator: a(0x11),
};

export const DEPLOYMENT = {
  chainId: 31337,
  startBlock: 1,
  contracts: { charter: ADDR.charter, committee: ADDR.committee, factory: ADDR.factory, markRegistry: ADDR.markRegistry } as never,
  stockTokens: {},
  books: [{ bookId: 1, name: "NVDA", symbol: "PERP_NVDA_USDC", venue: 0 as const, components: {} as never }],
};

export const COMPONENTS = {
  book: ADDR.book,
  senior: ADDR.senior,
  junior: ADDR.junior,
  vault: ADDR.vault,
  mandate: ADDR.mandate,
  router: ADDR.router,
  desk: ADDR.desk,
  adapter: ADDR.adapter,
};

const U = (n: number) => BigInt(n) * 1_000_000n;
export const DIGEST = keccak256(toHex("verdict-json")); // stands in for the sha2-256 digest
export const CHARTER_JSON = {
  underlying: tokenUnderlying(a(0xaa)),
  venue: 0,
  oracle: 1,
  sessions: `0x${"0".repeat(64)}`,
  ifTargetUsd: "25000000000",
  mmInventoryUsd: "75000000000",
  mandate: { maxInventoryUsd: "50000000000", maxSkewBps: 25, minQuoteWidthBps: 8, maxHedgeLeverage: 100, hedgeRatioMinBps: 5000, hedgeRatioMaxBps: 12000, noNewRiskOffHours: true, killAtDrawdownBps: -800, hedgeAllowRoot: `0x${"0".repeat(64)}` },
  seniorHurdleBps: 6000,
  seniorCapBps: 7000,
  subscriptionWindow: 600,
  juniorNoticeSeconds: "900",
  sponsor: ADDR.sponsor,
  perWalletCapUsd: "0",
  symbol: strToBytes32("PERP_NVDA_USDC"),
  takerFeeBps: 0,
  makerFeeBps: 0,
};

/** Builds the scenario; returns the fake chain with head at the last block. */
export function scenarioChain(): FakeChain {
  const ch = new FakeChain();
  ch.charters.set(1n, { charter: CHARTER_JSON, filedAt: 1_790_000_002, decidedAt: 0 });
  ch.bookCharters.set(ADDR.book, CHARTER_JSON);
  const L = (abi: Abi, address: Address, name: string, args: Record<string, unknown>, block: number, logIndex: number, tx: number) =>
    ch.logs.push(makeLog(abi, name, args, { address, block, logIndex, tx }));

  // block 1: filing
  L(marketCharterAbi, ADDR.charter, "CharterFiled", { id: 1n, sponsor: ADDR.sponsor, underlying: CHARTER_JSON.underlying, venue: 0, symbol: CHARTER_JSON.symbol, feeUsd: U(5000), bondBkrn: 10n ** 23n }, 1, 0, 1);
  // block 2: committee seats, jury verdict, two votes
  L(riskCommitteeAbi, ADDR.committee, "MemberSet", { index: 0, member: ADDR.memberA }, 2, 0, 2);
  L(riskCommitteeAbi, ADDR.committee, "MemberBonded", { member: ADDR.memberA, amount: 25n * 10n ** 22n }, 2, 1, 2);
  L(riskCommitteeAbi, ADDR.committee, "JuryVerdictPosted", { charterId: 1n, cid: DIGEST, recommendApprove: true }, 2, 2, 3);
  L(riskCommitteeAbi, ADDR.committee, "Voted", { charterId: 1n, member: ADDR.memberA, approve: true }, 2, 3, 4);
  // block 3: second vote finalizes: Decided + CharterDecided + BookCreated (same tx), then a commitment
  L(riskCommitteeAbi, ADDR.committee, "Voted", { charterId: 1n, member: ADDR.memberB, approve: true }, 3, 0, 5);
  L(riskCommitteeAbi, ADDR.committee, "Decided", { charterId: 1n, approved: true }, 3, 1, 5);
  L(bookFactoryAbi, ADDR.factory, "BookCreated", { bookId: 1n, book: ADDR.book, components: COMPONENTS }, 3, 2, 5);
  L(marketCharterAbi, ADDR.charter, "CharterDecided", { id: 1n, approved: true, juryCid: DIGEST, book: ADDR.book }, 3, 3, 5);
  L(trancheAbi, ADDR.senior, "Committed", { wallet: ADDR.wallet, receiver: ADDR.wallet, assets: U(70000), round: 0n }, 3, 4, 6);
  L(trancheAbi, ADDR.junior, "Committed", { wallet: ADDR.sponsor, receiver: ADDR.sponsor, assets: U(30000), round: 0n }, 3, 5, 7);
  // block 4: window closes; implementation-added ERC-20 Transfer on the senior tranche
  L(bookAbi, ADDR.book, "WindowClosed", { bookId: 1n, seniorAllocated: U(70000), juniorAllocated: U(30000), seniorCommitted: U(70000), juniorCommitted: U(30000) }, 4, 0, 8);
  ch.logs.push({
    ...makeLog(trancheAbi, "AllocationClaimed", { wallet: ADDR.wallet, shares: 0n, refund: 0n }, { address: ADDR.senior, block: 4, logIndex: 1, tx: 9 }),
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(64)}`,
      `0x${"0".repeat(24)}${ADDR.wallet.slice(2)}`,
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [U(70000)]),
  });
  L(trancheAbi, ADDR.senior, "AllocationClaimed", { wallet: ADDR.wallet, shares: U(70000), refund: 0n }, 4, 2, 9);
  // block 5: agent key + junior redemption request (notice 900s)
  L(mMMandateAbi, ADDR.mandate, "KeyRegistered", { key: ADDR.key, operator: ADDR.operator, validUntil: 1_800_000_000n, inventoryTierUsd: U(50000) }, 5, 0, 10);
  L(trancheAbi, ADDR.junior, "RedeemRequest", { controller: ADDR.sponsor, owner: ADDR.sponsor, requestId: 5_966_668n, sender: ADDR.sponsor, shares: U(1000) }, 5, 1, 11);
  // block 6: mark committed, then applied: bucket settles at 1.01
  L(markRegistryAbi, ADDR.markRegistry, "MarkCommitted", {
    markId: 1n, bookId: 1n, periodEnd: 1_790_000_100n, navUsd: U(101000), deployedValueUsd: U(100000),
    inventoryRoot: DIGEST, pnlJsonHash: DIGEST, receiptsRoot: DIGEST, signer: a(0x51),
  }, 6, 0, 12);
  L(trancheAbi, ADDR.junior, "BucketSettled", { requestId: 5_966_668n, shares: U(1000), assets: U(1010), priceWad: 101n * 10n ** 16n }, 6, 1, 13);
  L(bookAbi, ADDR.book, "MarkApplied", {
    bookId: 1n, markId: 1n, navUsd: U(101000), pnlUsd: U(1000), seniorNav: U(70300), juniorNav: U(30700),
    seniorPrice: 1_004_285_714_285_714_285n, juniorPrice: 101n * 10n ** 16n,
  }, 6, 2, 13);
  L(markRegistryAbi, ADDR.markRegistry, "MarkApplied", { markId: 1n, bookId: 1n }, 6, 3, 13);
  // block 7: fee flow distributed; drawdown kill at mark (by the book) revokes the key; claim
  L(revenueRouterAbi, ADDR.router, "Distributed", { bookId: 1n, period: 1_790_000_100n, amounts: [U(100), U(5), U(9), U(51), U(35)] }, 7, 0, 14);
  L(mMMandateAbi, ADDR.mandate, "KeyRevoked", { key: ADDR.key, by: ADDR.mandate, reason: strToBytes32("KILL") }, 7, 1, 15);
  L(mMMandateAbi, ADDR.mandate, "Kill", { reason: strToBytes32("DRAWDOWN"), by: ADDR.book }, 7, 2, 15);
  L(bookAbi, ADDR.book, "Killed", { bookId: 1n, reason: strToBytes32("DRAWDOWN") }, 7, 3, 15);
  L(trancheAbi, ADDR.junior, "RedemptionClaimed", { controller: ADDR.sponsor, receiver: ADDR.sponsor, assets: U(1010) }, 7, 4, 16);
  // block 8: a log with a topic no ABI knows
  ch.logs.push({ ...makeLog(bookAbi, "Retiring", { bookId: 1n }, { address: ADDR.book, block: 8, logIndex: 0, tx: 17 }), topics: [keccak256(toHex("Mystery(uint256)"))] });
  ch.head = 8n;
  return ch;
}

export const EXPECTED_EVENT_TYPES = [
  "charter.filed",
  "book.created",
  "charter.decided",
  "book.window_closed",
  "book.live",
  "agent.registered",
  "redemption.requested",
  "redemption.honoured",
  "agent.revoked",
  "kill.executed",
  "book.killed",
];
