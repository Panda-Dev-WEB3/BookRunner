import { describe, expect, test } from "bun:test";
import { encodeFunctionData, getAddress } from "viem";
import { roomFigure, roomNote } from "../src/components/invest/investCopy";
import {
  bookRooms,
  checkDeposit,
  depositWindow,
  distributionShares,
  firstMarkAtOrAfter,
  indicativeShares,
  pctOfBps,
  positionFlags,
  priceWad,
  promptText,
  roundRoom,
  seniorCapRoom,
  seniorRoomPerJunior,
  seniorRoundRoom,
  sharesValue,
  walletRoom,
  withPlainPrompts,
} from "../src/components/invest/logic";
import { checkCopy } from "@bookrunner/shared/copy";

const U = 1_000_000n; // 1 USDC in base units
const HOUR = 3600;
// Book.topUp() on testnet: round ends 2026-11-01 16:16:49 UTC, 100k USDC per tranche.
const ENDS = 1_793_549_809;
const round = { bookId: 1, open: true, endsAt: ENDS, seniorCapacityUsd: 100_000n * U, juniorCapacityUsd: 100_000n * U };

describe("firstMarkAtOrAfter", () => {
  test("rounds up to the next period end", () => {
    expect(firstMarkAtOrAfter(ENDS, HOUR)).toBe(1_793_552_400); // 17:00 UTC
    expect(firstMarkAtOrAfter(1_793_552_400, HOUR)).toBe(1_793_552_400); // already on a period end
    expect(firstMarkAtOrAfter(1, HOUR)).toBe(HOUR);
  });
  test("guards a zero interval", () => {
    expect(firstMarkAtOrAfter(10, 0)).toBe(10);
  });
});

describe("depositWindow", () => {
  const live = { state: "Live", subscriptionEndsSec: 1_790_948_492, topUp: round, nowSec: ENDS - 1000, markIntervalSec: HOUR };

  test("open top-up round settles at the first mark after it ends", () => {
    expect(depositWindow(live)).toEqual({ status: "open", kind: "topup", endsAt: ENDS, settlesAt: 1_793_552_400 });
  });
  test("ended round is settling until the mark applies it", () => {
    expect(depositWindow({ ...live, nowSec: ENDS })).toEqual({ status: "settling", kind: "topup", endsAt: ENDS, settlesAt: 1_793_552_400 });
  });
  test("no round, loading and unreadable", () => {
    expect(depositWindow({ ...live, topUp: { ...round, open: false } })).toEqual({ status: "closed", why: "no-round" });
    expect(depositWindow({ ...live, topUp: undefined })).toEqual({ status: "loading" });
    expect(depositWindow({ ...live, topUp: null })).toEqual({ status: "closed", why: "no-round" });
  });
  test("pauses only matter while a round is open", () => {
    expect(depositWindow({ ...live, guardianPaused: true })).toMatchObject({ status: "paused", by: "guardian" });
    expect(depositWindow({ ...live, tranchePaused: true })).toMatchObject({ status: "paused", by: "tranche" });
    expect(depositWindow({ ...live, nowSec: ENDS + 5, tranchePaused: true }).status).toBe("settling");
  });
  test("subscription window", () => {
    const sub = { state: "Subscription", subscriptionEndsSec: 2_000, topUp: null, nowSec: 1_000, markIntervalSec: HOUR };
    expect(depositWindow(sub)).toEqual({ status: "open", kind: "subscription", endsAt: 2_000, settlesAt: 2_000 });
    expect(depositWindow({ ...sub, nowSec: 2_000 }).status).toBe("settling");
    expect(depositWindow({ ...sub, subscriptionEndsSec: null })).toEqual({ status: "closed", why: "unknown" });
  });
  test("other book states take no deposits", () => {
    for (const [state, why] of [
      ["Cancelled", "cancelled"],
      ["Retiring", "retiring"],
      ["Retired", "retired"],
      ["Weird", "unknown"],
    ] as const) {
      expect(depositWindow({ ...live, state })).toEqual({ status: "closed", why });
    }
  });
});

