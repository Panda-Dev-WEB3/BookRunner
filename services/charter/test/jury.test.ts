// Rule checks + deterministic rule-based jury + verdict assembly.
import { describe, expect, test } from "bun:test";
import { MULTIPLIER_VECTOR as V, ORACLE, SESSIONS_24X7, VENUE, checkCopy, encodeSessions, usd } from "@bookrunner/shared";
import { cidOfJson } from "../src/domain/cid";
import { sanitizeCopy } from "../src/domain/copyFilter";
import { PERSONAS, ruleJury } from "../src/domain/jurors";
import { type RuleCheck, hedgeFloatCapacityUsd, runRuleChecks, tokenValueUsd } from "../src/domain/ruleChecks";
import { buildVerdict, recommendation } from "../src/domain/verdict";
import { nvdaCharter, nvdaToken, ruleContextFor } from "./fixtures";

const statusOf = (checks: RuleCheck[], id: string) => checks.filter((c) => c.id === id).map((c) => c.status);
const FIXED = new Date("2026-10-02T12:00:00.000Z");

describe("rule checks", () => {
  test("launch charter passes every blocking check", () => {
    const c = nvdaCharter();
    const checks = runRuleChecks(c, ruleContextFor(c));
    expect(checks.filter((x) => x.status === "block")).toEqual([]);
    expect(statusOf(checks, "charter_validate")).toEqual(["pass"]);
    expect(statusOf(checks, "mandate_float_cap")).toEqual(["pass"]);
    expect(statusOf(checks, "venue_min_if")).toEqual(["info"]); // exactly at the minimum
  });

  test("float caps: capacity valued with the multiplier exactly once", () => {
    const t = nvdaToken({ multiplierWad: 2n * 10n ** 18n, floatCapRaw: 10n ** 18n, priceWad: 100n * 10n ** 18n });
    expect(tokenValueUsd(10n ** 18n, t, 100n * 10n ** 18n)).toBe(usd("200"));
    expect(hedgeFloatCapacityUsd({ kind: "token", token: t })).toBe(usd("200"));
  });

  test("pinned convention (VERIFY C2): per-share price x live uiMultiplier = qty x per-token feed", () => {
    const t = nvdaToken({ multiplierWad: V.uiMultiplierWad, decimals: V.decimals });
    expect(tokenValueUsd(V.qtyRaw, t, V.perSharePriceWad)).toBe(V.valueUsd6);
  });

  test("float cap below the band minimum blocks; between min and max warns", () => {
    const c = nvdaCharter(); // maxInv 50k, band 50%-120% -> need 25k..60k
    const tight = runRuleChecks(c, ruleContextFor(c, { underlying: { kind: "token", token: nvdaToken({ floatCapRaw: 100n * 10n ** 18n }) } })); // 19k
    expect(statusOf(tight, "mandate_float_cap")).toEqual(["block"]);
    const mid = runRuleChecks(c, ruleContextFor(c, { underlying: { kind: "token", token: nvdaToken({ floatCapRaw: 200n * 10n ** 18n }) } })); // 38k
    expect(statusOf(mid, "mandate_float_cap")).toEqual(["warn"]);
  });

  test("index capacity is the tightest weighted component", () => {
    const cap = hedgeFloatCapacityUsd({
      kind: "index",
      components: [
        { weightBps: 5000, token: nvdaToken({ floatCapRaw: 100n * 10n ** 18n, priceWad: 100n * 10n ** 18n }) }, // 10k / 50% = 20k
        { weightBps: 5000, token: nvdaToken({ floatCapRaw: 1000n * 10n ** 18n, priceWad: 100n * 10n ** 18n }) }, // 100k / 50% = 200k
      ],
    });
    expect(cap).toBe(usd("20000"));
  });

  test("engine + non-attested oracle blocks; Chainlink on Orderly warns", () => {
    const engine = nvdaCharter({ venue: VENUE.POOL_ENGINE, oracle: ORACLE.CHAINLINK });
    expect(statusOf(runRuleChecks(engine, ruleContextFor(engine)), "oracle_plan")).toEqual(["block"]);
    const cl = nvdaCharter({ oracle: ORACLE.CHAINLINK });
    expect(statusOf(runRuleChecks(cl, ruleContextFor(cl)), "oracle_plan")).toEqual(["warn"]);
  });

  test("sessions: 24x7 on an equity warns; reserved bits block; risk-on off-hours warns", () => {
    const c247 = nvdaCharter({ sessions: encodeSessions(SESSIONS_24X7) });
    expect(statusOf(runRuleChecks(c247, ruleContextFor(c247)), "sessions_sanity")).toEqual(["warn"]);
    const bad = nvdaCharter({ sessions: `0x${"f".repeat(64)}` });
    expect(statusOf(runRuleChecks(bad, ruleContextFor(bad)), "sessions_sanity")).toEqual(["block"]);
    const riskOn = nvdaCharter({ mandate: { ...nvdaCharter().mandate, noNewRiskOffHours: false } });
    expect(statusOf(runRuleChecks(riskOn, ruleContextFor(riskOn)), "sessions_off_hours")).toEqual(["warn"]);
  });

  test("liquidity: below hedge size blocks, unknown warns, devnet mock is info", () => {
    const c = nvdaCharter();
    expect(statusOf(runRuleChecks(c, ruleContextFor(c, { liquidity: { mode: "configured", usd: usd("10000") } })), "underlying_liquidity")).toEqual(["block"]);
    expect(statusOf(runRuleChecks(c, ruleContextFor(c, { liquidity: { mode: "unknown", usd: null } })), "underlying_liquidity")).toEqual(["warn"]);
    expect(statusOf(runRuleChecks(c, ruleContextFor(c, { liquidity: { mode: "devnet_mock", usd: null } })), "underlying_liquidity")).toEqual(["info"]);
  });

  test("stale or missing price warns, held is info", () => {
    const c = nvdaCharter();
    const stale = ruleContextFor(c, { price: { priceWad: 1n, publishedAt: 1_790_000_000, held: false }, nowSec: 1_790_001_000 });
    expect(statusOf(runRuleChecks(c, stale), "oracle_price")).toEqual(["warn"]);
    expect(statusOf(runRuleChecks(c, ruleContextFor(c, { price: { priceWad: null, publishedAt: null, held: false } })), "oracle_price")).toEqual(["warn"]);
    expect(statusOf(runRuleChecks(c, ruleContextFor(c, { price: { priceWad: 1n, publishedAt: 1_790_000_000, held: true } })), "oracle_price")).toEqual(["info"]);
  });
});

