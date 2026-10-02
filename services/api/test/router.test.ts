import { describe, expect, test } from "bun:test";
import { KEYS, RECEIPT_KIND, RECEIPT_LEAF, PERIOD_LEAF, receiptsTree, strToBytes32, verifyProof } from "@bookrunner/shared";
import { mMMandateAbi, trancheAbi } from "@bookrunner/shared/abi";
import { TRPCError } from "@trpc/server";
import { decodeFunctionData, erc20Abi } from "viem";
import { limitsBucketSeconds } from "../src/routers/book";
import { hourlyTree, receiptsRootOf } from "../src/domain/receipts";
import { A } from "./fakes";
import { ALICE, BOOK, NOW, SPONSOR, makeWorld, seedBook, seedReceipts } from "./fixtures";

async function trpcErr(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error("expected a TRPCError");
}

describe("book router", () => {
  test("list: latest NAV, tranche NAVs + share prices, state, venue, symbol, limits", async () => {
    const w = makeWorld();
    seedBook(w);
    w.kv.put(KEYS.liveNav(1), { navUsd: "100350.5", ts: NOW - 5_000 });
    const [b] = await w.caller.book.list();
    expect(b).toMatchObject({
      bookId: 1,
      symbol: "PERP_NVDA_USDC",
      venue: "orderly",
      state: "Live",
      navUsd: "100300.000000",
      seniorNavUsd: "70100.000000",
      juniorNavUsd: "30200.000000",
      seniorSharePrice: "1.003",
      juniorSharePrice: "1.03",
    });
    expect(b!.lastMark?.markId).toBe(3);
    expect(b!.liveNav?.navUsd).toBe("100350.500000");
    expect(b!.limits).toMatchObject({ state: "warn", source: "db", inventoryUtil: 0.95 });
    expect(b!.components.mandate).toBe(BOOK.mandate);
  });

  test("list: live risk state in Redis wins over the limits table", async () => {
    const w = makeWorld();
    seedBook(w);
    w.kv.put(KEYS.riskState(1), { state: "breach", inventoryUtil: 1.2, skewUtil: 0.1, hedgeRatioBps: null, drawdownBps: -50, offHours: false, breaches: ["INVENTORY"], ts: NOW });
    const [b] = await w.caller.book.list();
    expect(b!.limits).toMatchObject({ state: "breach", breaches: ["INVENTORY"], source: "live" });
  });

  test("get: components, charter, mandate, latest mark, live NAV, chain overlay", async () => {
    const w = makeWorld();
    seedBook(w);
    w.kv.put(KEYS.agentHeartbeat(1), String(NOW - 2_000));
    w.kv.put(KEYS.agentQuote(1), { bookId: 1, ts: NOW, bid: 189.9, ask: 190.1, size: 5, mid: 190, oracle: 190, inventoryUsd: 0, skewBps: 0, widthBps: 10, sides: { bid: true, ask: true } });
    const g = await w.caller.book.get({ bookId: 1 });
    expect(g.source).toBe("chain");
    expect(g.seniorSharePrice).toBe("1.003");
    expect(g.seniorNavUsd).toBe("70150.000000");
    expect(g.charter?.ticker).toBe("NVDA");
    expect(g.mandate?.maxInventoryUsd).toBe("50000.000000");
    expect(g.latestMark?.receiptsRoot).toBeDefined();
    expect(g.agent.alive).toBe(true);
    expect(g.quote?.bid).toBe(189.9);
    expect(g.killed).toBe(false);

    w.chain.failAll = true; // RPC down: DB view still served
    const g2 = await w.caller.book.get({ bookId: 1 });
    expect(g2.source).toBe("db");
    expect(g2.seniorSharePrice).toBe("1.003");
    expect((await trpcErr(w.caller.book.get({ bookId: 9 }))).code).toBe("NOT_FOUND");
  });

  test("nav: ascending mark series + live point", async () => {
    const w = makeWorld();
    seedBook(w);
    w.kv.put(KEYS.liveNav(1), { navUsd: 100400, seniorNav: "70160", juniorNav: "30240" });
    const n = await w.caller.book.nav({ bookId: 1 });
    expect(n.points.map((p) => p.markId)).toEqual([1, 2, 3]);
    expect(n.points[0]).toMatchObject({ navUsd: "100100.000000", seniorSharePrice: "1.001", source: "mark" });
    expect(n.live).toMatchObject({ navUsd: "100400.000000", seniorNavUsd: "70160.000000", source: "live" });
    const ranged = await w.caller.book.nav({ bookId: 1, from: (NOW - 650_000) / 1000 });
    expect(ranged.points.map((p) => p.markId)).toEqual([2, 3]);
  });

  test("limits: latest + bucketed series + mandate bounds", async () => {
    const w = makeWorld();
    seedBook(w);
    const l = await w.caller.book.limits({ bookId: 1, from: new Date(NOW - 3_600_000).toISOString(), to: NOW, bucketSeconds: 3600 });
    expect(l.bucketSeconds).toBe(3600);
    expect(l.series).toHaveLength(1);
    expect(l.series[0]).toMatchObject({ inventoryUtilMax: 0.95, drawdownMin: -20, state: "warn", samples: 2, breaching: false });
    expect(l.latest?.state).toBe("warn");
    expect(l.mandate?.killAtDrawdownBps).toBe(-800);
    expect(limitsBucketSeconds(86_400_000)).toBe(300);
    expect(limitsBucketSeconds(60_000)).toBe(60);
    expect(limitsBucketSeconds(30 * 86_400_000, 60)).toBe(1296);
  });

  test("marks: paginated with roots", async () => {
    const w = makeWorld();
    seedBook(w);
    const p1 = await w.caller.book.marks({ bookId: 1, limit: 2 });
    expect(p1.items.map((m) => m.markId)).toEqual([3, 2]);
    expect(p1.items[0]).toHaveProperty("receiptsRoot");
    expect(p1.items[0]).toHaveProperty("inventoryRoot");
    expect(p1.nextCursor).toBe(2);
    const p2 = await w.caller.book.marks({ bookId: 1, limit: 2, cursor: 2 });
    expect(p2.items.map((m) => m.markId)).toEqual([1]);
    expect(p2.nextCursor).toBeNull();
  });
});

