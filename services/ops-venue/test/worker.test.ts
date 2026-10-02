import { describe, expect, test } from "bun:test";
import { ACCOUNT, RECEIPT_KIND, strToBytes32, type VenueAccount } from "@bookrunner/shared";
import { computeReport, dropSuspicious } from "../src/domain/report";
import { keyFromSecret } from "../src/orderly/auth";
import { OrderlyVenue } from "../src/client";
import { OrderlyHttpError } from "../src/orderly/http";
import { pruneSagas } from "../src/store";
import { loadOrCreateBuilderKey, Provisioner } from "../src/worker/provision";
import { bookCursorName } from "../src/worker/logs";
import { OpsService } from "../src/worker/service";
import { ADAPTER, BASE, BUILDER_ID, IF_ID, MANDATE, makeCtx, MM_ID, setupReporting, SYMBOL, trackedBook } from "./helpers";

const acct = (equity: bigint, qty = 0, mark = 0): VenueAccount => ({
  equityUsd: equity,
  freeCollateralUsd: equity,
  position: qty ? { symbol: SYMBOL, netQty: qty, avgPx: mark, markPx: mark, netExposureUsd: BigInt(Math.round(qty * mark * 1e6)), unrealizedPnlUsd: 0n } : null,
});

describe("report computation (pure)", () => {
  test("IF floored at 0, signed margin + exposure, strictly increasing asOf", () => {
    expect(computeReport(acct(-5n), acct(-10n, -2, 100), SYMBOL, 10_500, null)).toEqual({ insuranceUsd: 0n, marginUsd: -10n, netExposureUsd: -200_000_000n, asOf: 10n });
    expect(computeReport(acct(1n), acct(1n), SYMBOL, 10_999, 10n)).toBeNull();
    expect(computeReport(acct(1n), acct(1n), SYMBOL, 11_000, 10n)?.asOf).toBe(11n);
  });

  test("drop guard: unexplained falls beyond the threshold are suspicious; withdrawals explain falls", () => {
    expect(dropSuspicious({ lastValue: 100n, newValue: 49n, withdrawnSince: 0n, maxDropBps: 5000 })).toBe(true);
    expect(dropSuspicious({ lastValue: 100n, newValue: 50n, withdrawnSince: 0n, maxDropBps: 5000 })).toBe(false);
    expect(dropSuspicious({ lastValue: 100n, newValue: 0n, withdrawnSince: 100n, maxDropBps: 5000 })).toBe(false);
    expect(dropSuspicious({ lastValue: null, newValue: 0n, withdrawnSince: 0n, maxDropBps: 5000 })).toBe(false);
  });
});

async function service() {
  const t = await makeCtx();
  t.chain.books = [trackedBook()];
  const svc = new OpsService(t.ctx, new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret)));
  await svc.syncBooks();
  return { ...t, svc };
}

