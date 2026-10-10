// Plain-language copy for the invest flow that encodes protocol behaviour (when a deposit settles,
// what a killed book still accepts). Pure and DOM-free so the wording is unit-tested against the
// contracts' rules (test/invest-copy.test.ts): a top-up round settles only at the first mark whose
// period ends at or after the ROUND END (Book._settleAtMark / Tranche.settleAtMark), never "at the
// next mark", and a round cannot be closed early.
import { USDC_DECIMALS, formatAmountDisplay } from "../../lib/amount";
import { fmtWhen } from "../../lib/format";
import { getSettlementSymbol } from "../../lib/settlementToken";
import { type DepositWindow, type RoundRoom, type TrancheRoom, pctOfBps } from "./logic";

const whole = (raw: bigint) => formatAmountDisplay(raw, USDC_DECIMALS, 0);
const sym = () => getSettlementSymbol();

/** "0 of 100,000 USDC committed": one framing for a tranche's round on every page (settlement token symbol). */
export function roomFigure(room: RoundRoom, symbol: string = sym()): string {
  return `${whole(room.committed)} of ${whole(room.capacity)} ${symbol} committed`;
}

/**
 * The per-wallet cap in words. When it is above what the round can take per tranche, the round's
 * capacity is the real limit, so say so instead of showing a cap that cannot be reached.
 */
export function perWalletCapText(cap: bigint | null, roundCapacity: bigint | null, sponsor = false, symbol: string = sym()): string {
  if (cap === null) return "—";
  if (cap === 0n) return "None";
  if (sponsor) return "No cap (sponsor wallet)";
  const base = `${whole(cap)} ${symbol} per round`;
  return roundCapacity !== null && roundCapacity > 0n && cap > roundCapacity ? `${base}; this round takes at most ${whole(roundCapacity)} ${symbol} per tranche` : base;
}

/**
 * The line under a tranche's round figures, or null when nothing limits it: Senior can be limited
 * by the Senior cap well below the round capacity (Book._seniorTopUpRoom), and an oversubscribed
 * round is filled pro-rata at the settling mark.
 */
export function roomNote(room: TrancheRoom, capBps: number | null | undefined): string | null {
  const cap = capBps != null ? `${pctOfBps(capBps)} Senior cap` : "Senior cap";
  if (room.capLimited) {
    return room.oversubscribed
      ? `Oversubscribed under the ${cap}: Senior deposits will be scaled down pro-rata unless more Junior comes in.`
      : `Limited by the ${cap}: about ${whole(room.left)} ${sym()} can still be accepted, more if Junior grows (estimate from the last mark).`;
  }
  return room.oversubscribed ? "Oversubscribed: deposits will be scaled down pro-rata." : null;
}

/** The three steps at the top of the Invest page. */
export const INVEST_STEPS = [
  {
    n: 1,
    title: "Pick a book",
    body: "Each book is the underwriting pool of one perp market, with its own rules, marks and contracts.",
  },
  {
    n: 2,
    title: "Choose Senior or Junior",
    body: "Senior receives a fixed share of each distribution and is last in line for losses. Junior takes losses first and keeps the rest, plus any trading gains.",
  },
  {
    n: 3,
    title: "Deposit and sign",
    body: "Your deposit waits in escrow until the round ends, and cannot be cancelled before then. The first mark after the round end turns it into shares at that mark's price.",
  },
] as const;

/** One or two sentences on what the deposit window means right now. */
export function windowSentence(w: DepositWindow, timeZone?: string): string {
  const when = (s: number) => fmtWhen(s, timeZone);
  switch (w.status) {
    case "loading":
      return "Checking whether this book takes deposits right now…";
    case "open":
      return w.kind === "subscription"
        ? `The subscription window is open until ${when(w.endsAt)}. When it closes, commitments are allocated pro-rata and shares start at 1.00 ${sym()} each.`
        : `A top-up round is open until ${when(w.endsAt)}. Deposits wait in escrow, cannot be cancelled, and are turned into shares at the first mark after the round ends (${when(w.settlesAt)}), at that mark's share price.`;
    case "settling":
      return w.kind === "subscription"
        ? `The subscription window closed at ${when(w.endsAt)}. Commitments are allocated as soon as the window is closed on-chain.`
        : `The round ended at ${when(w.endsAt)}. It settles at the first mark after that (${when(w.settlesAt)}); then you can collect your shares and any refund.`;
    case "paused":
      return w.by === "guardian"
        ? "The protocol guardian has paused new deposits for now. Withdrawals and claims are never blocked by a pause."
        : "The sponsor or guardian has paused deposits into this tranche. Withdrawals and claims are never blocked by a pause.";
    case "closed":
      switch (w.why) {
        case "no-round":
          return "This book takes deposits only during a top-up round, which its sponsor opens with a capacity per tranche. No round is open right now. You can still withdraw and claim at any time.";
        case "cancelled":
          return "This book was cancelled at the end of its subscription window. Every commitment can be taken back 1:1 from the Withdraw tab.";
        case "retiring":
          return "This book is winding down, so it takes no new deposits. Withdrawals keep settling at each mark.";
        case "retired":
          return "This book is retired. Withdrawals settle at its final price.";
        default:
          return "This book does not take deposits right now.";
      }
  }
}

/** When deposits made now settle, as a clause: "at the first mark after the round ends (…)". */
export function settlesClause(w: DepositWindow, timeZone?: string): string | null {
  if (w.status !== "open" && w.status !== "settling" && w.status !== "paused") return null;
  return w.kind === "subscription"
    ? `when the subscription window closes (${fmtWhen(w.settlesAt, timeZone)})`
    : `at the first mark after the round ends (${fmtWhen(w.settlesAt, timeZone)})`;
}

/**
 * A commitment is locked until its round settles: Tranche.sol has no cancel or withdraw path for a
 * walletCommit. The only ways out are settlement (claimAllocation) or a round cancelled by
 * Book.retire() / a failed window (claimCancelledRefund, 1:1).
 */
export function noCancelLine(w: DepositWindow, timeZone?: string): string {
  const subscription = w.status !== "closed" && w.status !== "loading" && w.kind === "subscription";
  const at = w.status === "open" || w.status === "settling" || w.status === "paused" ? ` (${fmtWhen(w.settlesAt, timeZone)})` : "";
  return subscription
    ? `A commitment cannot be cancelled or withdrawn before the window closes${at}. Withdrawals apply to shares once they are allocated. If the book is cancelled at the end of the window, every commitment is refunded in full.`
    : `A deposit cannot be cancelled or withdrawn before the round settles${at}. Withdrawals apply to shares after settlement. If the book retires first, the round is cancelled and the deposit is refunded in full.`;
}

/** The deposit sentence of the "mandate is killed" callout (empty when deposits are not open). */
export function killedDepositNote(w: DepositWindow, timeZone?: string): string {
  if (w.status !== "open") return "";
  return w.kind === "subscription"
    ? ` Deposits are still accepted and are allocated ${settlesClause(w, timeZone)}, at 1.00 ${sym()} per share.`
    : ` Deposits are still accepted and settle ${settlesClause(w, timeZone)}, at that mark's share price.`;
}
