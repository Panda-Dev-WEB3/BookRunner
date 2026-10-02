// Tolerant parsers: activity feeds, jury verdicts, mark PnL statements, API / wallet errors.
import { describe, expect, test } from "bun:test";
import { describeError, errorCode, isMissingProcedure } from "../src/lib/errors";
import { hedgeQty, parseFills, parseHedges, parseReceipts } from "../src/lib/feeds";
import { jurorLabel, parseVerdict, seatLabel } from "../src/lib/jury";
import { markStatements, parseMarkStatement, wadToNumber } from "../src/lib/markStatement";

describe("feeds", () => {
  test("fills: accepts {items} or arrays, drops malformed rows, newest first", () => {
    const rows = parseFills({
      items: [
        { ts: "2026-10-02T06:00:00Z", side: "buy", qty: 1, px: 190, feeUsd: "0.1", venueTradeId: "t1" },
        { ts: 1790921100, side: "sell", qty: "2", px: "191", venueTradeId: 7, maker: false, receiptId: "12" },
        { ts: "x", side: "buy", qty: 1, px: 1 },
        { ts: "2026-10-02T06:00:00Z", side: "hold", qty: 1, px: 1 },
        null,
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ side: "sell", qty: 2, px: 191, maker: false, receiptId: 12, venueTradeId: "7" });
    expect(rows[1]).toMatchObject({ feeUsd: 0.1, maker: true, receiptId: null });
    expect(parseFills("nope")).toEqual([]);
  });
  test("hedges and receipts", () => {
    const h = parseHedges([{ ts: "2026-10-02T06:00:00Z", px: 190, qtyRaw: "-1500000000000000000", asset: "0xabc", txHash: "0x1" }]);
    expect(h[0]).toMatchObject({ venue: "UNIV3", mult: 1, qtyRaw: "-1500000000000000000" });
    expect(hedgeQty("-1500000000000000000")).toBe(-1.5);
    expect(hedgeQty("5")).toBe(5e-18);
    expect(hedgeQty("1.5")).toBeNull();
    const r = parseReceipts({ items: [{ id: 3, kind: 1, ts: 1790921100 }, { receiptId: 9, kind: 0, ts: "2026-10-02T06:00:00Z", kindName: "quote" }, { kind: 1 }] });
    expect(r.map((x) => [x.id, x.kindName])).toEqual([
      [9, "quote"],
      [3, "fill"],
    ]);
  });
});

describe("jury verdict", () => {
  test("parses models, rule checks and tally; unknown votes abstain", () => {
    const v = parseVerdict({
      summary: "2 of 3 jurors approve",
      models: [
        { model: "claude-x", vote: "approve", rationale: "Mandate is conservative", risks: ["oracle staleness"] },
        { model: "rules:conservative", vote: "reject", rationale: "IF small" },
        { model: "m3", vote: "maybe", error: "timeout" },
      ],
      ruleChecks: [{ id: "if_min", status: "pass", detail: "IF meets the venue minimum", metrics: { ifUsd: 25000 } }, { id: "x", status: "odd" }],
      tally: { seats: 3, approve: 2, reject: 1, abstain: 0 },
      approvalsRequired: 2,
    });
    expect(v?.models.map((m) => m.vote)).toEqual(["approve", "reject", "abstain"]);
    expect(v?.models[2]?.error).toBe("timeout");
    expect(v?.ruleChecks[0]?.metrics).toEqual({ ifUsd: "25000" });
    expect(v?.ruleChecks[1]?.status).toBe("info");
    expect(v?.tally).toEqual({ seats: 3, approve: 2, reject: 1, abstain: 0 });
    expect(v?.placeholder).toBe(false);
    expect(parseVerdict(null)).toBeNull();
    const ph = parseVerdict({ note: "verdict posted on-chain; content not held by this deployment", source: "indexer", placeholder: true });
    expect(ph).toMatchObject({ placeholder: true, models: [], note: "verdict posted on-chain; content not held by this deployment" });
    expect(seatLabel(0)).toBe("Seat 1");
    expect(seatLabel(null)).toBe("Seat ?");
    expect(jurorLabel("rules:conservative")).toBe("Rule juror: conservative");
    expect(jurorLabel("claude-x")).toBe("claude-x");
  });
});

describe("mark PnL statement", () => {
  // shape committed by services/mark (pnlJsonHash)
  const pnl = {
    pnl: { feeFlowUsd: "17.303063", fundingUsd: "0.000000", markPnlUsd: "77.362340", realizedUsd: "89.812098", unrealizedUsd: "12.726249" },
    desk: {
      usdc: "0.000000",
      positions: [{ token: "0x2bdcc0de6be1f7d2ee689a0342d76f52e8efaba3", qtyRaw: "2000000000000000000", priceWad: "190500000000000000000", multiplierWad: "1000000000000000000", valueUsd: "381.000000" }, { token: 5 }],
      hedgeValueUsd: "381.000000",
    },
    venue: { marginUsd: "104666.015126", valuationAt: 1790921714, inTransitUsd: "0.000000", insuranceUsd: "30000.000000", netExposureUsd: "-13420.084131" },
    limits: { skewUtil: 0.04497, drawdownBps: 0, hedgeRatioBps: 2839, inventoryUtil: 0.27 },
    vaultIdleUsd: "1068.852977",
  };
  test("reads venue, desk and PnL; ignores malformed positions", () => {
    const s = parseMarkStatement({ markId: 228, periodEndAt: "2026-10-02T06:15:00.000Z", pnl });
    expect(s?.venue.netExposureUsd).toBe("-13420.084131");
    expect(s?.venue.valuationAt).toBe(1790921714);
    expect(s?.desk.positions).toHaveLength(1);
    expect(s?.pnl.feeFlowUsd).toBe("17.303063");
    expect(s?.hedgeRatioBps).toBe(2839);
    expect(parseMarkStatement({ markId: 1, periodEndAt: "", pnl: null })).toBeNull();
  });
  test("statements are newest first; WAD prices", () => {
    const list = markStatements([
      { markId: 1, periodEndAt: "a", pnl },
      { markId: 3, periodEndAt: "c", pnl },
      { markId: 2, periodEndAt: "b" },
    ]);
    expect(list.map((s) => s.markId)).toEqual([3, 1]);
    expect(wadToNumber("190500000000000000000")).toBe(190.5);
    expect(wadToNumber("5")).toBe(5e-18);
    expect(wadToNumber(null)).toBeNull();
  });
});

describe("errors", () => {
  test("network failures read as offline", () => {
    expect(describeError(new TypeError("Failed to fetch")).kind).toBe("offline");
  });
  test("wallet rejections", () => {
    expect(describeError({ shortMessage: "User rejected the request." }).kind).toBe("rejected");
    expect(describeError({ code: 4001, message: "denied" }).kind).toBe("rejected");
  });
  test("tRPC codes", () => {
    const e = (code: string, message = "m") => ({ message, data: { code } });
    expect(errorCode(e("NOT_FOUND"))).toBe("NOT_FOUND");
    expect(describeError(e("PRECONDITION_FAILED", "window closed"))).toEqual({ kind: "precondition", title: "Not possible right now", message: "window closed" });
    expect(describeError(e("SERVICE_UNAVAILABLE")).kind).toBe("unavailable");
    expect(describeError(e("CONFLICT")).kind).toBe("conflict");
    expect(isMissingProcedure(e("NOT_FOUND", 'No procedure found on path "book.fills"'))).toBe(true);
    expect(isMissingProcedure(e("NOT_FOUND", "book 9 not found"))).toBe(false);
    expect(describeError(e("NOT_FOUND", 'No procedure found on path "x"')).kind).toBe("unsupported");
    expect(describeError(undefined).kind).toBe("unknown");
  });
});
