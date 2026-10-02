// Low-gas mark (docs/LOW_GAS.md §1-§3): signed prices + signed venue reports valued off-chain and carried
// in ONE MarkRegistry.commitAndApply tx; fallback to commit + applyMark; the waterfall's "no fee flow"
// signal; Redis feeds with signature + role checks.
import { describe, expect, test } from "bun:test";
import { type PriceUpdate, VENUE, WAD, createLogger, devAccount, priceTypedData, strToBytes32, usd } from "@bookrunner/shared";
import { MemoryEventSink, MemorySettlementSignals } from "@bookrunner/waterfall";
import type { Address, Hex } from "viem";
import {
  type SignedVenueReport,
  type VenueReportValues,
  encodeVenueReport,
  signVenueReport,
  toSignedVenueReportJson,
  venueReportKey,
  venueReportRecentKey,
} from "../../ops-venue/src/report712";
import { type FeedRedis, type FeedVerifier, RedisMarkFeeds } from "../src/adapters/feeds";
import {
  ORACLE_BUNDLE_KEY,
  type SignedPrice,
  decodePriceData,
  encodePriceData,
  newestByUnderlying,
  parseOracleBundle,
  parseSignedPrice,
  pickSignedPrice,
  valuationRefTs,
} from "../src/domain/prices";
import { markReadiness } from "../src/domain/readiness";
import { applySignedVenueReport } from "../src/domain/venue";
import { LocalMarkSigner, MarkPipeline, MarkScheduler, RetryableMarkError, markJobId } from "../src/index";
import type { MarkFeeds } from "../src/ports";
import { FakeMarkChain, FakeMarkStore, FakeReceipts, P, ref, snapshot } from "./fixtures";

const log = createLogger("mark-lowgas-test", "silent");
const REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const ORACLE = "0x00000000000000000000000000000000000000f1" as Address;
const CHAIN = 31337;
const oracleKey = devAccount("oracleSigner");
const opsKey = devAccount("opsVenue");
const NVDA_ID = strToBytes32("NVDA").toLowerCase() as Hex;
const TSLA_ID = strToBytes32("TSLA").toLowerCase() as Hex;

async function signedPrice(over: Partial<PriceUpdate> & { priceId?: string } = {}, signer = oracleKey): Promise<SignedPrice> {
  const u: PriceUpdate = {
    underlying: over.underlying ?? NVDA_ID,
    priceWad: over.priceWad ?? 200n * WAD,
    publishedAt: over.publishedAt ?? BigInt(P + 20),
    held: over.held ?? false,
    sourceCount: over.sourceCount ?? 3,
    sourcesHash: over.sourcesHash ?? (`0x${"11".repeat(32)}` as Hex),
  };
  const signature = await signer.signTypedData(priceTypedData(CHAIN, ORACLE, u));
  return { ...u, priceId: over.priceId ?? "NVDA", signature };
}

const BOOK = ref(1);
const ADAPTER = BOOK.components.adapter;

async function signedReport(v: Partial<VenueReportValues> = {}, o: { adapter?: Address; bookId?: number; signer?: typeof opsKey } = {}): Promise<SignedVenueReport> {
  const values: VenueReportValues = {
    insuranceUsd: v.insuranceUsd ?? usd("26000"),
    marginUsd: v.marginUsd ?? usd("76000"),
    netExposureUsd: v.netExposureUsd ?? -usd("9000"),
    asOf: v.asOf ?? BigInt(P + 20),
  };
  const adapter = o.adapter ?? ADAPTER;
  const signer = o.signer ?? opsKey;
  const signature = await signVenueReport(signer, CHAIN, adapter, values);
  return { ...values, bookId: o.bookId ?? 1, chainId: CHAIN, adapter, signer: signer.address, signature, signedAt: 0 };
}

class StaticFeeds implements MarkFeeds {
  constructor(
    public prices: SignedPrice[] = [],
    public reports: SignedVenueReport[] = [],
    public fail: string | null = null,
  ) {}
  async signedPrices() {
    if (this.fail) throw new Error(this.fail);
    return this.prices;
  }
  async venueReports() {
    if (this.fail) throw new Error(this.fail);
    return this.reports;
  }
}

