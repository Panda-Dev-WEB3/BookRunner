// Insurance-fund account mode (ORDERLY_IF_MODE, docs/VERIFY.md O10): contract = the book's OrderlyIFAccount (delegate
// account, today's path), builder = an operator EOA's Orderly account bound on-chain by adapter.setIfAccountOwner and
// listed per book in ORDERLY_IF_BUILDER_ACCOUNTS. Mode selection, the binding checks (a mismatch never blocks another
// book), builder provisioning (no delegate / key registration by us), the operator-driven IF withdrawal and the
// strictly-greater IF requirement.
import { describe, expect, test } from "bun:test";
import { ACCOUNT, type VenueSymbolIssuesMsg } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { loadOpsEnv } from "../src/config";
import type { VenueWithdrawRow, WithdrawSaga } from "../src/domain/withdraw";
import { ifAboveRequirement, ifAccountIssue, ifBindingOf, ORDERLY_IF_REQUIREMENT_USD, parseIfBuilderAccounts, resolveIfRequirementUsd } from "../src/domain/ifAccount";
import type { TrackedBook } from "../src/worker/context";
import { BookRegistry } from "../src/worker/books";
import { OpsService } from "../src/worker/service";
import { WithdrawProcessor } from "../src/worker/withdrawals";
import { OrderlyBuilderClient } from "../src/client";
import { generateKey } from "../src/orderly/auth";
import type { FetchLike } from "../src/orderly/http";
import { ADAPTER, IF_ID, IF_OWNER, makeCtx, MM_ID, OPS, provisioner, SYMBOL, trackedBook, VAULT } from "./helpers";

const EOA = "0x00000000000000000000000000000000000E0A01" as Address;
const OTHER_ID = `0x${"e5".repeat(32)}` as Hex;

describe("domain: binding, consistency, config parsing", () => {
  test("binding from the adapter views: devnet (adapter owns IF), contract (OrderlyIFAccount), builder (EOA owner)", () => {
    expect(ifBindingOf({ adapter: ADAPTER, ifOwner: ADAPTER, builderOwner: null })).toBe("devnet");
    expect(ifBindingOf({ adapter: ADAPTER, ifOwner: IF_OWNER, builderOwner: null })).toBe("contract");
    expect(ifBindingOf({ adapter: ADAPTER, ifOwner: EOA, builderOwner: EOA.toLowerCase() as Address })).toBe("builder");
  });

  test("mode vs binding: contract accepts contract / devnet; builder needs the EOA binding and the configured id", () => {
    const base = { bookId: 1, accountId: IF_ID, ifOwner: EOA };
    expect(ifAccountIssue({ ...base, mode: "contract", binding: "contract" })).toBeNull();
    expect(ifAccountIssue({ ...base, mode: "contract", binding: "devnet" })).toBeNull();
    expect(ifAccountIssue({ ...base, mode: "contract", binding: "builder" })).toContain("ORDERLY_IF_MODE=contract");
    expect(ifAccountIssue({ ...base, mode: "builder", binding: "contract" })).toContain("setIfAccountOwner");
    expect(ifAccountIssue({ ...base, mode: "builder", binding: "devnet" })).toContain("pre-v3");
    expect(ifAccountIssue({ ...base, mode: "builder", binding: "builder" })).toContain("no IF account configured for book 1");
    expect(ifAccountIssue({ ...base, mode: "builder", binding: "builder", expected: new Map([[1, OTHER_ID]]) })).toContain(`says ${OTHER_ID}`);
    expect(ifAccountIssue({ ...base, mode: "builder", binding: "builder", expected: new Map([[1, IF_ID.toUpperCase().replace("0X", "0x")]]) })).toBeNull();
  });

  test("ORDERLY_IF_BUILDER_ACCOUNTS: <bookId>=<accountId> pairs, one account per book", () => {
    expect([...parseIfBuilderAccounts(` 1=${IF_ID}, 2:${OTHER_ID} `)]).toEqual([
      [1, IF_ID],
      [2, OTHER_ID],
    ]);
    expect(parseIfBuilderAccounts(undefined).size).toBe(0);
    expect(parseIfBuilderAccounts("").size).toBe(0);
    expect(() => parseIfBuilderAccounts("1")).toThrow(/not <bookId>=<accountId>/);
    expect(() => parseIfBuilderAccounts("1=0x1234")).toThrow(/32-byte/);
    expect(() => parseIfBuilderAccounts(`1=${IF_ID},1=${OTHER_ID}`)).toThrow(/listed twice/);
    expect(() => parseIfBuilderAccounts(`1=${IF_ID},2=${IF_ID}`)).toThrow(/share IF account/);
  });

  test("env: ORDERLY_IF_MODE defaults to contract; builder needs ORDERLY_MODE=live; malformed accounts are refused", () => {
    expect(loadOpsEnv({}).ORDERLY_IF_MODE).toBe("contract");
    expect(() => loadOpsEnv({ ORDERLY_IF_MODE: "builder" })).toThrow(/needs ORDERLY_MODE=live/);
    const e = loadOpsEnv({ ORDERLY_MODE: "live", ORDERLY_BASE_URL: "https://testnet-api.orderly.org", ORDERLY_BROKER_ID: "bookrunner", ORDERLY_IF_MODE: "builder", ORDERLY_IF_BUILDER_ACCOUNTS: `1=${IF_ID}` });
    expect([e.ORDERLY_IF_MODE, e.ORDERLY_IF_BUILDER_ACCOUNTS]).toEqual(["builder", `1=${IF_ID}`]);
    expect(() => loadOpsEnv({ ORDERLY_MODE: "live", ORDERLY_IF_MODE: "builder", ORDERLY_IF_BUILDER_ACCOUNTS: "1=nope" })).toThrow(/32-byte/);
    expect(() => loadOpsEnv({ ORDERLY_IF_MODE: "custodian" })).toThrow();
  });
});

