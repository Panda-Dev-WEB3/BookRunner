// primary-confirm aggregation (domain/confirm.ts): Chainlink alone sets the price; confirmers only compare.
import { describe, expect, test } from "bun:test";
import { type ConfirmRun, nextConfirmRun, primaryConfirm } from "../src/domain/confirm";
import { decide } from "../src/domain/hold";

const NOW = 1_800_000_000_000;
const opts = { nowMs: NOW, primary: "chainlink", confirmBps: 200, maxAgeMs: 15_000 };
const cl = (price: number, ageMs = 60_000) => ({ name: "chainlink", price, ts: NOW - ageMs, maxAgeMs: 87_000_000 });
const dex = (price: number, ageMs = 2_000) => ({ name: "dex-twap", price, ts: NOW - ageMs, maxAgeMs: 60_000 });
const pyth = (price: number, ageMs = 500) => ({ name: "pyth", price, ts: NOW - ageMs });

describe("primaryConfirm", () => {
  test("within the band: price = Chainlink, sourceCount 1, every fresh confirmer attested", () => {
    const r = primaryConfirm([dex(190.5), cl(190), pyth(189.9)], opts);
    expect(r.ok).toBe(true);
    expect(r.price).toBe(190);
    expect(r.sourceCount).toBe(1);
    expect(r.accepted.map((q) => q.name)).toEqual(["chainlink"]);
    expect(r.attested!.map((q) => q.name)).toEqual(["chainlink", "dex-twap", "pyth"]);
    expect(r.confirm.status).toBe("ok");
    expect(r.confirm.primaryPrice).toBe(190);
    expect(r.confirm.diffBps).toBeCloseTo(26.3, 1);
    expect(r.confirm.confirmers.map((c) => [c.name, Math.round(c.diffBps * 10) / 10])).toEqual([
      ["dex-twap", 26.3],
      ["pyth", 5.3],
    ]);
  });

  test("diverged beyond ORACLE_CONFIRM_BPS: Chainlink is still the price (the DEX never moves it)", () => {
    const r = primaryConfirm([cl(190), dex(250)], opts);
    expect(r.ok).toBe(true);
    expect(r.price).toBe(190);
    expect(r.confirm.status).toBe("diverged");
    expect(r.confirm.diffBps).toBeCloseTo(3157.9, 1);
    // exactly at the threshold is not a divergence; one confirmer out of band is enough
    expect(primaryConfirm([cl(100), dex(102)], opts).confirm.status).toBe("ok");
    expect(primaryConfirm([cl(100), dex(102.01)], opts).confirm.status).toBe("diverged");
    expect(primaryConfirm([cl(100), dex(100.1), pyth(97.9)], opts).confirm.status).toBe("diverged");
  });

  test("Chainlink stale or missing: no price even with a fresh DEX TWAP", () => {
    const stale = primaryConfirm([{ ...cl(190, 90_000_000) }, dex(190)], opts);
    expect(stale.ok).toBe(false);
    expect(stale.price).toBeNull();
    expect(stale.accepted).toEqual([]);
    expect(stale.reason).toBe("primary source chainlink has no fresh observation (confirm sources never substitute for it)");
    expect(stale.confirm).toEqual({ status: "no-primary", diffBps: null, primaryPrice: null, primaryTs: null, confirmers: [] });
    const missing = primaryConfirm([dex(190), pyth(190)], opts);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("primary source chainlink has no observation (confirm sources never substitute for it)");
    expect(primaryConfirm([{ name: "chainlink", price: -1, ts: NOW }, dex(190)], opts).reason).toContain("no valid observation");
  });

  test("no fresh confirmer: published unconfirmed (status unavailable); stale confirmers are not attested", () => {
    const r = primaryConfirm([cl(190), dex(150, 120_000)], opts);
    expect(r.ok).toBe(true);
    expect(r.price).toBe(190);
    expect(r.confirm.status).toBe("unavailable");
    expect(r.confirm.diffBps).toBeNull();
    expect(r.attested!.map((q) => q.name)).toEqual(["chainlink"]);
    expect(r.rejected).toEqual([{ name: "dex-twap", price: 150, ts: NOW - 120_000, reason: "stale" }]);
  });

  test("hold: in session publishes Chainlink with the confirmers attested; off-hours seeds from Chainlink only", () => {
    const agg = primaryConfirm([cl(190), dex(191)], opts);
    const d = decide({ open: true, agg, lastOpen: null, nowMs: NOW, minSeedSources: 1 });
    expect(d).toMatchObject({ kind: "publish", price: 190, held: false, sourceCount: 1 });
    expect(d.kind === "publish" && d.sources.map((s) => s.name)).toEqual(["chainlink", "dex-twap"]);
    // off-hours start, no history: hold seeded at the Chainlink price, never the DEX's
    const seeded = decide({ open: false, agg: primaryConfirm([cl(190), dex(250)], opts), lastOpen: null, nowMs: NOW, minSeedSources: 1 });
    expect(seeded).toMatchObject({ kind: "publish", price: 190, held: true, sourceCount: 1, seeded: true });
    // off-hours start with Chainlink unavailable: nothing to seed even though the DEX trades
    const none = decide({ open: false, agg: primaryConfirm([dex(190)], opts), lastOpen: null, nowMs: NOW, minSeedSources: 1 });
    expect(none.kind).toBe("skip");
    // in session with Chainlink stale: skip (the last signed price ages until StalePrice)
    expect(decide({ open: true, agg: primaryConfirm([dex(190)], opts), lastOpen: null, nowMs: NOW }).kind).toBe("skip");
  });
});