describe("provisioning", () => {
  test("creates the symbol with the IF account, keys (prefix only in DB) and venue_accounts rows", async () => {
    const t = await service();
    const sym = t.mock.venue.requireSymbol(SYMBOL);
    expect(sym.ifAccountId).toBe(IF_ID);
    expect(t.mock.venue.builderAccountId).toBe(BUILDER_ID);
    const rows = await t.store.venueAccounts(1);
    expect(rows.map((r) => [r.kind, r.status]).sort()).toEqual([
      ["builder", "active"],
      ["if", "active"],
      ["mm", "active"],
    ]);
    const f = t.keys.loadBook(1);
    const mm = rows.find((r) => r.kind === "mm");
    expect(mm?.keyPrefix).toBe(f?.trade?.orderlyKey.slice(0, 16) ?? "missing");
    expect(mm?.keyPrefix?.length).toBe(16);
    expect(f?.trade?.scope).toBe("read,trading");
    expect(f?.ops.if?.scope).toBe("read,asset");
    const keys = t.mock.venue.keyInfo(MM_ID).map((k) => k.scope.join(","));
    expect(keys.sort()).toEqual(["read,asset", "read,trading"]);
  });

  test("periodic report posts IF/MM equity and net exposure", async () => {
    const t = await service();
    t.mock.venue.credit(IF_ID, 25_000_000_000);
    t.mock.venue.credit(MM_ID, 75_000_000_000);
    t.mock.venue.setPrice("NVDA", 190, false);
    t.mock.venue.placeOrder({ accountId: MM_ID, keyId: null }, { symbol: SYMBOL, order_type: "LIMIT", side: "BUY", order_price: 189.5, order_quantity: 10 });
    t.mock.venue.externalTaker(SYMBOL, "SELL", 10);
    await t.svc.reportAll();
    const call = t.chain.calls.find((c) => c.fn === "report");
    expect(call?.args.slice(0, 4)).toEqual([ADAPTER, 25_000_000_000n, 75_000_000_000n + 5_000_000n, 1_900_000_000n]);
    await t.svc.reportAll(); // same second -> skipped (monotonic asOf)
    expect(t.chain.count("report")).toBe(1);
  });

  test("an empty venue read (e.g. simulator restart) is held back until it persists", async () => {
    let now = 1_800_000_000_000;
    const t = await makeCtx({ now: () => now });
    t.chain.books = [trackedBook()];
    const svc = new OpsService(t.ctx, new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret)));
    await svc.syncBooks();
    // nothing credited on the venue: IF + MM read as 0 vs 100k planned deployment
    for (let i = 0; i < 2; i++) {
      now += 15_000;
      await svc.reportAll();
    }
    expect(t.chain.count("report")).toBe(0);
    now += 15_000;
    await svc.reportAll(); // third consecutive reading -> reported
    expect(t.chain.count("report")).toBe(1);
  });
});

describe("kill -> venue key revocation", () => {
  test("revoke_key job: cancel-all, key removed (401 after), DB revoked, DECISION receipt, one agent.revoked event", async () => {
    const t = await service();
    t.mock.venue.credit(MM_ID, 75_000_000_000);
    t.mock.venue.setPrice("NVDA", 190, false);
    t.mock.venue.credit(IF_ID, 25_000_000_000);
    const agent = new OrderlyVenue({ baseUrl: BASE, accountId: MM_ID, symbol: SYMBOL, mode: "mock", bookId: 1, keysDir: t.keys.dir, fetch: t.mock.fetch });
    await agent.replaceQuote({ bid: { px: 189, qty: 1 }, ask: { px: 191, qty: 1 } });
    expect(t.mock.venue.openOrders(MM_ID)).toHaveLength(2);

    const r = await t.svc.handleJob({ kind: "revoke_key", bookId: 1 });
    expect(r.revokedNow).toBe(true);
    expect(t.mock.venue.openOrders(MM_ID)).toHaveLength(0);
    const err = await agent.replaceQuote({ bid: { px: 189, qty: 1 } }).catch((e) => e);
    expect((err as OrderlyHttpError).status).toBe(401);
    expect((await t.store.venueAccounts(1)).find((x) => x.kind === "mm")?.status).toBe("revoked");
    expect(t.store.receipts.map((x) => x.kind)).toEqual([RECEIPT_KIND.DECISION]);

    await t.svc.onKillMessage(JSON.stringify({ bookId: 1, ts: Date.now(), reason: "DRAWDOWN", breaches: [] }));
    await t.svc.handleJob({ kind: "revoke_key", bookId: 1 });
    expect(t.store.events.filter((e) => e.type === "agent.revoked")).toHaveLength(1);
    expect(t.store.receipts).toHaveLength(1);
    // provisioning must not resurrect a revoked key
    await t.svc.provisioner.ensure(t.svc.registry.list()[0] as ReturnType<typeof trackedBook>, true);
    expect((await t.store.venueAccounts(1)).find((x) => x.kind === "mm")?.status).toBe("revoked");
  });

  test("mandate Kill log revokes; Remandated (mandate no longer killed) rotates a fresh trade key", async () => {
    const t = await service();
    t.chain.killed = true;
    t.chain.mandateLogList.push({ kind: "Kill", mandate: MANDATE, reason: strToBytes32("DRAWDOWN"), block: 12n, txHash: "0x01" });
    t.chain.block = 12n;
    await t.svc.logs.poll();
    const old = t.keys.loadBook(1)?.trade;
    expect(old?.revokedAt).toBeTruthy();
    // replay of the same Kill after a re-mandate must not revoke the new key
    t.chain.killed = false;
    t.chain.mandateLogList.push({ kind: "Remandated", mandate: MANDATE, block: 13n, txHash: "0x02" });
    t.chain.block = 13n;
    await t.svc.logs.poll();
    const fresh = t.keys.loadBook(1)?.trade;
    expect(fresh?.revokedAt).toBeNull();
    expect(fresh?.orderlyKey).not.toBe(old?.orderlyKey);
    expect((await t.store.venueAccounts(1)).find((x) => x.kind === "mm")?.status).toBe("active");
    expect(t.store.events.map((e) => e.type)).toEqual(["agent.revoked", "agent.registered"]);
  });

  test("log watcher persists its cursor and turns WithdrawRequested into sagas", async () => {
    const t = await service();
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, 1n); // block 11
    await t.svc.logs.poll();
    expect(t.store.cursors.get("ops-venue:logs")).toBe(12n);
    expect(t.store.cursors.get(bookCursorName(ADAPTER))).toBe(12n);
    expect(Object.keys(t.sagas.get().withdrawals)).toEqual([`${ADAPTER.toLowerCase()}:${req.nonce}`]);
  });

});

