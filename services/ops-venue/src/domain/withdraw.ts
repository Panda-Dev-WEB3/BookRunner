// Withdrawal saga (pure). One saga per adapter WithdrawRequested(account, amount, nonce):
//
//   detected --venue_requested--> requested --confirmed--> confirmed --venue_paid--> paid --swept--> swept
//      |  \______________________ error (attempts++) __________________________/                 |
//      |                          attempts >= max or fatal  ->  failed                             terminal
//      +--skipped--> skipped      (on-chain request no longer Requested: never executed again)
//   requested|confirmed --cancelled--> cancelled   (venue rejected/failed it; adapter.cancel/failWithdraw)
//
//   request : on-chain withdrawRequest(nonce).status must still be Requested, then POST the Orderly
//             withdraw request (delegate signer, receiver = adapter); the venue debits the account here
//   confirm : adapter.confirmWithdraw(nonce) right after the venue accepted it, BEFORE any USDC can reach
//             the adapter: from here the amount is in-transit principal (a sweep can never take it as
//             unattributed, and the venue debit and the adapter debit happen back to back)
//   pay     : mock -> MockOrderlyVault.operatorWithdraw(accountId, adapter, amount) (+ creditFees to
//             materialise venue PnL the mock vault never received); live -> wait for Orderly to pay (VERIFY)
//   sweep   : adapter.sweepToVault() (waits while the mark-window gate is closed)
// Every on-chain write is recorded (hash + nonce) before its receipt is awaited and inspected on retry.
import type { Address, Hex } from "viem";
import type { SentTx } from "../chain";

export type WithdrawStage = "detected" | "requested" | "confirmed" | "paid" | "swept" | "skipped" | "cancelled" | "failed";

export type WithdrawTxSlot = "confirm" | "mint" | "credit" | "pay" | "sweep" | "cancel";

export interface WithdrawSaga {
  key: string; // `${adapter}:${nonce}` (lowercase adapter)
  bookId: number;
  adapter: Address;
  account: number; // ACCOUNT.IF | ACCOUNT.MM
  accountId: Hex;
  amount: string; // raw 6dp decimal string
  nonce: string;
  stage: WithdrawStage;
  withdrawId?: string;
  /** mock: venue PnL materialised before the payout (fixed once computed). */
  creditAmount?: string;
  /** txs broadcast by this saga, recorded before their receipts were awaited */
  txs?: Partial<Record<WithdrawTxSlot, SentTx>>;
  payTx?: Hex;
  confirmTx?: Hex;
  sweepTx?: Hex | null;
  cancelTx?: Hex;
  reason?: string; // skipped / cancelled
  attempts: number;
  lastError?: string;
  detectedTx?: Hex;
  createdAt: number;
  updatedAt: number;
}

export type WithdrawEvent =
  | { type: "venue_requested"; withdrawId: string }
  | { type: "confirmed"; confirmTx?: Hex }
  | { type: "venue_paid"; payTx?: Hex }
  | { type: "swept"; sweepTx: Hex | null }
  | { type: "skipped"; reason: string }
  | { type: "cancelled"; reason: string; cancelTx?: Hex }
  | { type: "error"; error: string; fatal?: boolean };

export type WithdrawStep = "request" | "confirm" | "pay" | "sweep";

export const sagaKey = (adapter: Address, nonce: bigint | string) => `${adapter.toLowerCase()}:${nonce.toString()}`;