describe("capacity", () => {
  test("roundRoom", () => {
    expect(roundRoom(100n * U, 25n * U)).toEqual({ capacity: 100n * U, committed: 25n * U, remaining: 75n * U, over: false, filled: 0.25 });
    expect(roundRoom(100n * U, 150n * U)).toMatchObject({ remaining: 0n, over: true, filled: 1 });
    expect(roundRoom(0n, 0n)).toMatchObject({ remaining: 0n, over: false, filled: 0 });
  });
  test("seniorCapRoom mirrors Book._seniorTopUpRoom (S' <= J c / (1 - c))", () => {
    // testnet NVDA: S 73,518.96 · J 32,060.42 · cap 70% -> limit 74,807.66 -> room ~1,288.70
    const s = 73_518_963_306n;
    const j = 32_060_424_307n;
    expect(seniorCapRoom(s, j, 7000)).toBe((j * 7000n) / 3000n - s);
    expect(seniorCapRoom(80_000n * U, j, 7000)).toBe(0n);
    expect(seniorCapRoom(s, j, 10_000)).toBeNull();
    expect(seniorCapRoom(s, j, 0)).toBe(0n);
  });
  test("seniorRoundRoom counts Junior committed up to its capacity, minus Senior committed", () => {
    const base = { seniorNav: 70_000n * U, juniorNav: 30_000n * U, capBps: 7000 };
    // limit = 30k * 7/3 = 70k -> no room before Junior comes in
    expect(seniorRoundRoom({ ...base, senior: roundRoom(100_000n * U, 0n), junior: roundRoom(100_000n * U, 0n) })).toBe(0n);
    // 3k of Junior adds 7k of Senior room; 2k Senior already committed
    expect(seniorRoundRoom({ ...base, senior: roundRoom(100_000n * U, 2_000n * U), junior: roundRoom(100_000n * U, 3_000n * U) })).toBe(5_000n * U);
    // Junior above its capacity only counts up to the capacity
    expect(seniorRoundRoom({ ...base, senior: roundRoom(100_000n * U, 0n), junior: roundRoom(3_000n * U, 9_000n * U) })).toBe(7_000n * U);
    expect(seniorRoundRoom({ ...base, capBps: 10_000, senior: roundRoom(1n, 0n), junior: null })).toBeNull();
  });
  test("bookRooms: Senior room is min(capacity, Senior cap room), never the full capacity when the cap binds", () => {
    // live NVDA marked NAVs: S 73,529.28 · J 32,293.22 · cap 70% · 100k capacity per tranche
    const nav = { seniorNav: 73_529_280_000n, juniorNav: 32_293_220_000n, capBps: 7000 };
    const r = bookRooms({ topUp: round, committed: { senior: 0n, junior: 0n }, ...nav });
    expect(r.senior).toMatchObject({ capacity: 100_000n * U, remaining: 100_000n * U, left: 1_821_566_666n, capLimited: true, oversubscribed: false });
    expect(r.junior).toMatchObject({ left: 100_000n * U, capLimited: false, oversubscribed: false });
    expect(roomFigure(r.senior!)).toBe("0 of 100,000 USDC committed");
    expect(roomNote(r.senior!, 7000)).toBe("Limited by the 70% Senior cap: about 1,821 USDC can still be accepted, more if Junior grows (estimate from the last mark).");
    expect(roomNote(r.junior!, 7000)).toBeNull();
    // 50k of Senior committed is far above the cap room: oversubscribed although the capacity is not
    const over = bookRooms({ topUp: round, committed: { senior: 50_000n * U, junior: 0n }, ...nav }).senior!;
    expect(over).toMatchObject({ over: false, left: 0n, capLimited: true, oversubscribed: true });
    expect(roomNote(over, 7000)).toContain("Oversubscribed under the 70% Senior cap");
    // Junior committed this round adds Senior room (c / (1 - c) per USDC)
    const withJunior = bookRooms({ topUp: round, committed: { senior: 0n, junior: 3_000n * U }, ...nav }).senior!;
    expect(withJunior.left).toBe(((32_293_220_000n + 3_000n * U) * 7000n) / 3000n - 73_529_280_000n);
    // unknown NAVs or cap: capacity only; unknown committed totals: no room shown
    expect(bookRooms({ topUp: round, committed: { senior: 0n, junior: 0n }, seniorNav: null, juniorNav: null, capBps: 7000 }).senior).toMatchObject({ left: 100_000n * U, capLimited: false });
    expect(bookRooms({ topUp: round, committed: { senior: undefined, junior: null }, ...nav })).toEqual({ senior: null, junior: null });
    expect(bookRooms({ topUp: null, committed: { senior: 0n, junior: 0n }, ...nav })).toEqual({ senior: null, junior: null });
    // a cap at 100%, or a cap room above the capacity, leaves the capacity in charge
    expect(bookRooms({ topUp: round, committed: { senior: 0n, junior: 0n }, ...nav, capBps: 10_000 }).senior).toMatchObject({ capLimited: false });
    const small = { ...round, seniorCapacityUsd: 1_000n * U };
    expect(bookRooms({ topUp: small, committed: { senior: 1_200n * U, junior: 0n }, ...nav }).senior).toMatchObject({ capLimited: false, over: true, oversubscribed: true, left: 0n });
    for (const x of [r.senior!, over, withJunior]) expect(checkCopy(roomNote(x, 7000) ?? "")).toEqual([]);
  });
  test("seniorRoomPerJunior", () => {
    expect(seniorRoomPerJunior(7000)).toBeCloseTo(2.3333, 3);
    expect(seniorRoomPerJunior(10_000)).toBeNull();
  });
  test("walletRoom from Tranche.maxDeposit", () => {
    const cap = 250_000n * U;
    expect(walletRoom(undefined, 0n, cap)).toBeUndefined();
    expect(walletRoom(null, 0n, cap)).toBeUndefined();
    expect(walletRoom(2n ** 256n - 1n, 0n, cap)).toBeNull(); // sponsor / uncapped
    expect(walletRoom(cap - 10n * U, 10n * U, cap)).toBe(cap - 10n * U);
    expect(walletRoom(0n, cap, cap)).toBe(0n); // cap used up
    expect(walletRoom(0n, 0n, cap)).toBeUndefined(); // 0 because the round is closed
  });
});