describe("tranche router", () => {
  test("subscribe: prepared [approve, deposit] inside the window", async () => {
    const w = makeWorld();
    seedBook(w, { state: "Subscription", subscriptionEndsIn: 300 });
    w.chain.setWallet(BOOK.senior, ALICE, { depositsOpen: true, committed: 0n, totalCommitted: 10_000_000_000n });
    const res = await w.caller.tranche.subscribe({ bookId: 1, tranche: "senior", amountUsd: "1500.5", wallet: ALICE });
    expect(res.txs).toHaveLength(2);
    const [approve, deposit] = res.txs;
    expect(approve!.to).toBe(w.chain.deployment.contracts.usdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data }).args).toEqual([BOOK.senior, 1_500_500_000n]);
    expect(deposit!.to).toBe(BOOK.senior);
    expect(decodeFunctionData({ abi: trancheAbi, data: deposit!.data }).args).toEqual([1_500_500_000n, ALICE]);
    expect(res.cap).toMatchObject({ perWalletCapUsd: "250000.000000", committedUsd: "0.000000", remainingUsd: "248499.500000", sponsorExempt: false });
    expect(res.window.depositsOpen).toBe(true);
  });

  test("subscribe in a Live top-up round: settles at the first mark at or after the round end, never 'window close'", async () => {
    const w = makeWorld();
    seedBook(w); // Live
    const key = BOOK.book.toLowerCase();
    const endsAt = NOW / 1000 + 30 * 86_400 + 1_009; // mid-period, like testnet's 16:16:49 round end
    w.chain.books.set(key, { ...w.chain.books.get(key)!, topUp: { open: true, endsAt } });
    w.chain.setWallet(BOOK.senior, ALICE, { depositsOpen: true, committed: 0n });
    const res = await w.caller.tranche.subscribe({ bookId: 1, tranche: "senior", amountUsd: "100", wallet: ALICE });
    const settles = Math.ceil(endsAt / 300) * 300; // fake markInterval 300 s
    const text = [...res.warnings, ...res.txs.map((t) => t.description)].join(" ");
    expect(text).not.toContain("window close");
    expect(res.warnings.join(" ")).toContain(`first mark at or after the round end (${new Date(settles * 1000).toISOString()})`);
    expect(res.txs.at(-1)!.description).toContain("accepted at the first mark at or after the round end (");
    // a subscription window keeps its own wording
    const sub = makeWorld();
    seedBook(sub, { state: "Subscription", subscriptionEndsIn: 300 });
    sub.chain.setWallet(BOOK.senior, ALICE, { depositsOpen: true, committed: 0n });
    const s = await sub.caller.tranche.subscribe({ bookId: 1, tranche: "senior", amountUsd: "100", wallet: ALICE });
    expect(s.txs.at(-1)!.description).toContain("allocated pro-rata at window close");
    // the per-wallet cap is per round
    w.chain.setWallet(BOOK.senior, ALICE, { depositsOpen: true, committed: 250_000_000_000n });
    expect((await trpcErr(w.caller.tranche.subscribe({ bookId: 1, tranche: "senior", amountUsd: "1", wallet: ALICE }))).message).toContain("USDC per round");
  });

  test("subscribe: window closed, paused, guardian pause, cap exceeded", async () => {
    const w = makeWorld();
    seedBook(w, { state: "Subscription", subscriptionEndsIn: -10 });
    w.chain.setWallet(BOOK.junior, ALICE, { depositsOpen: false });
    const closed = await trpcErr(w.caller.tranche.subscribe({ bookId: 1, tranche: "junior", amountUsd: 100, wallet: ALICE }));
    expect(closed.code).toBe("PRECONDITION_FAILED");
    expect(closed.message).toContain("window closed");

    w.chain.setWallet(BOOK.junior, ALICE, { depositsOpen: true, paused: true });
    expect((await trpcErr(w.caller.tranche.subscribe({ bookId: 1, tranche: "junior", amountUsd: 100, wallet: ALICE }))).message).toContain("paused");

    w.chain.setWallet(BOOK.junior, ALICE, { depositsOpen: true, committed: 249_000_000_000n });
    const capped = await trpcErr(w.caller.tranche.subscribe({ bookId: 1, tranche: "junior", amountUsd: "1000.000001", wallet: ALICE }));
    expect(capped.code).toBe("PRECONDITION_FAILED");
    expect(capped.message).toContain("at most 1000.000000 more");
    // sponsor is exempt from the per-wallet cap
    w.chain.setWallet(BOOK.junior, SPONSOR, { depositsOpen: true, committed: 249_000_000_000n });
    const sponsor = await w.caller.tranche.subscribe({ bookId: 1, tranche: "junior", amountUsd: "5000", wallet: SPONSOR });
    expect(sponsor.cap.sponsorExempt).toBe(true);

    w.chain.params_ = { ...w.chain.params_, newBooksPaused: true };
    expect((await trpcErr(w.caller.tranche.subscribe({ bookId: 1, tranche: "junior", amountUsd: 1, wallet: ALICE }))).message).toContain("guardian");
    expect((await trpcErr(w.caller.tranche.subscribe({ bookId: 1, tranche: "junior", amountUsd: 0, wallet: ALICE }))).code).toBe("BAD_REQUEST");
  });

  test("subscribe: falls back to indexed window/cap data when the RPC is down", async () => {
    const w = makeWorld();
    seedBook(w, { state: "Subscription", subscriptionEndsIn: 120 });
    w.data.subscriptions.push({ bookId: 1, tranche: "senior", wallet: ALICE.toLowerCase(), kind: "commit", round: 0, assets: "250000.000000" });
    w.chain.failAll = true;
    const e = await trpcErr(w.caller.tranche.subscribe({ bookId: 1, tranche: "senior", amountUsd: 1, wallet: ALICE }));
    expect(e.message).toContain("Per-wallet cap");
    w.data.subscriptions = [];
    const ok = await w.caller.tranche.subscribe({ bookId: 1, tranche: "senior", amountUsd: 1, wallet: ALICE });
    expect(ok.warnings.join(" ")).toContain("indexed data");
  });

  test("redeem: Junior eligibleAt = now + notice; settles at the first mark at/after it; notice is not a gate", async () => {
    const w = makeWorld();
    seedBook(w);
    w.chain.setWallet(BOOK.junior, ALICE, { shares: 10_000_000_000n });
    const r = await w.caller.tranche.redeem({ bookId: 1, tranche: "junior", shares: "2500", wallet: ALICE });
    const nowSec = NOW / 1000;
    expect(r.eligibleAtUnix).toBe(nowSec + 900);
    expect(r.noticeSeconds).toBe(900);
    expect(r.requestId).toBe(String(Math.ceil((nowSec + 900) / 300)));
    expect(Date.parse(r.settlesAtPeriodEnd) / 1000).toBe(Math.ceil((nowSec + 900) / 300) * 300);
    expect(r.notice.isGate).toBe(false);
    expect(r.notice.text).toContain("Notice is not a gate");
    expect(r.indicative).toMatchObject({ sharePrice: "1.03", valueUsd: "2575.000000", source: "chain" });
    expect(decodeFunctionData({ abi: trancheAbi, data: r.tx.data }).args).toEqual([2_500_000_000n, ALICE, ALICE]);

    w.chain.setWallet(BOOK.senior, ALICE, { shares: 1_000_000n });
    const s = await w.caller.tranche.redeem({ bookId: 1, tranche: "senior", shares: "1", wallet: ALICE });
    expect(s.eligibleAtUnix).toBe(nowSec);
    expect(s.noticeSeconds).toBe(0);
  });

  test("redeem: allowed in every book state (no permission gate), only share balance is checked", async () => {
    for (const state of ["Live", "Retiring", "Retired", "Cancelled", "Subscription"]) {
      const w = makeWorld();
      seedBook(w, { state });
      w.chain.params_ = { ...w.chain.params_, newBooksPaused: true };
      w.chain.setWallet(BOOK.senior, ALICE, { shares: 1_000_000n, depositsOpen: false, paused: true });
      const r = await w.caller.tranche.redeem({ bookId: 1, tranche: "senior", shares: "1", wallet: ALICE });
      expect(r.txs).toHaveLength(1);
    }
    const w = makeWorld();
    seedBook(w);
    w.chain.setWallet(BOOK.senior, ALICE, { shares: 1_000_000n });
    expect((await trpcErr(w.caller.tranche.redeem({ bookId: 1, tranche: "senior", shares: "2", wallet: ALICE }))).code).toBe("BAD_REQUEST");
  });

  test("position: shares, NAV value, pending/claimable redemptions, claimable allocation", async () => {
    const w = makeWorld();
    seedBook(w);
    const bucket = BigInt(Math.ceil((NOW / 1000 + 900) / 300));
    w.data.redemptions.push({
      id: 1,
      bookId: 1,
      tranche: "junior",
      wallet: ALICE.toLowerCase(),
      shares: "100.000000",
      noticeAt: new Date(NOW),
      honouredMarkId: null,
      requestId: bucket.toString(),
      eligibleAt: new Date(NOW + 900_000),
      assets: null,
      claimedAt: null,
      requestTx: "0xreq",
      logIndex: 0,
    });
    w.chain.setWallet(BOOK.senior, ALICE, { shares: 2_000_000_000n, navValue: 2_006_000_000n, claimableShares: 5n, claimableRefund: 7n });
    w.chain.setWallet(BOOK.junior, ALICE, { shares: 1_000_000_000n, navValue: 1_030_000_000n, claimableAssets: 3_000_000n, buckets: [{ requestId: bucket, pendingShares: 100_000_000n, claimableShares: 0n }] });
    const p = await w.caller.tranche.position({ bookId: 1, wallet: ALICE });
    expect(p.source).toBe("chain");
    const [s, j] = p.tranches;
    expect(s).toMatchObject({ tranche: "senior", shares: "2000.000000", navValueUsd: "2006.000000", claimableAllocation: { shares: "0.000005", refundUsd: "0.000007" } });
    expect(j).toMatchObject({ tranche: "junior", claimableRedemptionUsd: "3.000000" });
    expect(j!.redemptions).toEqual([expect.objectContaining({ requestId: bucket.toString(), status: "pending", shares: "100.000000" })]);
    expect(p.totals).toEqual({ navValueUsd: "3036.000000", claimableRedemptionUsd: "3.000000" });

    w.chain.failAll = true;
    const db = await w.caller.tranche.position({ bookId: 1, wallet: ALICE });
    expect(db.source).toBe("db");
    expect(db.tranches[0]!.shares).toBeNull();
    expect(db.tranches[1]!.redemptions[0]!.status).toBe("pending");
  });

  test("claim: allocation, redemptions, cancelled refunds", async () => {
    const w = makeWorld();
    seedBook(w);
    w.chain.setWallet(BOOK.senior, ALICE, { claimableShares: 10n, claimableAssets: 5n });
    const c = await w.caller.tranche.claim({ bookId: 1, wallet: ALICE });
    expect(c.txs.map((t) => decodeFunctionData({ abi: trancheAbi, data: t.data }).functionName)).toEqual(["claimAllocation", "claimRedemption"]);
    expect(c.txs.every((t) => t.to === BOOK.senior)).toBe(true);

    const none = await w.caller.tranche.claim({ bookId: 1, wallet: A(0x999) });
    expect(none.txs).toEqual([]);
    expect(none.message).toBe("Nothing to claim right now");

    const x = makeWorld();
    seedBook(x, { state: "Cancelled" });
    x.chain.setWallet(BOOK.junior, ALICE, { committed: 50_000_000n });
    const r = await x.caller.tranche.claim({ bookId: 1, wallet: ALICE, tranche: "junior" });
    expect(decodeFunctionData({ abi: trancheAbi, data: r.txs[0]!.data }).functionName).toBe("claimCancelledRefund");
    expect(r.claimable[0]!.cancelledRefundUsd).toBe("50.000000");
  });

  test("on-chain mutations without a deployment are PRECONDITION_FAILED", async () => {
    const w = makeWorld({ chain: false });
    seedBook(w, { state: "Subscription", subscriptionEndsIn: 100 });
    for (const p of [
      w.caller.tranche.subscribe({ bookId: 1, tranche: "senior", amountUsd: 1, wallet: ALICE }),
      w.caller.tranche.redeem({ bookId: 1, tranche: "senior", shares: 1, wallet: ALICE }),
      w.caller.tranche.claim({ bookId: 1, wallet: ALICE }),
      w.caller.agent.revoke({ bookId: 1, key: A(0xdd), reason: "X" }),
    ]) {
      const e = await trpcErr(p);
      expect(e.code).toBe("PRECONDITION_FAILED");
      expect(e.message).toContain("not deployed");
    }
  });
});