function setup(o: { feeds?: MarkFeeds; atomic?: boolean; commitMode?: "auto" | "legacy"; maxVenueReportAgeSec?: number } = {}) {
  const chain = new FakeMarkChain();
  chain.atomic = o.atomic ?? true;
  const store = new FakeMarkStore();
  const events = new MemoryEventSink();
  const pipeline = new MarkPipeline({
    books: { get: async (id) => (id === 1 ? BOOK : undefined) },
    chain,
    store,
    receipts: new FakeReceipts(),
    signer: new LocalMarkSigner(devAccount("markSigner"), CHAIN, REGISTRY),
    events,
    log,
    maxRetries: 3,
    confirmations: 0n,
    receiptsWaitMs: 20,
    dbRetries: 2,
    dbRetryBaseMs: 1,
    chainId: CHAIN,
    ...(o.feeds ? { feeds: o.feeds } : {}),
    ...(o.commitMode ? { commitMode: o.commitMode } : {}),
    ...(o.maxVenueReportAgeSec !== undefined ? { maxVenueReportAgeSec: o.maxVenueReportAgeSec } : {}),
  });
  return { chain, store, events, pipeline };
}

// fixture snapshot: vault idle 2000 + desk 500 USDC + 7600 NVDA; adapter 25000 + 75500 (valuationAt P-10)
const NAV_ADAPTER = usd("110600");
// signed report 26000 + 76000 replaces the adapter's 100500
const NAV_SIGNED = usd("2000") + usd("26000") + usd("76000") + usd("8100");