describe("min-IF: Orderly's requirement is strictly greater (VERIFY O10)", () => {
  test("requirement per network from the API host, overridable; none for mock-orderly", () => {
    expect(resolveIfRequirementUsd("https://testnet-api.orderly.org")).toBe(100_000_000n);
    expect(resolveIfRequirementUsd("https://api.orderly.org")).toBe(25_000_000_000n);
    expect(resolveIfRequirementUsd("http://localhost:8790")).toBeNull();
    expect(resolveIfRequirementUsd("not a url")).toBeNull();
    expect(resolveIfRequirementUsd("http://localhost:8790", 250)).toBe(250_000_000n);
    expect(ORDERLY_IF_REQUIREMENT_USD).toEqual({ testnet: 100_000_000n, mainnet: 25_000_000_000n });
  });

  test("exactly the requirement is not enough; times the markets on the account", () => {
    const t = ORDERLY_IF_REQUIREMENT_USD.testnet;
    expect(ifAboveRequirement(t, t)).toBe(false);
    expect(ifAboveRequirement(t + 1n, t)).toBe(true);
    expect(ifAboveRequirement(101_000_000n, t)).toBe(true); // the testnet venueMinIf (101 USDG)
    expect(ifAboveRequirement(25_000_000_000n, ORDERLY_IF_REQUIREMENT_USD.mainnet)).toBe(false);
    expect(ifAboveRequirement(25_001_000_000n, ORDERLY_IF_REQUIREMENT_USD.mainnet)).toBe(true); // the mainnet venueMinIf
    expect(ifAboveRequirement(2n * t, t, 2)).toBe(false);
    expect(ifAboveRequirement(2n * t + 1n, t, 2)).toBe(true);
  });

  test("fund_if job: funded only at or above the target AND strictly above the requirement", async () => {
    const t = await makeCtx();
    t.chain.books = [trackedBook()];
    const svc = new OpsService(t.ctx, await provisioner(t));
    await svc.syncBooks();
    t.ctx.settings.ifRequirementUsd = 25_000_000_000n;
    const book = svc.registry.get(1) as TrackedBook;
    book.ifTargetUsd = 25_000_000_000n; // a charter at exactly the requirement (the chain's venueMinIf would refuse it)
    t.mock.venue.credit(IF_ID, 25_000_000_000);
    expect(await svc.handleJob({ kind: "fund_if", bookId: 1 })).toMatchObject({ balanceUsd: "25000000000", funded: false, requirementUsd: "25000000000", aboveRequirement: false, ifMode: "contract", ifAccountId: IF_ID });
    t.mock.venue.credit(IF_ID, 1_000_000);
    expect(await svc.handleJob({ kind: "fund_if", bookId: 1 })).toMatchObject({ funded: true, aboveRequirement: true });
    t.ctx.settings.ifRequirementUsd = null; // mock-orderly: only the target applies
    const r = (await svc.handleJob({ kind: "fund_if", bookId: 1 })) as Record<string, unknown>;
    expect(r.funded).toBe(true);
    expect(r.requirementUsd).toBeUndefined();
  });

  test("fund_if in live mode reads the IF ACCOUNT's equity (never the public insurancefund endpoint)", async () => {
    const t = await makeCtx();
    t.chain.books = [trackedBook()];
    const svc = new OpsService(t.ctx, await provisioner(t));
    await svc.syncBooks();
    t.ctx.settings.mode = "live";
    t.ctx.settings.ifRequirementUsd = 100_000_000n;
    (svc.registry.get(1) as TrackedBook).ifTargetUsd = 101_000_000n;
    t.builder.insuranceFund = async () => {
      throw new Error("must not be called in live mode");
    };
    t.mock.venue.credit(IF_ID, 150_000_000);
    expect(await svc.handleJob({ kind: "fund_if", bookId: 1 })).toMatchObject({ balanceUsd: "150000000", funded: true, aboveRequirement: true, ifAccountId: IF_ID });
  });
});

