// Builders for receipts rows and JSON-safe payloads. Pure.
import { formatFixed, payloadHash } from "@bookrunner/shared";
import type { ReceiptRow } from "../ports";

/** Receipts protocol: hour_start = floor(ts / RECEIPTS_INTERVAL_SECONDS) * interval. */
export function receiptRow(bookId: number, kind: number, tsSec: number, payload: Record<string, unknown>, intervalSec: number): ReceiptRow {
  const interval = Math.max(1, Math.floor(intervalSec));
  const ts = Math.floor(tsSec);
  return {
    bookId,
    kind,
    ts: new Date(ts * 1000),
    payload,
    payloadHash: payloadHash(payload),
    hourStart: new Date(Math.floor(ts / interval) * interval * 1000),
  };
}

/** USD 6dp raw -> decimal string "1234.5" (no rounding). */
export const usdStr = (raw: bigint): string => formatFixed(raw, 6);

/** USD 6dp raw -> float (analytics columns only). */
export const usdNum = (raw: bigint): number => Number(raw) / 1e6;

/** JSON-safe copy: bigint -> string, non-finite numbers -> null. */
export function jsonSafe<T>(v: T): T {
  return JSON.parse(
    JSON.stringify(v, (_k, x) => {
      if (typeof x === "bigint") return x.toString();
      if (typeof x === "number" && !Number.isFinite(x)) return null;
      return x;
    }),
  ) as T;
}

/** Finite number for DB double columns (Infinity utilisation when maxInventoryUsd == 0). */
export const finite = (x: number, cap = 1e12): number => (Number.isFinite(x) ? x : x > 0 ? cap : -cap);