describe("MarkPipeline: one commitAndApply tx (LOW_GAS §3)", () => {
  test("carries the signed prices + venue report the NAV used; no commit / applyMark txs", async () => {
    const price = await signedPrice();
    const report = await signedReport();
    const { chain, store, events, pipeline } = setup({ feeds: new StaticFeeds([price], [report]) });
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    if (out.status !== "applied") return;
    expect(out.atomic).toBe(true);
    expect(chain.commitCalls).toBe(0);
    expect(chain.applyCalls).toBe(0);
    expect(chain.atomicCalls).toHaveLength(1);
    const call = chain.atomicCalls[0]!;
    expect(call.priceData).toBe(encodePriceData([price]));
    expect(decodePriceData(call.priceData)[0]?.priceWad).toBe(200n * WAD);
    expect(call.venueReport).toBe(encodeVenueReport(report));
    // the venue is valued from the signed report, not the adapter's older on-chain one
    expect(out.input.deployedValueUsd).toBe(usd("26000") + usd("76000") + usd("8100"));
    expect(out.input.navUsd).toBe(NAV_SIGNED);
    // the snapshot was handed the newest signed price per underlying
    expect(chain.lastPrices?.get(NVDA_ID)?.priceWad).toBe(200n * WAD);
    // persisted + announced exactly as before
    expect(String(store.rows.get(1)?.commitTx)).toBe(String(out.commitTx));
    expect(store.rows.get(1)?.appliedTx).toBe(out.applyTx);
    expect(out.commitTx).toBe(out.applyTx);
    expect(events.events.map((e) => e.type)).toEqual(["mark.committed"]);
    expect(await pipeline.run({ bookId: 1, periodEnd: P })).toEqual({ status: "already", reason: "book already applied a mark for this period" });
    expect(chain.atomicCalls).toHaveLength(1);
  });

  test("signed report keeps the mark going while the adapter's on-chain report is a day old (no report txs)", async () => {
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([], [await signedReport()]) });
    chain.snap = snapshot({ venue: { ...snapshot().venue, valuationAt: P - 86_400 } });
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(out.status === "applied" && out.input.navUsd).toBe(NAV_SIGNED);
  });

  test("without a fresh signed report the stale-venue guard still refuses (retryable, nothing sent)", async () => {
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([], []) });
    chain.snap = snapshot({ venue: { ...snapshot().venue, valuationAt: P - 86_400 } });
    await expect(pipeline.run({ bookId: 1, periodEnd: P })).rejects.toBeInstanceOf(RetryableMarkError);
    expect(chain.atomicCalls).toHaveLength(0);
    expect(chain.commitCalls).toBe(0);
  });

  test("report the adapter would reject now (withdrawal requested): NAV still uses it, the tx leaves it out", async () => {
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([], [await signedReport()]) });
    chain.reportState = { valuationAt: BigInt(P - 10), lastFlowAt: 0n, pendingWithdrawUsd: usd("100") };
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status === "applied" && out.input.navUsd).toBe(NAV_SIGNED);
    expect(chain.atomicCalls[0]?.venueReport).toBe("0x");
    expect(chain.simulations.every((s) => s.venueReport === "0x")).toBe(true);
  });

  test("simulation reverts on the venue step: retried without the report, prices kept", async () => {
    const price = await signedPrice();
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([price], [await signedReport()]) });
    chain.simulateError = (_pd, vr) => (vr !== "0x" ? "ReportPredatesFlow" : null);
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(chain.simulations).toHaveLength(2);
    expect(chain.atomicCalls[0]).toMatchObject({ priceData: encodePriceData([price]), venueReport: "0x" });
  });

  test("simulation reverts on the price step: sent with neither (the signed mark is authoritative)", async () => {
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([await signedPrice()], [await signedReport()]) });
    chain.simulateError = (pd) => (pd !== "0x" ? "FuturePrice" : null);
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(chain.simulations.map((s) => [s.priceData !== "0x", s.venueReport !== "0x"])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    expect(chain.atomicCalls[0]).toMatchObject({ priceData: "0x", venueReport: "0x" });
  });

  test("every variant reverts for another reason: the job fails (retried), nothing sent", async () => {
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([await signedPrice()], []) });
    chain.simulateError = () => "MarkTooOld";
    await expect(pipeline.run({ bookId: 1, periodEnd: P })).rejects.toThrow("MarkTooOld");
    expect(chain.atomicCalls).toHaveLength(0);
  });

  test("flowNonce moves under the mark tx: recomputed and re-signed at the new nonce", async () => {
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([], [await signedReport()]) });
    chain.nonces = [7n, 8n]; // pre-sign check 7; a flow lands before the tx -> the revert re-reads 8
    chain.failAtomic = ["execution reverted: FlowNonceMismatch"];
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(chain.atomicCalls.map((c) => c.input.flowNonce)).toEqual([7n, 8n]);
    expect(chain.snapshots).toBe(2);
  });

  test("someone else marked the period meanwhile: unmarkable, no retry", async () => {
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([], [await signedReport()]) });
    chain.failAtomic = ["execution reverted: PeriodNotAfterLast"];
    const orig = chain.commitAndApply.bind(chain);
    chain.commitAndApply = async (...a) => {
      chain.lastPeriodEnd = P; // another keeper's commitAndApply landed first
      return orig(...a);
    };
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("unmarkable");
    expect(out.status === "unmarkable" && out.reason).toContain("already applied");
    expect(chain.atomicCalls).toHaveLength(1);
  });

  test("feeds down: valued at on-chain state, still one tx (without prices / report)", async () => {
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([], [], "redis down") });
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status === "applied" && out.input.navUsd).toBe(NAV_ADAPTER);
    expect(chain.atomicCalls[0]).toMatchObject({ priceData: "0x", venueReport: "0x" });
  });

  test("dry run returns the tx plan and sends nothing", async () => {
    const price = await signedPrice();
    const report = await signedReport();
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([price], [report]) });
    const out = await pipeline.run({ bookId: 1, periodEnd: P }, { dryRun: true });
    expect(out.status).toBe("dry_run");
    if (out.status !== "dry_run") return;
    expect(out.computed.tx.priceData).toBe(encodePriceData([price]));
    expect(out.computed.tx.venueReport).toBe(encodeVenueReport(report));
    expect(out.computed.snapshot.venue.source).toBe("signed_report");
    expect(chain.simulations).toHaveLength(0);
    expect(chain.atomicCalls).toHaveLength(0);
  });
});