/** OpsService over the in-process mock venue, with the adapter optionally bound to a builder EOA. */
async function ifService(o: { mode: "contract" | "builder"; builderBound: boolean; expected?: Map<number, string>; listingMode?: "api" | "manual"; state?: TrackedBook["state"] }) {
  let now = 1_800_000_000_000;
  const t = await makeCtx({ now: () => now, ...(o.listingMode ? { listingMode: o.listingMode } : {}) });
  t.ctx.settings.ifMode = o.mode;
  if (o.expected) t.ctx.settings.ifBuilderAccounts = o.expected;
  if (o.builderBound) t.chain.builderIfOwners.set(ADAPTER.toLowerCase(), EOA);
  t.chain.books = [trackedBook(o.state ?? "Live")];
  if (o.state) t.chain.states.set(trackedBook().book.toLowerCase(), o.state);
  const statuses: VenueSymbolIssuesMsg[] = [];
  t.ctx.status = { venueSymbolIssues: async (m) => void statuses.push(m) };
  const calls = { addKey: [] as Array<{ accountId: string; delegateContract?: string }>, createSymbol: [] as Array<{ symbol: string; ifAccountId?: string }>, getOrderlyKey: 0, requestWithdraw: 0 };
  const b = t.builder;
  const addKey = b.addKey.bind(b);
  b.addKey = async (p) => {
    calls.addKey.push({ accountId: p.accountId, ...(p.delegateContract ? { delegateContract: p.delegateContract } : {}) });
    return addKey(p);
  };
  const create = b.createSymbol.bind(b);
  b.createSymbol = async (p) => {
    calls.createSymbol.push({ symbol: p.symbol, ...(p.ifAccountId ? { ifAccountId: p.ifAccountId } : {}) });
    return create(p);
  };
  let keyRegistered = false;
  b.getOrderlyKey = async (_accountId, orderlyKey) => {
    calls.getOrderlyKey++;
    return keyRegistered ? { orderlyKey, scope: "read", expiration: 0 } : null;
  };
  const reqW = b.requestWithdraw.bind(b);
  b.requestWithdraw = async (p) => {
    calls.requestWithdraw++;
    return reqW(p);
  };
  t.chain.clockSec = () => BigInt(Math.floor(now / 1000));
  const svc = new OpsService(t.ctx, await provisioner(t));
  return { ...t, svc, calls, statuses, last: () => statuses.at(-1) as VenueSymbolIssuesMsg, registerKey: () => (keyRegistered = true), advance: (ms: number) => (now += ms) };
}

describe("ORDERLY_IF_MODE=contract (default)", () => {
  test("today's path: IF key registered via the delegate flow, listing with the OrderlyIFAccount's account", async () => {
    const t = await ifService({ mode: "contract", builderBound: false, listingMode: "api" });
    await t.svc.syncBooks();
    const book = t.svc.registry.get(1) as TrackedBook;
    expect([book.ifBinding, book.ifAccountError]).toEqual(["contract", null]);
    expect(t.calls.addKey).toContainEqual({ accountId: IF_ID, delegateContract: IF_OWNER });
    expect(t.calls.createSymbol).toEqual([{ symbol: SYMBOL, ifAccountId: IF_ID }]);
    expect(t.last()).toMatchObject({ ifMode: "contract", ifAccounts: [], ifOperatorWaits: [] });
  });

  test("an adapter bound to a builder EOA is a mismatch: no IF provisioning, no api listing, published; MM still provisioned", async () => {
    const t = await ifService({ mode: "contract", builderBound: true, listingMode: "api" });
    await t.svc.syncBooks();
    const book = t.svc.registry.get(1) as TrackedBook;
    expect(book.ifBinding).toBe("builder");
    expect(book.ifAccountError).toContain("ORDERLY_IF_MODE=contract");
    expect(t.calls.addKey.some((k) => k.accountId === IF_ID)).toBe(false);
    expect(t.calls.addKey.some((k) => k.accountId === MM_ID)).toBe(true); // trade + MM ops keys
    expect(t.calls.createSymbol).toEqual([]);
    expect(t.last().ifAccounts).toEqual([{ bookId: 1, accountId: IF_ID, binding: "builder", issue: "mismatch", detail: book.ifAccountError as string }]);
  });
});

describe("ORDERLY_IF_MODE=builder", () => {
  const expected = new Map([[1, IF_ID as string]]);

  test("builder-bound and configured: no delegate key registration for the EOA account; waits for the operator's key, then marks it", async () => {
    const t = await ifService({ mode: "builder", builderBound: true, expected, listingMode: "api" });
    await t.svc.syncBooks();
    const book = t.svc.registry.get(1) as TrackedBook;
    expect([book.ifBinding, book.ifAccountError, book.owners.if]).toEqual(["builder", null, EOA]);
    expect(t.calls.addKey.some((k) => k.accountId === IF_ID)).toBe(false); // only the EOA's own wallet can add it
    expect(t.calls.createSymbol).toEqual([{ symbol: SYMBOL, ifAccountId: IF_ID }]); // api mode: the market gets the builder account
    expect(t.keys.loadBook(1)?.ops.if?.registeredAt).toBeNull();
    const pend = t.last().ifAccounts?.[0];
    expect(pend).toMatchObject({ bookId: 1, accountId: IF_ID, binding: "builder", issue: "key_pending" });
    expect(pend?.detail).toContain(EOA);
    // throttled: the next poll inside the minute does not re-check
    const checks = t.calls.getOrderlyKey;
    await t.svc.syncBooks();
    expect(t.calls.getOrderlyKey).toBe(checks);
    t.registerKey(); // the operator adds ops-venue's key from its wallet
    t.advance(60_000);
    await t.svc.syncBooks();
    expect(t.keys.loadBook(1)?.ops.if?.registeredAt).toBeTruthy();
    expect(t.last().ifAccounts).toEqual([]);
  });

  test("live mode: the delegate signer is confirmed for the adapter (MM) only, never for the EOA", async () => {
    const t = await ifService({ mode: "builder", builderBound: true, expected });
    t.ctx.settings.mode = "live";
    t.chain.delegateTxs.set(ADAPTER.toLowerCase(), `0x${"dd".repeat(32)}`);
    const delegates: string[] = [];
    t.builder.registerDelegateSigner = async (p) => {
      delegates.push(p.delegateContract.toLowerCase());
      return { accountId: MM_ID, validSigner: "" };
    };
    await t.svc.syncBooks();
    expect(delegates).toEqual([ADAPTER.toLowerCase()]);
  });

  test("the adapter still on the OrderlyIFAccount, or a wrong / missing configured id: mismatch, another book unaffected", async () => {
    const t = await ifService({ mode: "builder", builderBound: false, expected });
    await t.svc.syncBooks();
    expect(t.svc.registry.get(1)?.ifAccountError).toContain("setIfAccountOwner");
    expect(t.last().ifAccounts?.[0]?.issue).toBe("mismatch");
    const t2 = await ifService({ mode: "builder", builderBound: true, expected: new Map([[1, OTHER_ID]]) });
    await t2.svc.syncBooks();
    expect(t2.svc.registry.get(1)?.ifAccountError).toContain(`says ${OTHER_ID}`);
    const t3 = await ifService({ mode: "builder", builderBound: true });
    await t3.svc.syncBooks();
    expect(t3.svc.registry.get(1)?.ifAccountError).toContain("no IF account configured");
    expect((await t3.store.venueAccounts(1)).some((r) => r.kind === "mm" && r.status === "active")).toBe(true);
  });

  test("the timelock binds the EOA after the book was tracked (Subscription): re-read, re-provisioned, error cleared", async () => {
    const t = await ifService({ mode: "builder", builderBound: false, expected, state: "Subscription" });
    await t.svc.syncBooks();
    expect(t.svc.registry.get(1)?.ifAccountError).toContain("setIfAccountOwner");
    t.chain.builderIfOwners.set(ADAPTER.toLowerCase(), EOA); // adapter.setIfAccountOwner(EOA)
    await t.svc.syncBooks();
    const book = t.svc.registry.get(1) as TrackedBook;
    expect([book.ifBinding, book.ifAccountError, book.owners.if]).toEqual(["builder", null, EOA]);
    expect(t.last().ifAccounts?.[0]?.issue).toBe("key_pending");
  });
});

