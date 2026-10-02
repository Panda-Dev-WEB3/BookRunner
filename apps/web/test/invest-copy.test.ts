// Invest-flow copy that encodes protocol behaviour (components/invest/investCopy.ts).
import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { INVEST_STEPS, killedDepositNote, noCancelLine, settlesClause, windowSentence } from "../src/components/invest/investCopy";
import { depositWindow } from "../src/components/invest/logic";

const HOUR = 3600;
// Book.topUp() on testnet: round ends 2026-11-01 16:16:49 UTC; the 17:00 UTC mark settles it.
const ENDS = 1_793_549_809;
const round = { bookId: 1, open: true, endsAt: ENDS, seniorCapacityUsd: 1n, juniorCapacityUsd: 1n };
const live = { state: "Live", subscriptionEndsSec: 1_790_948_492, topUp: round, nowSec: 1_790_960_000, markIntervalSec: HOUR };
const open = depositWindow(live);
const settling = depositWindow({ ...live, nowSec: ENDS + 60 });
const sub = depositWindow({ state: "Subscription", subscriptionEndsSec: 1_790_948_492, topUp: null, nowSec: 1_790_940_000, markIntervalSec: HOUR });

describe("settlement timing", () => {
  test("a top-up deposit settles at the first mark after the round END, with its date", () => {
    expect(settlesClause(open, "UTC")).toBe("at the first mark after the round ends (1 Nov 2026, 17:00 UTC)");
    expect(windowSentence(open, "UTC")).toBe(
      "A top-up round is open until 1 Nov 2026, 16:16 UTC. Deposits wait in escrow, cannot be cancelled, and are turned into shares at the first mark after the round ends (1 Nov 2026, 17:00 UTC), at that mark's share price.",
    );
    expect(windowSentence(settling, "UTC")).toContain("It settles at the first mark after that (1 Nov 2026, 17:00 UTC)");
  });

  test("the killed-book callout names the settling mark, not the next one", () => {
    expect(killedDepositNote(open, "UTC")).toBe(" Deposits are still accepted and settle at the first mark after the round ends (1 Nov 2026, 17:00 UTC), at that mark's share price.");
    expect(killedDepositNote(sub, "UTC")).toContain("allocated when the subscription window closes");
    expect(killedDepositNote(settling)).toBe("");
    expect(killedDepositNote({ status: "closed", why: "no-round" })).toBe("");
  });

  test("the three Invest steps never promise settlement at the next mark", () => {
    const deposit = INVEST_STEPS[2].body;
    expect(deposit).toContain("until the round ends");
    expect(deposit).toContain("first mark after the round end");
    for (const s of INVEST_STEPS) expect(s.body).not.toMatch(/next mark/i);
  });

  test("a commitment cannot be cancelled before its round settles (Tranche has no cancel path)", () => {
    expect(noCancelLine(open, "UTC")).toBe(
      "A deposit cannot be cancelled or withdrawn before the round settles (1 Nov 2026, 17:00 UTC). Withdrawals apply to shares after settlement. If the book retires first, the round is cancelled and the deposit is refunded in full.",
    );
    expect(noCancelLine(sub, "UTC")).toContain("A commitment cannot be cancelled or withdrawn before the window closes (");
    expect(noCancelLine({ status: "loading" })).toContain("cannot be cancelled or withdrawn before the round settles.");
    expect(INVEST_STEPS[2].body).toContain("cannot be cancelled");
    expect(windowSentence(open)).toContain("cannot be cancelled");
  });

  test("everything passes the copy rules", () => {
    const all = [...INVEST_STEPS.map((s) => s.body), noCancelLine(open), noCancelLine(sub), windowSentence(open), windowSentence(settling), windowSentence(sub), killedDepositNote(open), killedDepositNote(sub)];
    for (const w of ["no-round", "cancelled", "retiring", "retired", "unknown"] as const) all.push(windowSentence({ status: "closed", why: w }));
    for (const s of all) expect(checkCopy(s)).toEqual([]);
  });
});
