// Canonical user-facing copy (Overview §10). Tranches are described by seniority and loss order
// only, never by rates. Checked in CI by scripts/check-copy.ts.

export const TAGLINE = "Run the book.";
export const STRAPLINE = "The underwriting syndicate for on-chain perp markets.";

export const LEGAL =
  "Bookrunner is software; not a fund, adviser, broker or venue operator of record. Stock-perp books are not offered to US persons.";

export const TRANCHE_COPY = {
  senior: {
    name: "Senior",
    line: "First claim on fee flow up to its share, last loss in the waterfall; redeemable at NAV at every mark.",
  },
  junior: {
    name: "Junior",
    line: "Residual fee flow, first loss; redeemable at NAV after notice. Notice is not a gate.",
  },
} as const;

/**
 * How a distribution is shared (Waterfall.splitDistribution / RevenueRouter.computeSplit): Senior
 * gets a fixed share of what is left after expenses and carry and Junior the rest, in the same
 * transaction, so neither is "paid first"; mark gains go to Junior once Senior impairment is restored.
 */
export const SPLIT_LINE =
  "Senior receives a fixed share of each distribution after expenses and carry; Junior receives the rest plus any trading gains at the marks.";
/**
 * What "never a revenue claim" means (the copy rule, ARCHITECTURE §2.2): BkrnStaking.notifyReward
 * does share carry-funded BKRN pro-rata, so the rule is explained as no claim on book USDC or fee
 * flow, with buybacks that depend on a keeper and can be zero, never as "no fixed rate".
 */
export const REVENUE_CLAIM_LINE =
  "Stakers have no claim on any book's USDC or fee flow. The protocol may distribute bought-back BKRN, which depends on a keeper running a buyback and can be zero.";
export const AGENTS_LINE = "Bookrunner agents quote the book under its mandate.";
export const BACKSTOP_LINE = "Backstop up to the pool: covers Senior impairment only once Junior is exhausted.";
export const LIVE_VS_MARKED =
  "Marked values come from the signed mark committed on-chain each period. Live values are an intra-period estimate and are never used for subscriptions or redemptions.";
export const FEE_FLOW_LINE = "Fee flow is the observed accrual over the mark period, distributed by the book's router.";
/**
 * Sponsor skin (Waterfall.allocateWindow enforces SPONSOR_MIN_JUNIOR_BPS only when the subscription
 * window closes; later outflows only flag the sponsor, and top-ups mint Junior with no sponsor check).
 */
export const SPONSOR_SKIN_LINE =
  "The sponsor is allocated first and holds at least 10% of Junior when the subscription window closes. If the sponsor later redeems or transfers below 10%, the committee may slash their bond. Later top-ups can dilute the sponsor's share.";
/** The same rule in one clause, for tight spots (cards, list items, form help). */
export const SPONSOR_SKIN_SHORT = "holds at least 10% of Junior when the subscription window closes";
/**
 * A mark only settles a redemption: the USDC moves in a separate claim, which Tranche._claim pays
 * from escrow and reverts InsufficientLiquidity while the book's cash is still deployed on the venue.
 */
export const COLLECT_LINE = "A mark settles a request; you then collect the proceeds in a separate transaction.";
export const CASH_WAIT_LINE = "If the book's cash is still on the venue, collecting waits until the keeper brings it back.";
export const NOTICE_LINE = "Notice is not a gate: a redemption request is always accepted and settles at the first mark on or after its eligible time.";

export const venueLabel = (v: string | null | undefined): string =>
  v === "pool_engine" ? "In-house engine" : v === "orderly" ? "Orderly" : "Unknown venue";

/**
 * One line on the venue. On a test network the Orderly vault is a protocol-owned simulator
 * (MockOrderlyVault, contracts/script/Deploy.s.sol), so "listed on Orderly's public contracts" is
 * only said on mainnet.
 */
export const venueDetail = (v: string | null | undefined, testnet = false): string =>
  v === "pool_engine"
    ? "Pool-vs-trader engine with an attested oracle and off-hours regime"
    : v === "orderly"
      ? testnet
        ? "Orderly-style venue (testnet simulator): a protocol-owned mock of Orderly's vault"
        : "Listed on Orderly's public contracts"
      : "";

/** What the test network stands in for (Deploy.s.sol: protocol-owned mocks on devnet and testnet). */
export const TESTNET_MOCKS_LINE =
  "On this test network the Orderly vault, the Stock Tokens and the BKRN buyback router are protocol-owned mocks: Stock Tokens trade at the signed oracle price and buybacks at a fixed price.";

/** Where the carry's BKRN is bought: a fixed-price mock router on test networks, the market on mainnet. */
export const buybackWhere = (testnet: boolean): string => (testnet ? "through the test network's mock swap router, at a fixed price" : "on the market");