describe("rule-based jury", () => {
  test("deterministic: same input -> identical votes and identical verdict CID", async () => {
    const c = nvdaCharter();
    const checks = runRuleChecks(c, ruleContextFor(c));
    const a = buildVerdict({ charterId: 1, charter: c, votes: ruleJury(c, checks), ruleChecks: checks, createdAt: FIXED });
    const b = buildVerdict({ charterId: 1, charter: nvdaCharter(), votes: ruleJury(nvdaCharter(), runRuleChecks(c, ruleContextFor(c))), ruleChecks: checks, createdAt: FIXED });
    expect(a).toEqual(b);
    expect((await cidOfJson(a)).cid).toBe((await cidOfJson(b)).cid);
  });

  test("launch charter: unanimous approval -> recommendApprove, 2-of-3 committee threshold", () => {
    const c = nvdaCharter();
    const checks = runRuleChecks(c, ruleContextFor(c));
    const votes = ruleJury(c, checks);
    expect(votes.map((v) => [v.model, v.vote])).toEqual([
      ["rules:conservative", "approve"],
      ["rules:balanced", "approve"],
      ["rules:permissive", "approve"],
    ]);
    const verdict = buildVerdict({ charterId: 1, charter: c, votes, ruleChecks: checks, createdAt: FIXED });
    expect(verdict.recommendApprove).toBe(true);
    expect(verdict.approvalsRequired).toBe(2);
    expect(verdict.tally).toEqual({ seats: 3, approve: 3, reject: 0, abstain: 0 });
  });

  test("personas differ on thresholds: two warnings split the jury 2-1 for approval", () => {
    const c = nvdaCharter({ oracle: ORACLE.CHAINLINK }); // warn: oracle_plan
    const checks = runRuleChecks(c, ruleContextFor(c, { liquidity: { mode: "unknown", usd: null } })); // warn: liquidity
    expect(checks.filter((x) => x.status === "warn").length).toBe(2);
    const votes = ruleJury(c, checks);
    expect(votes.map((v) => v.vote)).toEqual(["reject", "approve", "approve"]);
    expect(recommendation(votes, checks)).toBe(true);
  });

  test("deep kill drawdown: conservative and balanced reject -> recommend reject (3-of-3 needed)", () => {
    const c = nvdaCharter({ mandate: { ...nvdaCharter().mandate, killAtDrawdownBps: -3000 } });
    const checks = runRuleChecks(c, ruleContextFor(c));
    const votes = ruleJury(c, checks);
    expect(votes.map((v) => v.vote)).toEqual(["reject", "reject", "approve"]);
    const verdict = buildVerdict({ charterId: 2, charter: c, votes, ruleChecks: checks, createdAt: FIXED });
    expect(verdict.recommendApprove).toBe(false);
    expect(verdict.approvalsRequired).toBe(3);
  });

  test("a blocking check makes every persona reject and vetoes the recommendation", () => {
    const c = nvdaCharter({ ifTargetUsd: usd("1000") });
    const checks = runRuleChecks(c, ruleContextFor(c));
    expect(ruleJury(c, checks).every((v) => v.vote === "reject")).toBe(true);
    // even a (hypothetical) unanimous approval cannot override a block
    const approvals = PERSONAS.map((p) => ({ model: p.id, source: "rules" as const, vote: "approve" as const, rationale: "x", risks: [] }));
    expect(recommendation(approvals, checks)).toBe(false);
  });

  test("abstentions count against approval (strict majority of seats)", () => {
    const seat = (vote: "approve" | "reject" | "abstain") => ({ model: "m", source: "anthropic" as const, vote, rationale: "r", risks: [] });
    expect(recommendation([seat("approve"), seat("abstain"), seat("abstain")], [])).toBe(false);
    expect(recommendation([seat("approve"), seat("approve"), seat("abstain")], [])).toBe(true);
  });

  test("all generated text respects the copy rules", () => {
    const variants = [
      nvdaCharter(),
      nvdaCharter({ oracle: ORACLE.CHAINLINK, sessions: encodeSessions(SESSIONS_24X7) }),
      nvdaCharter({ ifTargetUsd: 1n, seniorCapBps: 9500, mandate: { ...nvdaCharter().mandate, killAtDrawdownBps: -4000, hedgeRatioMinBps: 100, maxHedgeLeverage: 500 } }),
    ];
    for (const c of variants) {
      const checks = runRuleChecks(c, ruleContextFor(c, { liquidity: { mode: "unknown", usd: null }, newBooksPaused: true }));
      const verdict = buildVerdict({ charterId: 9, charter: c, votes: ruleJury(c, checks), ruleChecks: checks, createdAt: FIXED });
      const text = [verdict.summary, ...verdict.models.flatMap((m) => [m.rationale, ...m.risks]), ...verdict.ruleChecks.map((r) => r.detail)].join("\n");
      expect(checkCopy(text)).toEqual([]);
    }
  });
});

describe("copy filter", () => {
  test("replaces banned terms and leaves clean text untouched", () => {
    const dirty = "Senior is protected and guaranteed a stable yield; target APY is 12% with insured returns.";
    const r = sanitizeCopy(dirty);
    expect(checkCopy(r.text)).toEqual([]);
    expect(r.replaced.sort()).toEqual(["APY", "guaranteed", "insured", "protected", "returns", "target", "yield"].sort());
    expect(sanitizeCopy("Junior absorbs losses first.").text).toBe("Junior absorbs losses first.");
  });

  test("strips control characters that Postgres jsonb rejects", () => {
    expect(sanitizeCopy("a\u0000b\nc").text).toBe("ab\nc");
  });
});
