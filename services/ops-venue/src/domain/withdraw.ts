// Withdrawal saga (pure). One saga per adapter WithdrawRequested(account, amount, nonce):
//
//   detected --venue_requested--> requested --venue_paid--> paid --confirmed--> confirmed --swept--> swept
//        \___________________________ error (attempts++) ________________________/        |
//                                  attempts >= max or fatal  ->  failed                    terminal
//
//   request : POST withdraw request on Orderly (delegate signer, receiver = adapter)
//   pay     : mock -> MockOrderlyVault.operatorWithdraw(accountId, adapter, amount) (+ creditFees to
//             materialise venue PnL the mock vault never received); live -> wait for Orderly to pay (VERIFY)
//   confirm : adapter.confirmWithdraw(nonce)
//   sweep   : adapter.sweepToVault()
import type { Address, Hex } from "viem";

export type WithdrawStage = "detected" | "requested" | "paid" | "confirmed" | "swept" | "failed";

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
  payTx?: Hex;
  confirmTx?: Hex;
  sweepTx?: Hex | null;
  attempts: number;
  lastError?: string;
  detectedTx?: Hex;
  createdAt: number;
  updatedAt: number;
}

export type WithdrawEvent =
  | { type: "venue_requested"; withdrawId: string }
  | { type: "venue_paid"; payTx?: Hex }
  | { type: "confirmed"; confirmTx?: Hex }
  | { type: "swept"; sweepTx: Hex | null }
  | { type: "error"; error: string; fatal?: boolean };

export type WithdrawStep = "request" | "pay" | "confirm" | "sweep";

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
      return "pay";
    case "paid":
      return "confirm";
    case "confirmed":
      return "sweep";
    default:
      return null;
  }
}

const NEXT: Record<Exclude<WithdrawEvent["type"], "error">, { from: WithdrawStage; to: WithdrawStage }> = {
  venue_requested: { from: "detected", to: "requested" },
  venue_paid: { from: "requested", to: "paid" },
  confirmed: { from: "paid", to: "confirmed" },
  swept: { from: "confirmed", to: "swept" },
};

export function isTerminal(s: WithdrawSaga): boolean {
  return s.stage === "swept" || s.stage === "failed";
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
  if (s.stage !== t.from) throw new Error(`withdraw ${s.key}: illegal ${ev.type} in stage ${s.stage}`);
  const next: WithdrawSaga = { ...s, stage: t.to, attempts: 0, updatedAt: now };
  delete next.lastError;
  if (ev.type === "venue_requested") next.withdrawId = ev.withdrawId;
  if (ev.type === "venue_paid" && ev.payTx) next.payTx = ev.payTx;
  if (ev.type === "confirmed" && ev.confirmTx) next.confirmTx = ev.confirmTx;
  if (ev.type === "swept") next.sweepTx = ev.sweepTx;
  return next;
}

/** Retry backoff for a saga that keeps failing (ms). */
export function retryDelayMs(attempts: number, baseMs = 3000, maxMs = 120_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

/** confirmWithdraw reverted: was it because the nonce is already confirmed (crash after send)? */
export function looksAlreadyConfirmed(error: string): boolean {
  return /already|confirmed|not.?pending|unknown.?nonce|invalid.?nonce|nonce/i.test(error);
}

/** Mock vault materialisation: how much must be credited so operatorWithdraw(amount) can pay. */
export function shortfall(ledger: bigint | null, amount: bigint): bigint {
  if (ledger === null) return 0n;
  return ledger >= amount ? 0n : amount - ledger;
}
