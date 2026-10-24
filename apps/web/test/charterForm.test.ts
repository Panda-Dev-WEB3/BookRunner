import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { MAX_PREMIUM_BPS } from "@bookrunner/shared/insurancePool";
import { DEFAULT_FORM, FIELD_HELP, apiFieldToForm, formIssues, formToDraft, issuesFor, premiumText, splitDuration, stepOf, suggestSymbol, venueMinIfUsd, windowRaiseUsd } from "../src/lib/charterForm";

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

  test("audit M-1: Junior notice of at least one mark interval (the network's when known, else > 0)", () => {
    const notice = (s: number, markIntervalSeconds?: number | null) => issuesFor(formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, juniorNoticeSeconds: String(s) }, { markIntervalSeconds }), "juniorNoticeSeconds");
    expect(notice(3599, 3600)).toHaveLength(1);
    expect(notice(3599, 3600)[0]?.message).toContain("1 h");
    expect(notice(3600, 3600)).toEqual([]);
    expect(notice(0)).toHaveLength(1);
    expect(notice(100)).toEqual([]); // interval unknown: the API and MarketCharter.validate still check it
    expect(notice(86_400, 86_400)).toEqual([]); // the default form passes a daily network
  });

  test("audit M-3: max skew at most half the min quote width", () => {
    const skew = (maxSkewBps: string, minQuoteWidthBps: string) =>
      issuesFor(formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, mandate: { ...DEFAULT_FORM.mandate, maxSkewBps, minQuoteWidthBps } }), "mandate.maxSkewBps");
    expect(skew("25", "8")).toHaveLength(1);
    expect(skew("25", "8")[0]?.message).toContain("4 bps");
    expect(skew("5", "8")).toHaveLength(1);
    expect(skew("4", "8")).toEqual([]);
    expect(skew("4", "9")).toEqual([]);
  });

  test("Orderly books need an Orderly perp symbol; in-house symbols are free-form", () => {
    const symbolIssues = (symbol: string, venue: "orderly" | "pool_engine" = "orderly") =>
      formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, symbol, venue, ifSizeUsd: "30000" }).filter((i) => i.field === "symbol");
    expect(symbolIssues("PERP_NVDA_USDC")).toEqual([]);
    expect(symbolIssues("PERP_NVDA_USDC_bookrunner")).toEqual([]);
    expect(symbolIssues("NVDA-PERP")[0]?.message).toMatch(/PERP_NVDA_USDC/);
    expect(symbolIssues("NVDA-PERP", "pool_engine")).toEqual([]);
  });

  test("Orderly IF minimum per network: 101 on Robinhood testnet (> 100 USDG), 25,001 elsewhere (VERIFY O10)", () => {
    const ifIssue = (ifSizeUsd: string, chainId?: number) => formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, ifSizeUsd }, chainId === undefined ? {} : { chainId }).find((i) => i.field === "ifSizeUsd");
    expect([venueMinIfUsd("orderly"), venueMinIfUsd("orderly", 46630), venueMinIfUsd("orderly", 4663), venueMinIfUsd("pool_engine", 46630)]).toEqual([25_001, 101, 25_001, 10_000]);
    expect(ifIssue("101", 46630)).toBeUndefined();
    expect(ifIssue("100", 46630)?.message).toContain("minimum of 101");
    expect(ifIssue("25000")?.message).toContain("minimum of 25,001");
    expect(ifIssue("25000", 4663)?.severity).toBe("error");
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
      juniorNoticeSeconds: 86_400,
      takerFeeBps: 0,
      meta: { name: "NVDA book" },
    });
    expect(d.mandate).toMatchObject({ maxSkewBps: 4, minQuoteWidthBps: 8, killAtDrawdownBps: -800, hedgeAllow: [{ asset: "NVDA", venue: "UNIV3" }] });
    expect(formToDraft({ ...DEFAULT_FORM, underlyingKind: "index", underlying: "RHX5" }).underlying).toEqual({ index: "RHX5" });
  });

  test("2026-10 insurance pool: new charters default to a pool-funded IF at the pool's floor", () => {
    expect(DEFAULT_FORM.ifFromPool).toBe(true);
    // pool audit 2026-10-23 B-M2: the MM inventory must be at least half the pool-funded insurance fund
    const under = formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, ifSizeUsd: "30000", mmInventoryUsd: "14999" }).find((i) => i.field === "mmInventoryUsd");
    expect(under?.message).toContain("at least 50% of its insurance fund");
    expect(formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, ifSizeUsd: "30000", mmInventoryUsd: "15000" }).find((i) => i.field === "mmInventoryUsd")).toBeUndefined();
    expect(formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, ifFromPool: false, premiumBps: "0", ifSizeUsd: "30000", mmInventoryUsd: "1" }).find((i) => i.field === "mmInventoryUsd")).toBeUndefined();
    expect(DEFAULT_FORM.premiumBps).toBe("0");
    expect(formToDraft({ ...DEFAULT_FORM, sponsor: SPONSOR })).toMatchObject({ ifFromPool: true, premiumBps: 0 });
    expect(formToDraft({ ...DEFAULT_FORM, sponsor: SPONSOR, premiumBps: "1500" })).toMatchObject({ ifFromPool: true, premiumBps: 1500 });
    // a book-funded IF pays no pool premium: the draft always sends 0
    expect(formToDraft({ ...DEFAULT_FORM, sponsor: SPONSOR, ifFromPool: false, premiumBps: "0" })).toMatchObject({ ifFromPool: false, premiumBps: 0 });
  });

  test("pool premium rules mirror CharterRules.poolReason (BAD_PREMIUM / NO_POOL)", () => {
    const premium = (premiumBps: string, ifFromPool = true) => issuesFor(formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, ifFromPool, premiumBps }), "premiumBps");
    expect(premium("0")).toEqual([]);
    expect(premium(String(MAX_PREMIUM_BPS))).toEqual([]);
    expect(premium(String(MAX_PREMIUM_BPS + 1))[0]?.message).toContain("at most 5000 bps");
    expect(premium("x")).toHaveLength(1);
    expect(premium("0", false)).toEqual([]);
    expect(premium("1200", false)[0]?.message).toContain("pays no pool premium");
    expect(premium("1200", false)[0]?.step).toBe("capital");
    const noPool = (poolConfigured: boolean | null, ifFromPool = true) => issuesFor(formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, ifFromPool }, { poolConfigured }), "ifFromPool");
    expect(noPool(false)[0]?.message).toContain("No insurance pool");
    expect(noPool(false, false)).toEqual([]);
    expect(noPool(null)).toEqual([]); // unknown: the API and the chain decide
    expect(noPool(true)).toEqual([]);
  });

  test("the pool fallback is off by default and only sent for a pool-funded IF (fix round 2, V-3)", () => {
    expect(DEFAULT_FORM.ifPoolFallback).toBe(false);
    expect(formToDraft({ ...DEFAULT_FORM, sponsor: SPONSOR }).ifPoolFallback).toBe(false);
    expect(formToDraft({ ...DEFAULT_FORM, sponsor: SPONSOR, ifPoolFallback: true }).ifPoolFallback).toBe(true);
    expect(formToDraft({ ...DEFAULT_FORM, sponsor: SPONSOR, ifFromPool: false, ifPoolFallback: true }).ifPoolFallback).toBe(false);
  });

  test("with the pool the window raises only the MM inventory; the IF still meets the venue minimum", () => {
    expect(windowRaiseUsd(DEFAULT_FORM)).toBe(75_000);
    expect(windowRaiseUsd({ ...DEFAULT_FORM, ifFromPool: false })).toBe(105_000);
    expect(windowRaiseUsd({ ...DEFAULT_FORM, mmInventoryUsd: "x" })).toBe(0);
    expect(formIssues({ ...DEFAULT_FORM, sponsor: SPONSOR, ifFromPool: true, ifSizeUsd: "1000" }).find((i) => i.field === "ifSizeUsd")?.message).toContain("venue minimum");
  });

  test("premium text and help pass the copy rules", () => {
    expect(premiumText(0)).toBe("12% (the pool's floor)");
    expect(premiumText(500)).toBe("12% (the pool's floor applies)");
    expect(premiumText(1550)).toBe("15.50%");
    expect(premiumText(0, 1500)).toBe("15% (the pool's floor)");
    for (const k of ["ifFromPool", "premiumBps", "ifSizeUsd"]) expect(checkCopy(FIELD_HELP[k] ?? "")).toEqual([]);
  });

  test("helpers", () => {
    expect(suggestSymbol("nvda", "orderly")).toBe("PERP_NVDA_USDC");
    expect(suggestSymbol("RHX5", "pool_engine")).toBe("RHX5-PERP");
    expect(splitDuration(900)).toEqual({ value: 15, unit: "min" });
    expect(splitDuration(172_800)).toEqual({ value: 2, unit: "d" });
    expect(splitDuration(61)).toEqual({ value: 61, unit: "s" });
    expect(stepOf("mandate.maxSkewBps")).toBe("mandate");
    expect(stepOf("ifSizeUsd")).toBe("capital");
    expect(stepOf("ifFromPool")).toBe("capital");
    expect(stepOf("premiumBps")).toBe("capital");
    expect(stepOf("juniorNoticeSeconds")).toBe("tranches");
    expect(apiFieldToForm("ifTargetUsd")).toBe("ifSizeUsd");
    expect(apiFieldToForm(null)).toBe("review");
  });
});
