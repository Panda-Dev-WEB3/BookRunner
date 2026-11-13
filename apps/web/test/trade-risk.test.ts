// Trading page v2: liquidation-risk levels (watch / danger / imminent / liquidatable against maintenance, or the
// off-hours requirement while the price is held), "if the session closes now", the order panel's pre-trade warning
// (within 20% of liquidation), the browser notice on a level that gets worse, and the price-chart / history logic
// (runs, summary, CSV export). Every message passes the copy rules.
import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import type { TradeFill, TradeHistoryPoint } from "../src/lib/api-types";
import { chartPoints, chartRuns, csvCell, fillsCsv, fillsCsvName, historySummary } from "../src/components/trade/historyLogic";
import { type PositionRisk, ifCloseText, moveToLiquidation, positionRisk, preTradeRisk, riskLevel, riskNotice, riskText } from "../src/components/trade/riskLogic";

// defaults: IM 10%, maintenance 5%, off-hours 20%
const market = (held = false) => ({
  margin: { initialMarginBps: 1000, maintenanceMarginBps: 500, offHoursMarginBps: 2000, maxLeverage: 10, holdableLeverage: 5, refusesUnholdable: false, orderLeverageCap: 10 },
  price: { held },
});
const pos = (ratio: number | null, o: { liq?: string; liqOff?: string } = {}) => ({
  side: ratio === null ? ("flat" as const) : ("long" as const),
  marginRatioBps: ratio,
  markPrice: "100.0",
  liquidationPrice: o.liq ?? "95.0",
  liquidationPriceOffHours: o.liqOff ?? "82.0",
});

describe("risk levels from the margin ratio", () => {
  test("bands are multiples of the requirement: 2x watch, 1.5x danger, 1.2x imminent, below 1x liquidatable", () => {
    expect(riskLevel(1000, 500)).toBe("ok"); // exactly 2x
    expect(riskLevel(999, 500)).toBe("watch");
    expect(riskLevel(749, 500)).toBe("danger");
    expect(riskLevel(599, 500)).toBe("imminent");
    expect(riskLevel(499, 500)).toBe("liquidatable");
    expect(riskLevel(0, 500)).toBe("liquidatable");
    expect(riskLevel(null, 500)).toBe("ok");
  });

  test("in session the maintenance margin applies, and 'if the session closes now' reads the off-hours requirement", () => {
    const r = positionRisk(pos(1500), market())!;
    expect(r).toMatchObject({ held: false, requirementBps: 500, level: "ok", ifClose: "liquidatable" });
    expect(r.moveNow).toBeCloseTo(0.05);
    expect(r.moveIfClose).toBeCloseTo(0.18);
    expect(positionRisk(pos(4000), market())!.ifClose).toBe("ok");
    expect(positionRisk(pos(3500), market())!.ifClose).toBe("watch");
    expect(positionRisk(pos(2300), market())!.ifClose).toBe("imminent");
    expect(positionRisk(pos(null), market())).toBeNull();
  });

  test("while the price is held the off-hours requirement is the one that applies; no separate 'if it closes'", () => {
    const r = positionRisk(pos(2600), market(true))!;
    expect(r).toMatchObject({ held: true, requirementBps: 2000, level: "danger", ifClose: null });
    expect(r.moveNow).toBeCloseTo(0.18); // the off-hours liquidation price
    expect(positionRisk(pos(3900), market(true))!.level).toBe("watch");
  });

  test("warning texts name the requirement and the move to liquidation, and pass the copy rules", () => {
    const texts = [
      riskText("watch", 900, 500, 0.08, false),
      riskText("danger", 700, 500, 0.04, false),
      riskText("imminent", 550, 500, 0.012, false),
      riskText("liquidatable", 400, 500, 0, false),
      riskText("imminent", 2200, 2000, 0.02, true),
    ];
    expect(riskText("ok", 2000, 500, 0.2, false)).toBeNull();
    expect(texts[2]!.body).toContain("within 20% of the maintenance margin (5% of notional)");
    expect(texts[2]!.body).toContain("about 1.2% against you");
    expect(texts[4]!.body).toContain("off-hours requirement (20% of notional");
    expect(texts[4]!.body).not.toContain("or reduce"); // no trade fills while held
    const close = ifCloseText(positionRisk(pos(1500), market())!, 2000)!;
    expect(close.title).toBe("If the session closes now, this position is liquidated");
    expect(ifCloseText(positionRisk(pos(2300), market())!, 2000)!.body).toContain("within 20%");
    expect(ifCloseText(positionRisk(pos(3500), market())!, 2000)).toBeNull();
    expect(ifCloseText(positionRisk(pos(2600), market(true))!, 2000)).toBeNull();
    const all = [...texts, close].flatMap((t) => (t ? [t.title, t.body] : []));
    expect(checkCopy(all.join("\n"))).toEqual([]);
  });

  test("move to liquidation", () => {
    expect(moveToLiquidation("100", "90")).toBeCloseTo(0.1);
    expect(moveToLiquidation("100", "any")).toBe(0);
    expect(moveToLiquidation("100", null)).toBeNull();
  });
});

