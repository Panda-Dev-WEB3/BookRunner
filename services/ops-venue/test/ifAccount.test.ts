// Insurance-fund account mode (ORDERLY_IF_MODE, docs/VERIFY.md O10): contract = the book's OrderlyIFAccount (delegate
// account, today's path), builder = an operator EOA's Orderly account bound on-chain by adapter.setIfAccountOwner and
// listed per book in ORDERLY_IF_BUILDER_ACCOUNTS. Mode selection, the binding checks (a mismatch never blocks another
// book), builder provisioning (no delegate / key registration by us), the operator-driven IF withdrawal and the
// strictly-greater IF requirement.
import { describe, expect, test } from "bun:test";
import { ACCOUNT, type VenueSymbolIssuesMsg } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { loadOpsEnv } from "../src/config";
import { type VenueWithdrawRow } from "../src/domain/withdraw";
import { ifAboveRequirement, ifAccountIssue, ifBindingOf, ORDERLY_IF_REQUIREMENT_USD, parseIfBuilderAccounts, resolveIfRequirementUsd } from "../src/domain/ifAccount";
import type { TrackedBook } from "../src/worker/context";
import { BookRegistry } from "../src/worker/books";
import { OpsService } from "../src/worker/service";
import { WithdrawProcessor } from "../src/worker/withdrawals";
import { ADAPTER, IF_ID, IF_OWNER, makeCtx, MM_ID, provisioner, SYMBOL, trackedBook, VAULT } from "./helpers";

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
    const e = loadOpsEnv({ ORDERLY_MODE: "live", ORDERLY_BROKER_ID: "bookrunner", ORDERLY_IF_MODE: "builder", ORDERLY_IF_BUILDER_ACCOUNTS: `1=${IF_ID}` });
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
    return { ...t, rows, wp };
  }

  test("waits (no venue POST, no attempt burnt, published) -> adopts the operator's withdrawal -> confirms -> waits for the return -> sweeps", async () => {
    const t = await setup();
    const amount = 10_000_000_000n;
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, amount);
    const saga = await t.wp.onRequested(req);
    expect(saga?.operatorIf).toBe(true);
    expect(saga?.owner).toBe(EOA);
    await t.wp.processAll();
    let s = t.wp.pending()[0];
    expect([s?.stage, s?.attempts, typeof s?.operatorWaitSince]).toEqual(["detected", 0, "number"]);
    expect(t.calls.requestWithdraw).toBe(0); // ops-venue never signs for the operator's wallet
    expect(t.wp.ifOperatorWaits()).toEqual([{ bookId: 1, nonce: "1", step: "withdraw", amount: amount.toString(), owner: EOA, adapter: ADAPTER, since: s?.operatorWaitSince as number }]);
    await t.svc.syncBooks();
    expect(t.last().ifOperatorWaits?.[0]?.step).toBe("withdraw");

    // a withdrawal of another amount is not adopted; the operator's own one (to its wallet) is
    t.rows.push({ id: 70, status: "PENDING", amountUsd: 1n, clientRef: null, receiver: EOA, createdAt: 5_000 });
    t.rows.push({ id: 71, status: "PENDING", amountUsd: amount, clientRef: null, receiver: EOA, createdAt: 6_000 });
    await t.wp.processNonce(1, "1");
    s = t.wp.pending()[0];
    expect([s?.stage, s?.withdrawId]).toEqual(["confirmed", "71"]);
    expect(t.chain.count("confirmWithdraw")).toBe(1);

    // Orderly paid the EOA; nothing on the adapter yet: waits for the operator's transfer
    (t.rows[1] as VenueWithdrawRow).status = "COMPLETED";
    await t.wp.processNonce(1, "1");
    s = t.wp.pending()[0];
    expect([s?.stage, s?.attempts, typeof s?.returnWaitSince]).toEqual(["confirmed", 0, "number"]);
    expect(t.wp.ifOperatorWaits()[0]?.step).toBe("return");
    expect(t.chain.count("sweepToVault")).toBe(0);

    t.chain.balances.set(ADAPTER.toLowerCase(), amount); // the operator transfers the USDG to the adapter
    await t.wp.processNonce(1, "1");
    expect(Object.values(t.sagas.get().withdrawals)[0]?.stage).toBe("swept");
    expect(t.chain.bal(VAULT)).toBe(amount);
    expect(t.wp.ifOperatorWaits()).toEqual([]);
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
    const s = Object.values(t.sagas.get().withdrawals)[0];
    expect([s?.stage, s?.attempts]).toEqual(["detected", 0]);
    const mm = await t.wp.onRequested(t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 1_000_000n));
    expect(mm?.operatorIf).toBeUndefined();
  });
});