describe("builder IF withdrawal: the operator withdraws on Orderly and returns the USDG", () => {
  async function setup() {
    const t = await ifService({ mode: "builder", builderBound: true, expected: new Map([[1, IF_ID as string]]) });
    t.ctx.settings.ifOperatorRecheckMs = 60_000;
    await t.svc.syncBooks();
    const rows: VenueWithdrawRow[] = [];
    t.builder.withdrawals = async () => rows.map((r) => ({ ...r })) as Awaited<ReturnType<typeof t.builder.withdrawals>>;
    t.builder.withdrawal = async (_a, id) => (rows.find((r) => String(r.id) === id) ?? null) as Awaited<ReturnType<typeof t.builder.withdrawal>>;
    const wp = t.svc.withdrawals as WithdrawProcessor;
    const saga = () => Object.values(t.sagas.get().withdrawals)[0] as WithdrawSaga;
    /** recall -> the operator's withdrawal adopted + confirmed -> Orderly pays the EOA (COMPLETED) */
    const paidToEoa = async (amount: bigint, id = 71) => {
      const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, amount);
      await wp.onRequested(req);
      rows.push({ id, status: "COMPLETED", amountUsd: amount, clientRef: null, receiver: EOA, createdAt: t.ctx.now() });
      const nonce = req.nonce.toString();
      await wp.processNonce(1, nonce);
      t.chain.balances.set(EOA.toLowerCase(), (t.chain.balances.get(EOA.toLowerCase()) ?? 0n) + amount); // Orderly paid the EOA
      return nonce;
    };
    return { ...t, rows, wp, saga, paidToEoa };
  }

  test("waits (no venue POST, no attempt burnt, published) -> adopts the operator's withdrawal -> confirms -> waits for the return -> sweeps", async () => {
    const t = await setup();
    const amount = 10_000_000_000n;
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, amount);
    const saga = await t.wp.onRequested(req);
    expect([saga?.operatorIf, saga?.owner, saga?.requestBlock]).toEqual([true, EOA, req.block.toString()]);
    await t.wp.processAll();
    let s = t.saga();
    expect([s.stage, s.attempts, typeof s.operatorWaitSince]).toEqual(["detected", 0, "number"]);
    expect(t.calls.requestWithdraw).toBe(0); // ops-venue never signs for the operator's wallet
    expect(t.wp.ifOperatorWaits()).toEqual([{ bookId: 1, nonce: "1", step: "withdraw", amount: amount.toString(), owner: EOA, adapter: ADAPTER, since: s.operatorWaitSince as number }]);
    await t.svc.syncBooks();
    expect(t.last().ifOperatorWaits?.[0]?.step).toBe("withdraw");

    // a withdrawal of another amount is not adopted; the operator's own one (to its wallet) is
    t.rows.push({ id: 70, status: "PENDING", amountUsd: 1n, clientRef: null, receiver: EOA, createdAt: 5_000 });
    t.rows.push({ id: 71, status: "PENDING", amountUsd: amount, clientRef: null, receiver: EOA, createdAt: 6_000 });
    await t.wp.processNonce(1, "1");
    s = t.saga();
    expect([s.stage, s.withdrawId]).toEqual(["confirmed", "71"]);
    expect(t.chain.count("confirmWithdraw")).toBe(1);
    expect(t.sagas.get().ifAdopted?.[IF_ID.toLowerCase()]).toEqual(["71"]);

    // Orderly paid the EOA; nothing returned yet: waits for the operator's transfer
    (t.rows[1] as VenueWithdrawRow).status = "COMPLETED";
    t.chain.balances.set(EOA.toLowerCase(), amount);
    await t.wp.processNonce(1, "1");
    s = t.saga();
    expect([s.stage, s.attempts, typeof s.returnWaitSince]).toEqual(["confirmed", 0, "number"]);
    expect(t.wp.ifOperatorWaits()[0]?.step).toBe("return");
    expect(t.chain.count("sweepToVault")).toBe(0);

    t.chain.tokenTransfer(EOA, ADAPTER, amount); // the operator transfers the USDG back to the adapter
    await t.wp.processNonce(1, "1");
    expect(t.saga().stage).toBe("swept");
    expect(t.saga().returns?.length).toBe(1);
    expect(t.chain.bal(VAULT)).toBe(amount);
    expect(t.wp.ifOperatorWaits()).toEqual([]);
  });

  test("regression: funds in the operator's wallet never count as returned; other USDC on the adapter does not either", async () => {
    const t = await setup();
    const amount = 4_000_000_000n;
    const nonce = await t.paidToEoa(amount);
    expect(t.chain.bal(EOA)).toBe(amount); // the payout sits in the operator's wallet
    expect((await t.chain.adapterFlowState(ADAPTER)).usdcBalance).toBe(0n); // the flow view never counts the EOA
    await t.wp.processNonce(1, nonce);
    expect(t.saga().stage).toBe("confirmed");
    expect(t.wp.ifOperatorWaits()).toMatchObject([{ step: "return", nonce }]); // the return alert fires
    // USDC reaching the adapter from elsewhere (fees, an MM payout, a donation) is not this payout's return
    t.chain.balances.set(ADAPTER.toLowerCase(), amount);
    t.chain.tokenTransfer(EOA, VAULT, amount); // the operator sending it anywhere but the adapter does not count either
    t.advance(61_000);
    await t.wp.processNonce(1, nonce);
    expect(t.saga().stage).toBe("confirmed");
    expect(t.chain.count("sweepToVault")).toBe(0);
    // a too-small return is not enough (the operator returns the full amount)
    t.chain.balances.set(EOA.toLowerCase(), amount);
    t.chain.tokenTransfer(EOA, ADAPTER, amount - 1n);
    t.advance(61_000);
    await t.wp.processNonce(1, nonce);
    expect(t.saga().stage).toBe("confirmed");
  });

  test("one return transfer is claimed by one saga only", async () => {
    const t = await setup();
    const a = await t.paidToEoa(1_000_000_000n, 71);
    const b = await t.paidToEoa(1_000_000_000n, 72);
    t.chain.tokenTransfer(EOA, ADAPTER, 1_000_000_000n);
    await t.wp.processNonce(1, a);
    await t.wp.processNonce(1, b);
    const stages = Object.values(t.sagas.get().withdrawals).map((s) => [s.nonce, s.stage]);
    expect(stages).toEqual([
      [a, "swept"],
      [b, "confirmed"],
    ]);
  });

  test("unreturned past OPS_IF_RETURN_WRITE_OFF_MS: written off from NAV on-chain, published critical; a late return is still swept", async () => {
    const t = await setup();
    t.ctx.settings.ifReturnWriteOffMs = 3_600_000;
    const amount = 2_000_000_000n;
    const nonce = await t.paidToEoa(amount);
    await t.wp.processNonce(1, nonce);
    t.advance(3_599_000);
    await t.wp.processNonce(1, nonce);
    expect(t.chain.count("writeOffOperatorPayout")).toBe(0);
    t.advance(1_000);
    await t.wp.processNonce(1, nonce);
    expect(t.chain.count("writeOffOperatorPayout")).toBe(1);
    expect(t.chain.adapter(ADAPTER).inTransit).toBe(0n); // NAV no longer counts it
    expect(typeof t.saga().writtenOffAt).toBe("number");
    expect(t.wp.ifOperatorWaits()[0]).toMatchObject({ step: "return", writtenOffAt: t.saga().writtenOffAt });
    t.advance(61_000);
    await t.wp.processNonce(1, nonce);
    expect(t.chain.count("writeOffOperatorPayout")).toBe(1); // once
    t.chain.tokenTransfer(EOA, ADAPTER, amount); // the late return: swept to the vault as a gain
    t.advance(61_000);
    await t.wp.processNonce(1, nonce);
    expect(t.saga().stage).toBe("swept");
    expect(t.chain.bal(VAULT)).toBe(amount);
  });

  test("a return-wait does not freeze the book's venue reports; the operator's pending withdrawal (Requested) still does", async () => {
    const t = await setup();
    const book = t.svc.registry.get(1) as TrackedBook;
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, 1_000_000n);
    await t.wp.onRequested(req);
    await t.wp.processAll();
    expect(await t.svc.reporter.holdReason(book, t.chain.headTs)).toContain("withdrawal in flight");
    t.rows.push({ id: 80, status: "COMPLETED", amountUsd: 1_000_000n, clientRef: null, receiver: EOA, createdAt: t.ctx.now() });
    await t.wp.processNonce(1, "1");
    expect(t.saga().stage).toBe("confirmed");
    t.chain.adapter(ADAPTER).lastFlowAt = 0n;
    expect(await t.svc.reporter.holdReason(book, t.chain.headTs)).toBeNull();
  });

  test("an unreadable IF history (key not registered yet) waits too; MM withdrawals of the same book run as usual", async () => {
    const t = await setup();
    t.builder.withdrawals = async () => {
      throw new Error("orderly key not registered");
    };
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, 5_000_000n);
    await t.wp.onRequested(req);
    await t.wp.processAll();
    t.advance(61_000);
    await t.wp.processAll();
    const s = t.saga();
    expect([s.stage, s.attempts]).toEqual(["detected", 0]);
    const mm = await t.wp.onRequested(t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 1_000_000n));
    expect(mm?.operatorIf).toBeUndefined();
  });
});

