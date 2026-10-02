// Sequential execution of prepared transactions ({to, data, value: "0", chainId, description}).
// The API never sends transactions; the connected wallet signs each one in order and the next one
// starts only after the previous is confirmed (approve -> deposit, approve -> stake -> file, ...).
import type { Hex } from "viem";

export interface PreparedTxLike {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description: string;
}

export type TxStatus = "queued" | "signing" | "pending" | "confirmed" | "failed" | "skipped";

export interface TxItem<T extends PreparedTxLike = PreparedTxLike> {
  tx: T;
  status: TxStatus;
  hash?: Hex;
  blockNumber?: bigint;
  error?: string;
  /** The receipt of `hash` says it reverted: a retry sends the transaction again. */
  reverted?: boolean;
}

/**
 * The item was broadcast (it has a hash) but waiting for its receipt failed (timeout, RPC error), so
 * the transaction may still confirm: a retry must wait for that hash again, never send it twice
 * (a second requestRedeem would file a second withdrawal request).
 */
export const awaitsReceipt = (i: Pick<TxItem, "status" | "hash" | "reverted">): boolean => i.status !== "confirmed" && !!i.hash && !i.reverted;

export interface TxExecutor<T extends PreparedTxLike = PreparedTxLike> {
  send(tx: T): Promise<Hex>;
  wait(hash: Hex, tx: T): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}

export const initialItems = <T extends PreparedTxLike>(txs: T[]): TxItem<T>[] => txs.map((tx) => ({ tx, status: "queued" }));

export const errText = (e: unknown): string => {
  const o = (e ?? {}) as { shortMessage?: unknown; message?: unknown };
  const s = typeof o.shortMessage === "string" ? o.shortMessage : typeof o.message === "string" ? o.message : String(e);
  return s.split("\n")[0] ?? s;
};

/**
 * Runs the queue in order, skipping items already confirmed (so a retry resumes where it stopped).
 * An item that was already broadcast and only lost its receipt wait resumes waiting on its hash
 * instead of being sent again; a reverted one is sent again. Stops at the first failure and marks
 * the rest skipped. Reports every state change.
 */
export async function runSequential<T extends PreparedTxLike>(
  items: TxItem<T>[],
  exec: TxExecutor<T>,
  onUpdate: (items: TxItem<T>[]) => void,
): Promise<{ ok: boolean; items: TxItem<T>[] }> {
  let cur = items.map((i) => (i.status === "confirmed" ? i : { ...i, status: "queued" as TxStatus, error: undefined }));
  const set = (idx: number, patch: Partial<TxItem<T>>) => {
    cur = cur.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    onUpdate(cur);
  };
  for (let i = 0; i < cur.length; i++) {
    const item = cur[i];
    if (!item || item.status === "confirmed") continue;
    try {
      let hash = awaitsReceipt(item) ? item.hash : undefined;
      if (!hash) {
        set(i, { status: "signing", hash: undefined, reverted: undefined, blockNumber: undefined });
        hash = await exec.send(item.tx);
      }
      set(i, { status: "pending", hash });
      const r = await exec.wait(hash, item.tx);
      if (r.status !== "success") {
        set(i, { reverted: true, blockNumber: r.blockNumber });
        throw new Error(`Transaction reverted in block ${r.blockNumber}`);
      }
      set(i, { status: "confirmed", blockNumber: r.blockNumber });
    } catch (e) {
      set(i, { status: "failed", error: errText(e) });
      cur = cur.map((it, j) => (j > i && it.status !== "confirmed" ? { ...it, status: "skipped" as TxStatus } : it));
      onUpdate(cur);
      return { ok: false, items: cur };
    }
  }
  return { ok: true, items: cur };
}

export function summarize(items: TxItem[]): { done: number; total: number; failed: boolean; running: boolean; allConfirmed: boolean } {
  const done = items.filter((i) => i.status === "confirmed").length;
  return {
    done,
    total: items.length,
    failed: items.some((i) => i.status === "failed"),
    running: items.some((i) => i.status === "signing" || i.status === "pending"),
    allConfirmed: items.length > 0 && done === items.length,
  };
}

/** Function selector + approximate calldata size, for the review list. */
export function callSummary(data: string): { selector: string; bytes: number } {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  return { selector: `0x${hex.slice(0, 8)}`, bytes: Math.floor(hex.length / 2) };
}