describe("agent router", () => {
  const KEY = A(0xde5c);
  const OP = A(0x0e11);

  test("register: prepared registerKey with tier >= maxInventory and bond check", async () => {
    const w = makeWorld();
    seedBook(w);
    w.chain.stake.set(OP.toLowerCase(), 30_000n * 10n ** 18n);
    const validUntil = NOW / 1000 + 86_400;
    const r = await w.caller.agent.register({ bookId: 1, key: KEY, operator: OP, validUntil, inventoryTierUsd: "50000" });
    expect(r.tx.to).toBe(BOOK.mandate);
    expect(decodeFunctionData({ abi: mMMandateAbi, data: r.tx.data }).args).toEqual([KEY, OP, BigInt(validUntil), 50_000_000_000n]);
    expect(r.signer).toBe(SPONSOR);
    expect(r.requiredBondBkrn).toBe("25000.0");

    expect((await trpcErr(w.caller.agent.register({ bookId: 1, key: KEY, operator: OP, validUntil, inventoryTierUsd: "49999" }))).code).toBe("BAD_REQUEST");
    expect((await trpcErr(w.caller.agent.register({ bookId: 1, key: KEY, operator: OP, validUntil: NOW / 1000 - 1, inventoryTierUsd: "50000" }))).code).toBe("BAD_REQUEST");
    w.chain.stake.set(OP.toLowerCase(), 1n);
    expect((await trpcErr(w.caller.agent.register({ bookId: 1, key: KEY, operator: OP, validUntil, inventoryTierUsd: "50000" }))).message).toContain("BKRN");
    w.chain.stake.set(OP.toLowerCase(), 10n ** 30n);
    w.chain.mandates.get(BOOK.mandate.toLowerCase())!.activeKeys = [KEY];
    expect((await trpcErr(w.caller.agent.register({ bookId: 1, key: KEY, operator: OP, validUntil, inventoryTierUsd: "50000" }))).code).toBe("CONFLICT");
    w.chain.mandates.get(BOOK.mandate.toLowerCase())!.killed = true;
    expect((await trpcErr(w.caller.agent.register({ bookId: 1, key: A(0x1), operator: OP, validUntil, inventoryTierUsd: "50000" }))).message).toContain("re-mandate");
  });

  test("register: a third-party operator's consentKey tx comes first (registerKey reverts OperatorConsentMissing without it)", async () => {
    const w = makeWorld();
    seedBook(w);
    w.chain.stake.set(OP.toLowerCase(), 30_000n * 10n ** 18n);
    const validUntil = NOW / 1000 + 86_400;
    const r = await w.caller.agent.register({ bookId: 1, key: KEY, operator: OP, validUntil, inventoryTierUsd: "50000" });
    expect(r.txs).toHaveLength(2);
    const consent = decodeFunctionData({ abi: mMMandateAbi, data: r.txs[0]!.data });
    expect(consent.functionName).toBe("consentKey");
    expect(consent.args).toEqual([KEY, true]);
    expect(r.txs[0]!.to).toBe(BOOK.mandate);
    expect(r.txs[0]!.signer).toBe(OP);
    expect(decodeFunctionData({ abi: mMMandateAbi, data: r.txs[1]!.data }).functionName).toBe("registerKey");
    expect(r.tx).toEqual(r.txs[1]!);
    expect(r.consentRequired).toBe(true);
    // consent already on-chain: only registerKey
    w.chain.consents.add(`${BOOK.mandate}|${OP}|${KEY}`.toLowerCase());
    const again = await w.caller.agent.register({ bookId: 1, key: KEY, operator: OP, validUntil, inventoryTierUsd: "50000" });
    expect(again.txs.map((t) => decodeFunctionData({ abi: mMMandateAbi, data: t.data }).functionName)).toEqual(["registerKey"]);
    // the sponsor bonding its own stake needs no consent
    w.chain.stake.set(SPONSOR.toLowerCase(), 30_000n * 10n ** 18n);
    const self = await w.caller.agent.register({ bookId: 1, key: A(0xbeef), operator: SPONSOR, validUntil, inventoryTierUsd: "50000" });
    expect(self.txs).toHaveLength(1);
    expect(self.consentRequired).toBe(false);
  });

  test("revoke: prepared revokeKey with bytes32 reason", async () => {
    const w = makeWorld();
    seedBook(w);
    w.chain.mandates.get(BOOK.mandate.toLowerCase())!.activeKeys = [KEY];
    const r = await w.caller.agent.revoke({ bookId: 1, key: KEY, reason: "OPERATOR_ROTATION" });
    expect(decodeFunctionData({ abi: mMMandateAbi, data: r.tx.data }).args).toEqual([KEY, strToBytes32("OPERATOR_ROTATION")]);
    expect(r.warnings).toEqual([]);
    const inactive = await w.caller.agent.revoke({ bookId: 1, key: A(0x2), reason: "X" });
    expect(inactive.warnings).toHaveLength(1);
    expect((await trpcErr(w.caller.agent.revoke({ bookId: 1, key: KEY, reason: "x".repeat(33) }))).code).toBe("BAD_REQUEST");
  });

  test("list: indexed keys + on-chain status + heartbeat", async () => {
    const w = makeWorld();
    seedBook(w);
    w.data.agentKeys.push({ bookId: 1, key: KEY.toLowerCase(), operator: OP.toLowerCase(), validUntil: new Date(NOW + 1e7), inventoryTierUsd: "50000.000000", status: "active", registeredTx: "0xr", revokedTx: null, revokedReason: null, updatedAt: new Date(NOW) });
    w.chain.mandates.get(BOOK.mandate.toLowerCase())!.activeKeys = [KEY, A(0x77777)];
    w.kv.put(KEYS.agentHeartbeat(1), String(NOW - 60_000));
    const l = await w.caller.agent.list({ bookId: 1 });
    expect(l.keys).toHaveLength(2);
    expect(l.keys[0]).toMatchObject({ key: KEY, activeOnChain: true, inventoryTierUsd: "50000.000000" });
    expect(l.keys[1]).toMatchObject({ operator: null, activeOnChain: true });
    expect(l.agent.alive).toBe(false);
    expect(l.killed).toBe(false);
  });
});

