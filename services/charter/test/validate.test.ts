// Draft validation parity with MarketCharter.validate reason codes (ARCHITECTURE §2.6).
import { describe, expect, test } from "bun:test";
import { type Charter, ORACLE, VENUE, indexUnderlying, strToBytes32, usd } from "@bookrunner/shared";
import { zeroHash } from "viem";
import { REASON_CODES, type ReasonCode, reasonFromBytes32, reasonToBytes32, validateCharter } from "../src/domain/validate";
import { devValidationContext, nvdaCharter } from "./fixtures";

const v = (c: Charter) => validateCharter(c, devValidationContext);
const withMandate = (m: Partial<Charter["mandate"]>) => nvdaCharter({ mandate: { ...nvdaCharter().mandate, ...m } });

describe("validateCharter (MarketCharter.validate mirror)", () => {
  test("launch charter is valid and returns the zero reason", () => {
    const r = v(nvdaCharter());
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.reasonBytes32).toBe(zeroHash);
  });

  const cases: Array<[string, Charter, ReasonCode]> = [
    ["IF below venue minimum", nvdaCharter({ ifTargetUsd: usd("24999.999999") }), "IF_BELOW_VENUE_MIN"],
    ["unknown venue", nvdaCharter({ venue: 2 as Charter["venue"] }), "BAD_VENUE"],
    ["unknown oracle", nvdaCharter({ oracle: 7 as Charter["oracle"] }), "BAD_ORACLE"],
    ["hurdle > 100%", nvdaCharter({ seniorHurdleBps: 10_001 }), "BAD_BPS"],
    ["senior cap > 100%", nvdaCharter({ seniorCapBps: 10_001 }), "BAD_BPS"],
    ["senior cap zero", nvdaCharter({ seniorCapBps: 0 }), "BAD_BPS"],
    ["window < 60s", nvdaCharter({ subscriptionWindow: 59 }), "BAD_WINDOW"],
    ["window > 30d", nvdaCharter({ subscriptionWindow: 30 * 86_400 + 1 }), "BAD_WINDOW"],
    ["notice > 30d", nvdaCharter({ juniorNoticeSeconds: 30n * 86_400n + 1n }), "BAD_NOTICE"],
    ["maxInventory zero", withMandate({ maxInventoryUsd: 0n }), "BAD_MANDATE"],
    ["min width zero", withMandate({ minQuoteWidthBps: 0 }), "BAD_MANDATE"],
    ["band min > max", withMandate({ hedgeRatioMinBps: 12_001 }), "BAD_MANDATE"],
    ["kill drawdown zero", withMandate({ killAtDrawdownBps: 0 }), "BAD_MANDATE"],
    ["kill drawdown positive", withMandate({ killAtDrawdownBps: 100 }), "BAD_MANDATE"],
    ["kill drawdown < -5000", withMandate({ killAtDrawdownBps: -5001 }), "BAD_MANDATE"],
    ["skew zero", withMandate({ maxSkewBps: 0 }), "BAD_MANDATE"],
    ["skew negative", withMandate({ maxSkewBps: -5 }), "BAD_MANDATE"],
    ["token not canonical", nvdaCharter({ underlying: `0x${"0".repeat(24)}${"b".repeat(40)}` }), "BAD_UNDERLYING"],
    ["zero underlying", nvdaCharter({ underlying: zeroHash }), "BAD_UNDERLYING"],
    ["index not registered", nvdaCharter({ underlying: indexUnderlying("RHX9") }), "BAD_UNDERLYING"],
    ["empty symbol", nvdaCharter({ symbol: zeroHash }), "BAD_SYMBOL"],
    [
      "in-house taker fee > 100 bps",
      nvdaCharter({ venue: VENUE.POOL_ENGINE, ifTargetUsd: usd("25000"), takerFeeBps: 101 }),
      "BAD_FEES",
    ],
  ];

  for (const [name, c, reason] of cases) {
    test(`${name} -> ${reason}`, () => {
      const r = v(c);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
      expect(r.reasonBytes32).toBe(strToBytes32(reason));
      expect(r.reasons).toEqual([reason]);
    });
  }

  test("boundaries accepted exactly at the limits", () => {
    expect(v(nvdaCharter({ ifTargetUsd: usd("25000") })).ok).toBe(true);
    expect(v(nvdaCharter({ subscriptionWindow: 60 })).ok).toBe(true);
    expect(v(nvdaCharter({ subscriptionWindow: 30 * 86_400 })).ok).toBe(true);
    expect(v(nvdaCharter({ juniorNoticeSeconds: 30n * 86_400n })).ok).toBe(true);
    expect(v(nvdaCharter({ juniorNoticeSeconds: 0n })).ok).toBe(true);
    expect(v(nvdaCharter({ seniorHurdleBps: 10_000, seniorCapBps: 10_000 })).ok).toBe(true);
    expect(v(nvdaCharter({ seniorHurdleBps: 0 })).ok).toBe(true);
    expect(v(withMandate({ killAtDrawdownBps: -5000 })).ok).toBe(true);
    expect(v(withMandate({ killAtDrawdownBps: -1 })).ok).toBe(true);
    expect(v(withMandate({ hedgeRatioMinBps: 12_000 })).ok).toBe(true); // min == max
    expect(v(withMandate({ maxSkewBps: 1, minQuoteWidthBps: 1 })).ok).toBe(true);
    expect(v(nvdaCharter({ venue: VENUE.POOL_ENGINE, takerFeeBps: 100 })).ok).toBe(true);
    // the taker-fee cap applies to the in-house venue only
    expect(v(nvdaCharter({ venue: VENUE.ORDERLY, takerFeeBps: 500 })).ok).toBe(true);
    // in-house venue minimum is lower
    expect(v(nvdaCharter({ venue: VENUE.POOL_ENGINE, ifTargetUsd: usd("10000") })).ok).toBe(true);
    expect(v(nvdaCharter({ venue: VENUE.POOL_ENGINE, ifTargetUsd: usd("9999") })).reason).toBe("IF_BELOW_VENUE_MIN");
    expect(v(nvdaCharter({ oracle: ORACLE.CHAINLINK })).ok).toBe(true);
  });

  test("registered index underlying is accepted", () => {
    const idx = indexUnderlying("RHX5");
    const ctx = { ...devValidationContext, isIndex: (u: `0x${string}`) => u === idx };
    expect(validateCharter(nvdaCharter({ underlying: idx }), ctx).ok).toBe(true);
  });

  test("first failing reason follows the contract's check order; all reasons listed", () => {
    const c = nvdaCharter({ symbol: zeroHash, seniorCapBps: 0, subscriptionWindow: 10, ifTargetUsd: 1n });
    const r = v(c);
    expect(r.reason).toBe("IF_BELOW_VENUE_MIN");
    expect(r.reasons).toEqual(["IF_BELOW_VENUE_MIN", "BAD_BPS", "BAD_WINDOW", "BAD_SYMBOL"]);
    // an unknown venue has no configured minimum (mapping default 0), so BAD_VENUE comes first
    expect(v(nvdaCharter({ venue: 9 as Charter["venue"], ifTargetUsd: 1n })).reason).toBe("BAD_VENUE");
  });

  test("bytes32 reason encoding matches Solidity bytes32(\"...\") and round-trips", () => {
    expect(reasonToBytes32("BAD_VENUE")).toBe(`0x4241445f56454e5545${"0".repeat(46)}`);
    for (const r of REASON_CODES) expect(reasonFromBytes32(reasonToBytes32(r))).toBe(r);
    expect(reasonFromBytes32(zeroHash)).toBeNull();
    expect(reasonFromBytes32(strToBytes32("SOMETHING_ELSE"))).toBeNull();
  });
});
