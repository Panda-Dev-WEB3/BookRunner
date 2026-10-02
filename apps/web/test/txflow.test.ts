import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { type PreparedTxLike, type TxExecutor, type TxItem, callSummary, initialItems, runSequential, summarize } from "../src/lib/txflow";

const tx = (n: number): PreparedTxLike => ({ to: `0x${String(n).padStart(40, "0")}`, data: "0x095ea7b3" + "00".repeat(64), value: "0", chainId: 31337, description: `tx ${n}` });

function fakeExecutor(opts: { rejectAt?: number; revertAt?: number } = {}) {
  const sent: string[] = [];
  const exec: TxExecutor = {
    async send(t) {
      if (opts.rejectAt !== undefined && t.description === `tx ${opts.rejectAt}`) throw Object.assign(new Error("User rejected the request.\nDetails: ..."), { shortMessage: "User rejected the request." });
      sent.push(t.description);
      return `0x${"aa".repeat(31)}${String(sent.length).padStart(2, "0")}` as Hex;
    },
    async wait(_h, t) {
      return { status: opts.revertAt !== undefined && t.description === `tx ${opts.revertAt}` ? "reverted" : "success", blockNumber: 7n };
    },
  };
  return { exec, sent };
}

describe("runSequential", () => {
  test("sends in order, each after the previous confirms, reporting every state", async () => {
    const { exec, sent } = fakeExecutor();
    const updates: string[][] = [];
    const r = await runSequential(initialItems([tx(1), tx(2), tx(3)]), exec, (it) => updates.push(it.map((i) => i.status)));
    expect(r.ok).toBe(true);
    expect(sent).toEqual(["tx 1", "tx 2", "tx 3"]);
    expect(r.items.every((i) => i.status === "confirmed" && i.blockNumber === 7n && !!i.hash)).toBe(true);
    expect(updates[0]).toEqual(["signing", "queued", "queued"]);
    expect(updates[1]).toEqual(["pending", "queued", "queued"]);
    expect(updates.at(-1)).toEqual(["confirmed", "confirmed", "confirmed"]);
  });

  test("stops at the first failure and marks the rest not sent; retry resumes", async () => {
    const first = fakeExecutor({ rejectAt: 2 });
    const r = await runSequential(initialItems([tx(1), tx(2), tx(3)]), first.exec, () => {});
    expect(r.ok).toBe(false);
    expect(r.items.map((i) => i.status)).toEqual(["confirmed", "failed", "skipped"]);
    expect(r.items[1]?.error).toBe("User rejected the request.");
    const again = fakeExecutor();
    const r2 = await runSequential(r.items, again.exec, () => {});
    expect(r2.ok).toBe(true);
    expect(again.sent).toEqual(["tx 2", "tx 3"]);
  });

  test("a reverted receipt is a failure", async () => {
    const { exec } = fakeExecutor({ revertAt: 1 });
    const r = await runSequential(initialItems([tx(1)]), exec, () => {});
    expect(r.items[0]?.status).toBe("failed");
    expect(r.items[0]?.error).toContain("reverted");
  });
});

describe("summaries", () => {
  test("summarize and callSummary", () => {
    const items: TxItem[] = [
      { tx: tx(1), status: "confirmed" },
      { tx: tx(2), status: "pending" },
    ];
    expect(summarize(items)).toEqual({ done: 1, total: 2, failed: false, running: true, allConfirmed: false });
    expect(summarize([]).allConfirmed).toBe(false);
    expect(callSummary(tx(1).data)).toEqual({ selector: "0x095ea7b3", bytes: 68 });
  });
});