describe("MarkPipeline: backward compatibility", () => {
  test("registry without commitAndApply: commit + applyMark (two txs), detection cached", async () => {
    const { chain, pipeline } = setup({ atomic: false, feeds: new StaticFeeds([await signedPrice()], [await signedReport()]) });
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(out.status === "applied" && out.atomic).toBeUndefined();
    expect(chain.commitCalls).toBe(1);
    expect(chain.applyCalls).toBe(1);
    expect(chain.atomicCalls).toHaveLength(0);
    // the NAV still uses the signed inputs (they are valuation inputs, not tx inputs)
    expect(out.status === "applied" && out.input.navUsd).toBe(NAV_SIGNED);
    await pipeline.run({ bookId: 1, periodEnd: P + 300 }).catch(() => undefined);
    expect(chain.supportsCalls).toBe(1);
  });

  test("feature check says yes but the call has no such function (no revert data): falls back once", async () => {
    const { chain, pipeline } = setup({ feeds: new StaticFeeds([], [await signedReport()]) });
    chain.simulateUnsupported = true;
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(chain.simulations).toHaveLength(1);
    expect(chain.commitCalls).toBe(1);
    expect(chain.applyCalls).toBe(1);
  });

  test("MARK_COMMIT_MODE=legacy never probes the registry", async () => {
    const { chain, pipeline } = setup({ commitMode: "legacy" });
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(chain.supportsCalls).toBe(0);
    expect(chain.commitCalls).toBe(1);
  });

  test("no feeds configured: pre-low-gas valuation", async () => {
    const { pipeline } = setup({ atomic: false });
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status === "applied" && out.input.navUsd).toBe(NAV_ADAPTER);
  });
});

describe("signed venue report overlay (pure)", () => {
  const s = snapshot({ venue: { ...snapshot().venue, lastFlowAt: P - 100 } });
  const opts = { venue: VENUE.ORDERLY, adapter: ADAPTER, chainId: CHAIN };

  test("newest report consistent with the snapshot wins; deployed = insurance + max(margin,0) + in-transit", async () => {
    const after = await signedReport({ asOf: BigInt(P + 40) }); // after the snapshot block (P+30)
    const good = await signedReport({ asOf: BigInt(P + 25), marginUsd: -usd("5") });
    const older = await signedReport({ asOf: BigInt(P + 5) });
    const o = applySignedVenueReport({ ...s, venue: { ...s.venue, inTransitUsd: usd("7") } }, [older, after, good], opts);
    expect(o.report?.asOf).toBe(BigInt(P + 25));
    expect(o.snapshot.venue.deployedValueUsd).toBe(usd("26000") + usd("7"));
    expect(o.snapshot.venue.marginUsd).toBe(-usd("5"));
    expect(o.snapshot.venue.valuationAt).toBe(P + 25);
    expect(o.snapshot.venue.source).toBe("signed_report");
    expect(o.rejected.some((r) => r.includes("after the snapshot block"))).toBe(true);
  });

  test("never before the last on-chain flow, never older than the adapter's own report", async () => {
    const preFlow = await signedReport({ asOf: BigInt(P - 150) });
    expect(applySignedVenueReport(s, [preFlow], opts).report).toBeNull();
    const notNewer = await signedReport({ asOf: BigInt(P - 20) }); // adapter valuationAt = P - 10
    const o = applySignedVenueReport({ ...s, venue: { ...s.venue, lastFlowAt: 0 } }, [notNewer], opts);
    expect(o.report).toBeNull();
    expect(o.snapshot).toEqual({ ...s, venue: { ...s.venue, lastFlowAt: 0 } });
  });

  test("other adapter / chain, or an engine book: ignored", async () => {
    const other = await signedReport({}, { adapter: "0x00000000000000000000000000000000000000ee" });
    expect(applySignedVenueReport(s, [other], opts).report).toBeNull();
    expect(applySignedVenueReport(s, [{ ...(await signedReport()), chainId: 1 }], opts).report).toBeNull();
    expect(applySignedVenueReport(s, [await signedReport()], { ...opts, venue: VENUE.POOL_ENGINE }).report).toBeNull();
  });
});

