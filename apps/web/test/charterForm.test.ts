import { describe, expect, test } from "bun:test";
import { DEFAULT_FORM, apiFieldToForm, formIssues, formToDraft, issuesFor, splitDuration, stepOf, suggestSymbol } from "../src/lib/charterForm";

const SPONSOR = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

describe("charter form", () => {
  test("the devnet example is valid once a sponsor is set", () => {
    expect(formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR }).filter((i) => i.severity === "error")).toEqual([]);
    expect(formIssues(DEFAULT_FORM).map((i) => i.field)).toEqual(["sponsor"]);
  });

  test("mirrors MarketCharter.validate rules field by field", () => {
    const bad = formIssues({
      ...DEFAULT_FORM,
      sponsor: SPONSOR,
      symbol: "X".repeat(33),
      ifSizeUsd: "1000",
      seniorCapBps: "0",
      seniorShareBps: "10001",
      windowSeconds: "30",
      juniorNoticeSeconds: String(31 * 86_400),
      mandate: { ...DEFAULT_FORM.mandate, maxSkewBps: "0", minQuoteWidthBps: "0", hedgeRatioMinBps: "9000", hedgeRatioMaxBps: "8000", killAtDrawdownBps: "10", hedgeAllow: [] },
    });
    const fields = bad.map((i) => i.field);
    for (const f of ["symbol", "ifSizeUsd", "seniorCapBps", "seniorShareBps", "windowSeconds", "juniorNoticeSeconds", "mandate.maxSkewBps", "mandate.minQuoteWidthBps", "mandate.hedgeRatioMinBps", "mandate.killAtDrawdownBps"]) {
      expect(fields).toContain(f);
    }
    expect(bad.find((i) => i.field === "mandate.hedgeAllow")?.severity).toBe("warn");
    expect(issuesFor(bad, "mandate").length).toBeGreaterThan(3);
  });

  test("in-house engine fees are capped at 100 bps", () => {
    const issues = formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, venue: "pool_engine", ifSizeUsd: "10000", takerFeeBps: "150" });
    expect(issues.map((i) => i.field)).toEqual(["takerFeeBps"]);
  });

  test("form -> charter.file draft in human units", () => {
    const d = formToDraft({ ...DEFAULT_FORM, sponsor: SPONSOR, name: "  NVDA book " });
    expect(d).toMatchObject({
      sponsor: SPONSOR,
      underlying: { ticker: "NVDA" },
      venue: "orderly",
      sessions: "24x5",
      ifTargetUsd: "30000",
      seniorHurdleBps: 6000,
      seniorCapBps: 7000,
      subscriptionWindowSeconds: 600,
      juniorNoticeSeconds: 900,
      takerFeeBps: 0,
      meta: { name: "NVDA book" },
    });
    expect(d.mandate).toMatchObject({ maxSkewBps: 25, minQuoteWidthBps: 8, killAtDrawdownBps: -800, hedgeAllow: [{ asset: "NVDA", venue: "UNIV3" }] });
    expect(formToDraft({ ...DEFAULT_FORM, underlyingKind: "index", underlying: "RHX5" }).underlying).toEqual({ index: "RHX5" });
  });

  test("helpers", () => {
    expect(suggestSymbol("nvda", "orderly")).toBe("PERP_NVDA_USDC");
    expect(suggestSymbol("RHX5", "pool_engine")).toBe("RHX5-PERP");
    expect(splitDuration(900)).toEqual({ value: 15, unit: "min" });
    expect(splitDuration(172_800)).toEqual({ value: 2, unit: "d" });
    expect(splitDuration(61)).toEqual({ value: 61, unit: "s" });
    expect(stepOf("mandate.maxSkewBps")).toBe("mandate");
    expect(stepOf("ifSizeUsd")).toBe("capital");
    expect(stepOf("juniorNoticeSeconds")).toBe("tranches");
    expect(apiFieldToForm("ifTargetUsd")).toBe("ifSizeUsd");
    expect(apiFieldToForm(null)).toBe("review");
  });
});
