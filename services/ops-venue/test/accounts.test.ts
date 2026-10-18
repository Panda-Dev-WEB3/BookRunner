// v3 OrderlyAdapter accounts (VERIFY O6/O9): MM = the adapter's own Orderly account, IF = the account of the
// book's OrderlyIFAccount contract. Keys and withdrawals name the account OWNER as delegateContract, Orderly pays
// a contract account only to itself, and the adapter pulls IF payouts from the IF contract when it sweeps.
// Plus the native deposit-fee keeper (VERIFY O5).
import { describe, expect, test } from "bun:test";
import { ACCOUNT, type VenueSymbolIssuesMsg } from "@bookrunner/shared";
import type { Hex } from "viem";
import { KeyStore } from "../src/keys";
import { NativeFeeKeeper } from "../src/worker/native";
import { BookRegistry } from "../src/worker/books";
import { FeeSweeper } from "../src/worker/fees";
import { Reporter } from "../src/worker/reporter";
import { Revoker } from "../src/worker/revoke";
import type { TrackedBook } from "../src/worker/context";
import { loadOrCreateBuilderKey, Provisioner } from "../src/worker/provision";
import { keyFromSecret } from "../src/orderly/auth";
import { orderlyAccountId } from "../src/orderly/convert";
import { ADAPTER, BROKER, BUILDER_ID, IF_ID, IF_OWNER, makeCtx, MM_ID, setupWithdraw, trackedBook, VAULT } from "./helpers";

describe("IF account owned by the OrderlyIFAccount", () => {
  test("provisioning registers each account with its owner ", async () => {
    const t = await setupWithdraw("Live");
    expect(t.reg.list()[0]?.owners).toEqual({ if: IF_OWNER, mm: ADAPTER });
    expect(t.mock.venue.getAccount(IF_ID).owner).toBe(IF_OWNER.toLowerCase());
    expect(t.mock.venue.getAccount(MM_ID).owner).toBe(ADAPTER.toLowerCase());
  }, 120_000);

  test("IF withdrawal: delegate request with receiver = delegateContract = IF owner, payout there, swept via the adapter", async () => {
    const t = await setupWithdraw("Live");
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, 1_000_000_000n);
    const saga = await t.wp.onRequested(req);
    expect(saga?.owner).toBe(IF_OWNER);
    await t.wp.processAll();
    const s = Object.values(t.sagas.get().withdrawals)[0];
    expect(s?.stage).toBe("swept");
    const w = [...t.mock.venue.withdrawals.values()][0];
    expect(w?.receiver).toBe(IF_OWNER.toLowerCase());
    expect(w?.delegateContract).toBe(IF_OWNER.toLowerCase());
    // mock vault paid the IF account's owner (MockOrderlyVault only pays the account owner) ...
    expect(t.chain.calls.find((c) => c.fn === "operatorWithdraw")?.args[1]).toBe(IF_OWNER);
    // ... and the adapter's sweep pulled it from there into the vault
    expect(t.chain.bal(IF_OWNER)).toBe(0n);
    expect(t.chain.bal(VAULT)).toBe(1_000_000_000n);
    expect(t.adapterState().inTransit).toBe(0n);
  }, 120_000);

  test("MM withdrawal stays on the adapter's own account (no owner recorded)", async () => {
    const t = await setupWithdraw("Live");
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 2_000_000_000n);
    const saga = await t.wp.onRequested(req);
    expect(saga?.owner).toBeUndefined();
    await t.wp.processAll();
    expect([...t.mock.venue.withdrawals.values()][0]?.receiver).toBe(ADAPTER.toLowerCase());
    expect(t.chain.bal(VAULT)).toBe(2_000_000_000n);
  }, 120_000);

  test("pre-v3 adapter (no IF contract): both accounts owned by the adapter", async () => {
    const t = await makeCtx();
    t.chain.ifOwners.clear();
    t.chain.books = [trackedBook()];
    const reg = new BookRegistry(t.ctx);
    await reg.refresh();
    expect(reg.list()[0]?.owners).toEqual({ if: ADAPTER, mm: ADAPTER });
  }, 120_000);
});

