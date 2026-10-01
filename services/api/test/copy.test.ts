// Copy rules (ARCHITECTURE §6): no APY/yield/returns/target/guaranteed/protected/insured/... in any
// human text the API returns: tx descriptions, validation messages, notices, warnings, errors, MCP.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkCopy } from "@bookrunner/shared";
import { TRPCError } from "@trpc/server";
import { zeroHash } from "viem";
import { validateCharterLocal } from "../src/domain/charter";
import { NOTICE_TEXT } from "../src/domain/redemption";
import {
  approveBkrnTx,
  approveUsdcTx,
  claimAllocationTx,
  claimCancelledRefundTx,
  claimRedemptionTx,
  committeeVoteTx,
  depositTx,
  fileCharterTx,
  registerKeyTx,
  requestRedeemTx,
  revokeKeyTx,
  stakeTx,
} from "../src/domain/txs";
import { MCP_TOOLS } from "../src/mcp";
import { REASON_TEXT } from "../src/routers/charter";
import { A } from "./fakes";
import { ALICE, BOOK, makeWorld, sampleCharter, sampleDraft, seedBook } from "./fixtures";

const expectClean = (texts: string[]) => {
  const bad = texts.flatMap((t) => checkCopy(t).map((v) => `${v.term}: ${t}`));
  expect(bad).toEqual([]);
};

async function msg(p: Promise<unknown>): Promise<string[]> {
  try {
    const r = (await p) as { warnings?: string[]; message?: string; txs?: Array<{ description: string }>; notice?: { text: string } } | undefined;
    return [...(r?.warnings ?? []), ...(r?.message ? [r.message] : []), ...(r?.txs ?? []).map((t) => t.description), ...(r?.notice ? [r.notice.text] : [])];
  } catch (e) {
    return e instanceof TRPCError ? [e.message] : [String(e)];
  }
}

describe("copy rules", () => {
  test("static catalogs: reasons, notice, MCP tools", () => {
    expectClean([...Object.values(REASON_TEXT), NOTICE_TEXT, ...Object.values(MCP_TOOLS).flatMap((t) => [t.title, t.description])]);
  });

  test("every prepared tx description", () => {
    const c = sampleCharter();
    expectClean(
      [
        approveUsdcTx(1, A(1), A(2), 5n, "the flat charter fee (refundable on rejection)"),
        approveBkrnTx(1, A(1), A(2), 5n, "staking (sponsor bond)"),
        stakeTx(1, A(1), 5n),
        fileCharterTx(1, A(1), c, "PERP_NVDA_USDC"),
        committeeVoteTx(1, A(1), 1, true),
        committeeVoteTx(1, A(1), 1, false),
        depositTx(1, A(1), 5n, A(2), "the Senior tranche of book #1 (PERP_NVDA_USDC)"),
        requestRedeemTx(1, A(1), 5n, A(2), "Junior (book #1)"),
        claimAllocationTx(1, A(1), A(2), "Senior"),
        claimRedemptionTx(1, A(1), A(2), "Senior"),
        claimCancelledRefundTx(1, A(1), A(2), "Junior"),
        registerKeyTx(1, A(1), A(2), A(3), 1n, 5n),
        revokeKeyTx(1, A(1), A(2), "ROTATION"),
      ].map((t) => t.description),
    );
  });

  test("every local validation message", () => {
    const c = structuredClone(sampleCharter());
    c.venue = 9 as never;
    c.oracle = 9 as never;
    c.seniorHurdleBps = 20_000;
    c.seniorCapBps = 0;
    c.subscriptionWindow = 1;
    c.juniorNoticeSeconds = 10n ** 9n;
    c.mandate = { ...c.mandate, maxInventoryUsd: 0n, minQuoteWidthBps: 0, hedgeRatioMinBps: 2, hedgeRatioMaxBps: 1, killAtDrawdownBps: 1, maxSkewBps: 0 };
    c.underlying = zeroHash;
    c.symbol = zeroHash;
    const e = structuredClone(sampleCharter());
    e.venue = 1;
    e.ifTargetUsd = 1n;
    e.takerFeeBps = 500;
    const msgs = [...validateCharterLocal(c, { newBooksPaused: true }), ...validateCharterLocal(e)].map((i) => i.message);
    expect(msgs.length).toBeGreaterThanOrEqual(13);
    expectClean(msgs);
  });

  test("warnings and errors returned by the procedures", async () => {
    const w = makeWorld();
    seedBook(w, { state: "Subscription", subscriptionEndsIn: 120 });
    w.chain.usdc = { balance: 1n, allowance: 0n };
    const out: string[] = [];
    out.push(...(await msg(w.caller.charter.file(sampleDraft()))));
    out.push(...(await msg(w.caller.charter.file(sampleDraft({ underlying: { index: "IDX" }, ifTargetUsd: "1", symbol: "" })))));
    out.push(...(await msg(w.caller.tranche.subscribe({ bookId: 1, tranche: "senior", amountUsd: 10, wallet: ALICE }))));
    w.chain.setWallet(BOOK.junior, ALICE, { depositsOpen: true, committed: 250_000_000_000n });
    out.push(...(await msg(w.caller.tranche.subscribe({ bookId: 1, tranche: "junior", amountUsd: 10, wallet: ALICE }))));
    w.chain.setWallet(BOOK.junior, ALICE, { depositsOpen: false });
    out.push(...(await msg(w.caller.tranche.subscribe({ bookId: 1, tranche: "junior", amountUsd: 10, wallet: ALICE }))));
    out.push(...(await msg(w.caller.tranche.redeem({ bookId: 1, tranche: "junior", shares: 10, wallet: ALICE }))));
    w.chain.setWallet(BOOK.senior, ALICE, { shares: 10_000_000n, claimableShares: 1n, claimableAssets: 1n });
    out.push(...(await msg(w.caller.tranche.redeem({ bookId: 1, tranche: "senior", shares: 10, wallet: ALICE }))));
    out.push(...(await msg(w.caller.tranche.claim({ bookId: 1, wallet: ALICE }))));
    out.push(...(await msg(w.caller.agent.register({ bookId: 1, key: A(5), operator: A(6), validUntil: 1, inventoryTierUsd: 1 }))));
    out.push(...(await msg(w.caller.agent.register({ bookId: 1, key: A(5), operator: A(6), validUntil: 4_000_000_000, inventoryTierUsd: 1 }))));
    out.push(...(await msg(w.caller.agent.register({ bookId: 1, key: A(5), operator: A(6), validUntil: 4_000_000_000, inventoryTierUsd: 50_000 }))));
    out.push(...(await msg(w.caller.agent.revoke({ bookId: 1, key: A(5), reason: "TEST" }))));
    out.push(...(await msg(w.caller.charter.decide({ charterId: 1, member: A(5), approve: true }))));
    out.push(...(await msg(w.caller.book.get({ bookId: 77 }))));
    w.setChain(false);
    out.push(...(await msg(w.caller.charter.file(sampleDraft()))));
    out.push(...(await msg(w.caller.tranche.claim({ bookId: 1, wallet: ALICE }))));
    expect(out.length).toBeGreaterThan(15);
    expectClean(out);
  });

  test("no banned term in any prose string literal under src/", () => {
    const root = resolve(import.meta.dir, "../src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    const prose: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      for (const m of src.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
        const s = (m[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
        if (/[a-zA-Z]{3,}\s+[a-zA-Z]/.test(s)) prose.push(s);
      }
    }
    expect(prose.length).toBeGreaterThan(50);
    expectClean(prose);
  });
});
