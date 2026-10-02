// Low-gas views (docs/LOW_GAS.md): latest signed oracle bundle + age, signed venue report, mark schedule.
import { describe, expect, test } from "bun:test";
import { KEYS, devAccount, priceTypedData, strToBytes32 } from "@bookrunner/shared";
import type { PriceUpdate } from "@bookrunner/shared/eip712";
import { type Address, type Hex, encodeAbiParameters } from "viem";
import { encodeVenueReport, signVenueReport, toSignedVenueReportJson } from "../../ops-venue/src/report712";
import { createApp } from "../src/app";
import { webOrigins } from "../src/config";
import { ORACLE_BUNDLE_KEY, cadenceLabel, markSchedule, signedBundleView, venueReportKey, venueReportView } from "../src/domain/lowgas";
import { bookPriceId } from "../src/routers/book";
import { BOOK, NOW, makeWorld, seedBook } from "./fixtures";

const ORACLE = "0x00000000000000000000000000000000000000c8" as Address; // fakeDeployment().contracts.oracle
const oracleKey = devAccount("oracleSigner");
const ops = devAccount("opsVenue");
const sec = Math.floor(NOW / 1000);

const PRICE_DATA = [
  {
    type: "tuple[]",
    components: [
      { name: "underlying", type: "bytes32" },
      { name: "priceWad", type: "uint256" },
      { name: "publishedAt", type: "uint64" },
      { name: "held", type: "bool" },
      { name: "sourceCount", type: "uint32" },
      { name: "sourcesHash", type: "bytes32" },
    ],
  },
  { type: "bytes[]" },
] as const;

async function bundle(prints: Array<{ id: string; price: bigint; at: number; held?: boolean }>) {
  const updates: PriceUpdate[] = prints.map((p) => ({ underlying: strToBytes32(p.id), priceWad: p.price, publishedAt: BigInt(p.at), held: p.held ?? false, sourceCount: 3, sourcesHash: `0x${"11".repeat(32)}` as Hex }));
  const sigs = await Promise.all(updates.map((u) => oracleKey.signTypedData(priceTypedData(31337, ORACLE, u))));
  const priceData = encodeAbiParameters(PRICE_DATA, [updates, sigs]);
  return { priceData, publishedAt: Math.max(...prints.map((p) => p.at)), chainId: 31337, oracle: ORACLE, priceIds: prints.map((p) => p.id) };
}

async function report(asOf: number) {
  const values = { insuranceUsd: 25_000_000_000n, marginUsd: -1_500_000n, netExposureUsd: 12_345_678_900n, asOf: BigInt(asOf) };
  const signature = await signVenueReport(ops, 31337, BOOK.adapter, values);
  return toSignedVenueReportJson({ ...values, bookId: 1, chainId: 31337, adapter: BOOK.adapter, signer: ops.address, signature, signedAt: NOW });
}

describe("mark schedule", () => {
  test("due while the latest closed period's mark is pending, else the next period end", () => {
    expect(markSchedule(NOW, 300, sec - 300)).toMatchObject({ status: "due", nextPeriodEnd: sec, secondsUntil: 0, cadence: "every 5 min" });
    expect(markSchedule(NOW + 10_000, 300, sec)).toMatchObject({ status: "scheduled", nextPeriodEnd: sec + 300, secondsUntil: 290 });
    // daily cadence: next midnight UTC
    const day = markSchedule(NOW, 86_400, Math.floor(sec / 86_400) * 86_400);
    expect(day).toMatchObject({ status: "scheduled", cadence: "daily", intervalSeconds: 86_400 });
    expect(day.nextPeriodEndAt).toBe("2026-10-03T00:00:00.000Z");
    // a book that is not Live / Retiring is never "due"
    expect(markSchedule(NOW, 300, null, false).status).toBe("scheduled");
    expect(markSchedule(NOW, 300, null, true).status).toBe("due");
  });

  test("cadence labels", () => {
    expect([86_400, 3_600, 300, 172_800, 7_200, 45].map(cadenceLabel)).toEqual(["daily", "hourly", "every 5 min", "every 2 days", "every 2 hours", "every 45 s"]);
  });
});

describe("signed price bundle view", () => {
  test("OracleBundleMsg: per-print price, age and recovered signer; newest publishedAt", async () => {
    const b = await bundle([
      { id: "NVDA", price: 190_500_000_000_000_000_000n, at: sec - 4 },
      { id: "TSLA", price: 440_000_000_000_000_000_000n, at: sec - 2, held: true },
    ]);
    const v = await signedBundleView(b, [], NOW, { chainId: 31337, oracle: null });
    expect(v).toMatchObject({ available: true, source: "bundle", ageSeconds: 2, chainId: 31337, oracle: ORACLE, priceData: b.priceData });
    expect(v.prices.map((p) => [p.priceId, p.price, p.ageSeconds, p.held])).toEqual([
      ["NVDA", 190.5, 4, false],
      ["TSLA", 440, 2, true],
    ]);
    expect(v.prices[0]?.signer).toBe(oracleKey.address);
  });

  test("no bundle: the per-key signed messages; nothing: unavailable", async () => {
    const u: PriceUpdate = { underlying: strToBytes32("NVDA"), priceWad: 191n * 10n ** 18n, publishedAt: BigInt(sec - 30), held: false, sourceCount: 3, sourcesHash: `0x${"11".repeat(32)}` as Hex };
    const signature = await oracleKey.signTypedData(priceTypedData(31337, ORACLE, u));
    const msg = { priceId: "NVDA", underlying: u.underlying, priceWad: u.priceWad.toString(), price: 191, publishedAt: sec - 30, held: false, sourceCount: 3, sources: [], sourcesHash: u.sourcesHash, signature };
    const v = await signedBundleView(null, [msg, { junk: true }], NOW, { chainId: 31337, oracle: ORACLE });
    expect(v).toMatchObject({ available: true, source: "messages", ageSeconds: 30, priceData: null });
    expect(v.prices[0]).toMatchObject({ priceId: "NVDA", price: 191, signer: oracleKey.address });
    expect(await signedBundleView({ priceData: "0xdeadbeef" }, [], NOW, { chainId: 31337, oracle: ORACLE })).toMatchObject({ available: false, source: "none", prices: [] });
  });
});