describe("live provisioning: Orderly delegate signer confirmation", () => {
  const live = async () => {
    const t = await makeCtx({ mode: "live" });
    t.chain.books = [trackedBook("Subscription")];
    const reg = new BookRegistry(t.ctx);
    await reg.refresh();
    const p = new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret));
    return { ...t, book: reg.list()[0] as TrackedBook, p };
  };

  test("refuses until the timelock's setDelegateSigner tx exists for every owner, then confirms each once", async () => {
    const t = await live();
    await expect(t.p.ensure(t.book)).rejects.toThrow(/timelock must call adapter.setDelegateSigner/);
    t.chain.delegateTxs.set(ADAPTER.toLowerCase(), `0x${"01".repeat(32)}` as Hex);
    t.chain.delegateTxs.set(IF_OWNER.toLowerCase(), `0x${"02".repeat(32)}` as Hex);
    await t.p.ensure(t.book, true);
    expect(t.keys.delegateRegistered(1, ADAPTER)).toBe(true);
    expect(t.keys.delegateRegistered(1, IF_OWNER)).toBe(true);
    // the venue created both contract accounts (keccak256(abi.encode(owner, brokerHash))) with the ops EOA as delegate
    for (const owner of [IF_OWNER, ADAPTER]) {
      const a = t.mock.venue.getAccount(orderlyAccountId(owner, BROKER));
      expect([a.owner, a.delegateSigner]).toEqual([owner.toLowerCase(), t.chain.opsAddress.toLowerCase()]);
    }
    expect(new KeyStore(t.keys.dir).loadBook(1)?.delegates).toBeDefined();
  }, 120_000);
});

describe("venue symbol (VERIFY O19): charter PERP_NVDA_USDC -> Orderly builder market", () => {
  test("mock mode tracks the charter symbol verbatim", async () => {
    const t = await makeCtx();
    t.chain.books = [trackedBook()];
    const reg = new BookRegistry(t.ctx);
    await reg.refresh();
    expect(reg.list()[0]).toMatchObject({ symbol: "PERP_NVDA_USDC", charterSymbol: "PERP_NVDA_USDC", baseAsset: "NVDA" });
  }, 120_000);

  test("live mode: every venue call uses PERP_NVDA_USDC_<broker>; listing goes under it", async () => {
    const t = await makeCtx({ mode: "live" });
    t.chain.books = [trackedBook("Subscription")];
    const reg = new BookRegistry(t.ctx);
    await reg.refresh();
    const book = reg.list()[0] as TrackedBook;
    expect(book).toMatchObject({ symbol: `PERP_NVDA_USDC_${BROKER}`, charterSymbol: "PERP_NVDA_USDC", baseAsset: "NVDA" });
    t.chain.delegateTxs.set(ADAPTER.toLowerCase(), `0x${"01".repeat(32)}` as Hex);
    t.chain.delegateTxs.set(IF_OWNER.toLowerCase(), `0x${"02".repeat(32)}` as Hex);
    await new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret)).ensure(book, true);
    expect(t.mock.venue.symbols.get(`PERP_NVDA_USDC_${BROKER}`)?.baseAsset).toBe("NVDA");
    expect(t.mock.venue.symbols.has("PERP_NVDA_USDC")).toBe(false);
  }, 120_000);

  test("live mode: a charter symbol with no Orderly market keeps every non-trading duty, lists and trades nothing", async () => {
    const t = await makeCtx({ mode: "live" });
    const issues: VenueSymbolIssuesMsg[] = [];
    t.ctx.status = { venueSymbolIssues: async (m) => void issues.push(m) };
    t.chain.books = [{ ...trackedBook("Live"), charterSymbol: "NVDA-PERP", baseAsset: "NVDA-PERP" }];
    const reg = new BookRegistry(t.ctx);
    await reg.refresh();
    const book = reg.list()[0] as TrackedBook;
    expect(book.venueSymbolError).toMatch(/not an Orderly perp symbol/);
    expect(book.symbol).toBe("NVDA-PERP"); // label only
    expect(issues.at(-1)).toMatchObject({ v: 1, mode: "live", books: [{ bookId: 1, charterSymbol: "NVDA-PERP", error: book.venueSymbolError }] });
    // accounts, delegates and ops keys as usual; no listing, no trade key on Orderly
    t.chain.delegateTxs.set(ADAPTER.toLowerCase(), `0x${"01".repeat(32)}` as Hex);
    t.chain.delegateTxs.set(IF_OWNER.toLowerCase(), `0x${"02".repeat(32)}` as Hex);
    await new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret)).ensure(book, true);
    expect(t.mock.venue.symbols.size).toBe(0);
    const f = t.keys.loadBook(1);
    expect([!!f?.ops.if?.registeredAt, !!f?.ops.mm?.registeredAt, !!f?.trade?.registeredAt]).toEqual([true, true, false]);
    // venue reports still flow (capital on the venue stays visible to marks and risk)
    t.mock.venue.credit(IF_ID, 25_000_000_000);
    t.mock.venue.credit(MM_ID, 75_000_000_000);
    expect(await new Reporter(t.ctx).report(book)).not.toBeNull();
    // revocation still records the kill, without Orderly calls for a key that never reached Orderly
    expect((await new Revoker(t.ctx, reg).revoke(1, "KILL", "job")).revokedNow).toBe(true);
    // no fee sweeps from a book with no market
    await new FeeSweeper(t.ctx, reg).auto();
    expect(Object.keys(t.sagas.get().fees ?? {})).toEqual([]);
    // still reported on later passes (the alert holds), and the book is never re-loaded
    await reg.refresh();
    expect(issues.at(-1)?.books).toHaveLength(1);
    expect(reg.untradable().map((b) => b.bookId)).toEqual([1]);
  }, 120_000);
});

