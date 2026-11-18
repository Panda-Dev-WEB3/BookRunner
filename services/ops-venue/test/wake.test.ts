// RPC budget: the books and logs loops read the chain only when their ChainWake says it is due (a log notification, the
// safety poll, or the polling interval without a subscription); everything else they do is unchanged.
import { describe, expect, test } from "bun:test";
import type { ChainWake } from "@bookrunner/shared";
import { keyFromSecret } from "../src/orderly/auth";
import { loadOrCreateBuilderKey, Provisioner } from "../src/worker/provision";
import { OpsService, type OpsWakes } from "../src/worker/service";
import { BUILDER_ID, makeCtx, trackedBook } from "./helpers";

function stubWake(initiallyDue = true) {
  const s = { dueNow: initiallyDue, begins: 0, fails: 0, filters: 0 };
  const wake = {
    due: () => s.dueNow,
    begin: () => {
      s.begins++;
      s.dueNow = false;
    },
    failed: () => {
      s.fails++;
      s.dueNow = true;
    },
    refreshFilter: () => void s.filters++,
    onWake: () => () => undefined,
  } as unknown as ChainWake;
  return { wake, s };
}

async function rig(wakes: OpsWakes) {
  const t = await makeCtx();
  t.chain.books = [trackedBook()];
  const lists = { n: 0 };
  const list = t.chain.listBookIds.bind(t.chain);
  t.chain.listBookIds = async () => {
    lists.n++;
    return list();
  };
  const svc = new OpsService(t.ctx, new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret)), wakes);
  return { ...t, svc, lists };
}

describe("ops-venue books loop: chain reads when due", () => {
  test("not due: no bookIds() / state read, the rest of the pass still runs (status published)", async () => {
    const books = stubWake(true);
    const t = await rig({ books: books.wake });
    await t.svc.syncBooks(); // due: first read, the book is tracked
    expect(t.lists.n).toBe(1);
    expect(books.s.begins).toBe(1);
    expect(books.s.filters).toBe(1); // the wake watches the tracked books now
    await t.svc.syncBooks(); // not due
    await t.svc.syncBooks();
    expect(t.lists.n).toBe(1);
    expect(t.svc.registry.list()).toHaveLength(1);
    books.s.dueNow = true; // a notification
    await t.svc.syncBooks();
    expect(t.lists.n).toBe(2);
  });

  test("a failed read is due again", async () => {
    const books = stubWake(true);
    const t = await rig({ books: books.wake });
    t.chain.listBookIds = async () => {
      throw new Error("rpc down");
    };
    await expect(t.svc.syncBooks()).rejects.toThrow("rpc down");
    expect(books.s.fails).toBe(1);
    expect(books.wake.due()).toBe(true);
  });

  test("without a wake the loop reads every pass, as before", async () => {
    const t = await rig({});
    await t.svc.syncBooks();
    await t.svc.syncBooks();
    expect(t.lists.n).toBe(2);
  });
});

describe("ops-venue logs loop: eth_getLogs when due", () => {
  test("not due: no log scan and no block read; due: one scan", async () => {
    const logs = stubWake(true);
    const t = await rig({ logs: logs.wake });
    await t.svc.syncBooks();
    await t.svc.pollLogs();
    const scans = t.chain.logQueries.length;
    expect(logs.s.begins).toBe(1);
    t.chain.block += 5n;
    await t.svc.pollLogs(); // not due
    await t.svc.pollLogs();
    expect(t.chain.logQueries.length).toBe(scans);
    logs.s.dueNow = true;
    await t.svc.pollLogs();
    expect(t.chain.logQueries.length).toBeGreaterThan(scans);
  });
});