describe("builder IF misuse detection", () => {
  test("a withdrawal from the builder IF account no saga adopted is published after the grace; adopted / acknowledged ones never", async () => {
    const t = await ifService({ mode: "builder", builderBound: true, expected: new Map([[1, IF_ID as string]]) });
    await t.svc.syncBooks();
    const rows: VenueWithdrawRow[] = [{ id: 90, status: "COMPLETED", amountUsd: 7_000_000n, clientRef: null, receiver: EOA, createdAt: t.ctx.now() }];
    t.builder.withdrawals = async () => rows.map((r) => ({ ...r })) as Awaited<ReturnType<typeof t.builder.withdrawals>>;
    await t.svc.withdrawals.processAll();
    expect(t.svc.withdrawals.ifUnadopted()).toEqual([]); // inside the grace (a pending saga may adopt it)
    t.advance(600_000);
    await t.svc.withdrawals.processAll();
    expect(t.svc.withdrawals.ifUnadopted()).toEqual([{ bookId: 1, accountId: IF_ID, id: "90", amount: "7000000", status: "COMPLETED", createdAt: rows[0]?.createdAt as number }]);
    await t.svc.syncBooks();
    expect(t.last().ifUnadopted?.[0]?.id).toBe("90");
    // acknowledged after review: no longer published; an adopted one (ledger) never is
    t.ctx.settings.ifWithdrawAck = new Set(["90"]);
    t.sagas.get().ifAdopted = { [IF_ID.toLowerCase()]: ["91"] };
    rows.push({ id: 91, status: "COMPLETED", amountUsd: 1n, clientRef: null, receiver: EOA, createdAt: 1 });
    t.advance(60_000);
    await t.svc.withdrawals.processAll();
    expect(t.svc.withdrawals.ifUnadopted()).toEqual([]);
  });

  test("venue IF equity below the adapter's insurance is an unexplained drop (published), equal is not", async () => {
    const t = await ifService({ mode: "builder", builderBound: true, expected: new Map([[1, IF_ID as string]]) });
    t.ctx.settings.reportSettleSec = 0;
    t.registerKey();
    await t.svc.syncBooks();
    t.mock.venue.credit(IF_ID, 25_000_000_000);
    t.mock.venue.credit(MM_ID, 75_000_000_000);
    t.mock.venue.setPrice("NVDA", 190, false);
    t.chain.headTs = BigInt(Math.floor(t.ctx.now() / 1000));
    const book = t.svc.registry.get(1) as TrackedBook;
    t.chain.adapter(ADAPTER).insurance = 25_000_000_000n;
    await t.svc.reporter.report(book);
    expect(t.svc.reporter.ifEquityDrops()).toEqual([]);
    t.chain.adapter(ADAPTER).insurance = 30_000_000_000n; // the adapter expects more than the venue shows
    t.advance(20_000);
    t.chain.headTs += 20n;
    await t.svc.reporter.report(book);
    expect(t.svc.reporter.ifEquityDrops()).toMatchObject([{ bookId: 1, accountId: IF_ID, expectedUsd: "30000000000", venueUsd: "25000000000" }]);
    await t.svc.syncBooks();
    expect(t.last().ifEquityDrops?.[0]?.bookId).toBe(1);
  });

  test("equity on the builder IF account before the book's deposit: recorded, reports refused, published; a rebound clears it", async () => {
    const t = await ifService({ mode: "builder", builderBound: true, expected: new Map([[1, IF_ID as string]]), state: "Subscription" });
    t.registerKey();
    await t.svc.syncBooks();
    t.mock.venue.credit(IF_ID, 3_000_000);
    t.advance(60_000);
    await t.svc.syncBooks();
    expect(t.sagas.get().ifPriorEquity?.[ADAPTER.toLowerCase()]?.usd).toBe("3000000");
    const book = t.svc.registry.get(1) as TrackedBook;
    expect(await t.svc.reporter.holdReason(book, 1n << 40n)).toContain("held 3000000");
    expect(t.last().ifAccounts?.map((x) => x.issue)).toContain("prior_equity");
  });
});