// (the reviewed-finding scenarios live in regressions.test.ts)
describe("venue report vs in-flight flows", () => {
  test("held while a withdrawal is in flight and during the settle window after its confirm; then reports the debited venue value", async () => {
    const t = await setupReporting();
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 30_000_000_000n);
    await t.svc.logs.poll();
    t.chain.failNext.confirmWithdraw = "rpc down"; // saga stops after the venue debit
    await t.svc.withdrawals.processAll();
    expect(Object.values(t.sagas.get().withdrawals)[0]?.stage).toBe("requested");
    expect(t.mock.venue.getAccount(MM_ID).holding).toBe(45_000_000_000);
    t.tick(60);
    expect(await t.svc.reporter.report(t.book())).toBeNull();
    expect(t.chain.count("report")).toBe(0);
    await t.svc.withdrawals.processNonce(1, req.nonce.toString()); // confirm -> pay -> sweep
    t.tick(5);
    expect(await t.svc.reporter.report(t.book())).toBeNull(); // confirm is a venue flow: settle window
    t.tick(60);
    expect(await t.svc.reporter.report(t.book())).toMatch(/^0x/);
    expect(t.chain.calls.find((c) => c.fn === "report")?.args.slice(1, 3)).toEqual([25_000_000_000n, 45_000_000_000n]);
  });

  test("deposit settle window: reports again once it has passed", async () => {
    const t = await setupReporting();
    t.chain.adapter(ADAPTER).lastFlowAt = t.chain.headTs - 5n; // VenueDeposit 5s ago
    expect(await t.svc.reporter.report(t.book())).toBeNull();
    t.tick(30);
    expect(await t.svc.reporter.report(t.book())).toMatch(/^0x/);
  });
});

describe("saga retention", () => {
  test("prunes only old terminal sagas", () => {
    const now = 100 * 86_400_000;
    const st = {
      withdrawals: {},
      lastAsOf: {},
      reportGuard: {},
      fees: {
        a: { key: "a", bookId: 1, adapter: ADAPTER, symbol: SYMBOL, period: 1, amount: "0", stage: "skipped" as const, attempts: 0, createdAt: 0, updatedAt: 0 },
        b: { key: "b", bookId: 1, adapter: ADAPTER, symbol: SYMBOL, period: 2, amount: "5", stage: "planned" as const, attempts: 0, createdAt: 0, updatedAt: 0 },
      },
    };
    expect(pruneSagas(st, now)).toBe(true);
    expect(Object.keys(st.fees)).toEqual(["b"]);
  });
});