describe("signed prices (pure)", () => {
  test("priceData = abi.encode(PriceUpdate[], bytes[]) round trip; empty = 0x", async () => {
    const a = await signedPrice();
    const b = await signedPrice({ underlying: TSLA_ID, priceWad: 440n * WAD, priceId: "TSLA" });
    const data = encodePriceData([a, b]);
    expect(encodePriceData([])).toBe("0x");
    expect(decodePriceData("0x")).toEqual([]);
    expect(decodePriceData(data).map((p) => [p.underlying, p.priceWad, p.signature])).toEqual([
      [a.underlying, a.priceWad, a.signature],
      [b.underlying, b.priceWad, b.signature],
    ]);
  });

  test("OracleBundleMsg (priceData + priceIds), message arrays and malformed input", async () => {
    const a = await signedPrice();
    const b = await signedPrice({ underlying: TSLA_ID, priceId: "TSLA" });
    const bundle = { priceData: encodePriceData([a, b]), publishedAt: P + 20, chainId: CHAIN, oracle: ORACLE, priceIds: ["NVDA", "TSLA"] };
    const parsed = parseOracleBundle(JSON.stringify(bundle));
    expect(parsed.map((p) => p.priceId)).toEqual(["NVDA", "TSLA"]);
    expect(parsed[1]?.signature).toBe(b.signature);
    const msg = { ...a, priceWad: a.priceWad.toString(), publishedAt: Number(a.publishedAt), price: 200 };
    expect(parseOracleBundle([msg])[0]?.priceWad).toBe(a.priceWad);
    expect(parseSignedPrice({ ...msg, signature: "0x12" })).toBeNull();
    expect(parseSignedPrice({ ...msg, underlying: "NVDA" })).toBeNull();
    expect(parseOracleBundle("not json")).toEqual([]);
    expect(parseOracleBundle({ priceData: "0xdeadbeef" })).toEqual([]);
  });

  test("newest per underlying; a signed print is used only when newer than the stored one and not ahead of time", async () => {
    const old = await signedPrice({ publishedAt: BigInt(P) });
    const fresh = await signedPrice({ publishedAt: BigInt(P + 20) });
    const m = newestByUnderlying([fresh, old]);
    expect(m.get(NVDA_ID)?.publishedAt).toBe(BigInt(P + 20));
    expect(pickSignedPrice(m, NVDA_ID, BigInt(P + 20), BigInt(P + 30))).toBeNull(); // chain already has it
    expect(pickSignedPrice(m, NVDA_ID, BigInt(P), BigInt(P + 30))?.publishedAt).toBe(BigInt(P + 20));
    expect(pickSignedPrice(m, NVDA_ID, BigInt(P), BigInt(P + 14))).toBeNull(); // > 5 s ahead of the valuation time
    expect(pickSignedPrice(m, TSLA_ID, 0n, BigInt(P + 30))).toBeNull();
  });

  test("valuation time = max(snapshot block, wall clock): an idle chain's old head never hides a fresh print", () => {
    expect(valuationRefTs(BigInt(P), (P + 600) * 1000)).toBe(BigInt(P + 600));
    expect(valuationRefTs(BigInt(P + 600), P * 1000)).toBe(BigInt(P + 600));
  });
});

// ------------------------------------------------------------------ Redis feeds

class FakeFeedRedis implements FeedRedis {
  kv = new Map<string, string>();
  lists = new Map<string, string[]>();
  async get(k: string) {
    return this.kv.get(k) ?? null;
  }
  async mget(...keys: string[]) {
    return keys.map((k) => this.kv.get(k) ?? null);
  }
  async lrange(k: string, start: number, stop: number) {
    return (this.lists.get(k) ?? []).slice(start, stop + 1);
  }
  async scan(_cursor: string, _m: "MATCH", pattern: string): Promise<[string, string[]]> {
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return ["0", [...this.kv.keys()].filter((k) => re.test(k))];
  }
}

