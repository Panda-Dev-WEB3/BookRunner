import { describe, expect, test } from "bun:test";
import {
  agentRows,
  bookArt,
  bookCard,
  bookTicker,
  chartGeometry,
  depositWindow,
  firstMarkAtOrAfter,
  markRow,
  overview,
  parseTopUp,
  portfolioTotal,
  positionRowVisible,
  positionView,
  riskView,
  settlementRow,
  settlementTotals,
  statusClass,
  venueLabel,
} from "../src/dashboard/model";
import type { AgentListOut } from "../src/dashboard/types";
import { bookNvda, bookRhx5, markItem, position, settlements } from "./fixtures";

describe("books", () => {
  test("ticker from venue symbols, charter ticker wins", () => {
    expect(bookTicker("PERP_NVDA_USDC")).toBe("NVDA");
    expect(bookTicker("RHX5-PERP")).toBe("RHX5");
    expect(bookTicker("ODD")).toBe("ODD");
    expect(bookTicker("PERP_NVDA_USDC", "nvda")).toBe("NVDA");
  });

  test("venue labels and art", () => {
    expect(venueLabel("orderly")).toBe("Orderly");
    expect(venueLabel("pool_engine")).toBe("In-house pool engine");
    expect(bookArt("NVDA").src).toContain("greek-nvda");
    expect(bookArt("TSLA").src).toContain("greek-tsla");
    expect(bookArt("RHX5").src).toContain("greek-index");
  });

  test("status classes", () => {
    expect(statusClass("Live")).toBe("live");
    expect(statusClass("Killed")).toBe("killed");
    expect(statusClass("Rejected")).toBe("killed");
    expect(statusClass("Filed")).toBe("queued");
    expect(statusClass(null)).toBe("unknown");
  });

  test("book card maps the list item without inventing values", () => {
    const c = bookCard(bookNvda);
    expect(c.ticker).toBe("NVDA");
    expect(c.markedNav).toBeCloseTo(134854.933474, 6);
    expect(c.liveNav).toBeCloseTo(135025.864468, 6);
    expect(c.inventoryUtil).toBeCloseTo(0.108428, 6);
    expect(c.nextMarkAt).toBe("2026-10-07T06:00:00.000Z");
    const r = bookCard(bookRhx5);
    expect(r.liveNav).toBeNull();
    expect(r.inventoryUtil).toBeNull();
    expect(r.riskState).toBeNull();
  });

  test("overview sums marked NAV and ages the newest mark", () => {
    const now = Date.parse("2026-10-07T05:10:00.000Z");
    const o = overview([bookNvda, bookRhx5], now);
    expect(o.books).toBe(2);
    expect(o.liveBooks).toBe(2);
    expect(o.totalMarkedNav).toBeCloseTo(134854.933474 + 142012.981655, 5);
    expect(o.latestMarkAt).toBe("2026-10-07T05:00:00.000Z");
    expect(o.latestMarkAgeSec).toBe(600);
    expect(o.cadence).toBe("hourly");
    const none = overview([], now);
    expect(none.totalMarkedNav).toBeNull();
    expect(none.latestMarkAgeSec).toBeNull();
  });
});

describe("deposit window", () => {
  const now = 1_791_350_000;
  test("parses Book.topUp()", () => {
    expect(parseTopUp([true, 1_791_400_000n, 5n, 6n])).toEqual({ open: true, endsAt: 1_791_400_000, seniorCapacityUsd: 5n, juniorCapacityUsd: 6n });
  });
  test("first mark at or after", () => {
    expect(firstMarkAtOrAfter(7201, 3600)).toBe(10800);
    expect(firstMarkAtOrAfter(7200, 3600)).toBe(7200);
  });
  test("subscription window open / closed", () => {
    expect(depositWindow("Subscription", new Date((now + 60) * 1000).toISOString(), null, now, 3600)).toMatchObject({ kind: "subscription", open: true });
    expect(depositWindow("Subscription", new Date((now - 60) * 1000).toISOString(), null, now, 3600)).toMatchObject({ kind: "subscription", open: false });
  });
  test("a Live book takes deposits only in an open, unexpired top-up round", () => {
    const round = { open: true, endsAt: now + 1000, seniorCapacityUsd: 1n, juniorCapacityUsd: 2n };
    const w = depositWindow("Live", null, round, now, 3600);
    expect(w.kind).toBe("topup");
    if (w.kind === "topup") expect(w.settlesAtSec).toBe(firstMarkAtOrAfter(now + 1000, 3600));
    expect(depositWindow("Live", null, { ...round, endsAt: now - 1 }, now, 3600).kind).toBe("closed");
    expect(depositWindow("Live", null, { ...round, open: false }, now, 3600).kind).toBe("closed");
    expect(depositWindow("Live", null, null, now, 3600).kind).toBe("closed");
    expect(depositWindow("Retiring", null, round, now, 3600).kind).toBe("closed");
  });
});