describe("IF account switch after tracking (rebound)", () => {
  test("re-read periodically even when Live; the old IF key is removed from Orderly and kept in history; re-assign notice", async () => {
    const t = await ifService({ mode: "contract", builderBound: false, listingMode: "api" });
    t.ctx.settings.ifBindingRecheckMs = 300_000;
    await t.svc.syncBooks();
    const oldKey = t.keys.loadBook(1)?.ops.if;
    expect(oldKey?.registeredAt).toBeTruthy();
    const removed: string[] = [];
    t.builder.removeKeyWith = async (accountId, _key, orderlyKey) => void removed.push(`${accountId}:${orderlyKey}`);
    // the timelock binds a builder EOA (mode contract now mismatches: still picked up, never ignored)
    t.chain.builderIfOwners.set(ADAPTER.toLowerCase(), EOA);
    t.chain.accountIds = async () => ({ if: OTHER_ID, mm: MM_ID });
    await t.svc.syncBooks();
    expect(t.svc.registry.get(1)?.accounts.if).toBe(IF_ID); // Live: not due yet
    t.advance(300_000);
    await t.svc.syncBooks();
    const book = t.svc.registry.get(1) as TrackedBook;
    expect([book.accounts.if, book.ifBinding]).toEqual([OTHER_ID, "builder"]);
    expect(removed).toEqual([`${IF_ID}:${oldKey?.orderlyKey}`]);
    expect(t.keys.loadBook(1)?.history.some((h) => h.orderlyKey === oldKey?.orderlyKey && h.reason === "if_account_switched")).toBe(true);
    expect(t.last().ifAccounts?.map((x) => x.issue).sort()).toEqual(["mismatch", "reassign"]);
  });
});