const verifier = (o: Partial<{ oracleSigners: Address[]; ops: Address[] }> = {}): FeedVerifier => ({
  chainId: CHAIN,
  oracle: ORACLE,
  isOracleSigner: async (a) => (o.oracleSigners ?? [oracleKey.address]).some((x) => x.toLowerCase() === a.toLowerCase()),
  isOpsVenue: async (a) => (o.ops ?? [opsKey.address]).some((x) => x.toLowerCase() === a.toLowerCase()),
});

const priceMsg = (p: SignedPrice) => ({ ...p, priceWad: p.priceWad.toString(), publishedAt: Number(p.publishedAt), price: 0, sources: [] });

describe("RedisMarkFeeds", () => {
  test("prices: bundle + per-key messages; only prints signed by an active AttestedOracle signer", async () => {
    const r = new FakeFeedRedis();
    const a = await signedPrice();
    const b = await signedPrice({ underlying: TSLA_ID, priceId: "TSLA" });
    const forged = await signedPrice({ underlying: TSLA_ID, priceWad: 1n, priceId: "TSLA" }, devAccount("trader0"));
    const tampered = { ...(await signedPrice({ priceWad: 300n * WAD })), priceWad: 301n * WAD };
    r.kv.set(ORACLE_BUNDLE_KEY, JSON.stringify({ priceData: encodePriceData([a]), publishedAt: P + 20, chainId: CHAIN, oracle: ORACLE, priceIds: ["NVDA"] }));
    r.kv.set("bkrn:oracle:last:TSLA", JSON.stringify(priceMsg(b)));
    r.kv.set("bkrn:oracle:last:FAKE", JSON.stringify(priceMsg(forged)));
    r.kv.set("bkrn:oracle:last:BAD", JSON.stringify(priceMsg(tampered)));
    const feeds = new RedisMarkFeeds(r, verifier(), log);
    const got = await feeds.signedPrices();
    expect(got.map((p) => p.priceId).sort()).toEqual(["NVDA", "TSLA"]);
    expect(got.find((p) => p.priceId === "TSLA")?.priceWad).toBe(b.priceWad);
  });

  test("prices signed for another oracle / chain domain do not verify", async () => {
    const r = new FakeFeedRedis();
    r.kv.set(ORACLE_BUNDLE_KEY, JSON.stringify({ priceData: encodePriceData([await signedPrice()]) }));
    expect(await new RedisMarkFeeds(r, { ...verifier(), chainId: 1 }, log).signedPrices()).toEqual([]);
    expect(await new RedisMarkFeeds(r, { ...verifier(), oracle: "0x00000000000000000000000000000000000000f2" }, log).signedPrices()).toEqual([]);
  });

  test("venue reports: latest + recent, OPS_VENUE signer only, this book's adapter only, duplicates collapsed", async () => {
    const r = new FakeFeedRedis();
    const latest = toSignedVenueReportJson(await signedReport({ asOf: BigInt(P + 20) }));
    const prev = toSignedVenueReportJson(await signedReport({ asOf: BigInt(P + 5) }));
    const notOps = toSignedVenueReportJson(await signedReport({ asOf: BigInt(P + 6) }, { signer: devAccount("trader0") }));
    const otherAdapter = toSignedVenueReportJson(await signedReport({ asOf: BigInt(P + 7) }, { adapter: "0x00000000000000000000000000000000000000ee" }));
    const tampered = { ...toSignedVenueReportJson(await signedReport({ asOf: BigInt(P + 8) })), insuranceUsd: usd("99999999").toString() };
    r.kv.set(venueReportKey(1), JSON.stringify(latest));
    r.lists.set(venueReportRecentKey(1), [latest, prev, notOps, otherAdapter, tampered].map((x) => JSON.stringify(x)));
    const got = await new RedisMarkFeeds(r, verifier(), log).venueReports(BOOK);
    expect(got.map((x) => Number(x.asOf))).toEqual([P + 20, P + 5]);
    expect(got[0]?.signer).toBe(opsKey.address);
  });

  test("a bare VenueReportMsg (`sig`, no signer field) is accepted with the recovered signer", async () => {
    const r = new FakeFeedRedis();
    const full = toSignedVenueReportJson(await signedReport());
    const { signer: _s, signature: _sig, v: _v, signedAt: _t, ...bare } = full;
    r.kv.set(venueReportKey(1), JSON.stringify(bare));
    const got = await new RedisMarkFeeds(r, verifier(), log).venueReports(BOOK);
    expect(got).toHaveLength(1);
    expect(got[0]?.signer).toBe(opsKey.address);
    // the same report with a revoked ops key is dropped
    expect(await new RedisMarkFeeds(r, verifier({ ops: [] }), log).venueReports(BOOK)).toEqual([]);
  });
});