export function newWithdrawSaga(p: { bookId: number; adapter: Address; account: number; accountId: Hex; amount: bigint; nonce: bigint; txHash?: Hex }, now: number): WithdrawSaga {
  return {
    key: sagaKey(p.adapter, p.nonce),
    bookId: p.bookId,
    adapter: p.adapter,
    account: p.account,
    accountId: p.accountId,
    amount: p.amount.toString(),
    nonce: p.nonce.toString(),
    stage: "detected",
    attempts: 0,
    ...(p.txHash ? { detectedTx: p.txHash } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function nextStep(s: WithdrawSaga): WithdrawStep | null {
  switch (s.stage) {
    case "detected":
      return "request";
    case "requested":
      return "confirm";
    case "confirmed":
      return "pay";
    case "paid":
      return "sweep";
    default:
      return null;
  }
}

const NEXT: Record<Exclude<WithdrawEvent["type"], "error">, { from: readonly WithdrawStage[]; to: WithdrawStage }> = {
  venue_requested: { from: ["detected"], to: "requested" },
  confirmed: { from: ["requested"], to: "confirmed" },
  venue_paid: { from: ["confirmed"], to: "paid" },
  swept: { from: ["paid"], to: "swept" },
  skipped: { from: ["detected"], to: "skipped" },
  cancelled: { from: ["requested", "confirmed"], to: "cancelled" },
};

export function isTerminal(s: WithdrawSaga): boolean {
  return s.stage === "swept" || s.stage === "skipped" || s.stage === "cancelled" || s.stage === "failed";
}

/** Pure transition; throws on an illegal event for the current stage. */
export function transition(s: WithdrawSaga, ev: WithdrawEvent, now: number, maxAttempts = 40): WithdrawSaga {
  if (isTerminal(s)) throw new Error(`withdraw ${s.key}: saga is terminal (${s.stage})`);
  if (ev.type === "error") {
    const attempts = s.attempts + 1;
    const failed = ev.fatal === true || attempts >= maxAttempts;
    return { ...s, attempts, lastError: ev.error, stage: failed ? "failed" : s.stage, updatedAt: now };
  }
  const t = NEXT[ev.type];
  if (!t.from.includes(s.stage)) throw new Error(`withdraw ${s.key}: illegal ${ev.type} in stage ${s.stage}`);
  const next: WithdrawSaga = { ...s, stage: t.to, attempts: 0, updatedAt: now };
  delete next.lastError;
  if (ev.type === "venue_requested") next.withdrawId = ev.withdrawId;
  if (ev.type === "venue_paid" && ev.payTx) next.payTx = ev.payTx;
  if (ev.type === "confirmed" && ev.confirmTx) next.confirmTx = ev.confirmTx;
  if (ev.type === "swept") next.sweepTx = ev.sweepTx;
  if (ev.type === "skipped") next.reason = ev.reason;
  if (ev.type === "cancelled") {
    next.reason = ev.reason;
    if (ev.cancelTx) next.cancelTx = ev.cancelTx;
  }
  return next;
}

/** Retry backoff for a saga that keeps failing (ms). */
export function retryDelayMs(attempts: number, baseMs = 3000, maxMs = 120_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

/** Mock vault materialisation: how much must be credited so operatorWithdraw(amount) can pay. */
export function shortfall(ledger: bigint | null, amount: bigint): bigint {
  if (ledger === null) return 0n;
  return ledger >= amount ? 0n : amount - ledger;
}

/** Venue withdrawal history row (subset used to recognise our own earlier request). */
export interface VenueWithdrawRow {
  id: number | string;
  status: string;
  amountUsd: bigint;
  clientRef: string | null;
  receiver?: string | null;
  createdAt?: number | null; // ms
}

/**
 * Before POSTing a venue withdrawal, find one an earlier attempt already created (a POST whose response
 * was lost, a crash before the saga recorded it, a saga file lost while the on-chain request is still
 * pending) so it is never requested twice. Only confident matches are adopted: our own client_ref, or the
 * same amount + receiver created after the on-chain request (`sinceMs`, small clock skew) and not claimed
 * by another saga. Rows without a creation time are never adopted: re-requesting is recoverable, adopting
 * an older, already paid withdrawal would book phantom in-transit principal.
 */
export function matchPriorWithdrawal(rows: VenueWithdrawRow[], p: { ref: string; amount: bigint; receiver: string; sinceMs: number; claimed: ReadonlySet<string>; skewMs?: number }): VenueWithdrawRow | null {
  const open = rows.filter((r) => r.status !== "FAILED" && !p.claimed.has(String(r.id)));
  const byRef = open.find((r) => r.clientRef === p.ref);
  if (byRef) return byRef;
  const since = p.sinceMs - (p.skewMs ?? 5_000);
  const cands = open.filter(
    (r) => r.amountUsd === p.amount && (r.receiver == null || r.receiver.toLowerCase() === p.receiver.toLowerCase()) && typeof r.createdAt === "number" && r.createdAt >= since,
  );
  cands.sort((a, b) => (a.createdAt as number) - (b.createdAt as number));
  return cands[0] ?? null;
}
