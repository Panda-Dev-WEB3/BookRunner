// Receipts protocol (producers of quotes/fills/hedges/decisions): one receipts row per leaf.
import { type Db, receipts } from "@bookrunner/db";
import { type ReceiptKind, payloadHash } from "@bookrunner/shared";

export interface ReceiptRowInput {
  bookId: number;
  kind: ReceiptKind;
  ts: Date;
  payload: Record<string, unknown>;
}

export function receiptRow(r: ReceiptRowInput, intervalSeconds: number) {
  const tsSec = Math.floor(r.ts.getTime() / 1000);
  const hourStart = Math.floor(tsSec / intervalSeconds) * intervalSeconds;
  return {
    bookId: r.bookId,
    kind: r.kind,
    ts: r.ts,
    payload: r.payload,
    payloadHash: payloadHash(r.payload),
    hourStart: new Date(hourStart * 1000),
  };
}

export async function insertReceipt(db: Db, r: ReceiptRowInput, intervalSeconds: number): Promise<number | null> {
  const [row] = await db.insert(receipts).values(receiptRow(r, intervalSeconds)).returning({ id: receipts.id });
  return row?.id ?? null;
}
