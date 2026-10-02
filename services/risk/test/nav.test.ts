// Live NAV / drawdown computation and the hedge-band state machine.
import { describe, expect, test } from "bun:test";
import { usd, wad } from "@bookrunner/shared";
import { stepHedgeBand } from "../src/domain/hedgeBand";
import { computeLiveNav, venueDeployedValue } from "../src/domain/nav";
import { oracleFromChain, oracleFromRedis } from "../src/domain/oracle";
import type { NavInputs } from "../src/types";
import { T0 } from "./fakes";

const base: NavInputs = {
  vaultIdleUsd: usd(5_000),
  unfundedClaimsUsd: 0n,
  venueDeployedUsd: usd(80_000),
  deskValueUsd: usd(15_000),
  seniorNavUsd: usd(70_000),
  juniorNavUsd: usd(30_000),
  perfIndexWad: wad(1),
  highWaterWad: wad(1),
};

describe("computeLiveNav", () => {
  test("live NAV = vault idle + venue deployed + desk value - unfunded claims", () => {
    const r = computeLiveNav({ ...base, unfundedClaimsUsd: usd(2_000) });
    expect(r.navUsd).toBe(usd(98_000));
    expect(r.accountedNavUsd).toBe(usd(100_000));
    expect(r.drawdownBps).toBe(-200);
  });

  test("unfunded claims are netted against the whole book, not just idle cash (Book.markedNavNet)", () => {
    const r = computeLiveNav({ ...base, vaultIdleUsd: usd(1_000), unfundedClaimsUsd: usd(3_000) });
    expect(r.navUsd).toBe(usd(93_000)); // 1k idle + 95k deployed - 3k unfunded
  });

  test("no mark yet: perf index = high-water = 1e18 at window close, drawdown from live NAV", () => {
    const r = computeLiveNav({ ...base, venueDeployedUsd: usd(60_000) }); // NAV 80k vs 100k
    expect(r.liveIndexWad).toBe(wad(0.8));
    expect(r.highWaterWad).toBe(wad(1));
    expect(r.drawdownBps).toBe(-2000);
  });

  test("live index = index * liveNav / accounted; a new high resets drawdown to 0", () => {
    const r = computeLiveNav({ ...base, venueDeployedUsd: usd(90_000), perfIndexWad: wad(1.05), highWaterWad: wad(1.08) });
    // NAV 110k vs 100k accounted -> 1.05 * 1.1 = 1.155 > 1.08
    expect(r.liveIndexWad).toBe(wad(1.155));
    expect(r.highWaterWad).toBe(wad(1.155));
    expect(r.drawdownBps).toBe(0);
  });

  test("zero accounted NAV leaves the index unchanged", () => {
    const r = computeLiveNav({ ...base, seniorNavUsd: 0n, juniorNavUsd: 0n, perfIndexWad: wad(0.9) });
    expect(r.liveIndexWad).toBe(wad(0.9));
    expect(r.drawdownBps).toBe(-1000);
  });

  test("Orderly: live MM equity replaces the reported margin; engine/report path uses deployedValueUsd", () => {
    const adapter = { deployedValueUsd: usd(100_000), insuranceEquityUsd: usd(25_000), inTransitUsd: usd(1_000) };
    expect(venueDeployedValue(adapter, null)).toBe(usd(100_000));
    expect(venueDeployedValue(adapter, usd(70_000))).toBe(usd(96_000));
    expect(venueDeployedValue(adapter, usd(-5_000))).toBe(usd(26_000)); // negative margin floors at 0
  });
});

describe("oracle readings", () => {
  test("chain reading: never-pushed feed is stale", () => {
    expect(oracleFromChain({ priceWad: 0n, publishedAt: 0n, held: false }, false).stale).toBe(true);
    expect(oracleFromChain({ priceWad: wad(190), publishedAt: BigInt(T0), held: true }, false).held).toBe(true);
  });

  test("redis fallback: staleness from maxPriceAge", () => {
    const msg = {
      priceId: "NVDA",
      underlying: "0x00" as `0x${string}`,
      priceWad: wad(190).toString(),
      price: 190,
      publishedAt: T0 - 301,
      held: false,
      sourceCount: 3,
      sources: [],
      sourcesHash: "0x00" as `0x${string}`,
      signature: "0x00" as `0x${string}`,
    };
    expect(oracleFromRedis(msg, T0, 300)).toMatchObject({ stale: true, priceWad: wad(190), source: "redis" });
    expect(oracleFromRedis({ ...msg, publishedAt: T0 - 300 }, T0, 300).stale).toBe(false);
    expect(oracleFromRedis(null, T0, 300)).toMatchObject({ stale: true, source: "none" });
  });
});

describe("stepHedgeBand state machine", () => {
  const IN = { outOfBandSince: null, lastObservedAt: null };

  test("leaving the band starts the clock; staying out accumulates; re-entering resets", () => {
    const a = stepHedgeBand(IN, false, T0, 60);
    expect(a.state.outOfBandSince).toBe(T0);
    expect(a.outOfBandSec).toBe(0);
    const b = stepHedgeBand(a.state, false, T0 + 30, 60);
    expect(b.state.outOfBandSince).toBe(T0);
    expect(b.outOfBandSec).toBe(30);
    const c = stepHedgeBand(b.state, true, T0 + 32, 60);
    expect(c.state.outOfBandSince).toBeNull();
    expect(c.outOfBandSec).toBe(0);
    const d = stepHedgeBand(c.state, false, T0 + 34, 60);
    expect(d.state.outOfBandSince).toBe(T0 + 34);
  });

  test("an observation gap longer than maxGap restarts the clock (no grace credit for unobserved time)", () => {
    const a = stepHedgeBand(IN, false, T0, 60);
    const b = stepHedgeBand(a.state, false, T0 + 2000, 60);
    expect(b.state.outOfBandSince).toBe(T0 + 2000);
    expect(b.outOfBandSec).toBe(0);
  });

  test("continuous observation over the grace period reaches > 900s", () => {
    let st = stepHedgeBand(IN, false, T0, 60).state;
    let out = 0;
    for (let t = T0 + 2; t <= T0 + 902; t += 2) {
      const r = stepHedgeBand(st, false, t, 60);
      st = r.state;
      out = r.outOfBandSec;
    }
    expect(out).toBe(902);
  });
});

import { trustLiveVenueEquity } from "../src/domain/nav";

describe("venue settle window (deposit in flight must not read as a drawdown)", () => {
  test("live venue equity ignored within settleSec of the adapter's last capital flow", () => {
    expect(trustLiveVenueEquity(1_000, 950, 120)).toBe(false);
    expect(trustLiveVenueEquity(1_000, 880, 120)).toBe(true);
    expect(trustLiveVenueEquity(1_000, 0, 120)).toBe(true);
    expect(trustLiveVenueEquity(1_000, undefined, 120)).toBe(true);
  });
});
