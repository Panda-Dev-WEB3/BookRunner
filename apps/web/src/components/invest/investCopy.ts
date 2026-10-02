// Plain-language copy for the invest flow that encodes protocol behaviour (when a deposit settles,
// what a killed book still accepts). Pure and DOM-free so the wording is unit-tested against the
// contracts' rules (test/invest-copy.test.ts): a top-up round settles only at the first mark whose
// period ends at or after the ROUND END (Book._settleAtMark / Tranche.settleAtMark), never "at the
// next mark", and a round cannot be closed early.
import { USDC_DECIMALS, formatAmountDisplay } from "../../lib/amount";
import { fmtWhen } from "../../lib/format";
import { type DepositWindow, type RoundRoom, type TrancheRoom, pctOfBps } from "./logic";

const whole = (raw: bigint) => formatAmountDisplay(raw, USDC_DECIMALS, 0);

/** "0 of 100,000 USDC committed": one framing for a tranche's round on every page. */
export function roomFigure(room: RoundRoom): string {
  return `${whole(room.committed)} of ${whole(room.capacity)} USDC committed`;
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
      : `Limited by the ${cap}: about ${whole(room.left)} USDC can still be accepted, more if Junior grows (estimate from the last mark).`;
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
    body: "Senior is paid first and is last in line for losses. Junior takes losses first and keeps the rest of the fee flow.",
  },
  {
    n: 3,
    title: "Deposit and sign",
    body: "Your USDC waits in escrow until the round ends. The first mark after the round end turns it into shares at that mark's price.",
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
        ? `The subscription window is open until ${when(w.endsAt)}. When it closes, commitments are allocated pro-rata and shares start at 1.00 USDC each.`
        : `A top-up round is open until ${when(w.endsAt)}. Deposits wait in escrow and are turned into shares at the first mark after the round ends (${when(w.settlesAt)}), at that mark's share price.`;
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

/** The deposit sentence of the "mandate is killed" callout (empty when deposits are not open). */
export function killedDepositNote(w: DepositWindow, timeZone?: string): string {
  if (w.status !== "open") return "";
  return w.kind === "subscription"
    ? ` Deposits are still accepted and are allocated ${settlesClause(w, timeZone)}, at 1.00 USDC per share.`
    : ` Deposits are still accepted and settle ${settlesClause(w, timeZone)}, at that mark's share price.`;
}
