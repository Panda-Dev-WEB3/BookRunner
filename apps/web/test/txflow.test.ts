import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { checkCopy } from "@bookrunner/shared/copy";
import { DECLINED_TEXT, type PreparedTxLike, REQUEST_OPEN_TEXT, type TxExecutor, type TxItem, awaitsReceipt, callSummary, errText, initialItems, isRequestOpen, isUserRejection, runSequential, summarize } from "../src/lib/txflow";

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

  test("a decline in the wallet is 'not sent', in plain words, not a failure; signing again resumes", async () => {
    const first = fakeExecutor({ rejectAt: 2 });
    const r = await runSequential(initialItems([tx(1), tx(2), tx(3)]), first.exec, () => {});
    expect(r.ok).toBe(false);
    expect(r.items.map((i) => i.status)).toEqual(["confirmed", "skipped", "skipped"]);
    expect(r.items[1]?.error).toBe(DECLINED_TEXT);
    expect(summarize(r.items).failed).toBe(false);
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
    expect(r.items[0]?.reverted).toBe(true);
    expect(awaitsReceipt(r.items[0] as TxItem)).toBe(false);
    // a reverted transaction is sent again on retry
    const again = fakeExecutor();
    const r2 = await runSequential(r.items, again.exec, () => {});
    expect(again.sent).toEqual(["tx 1"]);
    expect(r2.items[0]).toMatchObject({ status: "confirmed", reverted: undefined });
  });

  test("retry after a lost receipt waits for the same hash again and never sends twice", async () => {
    const sent: string[] = [];
    const waited: Hex[] = [];
    let waitFails = true;
    const exec: TxExecutor = {
      async send(t) {
        sent.push(t.description);
        return `0x${"bb".repeat(32)}` as Hex;
      },
      async wait(h) {
        waited.push(h);
        // the receipt poller rejects on a 429 / timeout although the transaction was broadcast
        if (waitFails) throw Object.assign(new Error("HTTP request failed.\nStatus: 429"), { shortMessage: "HTTP request failed." });
        return { status: "success", blockNumber: 9n };
      },
    };
    const r = await runSequential(initialItems([tx(1), tx(2)]), exec, () => {});
    expect(r.ok).toBe(false);
    expect(r.items[0]).toMatchObject({ status: "failed", hash: `0x${"bb".repeat(32)}`, error: "HTTP request failed." });
    expect(awaitsReceipt(r.items[0] as TxItem)).toBe(true);
    waitFails = false;
    const updates: string[][] = [];
    const r2 = await runSequential(r.items, exec, (it) => updates.push(it.map((i) => i.status)));
    expect(r2.ok).toBe(true);
    expect(sent).toEqual(["tx 1", "tx 2"]); // tx 1 was sent once, tx 2 once
    expect(waited.length).toBe(3);
    expect(updates[0]).toEqual(["pending", "queued"]); // straight back to waiting, no signature
    // after "send it again" clears the hash, the step is signed again
    const cleared = r.items.map((i, j) => (j === 0 ? { ...i, hash: undefined } : i));
    sent.length = 0;
    await runSequential(cleared, exec, () => {});
    expect(sent).toEqual(["tx 1", "tx 2"]);
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

describe("wallet error text", () => {
  test("declines read as declined, in a neutral 'not sent' state, wherever they sit in the cause chain", () => {
    expect(isUserRejection({ code: 4001, message: "denied" })).toBe(true);
    expect(isUserRejection({ shortMessage: "User rejected the request." })).toBe(true);
    expect(isUserRejection({ name: "ContractFunctionExecutionError", cause: { name: "UserRejectedRequestError" } })).toBe(true);
    expect(isUserRejection(new Error("HTTP request failed."))).toBe(false);
    expect(errText({ shortMessage: "User rejected the request.", code: 4001 })).toBe(DECLINED_TEXT);
  });
  test("a second click while the wallet prompt is open (MetaMask -32002)", () => {
    const e = { code: -32002, message: "Request of type 'wallet_requestPermissions' already pending for origin http://127.0.0.1:5180. Please wait." };
    expect(isRequestOpen(e)).toBe(true);
    expect(errText(e)).toBe(REQUEST_OPEN_TEXT);
  });
  test("other failures keep their first line and stay failures", async () => {
    const exec: TxExecutor = {
      async send() {
        throw Object.assign(new Error("Insufficient funds for gas.\nDetails: ..."), { shortMessage: "Insufficient funds for gas." });
      },
      async wait() {
        return { status: "success", blockNumber: 1n };
      },
    };
    const r = await runSequential(initialItems([tx(1)]), exec, () => {});
    expect(r.items[0]).toMatchObject({ status: "failed", error: "Insufficient funds for gas." });
    for (const t of [DECLINED_TEXT, REQUEST_OPEN_TEXT]) expect(checkCopy(t)).toEqual([]);
  });
});