describe("pre-trade warning", () => {
  const after = (r: number | null) => ({ side: r === null ? ("flat" as const) : ("long" as const), marginRatioBps: r });

  test("warns when the resulting position is within 20% of maintenance, or of the off-hours requirement in session", () => {
    expect(preTradeRisk(after(3000), market())).toEqual([]);
    const off = preTradeRisk(after(2300), market()); // 4.3x: 1.15x the off-hours requirement
    expect(off).toHaveLength(1);
    expect(off[0]!.title).toBe("Close to liquidation if the session closes");
    expect(preTradeRisk(after(1900), market())).toEqual([]); // below off-hours: the API's own message covers it
    const mm = preTradeRisk(after(580), market());
    expect(mm.map((w) => w.title)).toEqual(["This order leaves the position close to liquidation"]);
    expect(preTradeRisk(after(600), market())).toEqual([]); // exactly 1.2x: not within
    expect(preTradeRisk(after(null), market())).toEqual([]);
    expect(checkCopy([...off, ...mm].flatMap((w) => [w.title, w.body]).join("\n"))).toEqual([]);
  });
});

describe("browser notice", () => {
  const r = (level: PositionRisk["level"], ifClose: PositionRisk["ifClose"] = "ok"): PositionRisk => ({ held: false, requirementBps: 500, level, ifClose, moveNow: 0.03, moveIfClose: 0.1 });

  test("only a level that gets worse and reaches danger; never the first reading, never an improvement", () => {
    expect(riskNotice(null, r("imminent"), "NVDA")).toBeNull();
    expect(riskNotice({ level: "ok", ifClose: "ok" }, r("watch"), "NVDA")).toBeNull();
    const n = riskNotice({ level: "watch", ifClose: "ok" }, r("danger"), "NVDA")!;
    expect(n.title).toBe("NVDA: your position is in danger");
    expect(n.body).toContain("About 3.0% from liquidation");
    expect(riskNotice({ level: "danger", ifClose: "ok" }, r("imminent"), "NVDA")!.title).toContain("close to liquidation");
    expect(riskNotice({ level: "imminent", ifClose: "ok" }, r("danger"), "NVDA")).toBeNull();
    expect(riskNotice({ level: "danger", ifClose: "ok" }, r("danger"), "NVDA")).toBeNull();
    expect(riskNotice({ level: "ok", ifClose: "watch" }, r("ok", "liquidatable"), "NVDA")!.title).toBe("NVDA: at risk if the session closes");
    const texts = [n, riskNotice({ level: "ok", ifClose: "watch" }, r("ok", "liquidatable"), "NVDA")!].flatMap((x) => [x.title, x.body]);
    expect(checkCopy(texts.join("\n"))).toEqual([]);
  });
});

describe("price chart and trade history logic", () => {
  const P = (t: number, c: number, held = false, o = c, h = c, l = c): TradeHistoryPoint => ({ t, open: String(o), high: String(h), low: String(l), close: String(c), held });

  test("runs break on a gap in the record and on a change of session (sharing the boundary point)", () => {
    const pts = chartPoints([P(0, 100), P(300, 101), P(600, 102, true), P(900, 102, true), P(3_000, 103), P(3_300, 104)]);
    const runs = chartRuns(pts, 300);
    expect(runs.map((x) => [x.held, x.points.map((p) => p.t)])).toEqual([
      [false, [0, 300]],
      [true, [300, 600, 900]],
      [false, [3_000, 3_300]],
    ]);
    expect(chartRuns([], 300)).toEqual([]);
  });

  test("summary: first open, last close, extremes, change", () => {
    const s = historySummary([P(0, 101, false, 100, 102, 99), P(300, 110, false, 101, 111, 100)])!;
    expect(s).toMatchObject({ first: 100, last: 110, high: 111, low: 99 });
    expect(s.change).toBeCloseTo(0.1);
    expect(historySummary([])).toBeNull();
  });

  test("CSV: exact values, escaped cells, defused formulas, the settlement symbol in the header", () => {
    const row: TradeFill = {
      id: "0xab:1",
      at: "2026-11-13T10:00:00.000Z",
      block: 12,
      txHash: "0xab",
      marketId: 1,
      kind: "liquidation",
      side: "sell",
      size: "10.0",
      price: "95.0",
      notionalUsd: "950.000000",
      feeUsd: "4.750000",
      realisedPnlUsd: "-100.000000",
      fundingUsd: null,
      marginUsd: null,
      badDebtUsd: "0.000000",
      positionAfter: "0.0",
    };
    const csv = fillsCsv([row], { settlementSymbol: "USDG", marketLabel: () => "NVDA, perp" });
    const [head, line] = csv.trim().split("\r\n");
    expect(head).toContain("fee_USDG");
    expect(line).toBe('2026-11-13T10:00:00.000Z,"NVDA, perp",Liquidation,sell,10.0,95.0,950.000000,4.750000,-100.000000,,,0.000000,0.0,12,0xab');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-12.5")).toBe("-12.5");
    expect(fillsCsvName("0x1234567890abcdef1234567890abcdef12345678", "NVDA-PERP", Date.parse("2026-11-13T12:00:00Z"))).toBe("bookrunner-trades-0x1234-5678-NVDA-PERP-2026-11-13.csv");
    expect(fillsCsvName("0x1234567890abcdef1234567890abcdef12345678", null, Date.parse("2026-11-13T12:00:00Z"))).toContain("all-markets");
  });
});