describe("native deposit-fee keeper", () => {
  const keeper = async (topUpMaxWei: bigint) => {
    let now = 1_000_000;
    const t = await makeCtx({ now: () => now });
    t.chain.depositFee = 400_000_000_000_000n; // 0.0004 ETH per deposit
    const k = new NativeFeeKeeper(t.ctx, { topUpMaxWei, headroom: 2n, cooldownMs: 60_000 });
    return { t, k, advance: (ms: number) => (now += ms) };
  };

  test("warn-only by default; ok once funded; skips books past Live", async () => {
    const { t, k } = await keeper(0n);
    expect(await k.check(trackedBook("Subscription"))).toMatchObject({ action: "warned", required: 800_000_000_000_000n, balance: 0n });
    expect(t.chain.count("fundNative")).toBe(0);
    t.chain.native.set(ADAPTER.toLowerCase(), 800_000_000_000_000n);
    expect(await k.check(trackedBook("Live"))).toMatchObject({ action: "ok" });
    expect(await k.check(trackedBook("Retiring"))).toBeNull();
  }, 120_000);

  test("tops up to headroom x required, capped per top-up, at most once per cooldown", async () => {
    const { t, k, advance } = await keeper(1_000_000_000_000_000n);
    expect(await k.check(trackedBook("Subscription"))).toMatchObject({ action: "topped_up", value: 1_000_000_000_000_000n }); // target 1.6e15, cap 1e15
    expect(await k.check(trackedBook("Subscription"))).toMatchObject({ action: "ok" });
    t.chain.native.set(ADAPTER.toLowerCase(), 0n); // spent by a deposit
    expect(await k.check(trackedBook("Subscription"))).toMatchObject({ action: "warned" }); // cooldown
    advance(60_001);
    expect(await k.check(trackedBook("Subscription"))).toMatchObject({ action: "topped_up" });
    expect(t.chain.count("fundNative")).toBe(2);
  }, 120_000);
});