describe("risk / settlements / oracle / events", () => {
  test("risk.state: live Redis state + last limits row + kills", async () => {
    const w = makeWorld();
    seedBook(w);
    w.data.kills.push({ id: 1, bookId: 1, ts: new Date(NOW - 1000), reason: "INVENTORY", breaches: ["INVENTORY"], actions: ["cancel_all"], txHashes: ["0xk"] });
    let r = await w.caller.risk.state({ bookId: 1 });
    expect(r.state).toBe("warn");
    expect(r.live).toBeNull();
    expect(r.kills[0]?.reason).toBe("INVENTORY");
    w.kv.put(KEYS.riskState(1), { state: "killed", inventoryUtil: 1.1, skewUtil: 0, hedgeRatioBps: null, drawdownBps: -900, offHours: true, breaches: ["DRAWDOWN"], ts: NOW - 120_000, netExposureUsd: 55000 });
    r = await w.caller.risk.state({ bookId: 1 });
    expect(r.state).toBe("killed");
    expect(r.live?.netExposureUsd).toBe(55000);
    expect(r.liveStale).toBe(true);
    expect(r.latest?.state).toBe("warn");
  });

  test("settlements.list: paginated decimal strings", async () => {
    const w = makeWorld();
    seedBook(w);
    const s = await w.caller.settlements.list({ bookId: 1 });
    expect(s.items[0]).toMatchObject({ grossUsd: "100.000000", carryUsd: "9.900000", seniorUsd: "53.460000", source: "distribution" });
  });

  test("oracle.prices: Redis first, DB fallback, staleness", async () => {
    const w = makeWorld();
    w.kv.put(KEYS.oracleLast("NVDA"), { priceId: "NVDA", underlying: "0x", priceWad: "190000000000000000000", price: 190, publishedAt: NOW / 1000 - 10, held: false, sourceCount: 3, sources: [], sourcesHash: "0x", signature: "0x" });
    w.data.oraclePrices.push({ priceId: "TSLA", ts: new Date(NOW - 3_600_000), price: 440, held: true, sourceCount: 3, sources: [], sourcesHash: "0x", signature: "0x", pushedTx: null });
    const o = await w.caller.oracle.prices();
    expect(o.prices.map((p) => [p.priceId, p.source, p.stale])).toEqual([
      ["NVDA", "live", false],
      ["TSLA", "db", true],
    ]);
    const one = await w.caller.oracle.prices({ priceIds: ["TSLA"] });
    expect(one.prices).toHaveLength(1);
  });

  test("events.recent: newest first, filters", async () => {
    const w = makeWorld();
    for (let i = 1; i <= 5; i++) w.data.events.push({ id: i, type: i % 2 ? "mark.committed" : "book.live", bookId: i === 5 ? 2 : 1, payload: { i }, dedupeKey: null, createdAt: new Date(NOW + i) });
    const all = await w.caller.events.recent();
    expect(all.items.map((e) => e.id)).toEqual([5, 4, 3, 2, 1]);
    const marks = await w.caller.events.recent({ type: "mark.committed", bookId: 1 });
    expect(marks.items.map((e) => e.id)).toEqual([3, 1]);
  });
});