describe("checkDeposit", () => {
  const base = { tranche: "junior" as const, balance: 10_000n * U, walletRoom: 250_000n * U, capacityRemaining: 100_000n * U };

  test("valid amount", () => {
    const c = checkDeposit("500", base);
    expect(c).toMatchObject({ raw: 500n * U, issue: null, error: null, warnings: [] });
    expect(c.max).toBe(10_000n * U); // smallest of balance, wallet room, capacity left
  });
  test("empty, zero and invalid", () => {
    expect(checkDeposit("", base)).toMatchObject({ issue: "empty", error: null, raw: null });
    expect(checkDeposit("0", base)).toMatchObject({ issue: "zero" });
    expect(checkDeposit("1.2.3", base).issue).toBe("invalid");
  });
  test("balance and per-wallet cap block", () => {
    expect(checkDeposit("20000", base)).toMatchObject({ issue: "exceeds-balance", raw: null });
    const capped = checkDeposit("600", { ...base, walletRoom: 500n * U });
    expect(capped.issue).toBe("above-max");
    expect(capped.error).toBe("Above the per-wallet cap: you can add at most 500.00 USDC in this round.");
    expect(checkDeposit("1", { ...base, walletRoom: 0n }).error).toBe("You have reached the per-wallet cap for this round.");
    expect(checkDeposit("600", { ...base, walletRoom: null }).issue).toBeNull(); // no cap
  });
  test("capacity and the Senior cap only warn", () => {
    const over = checkDeposit("5000", { ...base, capacityRemaining: 1_000n * U });
    expect(over.issue).toBeNull();
    expect(over.warnings).toHaveLength(1);
    expect(over.warnings[0]).toContain("pro-rata");
    expect(over.max).toBe(1_000n * U);
    const full = checkDeposit("5", { ...base, capacityRemaining: 0n });
    expect(full.warnings[0]).toContain("fully committed");
    expect(full.max).toBe(10_000n * U); // nothing left: Max falls back to balance / wallet room
    const senior = checkDeposit("2000", { ...base, tranche: "senior", seniorRoom: 1_288n * U });
    expect(senior.warnings.some((w) => w.includes("Senior can only grow") && w.includes("its cap"))).toBe(true);
    const named = checkDeposit("2000", { ...base, tranche: "senior", seniorRoom: 1_288n * U, seniorCapBps: 7000 });
    expect(named.warnings[0]).toContain("Senior can only grow by about 1,288.00 USDC before it reaches 70% of the book");
    expect(checkDeposit("2000", { ...base, tranche: "junior", seniorRoom: 1_288n * U }).warnings).toHaveLength(0);
  });
  test("unknown balance leaves Max off", () => {
    expect(checkDeposit("1", { ...base, balance: undefined }).max).toBeNull();
  });
  test("messages pass the copy rules", () => {
    const texts = [
      checkDeposit("600", { ...base, walletRoom: 500n * U }).error,
      checkDeposit("1", { ...base, walletRoom: 0n }).error,
      ...checkDeposit("5000", { ...base, capacityRemaining: 1_000n * U }).warnings,
      ...checkDeposit("5", { ...base, capacityRemaining: 0n }).warnings,
      ...checkDeposit("2000", { ...base, tranche: "senior", seniorRoom: 1n }).warnings,
    ];
    for (const t of texts) expect(checkCopy(t ?? "")).toEqual([]);
  });
});

