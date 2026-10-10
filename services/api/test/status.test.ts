import { describe, expect, test } from "bun:test";
import { KEYS } from "@bookrunner/shared/queues";
import { STATUS_CACHE_CONTROL, STATUS_CACHE_MS, createApp } from "../src/app";
import { webOrigins } from "../src/config";
import { type StatusView, markGrace, markStatus, riskLevel } from "../src/domain/status";
import { NOW, makeWorld, seedBook } from "./fixtures";

function setup(opts: { state?: string } = {}) {
  const w = makeWorld();
  seedBook(w, opts);
  const app = createApp(w.deps, { origins: webOrigins("http://127.0.0.1:5180") });
  return { w, app };
}

const getStatus = async (app: ReturnType<typeof setup>["app"]) => {
  const res = await app.request("/status");
  return { res, body: (await res.json()) as StatusView };
};

describe("GET /status", () => {
  test("per book: latest mark age, risk level, last distribution; cache-friendly", async () => {
    const { app } = setup();
    const { res, body } = await getStatus(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(STATUS_CACHE_CONTROL);
    expect(body.chainId).toBe(31337);
    expect(body.markIntervalSeconds).toBe(300);
    expect(body.books).toHaveLength(1);
    const b = body.books[0]!;
    expect(b).toMatchObject({ bookId: 1, symbol: "PERP_NVDA_USDC", state: "Live", venue: "orderly", markStatus: "ok", killed: false });
    expect(b.latestMark).toEqual({ periodEnd: new Date(NOW - 300_000).toISOString(), committedAt: new Date(NOW - 270_000).toISOString(), ageSeconds: 300 });
    // newest limits row is "warn" (no live Redis state)
    expect(b.risk).toBe("warn");
    expect(body.overall).toBe("warn");
    expect(b.lastDistribution).toMatchObject({ grossUsd: "100.000000", seniorUsd: "53.460000", juniorUsd: "35.640000", txHash: "0xdist" });
  });

  test("no secrets or internals: no addresses, no keys, no URLs", async () => {
    const { app } = setup();
    const text = await (await app.request("/status")).text();
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text).not.toMatch(/redis|postgres|mnemonic|token/i);
  });

  test("live risk state wins; killed -> breach + killed flag", async () => {
    const { w, app } = setup();
    w.kv.put(KEYS.riskState(1), { state: "killed", inventoryUtil: 0, skewUtil: 0, drawdownBps: 0, offHours: false, breaches: ["DRAWDOWN"], meta: { ts: NOW } });
    const b = (await getStatus(app)).body.books[0]!;
    expect(b.risk).toBe("breach");
    expect(b.killed).toBe(true);
  });

  test("overdue mark -> overall breach", async () => {
    const { w, app } = setup();
    w.now.ms = NOW + 3 * 3600_000;
    w.kv.put(KEYS.riskState(1), { state: "ok", inventoryUtil: 0, skewUtil: 0, drawdownBps: 0, offHours: false, breaches: [], meta: { ts: w.now.ms } });
    const { body } = await getStatus(app);
    expect(body.books[0]!.markStatus).toBe("overdue");
    expect(body.overall).toBe("breach");
  });

  test("computed at most once per cache window", async () => {
    const { w, app } = setup();
    let calls = 0;
    const orig = w.data.listBooks.bind(w.data);
    w.data.listBooks = async () => {
      calls++;
      return orig();
    };
    await Promise.all([app.request("/status"), app.request("/status"), app.request("/status")]);
    await app.request("/status");
    expect(calls).toBe(1);
    w.now.ms += STATUS_CACHE_MS;
    await app.request("/status");
    expect(calls).toBe(2);
  });

  test("DB failure -> 503, not cached", async () => {
    const { w, app } = setup();
    w.data.listBooks = async () => {
      throw new Error("db down");
    };
    const res = await app.request("/status");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("status domain", () => {
  test("grace: a quarter of the interval within [5 min, 1 h]", () => {
    expect(markGrace(300)).toBe(300);
    expect(markGrace(3600)).toBe(900);
    expect(markGrace(86_400)).toBe(3600);
  });

  test("mark status thresholds", () => {
    const end = new Date(NOW - 3600_000);
    const mark = { periodEnd: end } as Parameters<typeof markStatus>[1];
    expect(markStatus("Live", mark, null, NOW, 3600)).toBe("ok");
    expect(markStatus("Live", mark, null, NOW + 901_000, 3600)).toBe("late");
    expect(markStatus("Live", mark, null, NOW + 3600_000 + 901_000, 3600)).toBe("overdue");
    expect(markStatus("Subscription", null, null, NOW, 3600)).toBe("not_marked");
    expect(markStatus("Live", null, new Date(NOW - 10_000_000), NOW, 3600)).toBe("overdue");
  });

  test("risk levels", () => {
    const v = (state: string) => ({ state }) as Parameters<typeof riskLevel>[0];
    expect(riskLevel(v("ok")).risk).toBe("ok");
    expect(riskLevel(v("reduce_only")).risk).toBe("warn");
    expect(riskLevel(v("breach")).risk).toBe("breach");
    expect(riskLevel(v("killed"))).toEqual({ risk: "breach", killed: true });
    expect(riskLevel(null).risk).toBe("unknown");
  });
});
