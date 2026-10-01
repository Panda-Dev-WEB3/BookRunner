// Receipt leaves (pure). Protocol: receipts row {book_id, kind, ts, payload, payload_hash =
// payloadHash(payload), hour_start = floor(ts / RECEIPTS_INTERVAL_SECONDS) * interval}. Payloads are
// made JSON-safe (bigint -> decimal string) BEFORE hashing so the hash recomputed from the stored
// jsonb matches. ts is truncated to whole seconds (receipt leaves carry uint64 unix seconds).

import { type FillMsg, type QuoteMsg, type ReceiptKind, RECEIPT_KIND, bigintReplacer, payloadHash } from "@bookrunner/shared";
import type { Hex } from "viem";

export interface ReceiptRow {
  bookId: number;
  kind: ReceiptKind;
  ts: Date;
  payload: Record<string, unknown>;
  payloadHash: Hex;
  hourStart: Date;
}

export function jsonSafe<T>(v: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v, bigintReplacer)) as Record<string, unknown>;
}

export function hourStartSec(tsSec: number, intervalSec: number): number {
  const i = Math.max(1, Math.floor(intervalSec));
  return Math.floor(tsSec / i) * i;
}

export function buildReceipt(bookId: number, kind: ReceiptKind, tsMs: number, payload: unknown, intervalSec: number): ReceiptRow {
  const tsSec = Math.floor(tsMs / 1000);
  const safe = jsonSafe(payload);
  return {
    bookId,
    kind,
    ts: new Date(tsSec * 1000),
    payload: safe,
    payloadHash: payloadHash(safe),
    hourStart: new Date(hourStartSec(tsSec, intervalSec) * 1000),
  };
}

export const quoteReceipt = (q: QuoteMsg, intervalSec: number): ReceiptRow =>
  buildReceipt(q.bookId, RECEIPT_KIND.QUOTE, q.ts, { type: "quote", ...q }, intervalSec);

export const fillReceipt = (f: FillMsg, intervalSec: number): ReceiptRow =>
  buildReceipt(f.bookId, RECEIPT_KIND.FILL, f.ts, { type: "fill", ...f }, intervalSec);

export interface HedgeReceiptPayload {
  bookId: number;
  ts: number;
  action: "buy" | "sell" | "flatten";
  token: string;
  venue: string;
  qtyRaw: bigint; // signed
  amountIn: bigint;
  amountOut: bigint;
  valueUsd: bigint;
  txHash: string;
}

export const hedgeReceipt = (h: HedgeReceiptPayload, intervalSec: number): ReceiptRow =>
  buildReceipt(h.bookId, RECEIPT_KIND.HEDGE, h.ts, { type: "hedge", ...h }, intervalSec);