describe("shares", () => {
  test("priceWad", () => {
    expect(priceWad("1.0")).toBe(10n ** 18n);
    expect(priceWad("1.000258004163265306")).toBe(1_000_258_004_163_265_306n);
    expect(priceWad("0")).toBeNull();
    expect(priceWad(null)).toBeNull();
    expect(priceWad("abc")).toBeNull();
  });
  test("indicativeShares floors amount / price", () => {
    expect(indicativeShares(500n * U, "1.0")).toBe(500n * U);
    expect(indicativeShares(500n * U, "1.25")).toBe(400n * U);
    expect(indicativeShares(100n * U, "1.000258004163265306")).toBe(99_974_206n);
    expect(indicativeShares(1n, null)).toBeNull();
  });
  test("sharesValue floors shares * price", () => {
    expect(sharesValue(400n * U, "1.25")).toBe(500n * U);
    expect(sharesValue(12_600n * U, "1.017791247841269841")).toBe(12_824_169_722n);
  });
});

describe("positionFlags", () => {
  const empty = { shares: "0.000000", committedUsd: "0.000000", claimableAllocation: { shares: "0.000000", refundUsd: "0.000000" }, claimableRedemptionUsd: "0.000000", redemptions: [] };
  test("nothing held", () => {
    expect(positionFlags([{ tranche: "senior", ...empty }, { tranche: "junior", ...empty }])).toMatchObject({ anything: false, pendingRequests: 0 });
  });
  test("an unclaimed allocation and pending requests", () => {
    const f = positionFlags([
      { tranche: "senior", ...empty, redemptions: [{ status: "pending" }, { status: "claimed" }] },
      { tranche: "junior", ...empty, claimableAllocation: { shares: "12600.000000", refundUsd: "0.000000" } },
    ]);
    expect(f).toMatchObject({ allocationToClaim: true, redemptionToClaim: false, hasShares: false, pendingRequests: 1, anything: true });
  });
  test("shares, commitments and settled withdrawals; null fields from indexed data", () => {
    const f = positionFlags([
      { tranche: "senior", ...empty, shares: "10.5", committedUsd: null, claimableAllocation: null, claimableRedemptionUsd: "3" },
      { tranche: "junior", ...empty, shares: null, committedUsd: "1" },
    ]);
    expect(f).toMatchObject({ hasShares: true, hasCommitted: true, redemptionToClaim: true, allocationToClaim: false });
  });
});