describe("builder IF mode is a fallback: refused on mainnet without the owner's sign-off", () => {
  test("ops-venue env: CHAIN_ID 4663 + builder needs ORDERLY_IF_MODE_BUILDER_ACK=1; live needs a known Orderly host", () => {
    const live = { ORDERLY_MODE: "live", ORDERLY_BROKER_ID: "bookrunner", ORDERLY_BASE_URL: "https://api.orderly.org", CHAIN_ID: "4663", ORDERLY_IF_MODE: "builder", ORDERLY_IF_BUILDER_ACCOUNTS: `1=${IF_ID}` };
    expect(() => loadOpsEnv(live)).toThrow(/ORDERLY_IF_MODE_BUILDER_ACK=1/);
    expect(loadOpsEnv({ ...live, ORDERLY_IF_MODE_BUILDER_ACK: "1" }).ORDERLY_IF_MODE).toBe("builder");
    expect(loadOpsEnv({ ...live, CHAIN_ID: "46630", ORDERLY_BASE_URL: "https://testnet-api.orderly.org" }).ORDERLY_IF_MODE).toBe("builder");
    expect(() => loadOpsEnv({ ORDERLY_MODE: "live", ORDERLY_BASE_URL: "https://orderly-proxy.internal" })).toThrow(/ORDERLY_IF_REQUIREMENT_USD/);
    expect(loadOpsEnv({ ORDERLY_MODE: "live", ORDERLY_BASE_URL: "https://orderly-proxy.internal", ORDERLY_IF_REQUIREMENT_USD: "100" }).ORDERLY_IF_REQUIREMENT_USD).toBe(100);
  });
});