describe("nextConfirmRun (hysteresis + lag run)", () => {
  const o = { hysteresisMs: 60_000, lagBps: 100 };
  const c = (status: "ok" | "diverged" | "unavailable" | "no-primary", diffBps: number | null = status === "diverged" ? 250 : 20) => ({
    status,
    diffBps,
    primaryPrice: status === "no-primary" ? null : 190,
  });
  const run = (steps: Array<[number, ReturnType<typeof c>, boolean?]>) => {
    let r: ConfirmRun | null = null;
    for (const [t, x, open] of steps) r = nextConfirmRun(r, x, open ?? true, t, o);
    return r!;
  };

  test("entering diverged / unavailable is immediate; leaving needs the other status for 60 s", () => {
    expect(run([[0, c("ok")], [1_000, c("diverged")]])).toMatchObject({ status: "diverged", since: 1_000, pending: null });
    // one-tick flap to ok: still the same run
    expect(run([[0, c("diverged")], [10_000, c("ok")], [11_000, c("diverged")]])).toMatchObject({ status: "diverged", since: 0, pending: null });
    // ok for 59 s: still diverged; at 60 s the run ends and the ok run starts when ok began
    expect(run([[0, c("diverged")], [10_000, c("ok")], [69_000, c("ok")]])).toMatchObject({ status: "diverged", since: 0, pending: { status: "ok", since: 10_000 } });
    expect(run([[0, c("diverged")], [10_000, c("ok")], [70_000, c("ok")]])).toMatchObject({ status: "ok", since: 10_000, pending: null });
    // unavailable flapping with fresh ticks keeps its since too
    expect(run([[0, c("unavailable")], [5_000, c("ok")], [6_000, c("unavailable")], [700_000, c("unavailable")]])).toMatchObject({ status: "unavailable", since: 0 });
    // from ok to no-primary and back: not sticky, immediate
    expect(run([[0, c("ok")], [1_000, c("no-primary")], [2_000, c("ok")]])).toMatchObject({ status: "ok", since: 2_000 });
  });

  test("off-hours ends every run at once (closed)", () => {
    const r = run([[0, c("diverged")], [1_000, c("diverged"), false]]);
    expect(r).toMatchObject({ status: "closed", since: 1_000, lagSince: null });
    expect(run([[0, c("diverged")], [1_000, c("diverged"), false], [2_000, c("diverged")]])).toMatchObject({ status: "diverged", since: 2_000 });
  });

  test("lag run: gap > lagBps (Chainlink present), cleared only after 60 s within it", () => {
    expect(run([[0, c("ok", 150)]]).lagSince).toBe(0);
    expect(run([[0, c("ok", 100)]]).lagSince).toBeNull(); // not above
    expect(run([[0, c("ok", 150)], [10_000, c("ok", 20)], [11_000, c("ok", 150)]]).lagSince).toBe(0);
    expect(run([[0, c("ok", 150)], [10_000, c("ok", 20)], [70_000, c("ok", 20)]]).lagSince).toBeNull();
    // no confirmer (diffBps null) or no Chainlink: not a lag observation; the run clears after the hysteresis
    expect(run([[0, c("ok", 150)], [10_000, c("unavailable", null)], [69_000, c("unavailable", null)]]).lagSince).toBe(0);
    expect(run([[0, c("ok", 150)], [10_000, c("no-primary", null)], [70_000, c("no-primary", null)]]).lagSince).toBeNull();
    expect(run([[0, c("diverged", 300)], [1_000, c("diverged", 300), false]]).lagSince).toBeNull();
  });
});
