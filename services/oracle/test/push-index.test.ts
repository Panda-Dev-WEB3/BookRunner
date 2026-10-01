import { describe, expect, test } from "bun:test";
import { indexAsAggregate, indexLevel } from "../src/domain/index-level";
import { publishTimestamp, pushReason } from "../src/domain/push-policy";

const opts = { intervalMs: 5_000, deviationBps: 25 };

describe("push policy", () => {
  test("first / interval / deviation / held-change / none", () => {
    expect(pushReason(undefined, { price: 100, held: false }, 0, opts)).toBe("first");
    const last = { price: 100, held: false, atMs: 1_000 };
    expect(pushReason(last, { price: 100.1, held: false }, 2_000, opts)).toBeNull(); // 10 bps, 1s
    expect(pushReason(last, { price: 100.1, held: false }, 6_000, opts)).toBe("interval");
    expect(pushReason(last, { price: 100.26, held: false }, 1_500, opts)).toBe("deviation");
    expect(pushReason(last, { price: 99.74, held: false }, 1_500, opts)).toBe("deviation");
    expect(pushReason(last, { price: 100.25, held: false }, 1_500, opts)).toBeNull(); // exactly 25 bps: not >
    expect(pushReason(last, { price: 100, held: true }, 1_500, opts)).toBe("held-change");
  });

  test("publishTimestamp clamps to the chain clock", () => {
    expect(publishTimestamp(1000.9, null)).toBe(1000);
    expect(publishTimestamp(1000, 999)).toBe(1000); // normal: wall within head + 4
    expect(publishTimestamp(1000, 990)).toBe(994); // wall far ahead of chain: head + 4
    expect(publishTimestamp(1000, 90_000)).toBe(90_000); // chain warped ahead: never look stale
  });
});

describe("index level", () => {
  const comps = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"].map((priceId) => ({ priceId, weightBps: 2000 }));
  const prices = new Map(
    Object.entries({ NVDA: 190, TSLA: 440, AAPL: 255, MSFT: 520, AMZN: 230 }).map(([k, price]) => [k, { price, sourceCount: 3, ts: 5 }]),
  );

  test("RHX5 at demo prices = 0.2 * (190 + 440 + 255 + 520 + 230) = 327", () => {
    const r = indexLevel(comps, prices);
    expect(r.ok).toBe(true);
    expect(r.level).toBeCloseTo(327, 10);
    expect(r.sourceCount).toBe(3);
    expect(r.sources.map((s) => s.name)).toEqual(["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"]);
  });

  test("unequal weights and weakest source count", () => {
    const p = new Map(prices);
    p.set("TSLA", { price: 440, sourceCount: 4, ts: 5 });
    p.set("AAPL", { price: 255, sourceCount: 2, ts: 5 });
    const r = indexLevel(
      [
        { priceId: "NVDA", weightBps: 5000 },
        { priceId: "TSLA", weightBps: 3000 },
        { priceId: "AAPL", weightBps: 2000 },
      ],
      p,
    );
    expect(r.level).toBeCloseTo(0.5 * 190 + 0.3 * 440 + 0.2 * 255, 10);
    expect(r.sourceCount).toBe(2);
    expect(indexAsAggregate(r, 3).ok).toBe(false);
  });

  test("missing component -> not ok, never seeded", () => {
    const p = new Map(prices);
    p.delete("MSFT");
    const r = indexLevel(comps, p);
    expect(r).toMatchObject({ ok: false, level: null, missing: ["MSFT"] });
    const agg = indexAsAggregate(r, 3);
    expect(agg.ok).toBe(false);
    expect(agg.accepted).toEqual([]);
    expect(agg.reason).toContain("MSFT");
  });
});