describe("receipts router", () => {
  test("root by hour: stored root, or computed from leaves", async () => {
    const w = makeWorld();
    seedBook(w);
    const { hour0 } = seedReceipts(w);
    const computed = await w.caller.receipts.root({ bookId: 1, hourStart: hour0.getTime() / 1000 + 17 }); // floored to the interval
    expect(computed).toMatchObject({ kind: "hour", computed: true, leafCount: 3 });
    const rows = w.data.receipts.filter((r) => r.hourStart.getTime() === hour0.getTime());
    // our tree over stored hashes equals the shared receiptsTree over payloads
    const shared = receiptsTree(rows.map((r) => ({ kind: r.kind as 0, bookId: 1n, ts: BigInt(Math.floor(r.ts.getTime() / 1000)), payload: r.payload })));
    expect("root" in computed && computed.root).toBe(shared.root);
    w.data.receiptRoots.push({ id: 1, bookId: 1, hourStart: hour0, root: shared.root, leafCount: 3, createdAt: new Date(NOW) });
    const stored = await w.caller.receipts.root({ bookId: 1, hourStart: hour0.toISOString() });
    expect(stored).toMatchObject({ computed: false, matches: true });
    expect((await trpcErr(w.caller.receipts.root({ bookId: 1, hourStart: NOW / 1000 }))).code).toBe("NOT_FOUND");
  });

  test("root by mark + proof: leaf -> hourly root -> mark receiptsRoot verify", async () => {
    const w = makeWorld();
    seedBook(w);
    const { hour0, hour1 } = seedReceipts(w);
    const byHour = (h: Date) => w.data.receipts.filter((r) => r.hourStart.getTime() === h.getTime());
    const t0 = hourlyTree(byHour(hour0));
    const t1 = hourlyTree(byHour(hour1));
    w.data.receiptRoots.push(
      { id: 1, bookId: 1, hourStart: hour0, root: t0.root, leafCount: t0.count, createdAt: new Date(NOW) },
      { id: 2, bookId: 1, hourStart: hour1, root: t1.root, leafCount: t1.count, createdAt: new Date(NOW) },
    );
    const periodRoot = receiptsRootOf(w.data.receiptRoots).root;
    w.data.marks.find((m) => m.id === 3)!.receiptsRoot = periodRoot;

    const root = await w.caller.receipts.root({ markId: 3 });
    expect(root).toMatchObject({ kind: "mark", matches: true, computedRoot: periodRoot });
    expect("hours" in root && root.hours).toHaveLength(2);

    const fill = w.data.receipts.find((r) => r.kind === RECEIPT_KIND.FILL)!;
    const p = await w.caller.receipts.proof({ receiptId: fill.id });
    expect(p.kindName).toBe("fill");
    expect(p.payloadHashMatches).toBe(true);
    expect(p.hourly).toMatchObject({ root: t0.root, matchesStored: true, verified: true, leafCount: 3 });
    expect(verifyProof(p.hourly.root, RECEIPT_LEAF, p.leaf.values, p.hourly.proof)).toBe(true);
    expect(p.period).toMatchObject({ markId: 3, receiptsRoot: periodRoot, matchesMark: true, verified: true, hours: 2 });
    expect(verifyProof(periodRoot, PERIOD_LEAF, p.period!.leaf.values, p.period!.proof)).toBe(true);
    expect(p.roots.receiptsRoot).toBe(periodRoot);

    // tampering with the committed root is detected
    w.data.marks.find((m) => m.id === 3)!.receiptsRoot = `0x${"ab".repeat(32)}`;
    const bad = await w.caller.receipts.proof({ receiptId: fill.id });
    expect(bad.period).toMatchObject({ matchesMark: false, verified: false });
    expect((await trpcErr(w.caller.receipts.proof({ receiptId: 9999 }))).code).toBe("NOT_FOUND");
  });

  test("mark roots built over the hours since the previous mark are matched too (missed period)", async () => {
    const w = makeWorld();
    seedBook(w);
    w.data.marks = w.data.marks.filter((m) => m.id !== 2); // mark #3 now follows mark #1 (periodEnd NOW-900)
    const early = new Date(NOW - 840_000); // outside [NOW-600, NOW-300) but after mark #1
    const payload = { early: true };
    w.data.receipts.push({ id: 700, bookId: 1, kind: RECEIPT_KIND.QUOTE, ts: new Date(early.getTime() + 1000), payload, payloadHash: `0x${"22".repeat(32)}`, hourStart: early });
    const { hour0 } = seedReceipts(w);
    const t0 = hourlyTree(w.data.receipts.filter((r) => r.hourStart.getTime() === hour0.getTime()));
    const te = hourlyTree(w.data.receipts.filter((r) => r.hourStart.getTime() === early.getTime()));
    w.data.receiptRoots.push(
      { id: 1, bookId: 1, hourStart: early, root: te.root, leafCount: te.count, createdAt: new Date(NOW) },
      { id: 2, bookId: 1, hourStart: hour0, root: t0.root, leafCount: t0.count, createdAt: new Date(NOW) },
    );
    w.data.marks.find((m) => m.id === 3)!.receiptsRoot = receiptsRootOf(w.data.receiptRoots).root;
    const root = await w.caller.receipts.root({ markId: 3 });
    expect(root).toMatchObject({ matches: true, periodStart: (NOW - 900_000) / 1000 });
    const p = await w.caller.receipts.proof({ receiptId: 700 });
    expect(p.period).toMatchObject({ markId: 3, matchesMark: true, verified: true, hours: 2 });
    // Date inputs (superjson clients) are accepted
    const byDate = await w.caller.receipts.root({ bookId: 1, hourStart: early });
    expect(byDate).toMatchObject({ kind: "hour", computed: false, matches: true });
  });

  test("proof for an hour not yet covered by a mark has no period section", async () => {
    const w = makeWorld();
    seedBook(w);
    w.data.receipts.push({ id: 500, bookId: 1, kind: 0, ts: new Date(NOW - 10_000), payload: { q: 1 }, payloadHash: `0x${"11".repeat(32)}`, hourStart: new Date(NOW - 60_000) });
    const p = await w.caller.receipts.proof({ receiptId: 500 });
    expect(p.period).toBeNull();
    expect(p.hourly.verified).toBe(true);
    expect(p.payloadHashMatches).toBe(false);
  });
});