describe("fix round 2: the write-off never depends on reading the operator's Orderly account", () => {
  async function confirmedSaga(o: { completed?: boolean } = {}) {
    const t = await ifService({ mode: "builder", builderBound: true, expected: new Map([[1, IF_ID as string]]) });
    t.ctx.settings.ifOperatorRecheckMs = 60_000;
    t.ctx.settings.ifReturnWriteOffMs = 3_600_000;
    await t.svc.syncBooks();
    const rows: VenueWithdrawRow[] = [];
    t.builder.withdrawals = async () => rows.map((r) => ({ ...r })) as Awaited<ReturnType<typeof t.builder.withdrawals>>;
    const wp = t.svc.withdrawals as WithdrawProcessor;
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, 3_000_000_000n);
    await wp.onRequested(req);
    rows.push({ id: 75, status: o.completed ? "COMPLETED" : "PENDING", amountUsd: 3_000_000_000n, clientRef: null, receiver: EOA, createdAt: t.ctx.now() });
    t.builder.withdrawal = async (_a, id) => (rows.find((r) => String(r.id) === id) ?? null) as Awaited<ReturnType<typeof t.builder.withdrawal>>;
    await wp.processNonce(1, "1");
    const saga = () => Object.values(t.sagas.get().withdrawals)[0] as WithdrawSaga;
    expect(saga().stage).toBe("confirmed");
    return { ...t, rows, wp, saga };
  }

  for (const [label, read] of [
    ["the Orderly read throws (key removed / Orderly down)", "throw"],
    ["the row is missing from the history", "missing"],
  ] as const) {
    test(`${label}: no attempt burnt, still published, written off at confirmation + limit`, async () => {
      const t = await confirmedSaga();
      t.builder.withdrawal = read === "throw" ? async () => Promise.reject(new Error("orderly auth: key removed")) : async () => null;
      for (let i = 0; i < 70; i++) {
        t.advance(50_000); // 58 min of retries (well past the old 40 attempts)
        await t.wp.processNonce(1, "1");
      }
      expect([t.saga().stage, t.saga().attempts]).toEqual(["confirmed", 0]);
      expect(t.wp.ifOperatorWaits()).toMatchObject([{ step: "payout", nonce: "1" }]);
      expect(t.chain.count("writeOffOperatorPayout")).toBe(0);
      t.advance(130_000); // past confirmation + 1 h
      await t.wp.processNonce(1, "1");
      expect(t.chain.count("writeOffOperatorPayout")).toBe(1);
      expect(t.chain.adapter(ADAPTER).inTransit).toBe(0n);
      expect(t.wp.ifOperatorWaits()[0]).toMatchObject({ step: "payout", writtenOffAt: t.saga().writtenOffAt });
      // the return is seen on-chain even though Orderly still cannot be read
      t.chain.balances.set(EOA.toLowerCase(), 3_000_000_000n);
      t.chain.tokenTransfer(EOA, ADAPTER, 3_000_000_000n);
      t.advance(61_000);
      await t.wp.processNonce(1, "1");
      expect(t.saga().stage).toBe("swept");
    });
  }

  test("reports stay held before Orderly COMPLETED; a withdrawal FAILED there is released (failWithdraw), never double counted", async () => {
    const t = await confirmedSaga();
    const book = t.svc.registry.get(1) as TrackedBook;
    t.chain.adapter(ADAPTER).lastFlowAt = 0n;
    expect(await t.svc.reporter.holdReason(book, t.chain.headTs)).toContain("withdrawal in flight");
    (t.rows[0] as VenueWithdrawRow).status = "FAILED"; // Orderly credits it back to the IF account
    t.advance(61_000);
    await t.wp.processNonce(1, "1");
    expect(t.saga().stage).toBe("cancelled");
    expect(t.chain.count("failWithdraw")).toBe(1);
    expect(t.chain.adapter(ADAPTER).inTransit).toBe(0n);
    t.chain.adapter(ADAPTER).lastFlowAt = 0n;
    expect(await t.svc.reporter.holdReason(book, t.chain.headTs)).toBeNull();
  });

  test("once COMPLETED was seen, the return-wait no longer holds reports", async () => {
    const t = await confirmedSaga({ completed: true });
    expect(typeof t.saga().returnWaitSince).toBe("number");
    t.chain.adapter(ADAPTER).lastFlowAt = 0n;
    expect(await t.svc.reporter.holdReason(t.svc.registry.get(1) as TrackedBook, t.chain.headTs)).toBeNull();
    expect(t.wp.ifOperatorWaits()[0]?.step).toBe("return");
  });

  test("written off without Orderly COMPLETED ever seen: reports no longer held; a later FAILED closes without failWithdraw", async () => {
    const t = await confirmedSaga();
    const book = t.svc.registry.get(1) as TrackedBook;
    const byId = t.builder.withdrawal;
    t.builder.withdrawal = async () => null; // the row never shows COMPLETED (key removed / history gap)
    t.chain.adapter(ADAPTER).lastFlowAt = 0n;
    expect(await t.svc.reporter.holdReason(book, t.chain.headTs)).toContain("withdrawal in flight");
    t.advance(3_700_000); // past confirmation + 1 h
    await t.wp.processNonce(1, "1");
    expect(t.chain.count("writeOffOperatorPayout")).toBe(1);
    expect([t.saga().stage, t.saga().returnWaitSince, typeof t.saga().writtenOffAt]).toEqual(["confirmed", undefined, "number"]);
    t.chain.adapter(ADAPTER).lastFlowAt = 0n;
    expect(await t.svc.reporter.holdReason(book, t.chain.headTs)).toBeNull();
    expect(t.wp.ifOperatorWaits()[0]).toMatchObject({ step: "payout", nonce: "1" }); // still published (critical) until back
    (t.rows[0] as VenueWithdrawRow).status = "FAILED"; // Orderly credits it back: venue-side again, counted by the report
    t.builder.withdrawal = byId;
    t.advance(61_000);
    await t.wp.processNonce(1, "1");
    expect(t.saga().stage).toBe("cancelled");
    expect(t.chain.count("failWithdraw")).toBe(0);
  });

  test("a FAILED withdraw saga is published for alerts", async () => {
    const t = await ifService({ mode: "contract", builderBound: false });
    await t.svc.syncBooks();
    t.builder.requestWithdraw = async () => {
      throw new Error("venue down");
    };
    t.builder.withdrawals = async () => [];
    const wp = t.svc.withdrawals as WithdrawProcessor;
    await wp.onRequested(t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 1_000_000n));
    for (let i = 0; i < 6; i++) await wp.processNonce(1, "1");
    expect(wp.failedSagas()).toMatchObject([{ bookId: 1, nonce: "1", account: ACCOUNT.MM, amount: "1000000", error: "venue down" }]);
    await t.svc.syncBooks();
    expect(t.last().failedWithdrawals?.[0]).toMatchObject({ bookId: 1, nonce: "1", account: ACCOUNT.MM });
  });

  test("client: a withdrawal beyond the first history page is found (paging stops on a short or repeated page)", async () => {
    const pages: number[] = [];
    const row = (id: number) => ({ id, trans_status: "COMPLETED", amount: 1, created_time: 1 });
    const fetch = (async (input: string) => {
      const page = Number(new URL(input).searchParams.get("page"));
      pages.push(page);
      const rows = page === 1 ? Array.from({ length: 100 }, (_, i) => row(1000 - i)) : page === 2 ? [row(7), row(6)] : [];
      return new Response(JSON.stringify({ success: true, data: { rows } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;
    const c = new OrderlyBuilderClient({ baseUrl: "http://orderly.test", mode: "mock", brokerId: "bookrunner", chainId: 31337, builderAccountId: "0xb1", builderKey: await generateKey(), signer: OPS, fetch });
    expect((await c.withdrawal("0xaa", "6"))?.id).toBe("6");
    expect(pages).toEqual([1, 2]);
    pages.length = 0;
    expect(await c.withdrawal("0xaa", "5")).toBeNull();
    expect(pages).toEqual([1, 2]); // page 2 is short: done
    // a server ignoring `page` (same rows every time) ends after the second read
    const same = (async () => new Response(JSON.stringify({ success: true, data: { rows: Array.from({ length: 100 }, (_, i) => row(i)) } }), { status: 200 })) as unknown as FetchLike;
    const c2 = new OrderlyBuilderClient({ baseUrl: "http://orderly.test", mode: "mock", brokerId: "bookrunner", chainId: 31337, builderAccountId: "0xb1", builderKey: await generateKey(), signer: OPS, fetch: same });
    expect(await c2.withdrawal("0xaa", "500")).toBeNull();
  });
});