describe("routes", () => {
  test("oracle.signed: bundle + age + staleness against maxPriceAge", async () => {
    const w = makeWorld();
    w.kv.put(ORACLE_BUNDLE_KEY, await bundle([{ id: "NVDA", price: 190n * 10n ** 18n, at: sec - 400 }]));
    const v = await w.caller.oracle.signed();
    expect(v).toMatchObject({ available: true, maxPriceAgeSeconds: 300, ageSeconds: 400 });
    expect(v.prices[0]).toMatchObject({ priceId: "NVDA", stale: true, signer: oracleKey.address });
  });

  test("book.get: the underlying's latest signed print, the signed venue report and the mark schedule", async () => {
    const w = makeWorld();
    seedBook(w);
    w.kv.put(ORACLE_BUNDLE_KEY, await bundle([{ id: "TSLA", price: 1n, at: sec - 1 }, { id: "NVDA", price: 190n * 10n ** 18n, at: sec - 3 }]));
    w.kv.put(venueReportKey(1), await report(sec - 20));
    const g = await w.caller.book.get({ bookId: 1 });
    expect(g.priceId).toBe("NVDA");
    expect(g.signedPrice).toMatchObject({ priceId: "NVDA", price: 190, ageSeconds: 3 });
    expect(g.venueReport).toMatchObject({ bookId: 1, insuranceUsd: "25000.000000", marginUsd: "-1.500000", netExposureUsd: "12345.678900", ageSeconds: 20, signer: ops.address });
    expect(g.markSchedule).toMatchObject({ intervalSeconds: 300, status: "due", nextPeriodEnd: sec, lastPeriodEnd: sec - 300 });
  });

  test("book.get without low-gas feeds: nulls, never an error", async () => {
    const w = makeWorld();
    seedBook(w);
    const g = await w.caller.book.get({ bookId: 1 });
    expect(g.signedPrice).toBeNull();
    expect(g.venueReport).toBeNull();
    expect(g.markSchedule.cadence).toBe("every 5 min");
  });

  test("book.list carries the mark schedule; book.venueReport (Orderly only)", async () => {
    const w = makeWorld();
    seedBook(w);
    const [b] = await w.caller.book.list();
    expect(b?.markSchedule).toMatchObject({ status: "due", nextPeriodEnd: sec });
    w.kv.put(venueReportKey(1), await report(sec - 5));
    const r = await w.caller.book.venueReport({ bookId: 1 });
    expect(r).toMatchObject({ applicable: true, report: { ageSeconds: 5 } });
    expect(r.report?.venueReport).toBe(encodeVenueReport({ insuranceUsd: 25_000_000_000n, marginUsd: -1_500_000n, netExposureUsd: 12_345_678_900n, asOf: BigInt(sec - 5), signature: (await report(sec - 5)).signature }));
    w.data.books[0]!.venue = 1;
    expect(await w.caller.book.venueReport({ bookId: 1 })).toEqual({ bookId: 1, applicable: false, report: null });
  });

  test("REST mirror: /v1/oracle/signed and /v1/books/:id/venue-report", async () => {
    const w = makeWorld();
    seedBook(w);
    const app = createApp(w.deps, { origins: webOrigins("http://127.0.0.1:5180") });
    w.kv.put(ORACLE_BUNDLE_KEY, await bundle([{ id: "NVDA", price: 190n * 10n ** 18n, at: sec - 3 }]));
    w.kv.put(venueReportKey(1), await report(sec - 5));
    expect(await (await app.request("/v1/oracle/signed")).json()).toMatchObject({ available: true, ageSeconds: 3 });
    expect(await (await app.request("/v1/books/1/venue-report")).json()).toMatchObject({ applicable: true, report: { ageSeconds: 5 } });
  });

  test("tampered venue report: shown with the address it recovers to (not the OPS key)", async () => {
    const r = { ...(await report(sec - 5)), insuranceUsd: "1" };
    const v = await venueReportView(r, NOW);
    expect(v?.signer).not.toBe(ops.address);
    expect(await venueReportView({ junk: 1 }, NOW)).toBeNull();
  });

  test("book price id: risk's view wins, else the ticker from the symbol", () => {
    expect(bookPriceId("PERP_NVDA_USDC")).toBe("NVDA");
    expect(bookPriceId("RHX5-PERP")).toBe("RHX5");
    expect(bookPriceId("PERP_NVDA_USDC", { oracle: { priceId: "NVDA.X" } })).toBe("NVDA.X");
    expect(KEYS.oracleLast("NVDA")).toBe("bkrn:oracle:last:NVDA");
  });
});