// ------------------------------------------------------------------ scheduler + waterfall signal

describe("mark waits only for a distribution that is pending (LOW_GAS §3)", () => {
  function sched(signals?: { noDistribution(bookId: number, period: number): Promise<unknown> }) {
    const enq: string[] = [];
    const s = new MarkScheduler({
      books: { list: async () => [ref(1)] },
      chain: {
        snapshot: async () => ({
          state: "Live" as const,
          nowSec: P + 5,
          markInterval: 300,
          subscriptionEnds: 0,
          unfundedClaims: 0n,
          vaultIdle: usd("100"),
          inTransit: 0n,
          pendingWithdraw: 0n,
          mmWithdrawable: null,
          insuranceEquity: 0n,
          marginEquity: 0n,
          netExposure: 0n,
          sharePriceWad: { senior: WAD, junior: WAD },
          lastMarkPeriodEnd: P - 300,
          lastMark: null,
        }),
        pendingRedemptions: async () => ({ senior: 0n, junior: 0n }),
        findDistributed: async () => null,
      },
      maxMarkAge: async () => 3600,
      store: { distribution: async () => null },
      ...(signals ? { signals: signals as never } : {}),
      enqueue: async (job, g) => {
        enq.push(markJobId(job.bookId, job.periodEnd, g));
      },
      log,
      waitSeconds: 60,
      safetySeconds: 60,
    });
    return { s, enq };
  }

  test("the waterfall recorded 'nothing to distribute': marked at once", async () => {
    const signals = new MemorySettlementSignals();
    await signals.markNoDistribution({ bookId: 1, period: P, reason: "no fee flow", pendingGross: "0", at: 0 });
    const { s, enq } = sched(signals);
    const r = await s.tick();
    expect(r[0]?.readiness).toEqual({ ready: true, reason: "no_fee_flow" });
    expect(enq).toEqual([`mark-1-${P}`]);
  });

  test("no signal (distribution pending or waterfall not done): waits", async () => {
    const { s, enq } = sched(new MemorySettlementSignals());
    expect((await s.tick())[0]?.readiness).toEqual({ ready: false, reason: "waiting_distribution" });
    expect(enq).toEqual([]);
  });

  test("an unreadable signal store degrades to the bounded wait", async () => {
    const { s, enq } = sched({ noDistribution: async () => Promise.reject(new Error("redis down")) });
    expect((await s.tick())[0]?.readiness).toEqual({ ready: false, reason: "waiting_distribution" });
    expect(enq).toEqual([]);
  });

  test("readiness: no fee flow still waits for in-flight liquidity", () => {
    const base = { state: "Live" as const, periodEnd: P, lastMarkPeriodEnd: P - 300, nowSec: P + 5, maxMarkAge: 3600, waitSeconds: 60, safetySeconds: 60, distributed: false };
    expect(markReadiness({ ...base, noDistribution: true, liquidityShort: false })).toEqual({ ready: true, reason: "no_fee_flow" });
    expect(markReadiness({ ...base, noDistribution: true, liquidityShort: true })).toEqual({ ready: false, reason: "waiting_liquidity" });
  });
});
