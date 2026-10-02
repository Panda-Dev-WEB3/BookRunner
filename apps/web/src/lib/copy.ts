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

export const AGENTS_LINE = "Bookrunner agents quote the book under its mandate.";
export const BACKSTOP_LINE = "Backstop up to the pool: covers Senior impairment only once Junior is exhausted.";
export const LIVE_VS_MARKED =
  "Marked values come from the signed mark committed on-chain each period. Live values are an intra-period estimate and are never used for subscriptions or redemptions.";
export const FEE_FLOW_LINE = "Fee flow is the observed accrual over the mark period, distributed by the book's router.";
export const NOTICE_LINE = "Notice is not a gate: a redemption request is always accepted and settles at the first mark on or after its eligible time.";

export const venueLabel = (v: string | null | undefined): string =>
  v === "pool_engine" ? "In-house engine" : v === "orderly" ? "Orderly" : "Unknown venue";

export const venueDetail = (v: string | null | undefined): string =>
  v === "pool_engine" ? "Pool-vs-trader engine with an attested oracle and off-hours regime" : v === "orderly" ? "Listed on Orderly's public contracts" : "";