describe("plain-language wallet prompts", () => {
  const senior = getAddress("0xFe4ac74d2275ca1bCef70146Cca16d07F7E5ade9");
  const junior = getAddress("0x4d15C8c8be3682ab440AF7Ab13aBA9Fdf94d82e3");
  const usdc = getAddress("0x1111111111111111111111111111111111111111");
  const me = getAddress("0x2222222222222222222222222222222222222222");
  const ctx = { book: "NVDA", tranches: { senior, junior }, settlesText: "1 Nov 2026, 17:00 UTC", eligibleText: "2 Oct 2026, 18:15 UTC" };
  const tx = (to: string, data: string) => ({ to, data, value: "0", chainId: 46630, description: "api text" });
  const abi = [
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
    { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "a", type: "uint256" }, { name: "r", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
    { type: "function", name: "requestRedeem", stateMutability: "nonpayable", inputs: [{ name: "s", type: "uint256" }, { name: "c", type: "address" }, { name: "o", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
    { type: "function", name: "claimAllocation", stateMutability: "nonpayable", inputs: [{ name: "w", type: "address" }], outputs: [] },
    { type: "function", name: "claimRedemption", stateMutability: "nonpayable", inputs: [{ name: "c", type: "address" }, { name: "r", type: "address" }], outputs: [] },
    { type: "function", name: "claimCancelledRefund", stateMutability: "nonpayable", inputs: [{ name: "w", type: "address" }], outputs: [] },
    { type: "function", name: "somethingElse", stateMutability: "nonpayable", inputs: [], outputs: [] },
  ] as const;

  const approve = tx(usdc, encodeFunctionData({ abi, functionName: "approve", args: [senior, 500n * U] }));
  const deposit = tx(senior, encodeFunctionData({ abi, functionName: "deposit", args: [500n * U, me] }));
  const redeem = tx(junior, encodeFunctionData({ abi, functionName: "requestRedeem", args: [12n * U, me, me] }));

  test("approve names the tranche and says no USDC moves", () => {
    expect(promptText(approve, ctx)).toBe("Allow NVDA Senior to move up to 500.00 USDC from your wallet. This only sets a spending limit: no USDC moves yet.");
  });
  test("deposit says when the round settles", () => {
    expect(promptText(deposit, ctx)).toBe("Deposit 500.00 USDC into NVDA Senior. It waits there until the round settles (1 Nov 2026, 17:00 UTC) and cannot be cancelled before then.");
    expect(promptText(deposit, { ...ctx, settlesText: null })).toBe("Deposit 500.00 USDC into NVDA Senior. It waits there until the round settles and cannot be cancelled before then.");
  });
  test("withdrawal request and claims", () => {
    expect(promptText(redeem, ctx)).toContain("Ask to withdraw 12.00 NVDA Junior shares");
    expect(promptText(redeem, ctx)).toContain("2 Oct 2026, 18:15 UTC");
    // a mark only settles the request: collecting the USDC is a separate claim
    expect(promptText(redeem, ctx)).toContain("settle at the first mark on or after");
    expect(promptText(redeem, ctx)).toContain("collect the USDC in a separate transaction");
    expect(promptText(tx(junior, encodeFunctionData({ abi, functionName: "claimAllocation", args: [me] })), ctx)).toBe(
      "Collect your NVDA Junior shares from the settled round, plus any USDC refund.",
    );
    expect(promptText(tx(senior, encodeFunctionData({ abi, functionName: "claimRedemption", args: [me, me] })), ctx)).toBe("Collect the USDC from your settled NVDA Senior withdrawals.");
    expect(promptText(tx(senior, encodeFunctionData({ abi, functionName: "claimCancelledRefund", args: [me] })), ctx)).toContain("Take back your full NVDA Senior deposit");
  });
  test("unknown calls and bad calldata keep the API's description", () => {
    expect(promptText(tx(senior, encodeFunctionData({ abi, functionName: "somethingElse" })), ctx)).toBe("api text");
    expect(promptText(tx(senior, "0x1234"), ctx)).toBe("api text");
  });
  test("withPlainPrompts keeps every other field and passes the copy rules", () => {
    const out = withPlainPrompts([approve, deposit, redeem], ctx);
    expect(out.map((t) => t.data)).toEqual([approve.data, deposit.data, redeem.data]);
    expect(out.map((t) => t.to)).toEqual([usdc, senior, junior]);
    for (const t of out) expect(checkCopy(t.description)).toEqual([]);
  });
});

describe("terms", () => {
  test("distributionShares", () => {
    expect(distributionShares(6000)).toEqual({ senior: 6000, junior: 4000 });
    expect(distributionShares(12_000)).toEqual({ senior: 10_000, junior: 0 });
  });
  test("pctOfBps", () => {
    expect(pctOfBps(6000)).toBe("60%");
    expect(pctOfBps(1250)).toBe("12.5%");
    expect(pctOfBps(null)).toBe("—");
  });
});