describe("risk", () => {
  const mandate = { maxInventoryUsd: "50000.000000", maxSkewBps: 25, minQuoteWidthBps: 8, maxHedgeLeverage: 1, hedgeRatioMinBps: 5000, hedgeRatioMaxBps: 12000, noNewRiskOffHours: true, killAtDrawdownBps: -800, hedgeAllowRoot: "0x00" } as never;
  test("in-band hedge, within limits", () => {
    const r = riskView(bookNvda.limits, mandate);
    expect(r.operating).toBe("Within limits");
    expect(r.hedge.inBand).toBe(true);
    expect(r.inventory.alert).toBe(false);
    expect(r.drawdown.util).toBe(0);
  });
  test("breach, off-hours and kill states", () => {
    const l = { ...(bookNvda.limits as object), inventoryUtil: 1.2, hedgeRatioBps: 4000, drawdownBps: -400, offHours: true, state: "ok" } as never;
    const r = riskView(l, mandate);
    expect(r.inventory.alert).toBe(true);
    expect(r.hedge.inBand).toBe(false);
    expect(r.drawdown.util).toBeCloseTo(0.5, 6);
    expect(r.operating).toBe("Reduce-only (off-hours)");
    expect(riskView(l, mandate, true).operating).toBe("Killed");
    expect(riskView(null, null).operating).toBe("No risk report");
    expect(riskView(null, null).hedge.inBand).toBeNull();
  });
});

describe("marks, settlements, chart", () => {
  test("mark row", () => {
    const r = markRow(markItem);
    expect(r.nav).toBeCloseTo(134854.933474, 6);
    expect(r.pnl).toBeCloseTo(243.641296, 6);
    expect(r.feeFlow).toBeCloseTo(14.63967, 6);
    expect(r.txHash).toBe(markItem.appliedTx as string);
  });
  test("settlement rows and distribution totals", () => {
    const rows = settlements.map(settlementRow);
    expect(rows[0]?.source).toBe("Distribution");
    expect(rows[1]?.source).toBe("Venue fee share");
    const t = settlementTotals(rows);
    expect(t.periods).toBe(1);
    expect(t.gross).toBeCloseTo(17.266299, 6);
    expect(t.carry).toBeCloseTo(1.626629, 6);
  });
  test("chart geometry", () => {
    expect(chartGeometry([])).toBeNull();
    const g = chartGeometry([
      { navUsd: "100", ts: "a" },
      { navUsd: "110", ts: "b" },
      { navUsd: "bad", ts: "c" },
    ]);
    expect(g?.points.length).toBe(2);
    expect(g?.points[0]?.x).toBe(40);
    expect(g?.points[1]?.x).toBe(680);
    expect(g?.points[0]?.y).toBe(125);
    expect(g?.points[1]?.y).toBe(35);
    const flat = chartGeometry([{ navUsd: "5", ts: "a" }]);
    expect(flat?.points[0]?.y).toBe(125);
  });
});

describe("positions", () => {
  test("position view: shares, escrow, claimables, redemptions", () => {
    const v = positionView(position);
    const senior = v.rows.find((r) => r.tranche === "senior");
    const junior = v.rows.find((r) => r.tranche === "junior");
    expect(senior?.shares).toBe(1_000_000_000n);
    expect(senior?.committedUsd).toBe(250_000_000n);
    expect(junior?.claimableShares).toBe(12_600_000_000n);
    expect(v.claimable).toBe(true);
    expect(v.pendingDepositUsd).toBe(250_000_000n);
    expect(v.totalValueUsd).toBe(1_014_313_352n);
    expect(v.redemptions).toHaveLength(1);
    expect(v.redemptions[0]?.status).toBe("claimable");
    expect(positionRowVisible(junior as never)).toBe(true);
  });
  test("unknown chain values stay unknown", () => {
    const p = { ...position, tranches: position.tranches.map((t) => ({ ...t, shares: null, navValueUsd: null, committedUsd: null, claimableAllocation: null, claimableRedemptionUsd: null, redemptions: [] })) } as never;
    const v = positionView(p);
    expect(v.totalValueUsd).toBeNull();
    expect(v.claimable).toBe(false);
    expect(portfolioTotal([v])).toBeNull();
    expect(portfolioTotal([])).toBe(0n);
    expect(positionRowVisible(v.rows[0] as never)).toBe(false);
  });
});

test("agent rows flag keys the chain no longer holds", () => {
  const a = {
    bookId: 1,
    keys: [
      { key: "0x1", operator: "0x2", validUntil: null, inventoryTierUsd: "50000.000000", status: "active", activeOnChain: false, registeredTx: null, revokedTx: null, revokedReason: null, updatedAt: "" },
      { key: "0x3", operator: null, validUntil: null, inventoryTierUsd: null, status: "revoked", activeOnChain: false, registeredTx: null, revokedTx: "0x4", revokedReason: "RISK", updatedAt: "" },
    ],
    killed: false,
    killReason: null,
    agent: { heartbeatAt: null, alive: false },
  } as unknown as AgentListOut;
  const rows = agentRows(a);
  expect(rows[0]?.status).toBe("inactive");
  expect(rows[0]?.tierUsd).toBe(50000);
  expect(rows[1]?.status).toBe("revoked");
  expect(rows[1]?.tierUsd).toBeNull();
});
