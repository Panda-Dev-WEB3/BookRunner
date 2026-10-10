// VERIFY C1-C4 / C2: Chainlink as a production source — per-token feeds divided by the token's
// uiMultiplier (the multiplier is applied once, by the registry), decimals read on-chain, per-feed
// heartbeat staleness, the advisory oraclePaused flag, the L2 sequencer feed, and `held` from the session
// calendar rather than from the feed.
import { describe, expect, test } from "bun:test";
import { MULTIPLIER_VECTOR as V, SESSIONS_24X7, SESSIONS_NYSE_RTH, WAD, encodeSessions, priceId } from "@bookrunner/shared";
import type { Address } from "viem";
import { loadOracleConfig, resolveFeeds } from "../src/config";
import { buildUniverse } from "../src/domain/universe";
import { type AggregatorReader, ChainlinkSource, type ResolvedFeed, type RoundData, type TokenState } from "../src/sources/chainlink";
import { buildSources } from "../src/sources";
import { ScriptedSource, makeService, silentLog } from "./fakes";

const FEED = "0x00000000000000000000000000000000000000F1" as Address;
const TOKEN = "0x00000000000000000000000000000000000000D1" as Address;
const SEQ = "0x00000000000000000000000000000000000000E1" as Address;
// Thu 2026-10-01 15:00 UTC = 11:00 ET (in session)
const T0 = Date.parse("2026-10-01T15:00:00Z");
const T0S = BigInt(T0 / 1000);

class FakeReader implements AggregatorReader {
  dec = 8;
  decCalls = 0;
  rounds = new Map<Address, RoundData>();
  token: TokenState = { uiMultiplier: V.uiMultiplierWad, newUIMultiplier: V.uiMultiplierWad, effectiveAt: 0n, oraclePaused: false };
  tokenReads = 0;
  async decimals() {
    this.decCalls++;
    return this.dec;
  }
  async latestRoundData(feed: Address) {
    const r = this.rounds.get(feed);
    if (!r) throw new Error(`no round for ${feed}`);
    return r;
  }
  async tokenState() {
    this.tokenReads++;
    return this.token;
  }
}

const perToken = (over: Partial<ResolvedFeed> = {}): ResolvedFeed => ({ proxy: FEED, basis: "per-token", token: TOKEN, decimals: 8, maxAgeMs: 86_400_000 + 600_000, ...over });

function setup(now = T0, feed: Partial<ResolvedFeed> = {}, opts: { seq?: boolean } = {}) {
  const reader = new FakeReader();
  reader.rounds.set(FEED, { answer: V.feedAnswer, startedAt: T0S - 60n, updatedAt: T0S - 60n });
  reader.rounds.set(SEQ, { answer: 0n, startedAt: T0S - 7200n, updatedAt: T0S - 7200n });
  const src = new ChainlinkSource({ NVDA: perToken(feed) }, reader, { now: () => now, ...(opts.seq ? { sequencerFeed: SEQ, sequencerGraceMs: 3_600_000 } : {}) });
  return { reader, src };
}

describe("ChainlinkSource: per-token feeds are converted to per share (C2)", () => {
  test("price = feed / uiMultiplier (the pinned vector); decimals read once; kind chainlink", async () => {
    const { reader, src } = setup();
    const o = await src.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    expect(Number(o.price.toFixed(8))).toBe(V.perSharePrice);
    expect(o.uiMultiplier).toBe(V.uiMultiplierWad);
    expect(o.ts).toBe(T0 - 60_000);
    expect(o.stale).toBe(false);
    expect(await src.fetch("NVDA")).toEqual({ price: o.price, ts: T0 - 60_000, maxAgeMs: 87_000_000 });
    expect(reader.decCalls).toBe(1);
    expect(src.kind).toBe("chainlink");
    // a per-share feed is used as is (no token read)
    const plain = new ChainlinkSource({ NVDA: perToken({ basis: "per-share", token: null }) }, reader, { now: () => T0 });
    const reads = reader.tokenReads;
    expect((await plain.fetch("NVDA"))?.price).toBe(185.12345678);
    expect(reader.tokenReads).toBe(reads);
  });

  test("end to end: signed per-share price x registry multiplier = qty x feed (never multiplier^2)", async () => {
    const { src } = setup();
    const now = T0;
    const others = ["http-a", "http-b"].map((n) => new ScriptedSource(n, () => now));
    for (const s of others) s.set("NVDA", { price: V.perSharePrice });
    const { svc } = makeService({ sources: [src, ...others], settings: { minSources: 3, production: true }, now: () => now });
    await svc.setDeployment({ chainId: 4663, oracle: "0x00000000000000000000000000000000000000AA", chain: null });
    await svc.setUniverse(buildUniverse({ equities: [{ priceId: "NVDA", underlying: priceId("NVDA") }], indexes: [], books: [], defaultSessions: encodeSessions(SESSIONS_24X7) }).entries);
    const summary = await svc.tick(now);
    expect(summary.published).toEqual(["NVDA"]);
    const msg = svc.price("NVDA")!;
    expect(msg.sourceCount).toBe(3);
    expect(BigInt(msg.priceWad)).toBe(V.perSharePriceWad);
    // StockTokenRegistry._value with the live uiMultiplier
    const value = (V.qtyRaw * V.uiMultiplierWad * BigInt(msg.priceWad)) / (10n ** 18n * WAD * 10n ** 12n);
    expect(value).toBe(V.valueUsd6);
  });
});

describe("ChainlinkSource: refusals", () => {
  test("oraclePaused (corporate action) -> no observation", async () => {
    const { reader, src } = setup();
    reader.token = { ...reader.token, oraclePaused: true };
    const o = await src.observe("NVDA");
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.reason).toContain("oraclePaused");
    expect(await src.fetch("NVDA")).toBeNull();
  });

  test("multiplier effective after the feed's last round: the round's own multiplier, or no observation", async () => {
    // seen before the change: the answer embeds the multiplier observed with that round -> exact per share
    const seen = setup();
    const before = await seen.src.observe("NVDA");
    seen.reader.token = { uiMultiplier: 1_05n * 10n ** 16n, newUIMultiplier: 1_05n * 10n ** 16n, effectiveAt: T0S - 30n, oraclePaused: false };
    const after = await seen.src.observe("NVDA");
    if (!before.ok || !after.ok) throw new Error("expected observations");
    expect(after.price).toBe(before.price);
    expect(after.uiMultiplier).toBe(V.uiMultiplierWad);
    // a new round priced with the new multiplier uses it
    seen.reader.rounds.set(FEED, { answer: (V.feedAnswer * 105n) / 100n, startedAt: T0S - 10n, updatedAt: T0S - 10n });
    const next = await seen.src.observe("NVDA");
    if (!next.ok) throw new Error(next.reason);
    expect(next.uiMultiplier).toBe(1_05n * 10n ** 16n);
    // never seen (e.g. restart after the change): dropped
    const { reader, src } = setup();
    reader.token = { uiMultiplier: 10n * WAD, newUIMultiplier: 10n * WAD, effectiveAt: T0S - 30n, oraclePaused: false };
    const o = await src.observe("NVDA");
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.reason).toContain("after the feed's last round");
    reader.token = { uiMultiplier: V.uiMultiplierWad, newUIMultiplier: 10n * WAD, effectiveAt: T0S + 86_400n, oraclePaused: false };
    const p = await src.observe("NVDA");
    if (!p.ok) throw new Error(p.reason);
    expect(p.pendingMultiplier).toEqual({ value: 10n * WAD, effectiveAt: Number(T0S + 86_400n) });
  });

  test("decimals mismatch, bad answers, future rounds, unknown tickers", async () => {
    const { reader, src } = setup();
    reader.dec = 18;
    const o = await src.observe("NVDA");
    expect(!o.ok && o.reason).toContain("decimals() = 18, configured 8");
    const s2 = setup();
    s2.reader.rounds.set(FEED, { answer: -1n, startedAt: T0S, updatedAt: T0S });
    expect(await s2.src.fetch("NVDA")).toBeNull();
    s2.reader.rounds.set(FEED, { answer: 1n, startedAt: 0n, updatedAt: 0n });
    expect(await s2.src.fetch("NVDA")).toBeNull();
    s2.reader.rounds.set(FEED, { answer: 1n, startedAt: T0S + 60n, updatedAt: T0S + 60n });
    expect(await s2.src.fetch("NVDA")).toBeNull();
    s2.reader.token = { ...s2.reader.token, uiMultiplier: 0n };
    s2.reader.rounds.set(FEED, { answer: 1n, startedAt: T0S, updatedAt: T0S });
    expect(await s2.src.fetch("NVDA")).toBeNull();
    expect(await s2.src.observe("TSLA")).toEqual({ ok: false, reason: "no feed configured" });
  });

  test("L2 sequencer: down or inside the grace period -> no observation", async () => {
    const { reader, src } = setup(T0, {}, { seq: true });
    expect((await src.observe("NVDA")).ok).toBe(true);
    reader.rounds.set(SEQ, { answer: 1n, startedAt: T0S - 7200n, updatedAt: T0S - 7200n });
    expect(await src.observe("NVDA")).toEqual({ ok: false, reason: "L2 sequencer down" });
    reader.rounds.set(SEQ, { answer: 0n, startedAt: T0S - 60n, updatedAt: T0S - 60n });
    const o = await src.observe("NVDA");
    expect(!o.ok && o.reason).toContain("grace");
  });
});

describe("staleness and market hours (C3)", () => {
  const rthUniverse = () =>
    buildUniverse({
      equities: [{ priceId: "NVDA", underlying: priceId("NVDA") }],
      indexes: [],
      books: [{ bookId: 1, venue: 0, symbol: "NVDA-PERP", oracleKey: "NVDA", sessions: encodeSessions(SESSIONS_NYSE_RTH) }],
      defaultSessions: encodeSessions(SESSIONS_NYSE_RTH),
    }).entries;

  test("in session: a feed older than heartbeat + grace is rejected by the aggregator (per-observation max age)", async () => {
    let now = T0;
    const reader = new FakeReader();
    reader.rounds.set(FEED, { answer: V.feedAnswer, startedAt: T0S - 60n, updatedAt: T0S - 60n });
    const live = new ChainlinkSource({ NVDA: perToken({ maxAgeMs: 3_600_000 }) }, reader, { now: () => now });
    const http = ["http-a", "http-b"].map((n) => new ScriptedSource(n, () => now));
    for (const s of http) s.set("NVDA", { price: V.perSharePrice });
    const { svc } = makeService({ sources: [live, ...http], settings: { minSources: 3, sessionsMode: "charter", production: true }, now: () => now });
    await svc.setDeployment({ chainId: 4663, oracle: "0x00000000000000000000000000000000000000AA", chain: null });
    await svc.setUniverse(rthUniverse());
    expect((await svc.tick(now)).published).toEqual(["NVDA"]);
    // feed silent for 2 h while the market is open: only 2 fresh sources < 3 -> nothing is signed
    reader.rounds.set(FEED, { answer: V.feedAnswer, startedAt: T0S - 7200n, updatedAt: T0S - 7200n });
    now = T0 + 1000;
    const s = await svc.tick(now);
    expect(s.published).toEqual([]);
    expect(s.skipped[0]?.reason).toContain("2 of 3 required sources");
  });

  test("off-hours: held at the last open price from the calendar, whatever the feed does", async () => {
    let now = T0;
    const reader = new FakeReader();
    reader.rounds.set(FEED, { answer: V.feedAnswer, startedAt: T0S - 60n, updatedAt: T0S - 60n });
    const live = new ChainlinkSource({ NVDA: perToken() }, reader, { now: () => now });
    const http = ["http-a", "http-b"].map((n) => new ScriptedSource(n, () => now));
    for (const s of http) s.set("NVDA", { price: V.perSharePrice });
    const { svc } = makeService({ sources: [live, ...http], settings: { minSources: 3, sessionsMode: "charter", production: true }, now: () => now });
    await svc.setDeployment({ chainId: 4663, oracle: "0x00000000000000000000000000000000000000AA", chain: null });
    await svc.setUniverse(rthUniverse());
    await svc.tick(now);
    const open = svc.price("NVDA")!;
    expect(open.held).toBe(false);
    // Sat 2026-10-03 15:00 UTC: closed. The feed keeps answering (callable, maybe a different value)
    now = Date.parse("2026-10-03T15:00:00Z");
    reader.rounds.set(FEED, { answer: V.feedAnswer * 2n, startedAt: BigInt(now / 1000), updatedAt: BigInt(now / 1000) });
    await svc.tick(now);
    const held = svc.price("NVDA")!;
    expect(held.held).toBe(true);
    expect(held.price).toBe(open.price);
  });
});

describe("production rules in the service (mainnet)", () => {
  test("synthetic sources cannot be wired into a production service", () => {
    const synth = new ScriptedSource("synthetic-a") as ScriptedSource & { kind: "synthetic" };
    Object.assign(synth, { kind: "synthetic" });
    expect(() => makeService({ sources: [synth], settings: { production: true } })).toThrow("refuses synthetic sources");
    expect(() => makeService({ sources: [synth] })).not.toThrow();
  });

  test("off-hours seeding needs the full minimum on mainnet (1 source is enough off mainnet)", async () => {
    const now = Date.parse("2026-10-03T15:00:00Z"); // closed
    const one = new ScriptedSource("http-a", () => now);
    one.set("NVDA", { price: 190 });
    const universe = buildUniverse({
      equities: [{ priceId: "NVDA", underlying: priceId("NVDA") }],
      indexes: [],
      books: [],
      defaultSessions: encodeSessions(SESSIONS_NYSE_RTH),
    }).entries;
    for (const production of [true, false]) {
      const { svc } = makeService({ sources: [one], settings: { minSources: 3, sessionsMode: "charter", production }, now: () => now, publisher: null });
      await svc.setDeployment({ chainId: production ? 4663 : 31337, oracle: "0x00000000000000000000000000000000000000AA", chain: null });
      await svc.setUniverse(universe);
      const s = await svc.tick(now);
      if (production) {
        expect(s.published).toEqual([]);
        expect(s.skipped[0]?.reason).toContain("1 of 3 sources needed to seed a hold");
      } else expect(s.published).toEqual(["NVDA"]);
    }
  });
});

describe("config: feeds from config/chains/<chainId>.json + ORACLE_CHAINLINK_FEEDS", () => {
  test("mainnet config resolves 5 per-token feeds with their Stock Tokens and heartbeat-based max age", () => {
    const cfg = loadOracleConfig({ CHAIN_ID: "4663" });
    expect(Object.keys(cfg.chainlinkFeeds).sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA", "TSLA"]);
    const nvda = cfg.chainlinkFeeds.NVDA!;
    expect(nvda.basis).toBe("per-token");
    expect(nvda.token).toBe("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
    expect(nvda.proxy).toBe("0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15");
    expect(nvda.decimals).toBe(8);
    expect(nvda.maxAgeMs).toBe(86_400_000 + 600_000);
    expect(cfg.legacyChainlinkFeeds).toEqual([]);
    expect(cfg.sequencerUptimeFeed).toBeNull();
  });

  test("env overlay: objects and legacy plain addresses; a per-token feed without a token is refused", () => {
    const r = resolveFeeds(
      null,
      {
        NVDA: "0x00000000000000000000000000000000000000c1",
        TSLA: { proxy: "0x00000000000000000000000000000000000000c2", basis: "per-token", token: TOKEN, maxAgeSec: 120 },
      },
      { defaultMaxAgeMs: 3_600_000, heartbeatGraceMs: 600_000 },
    );
    expect(r.legacy).toEqual(["NVDA"]);
    expect(r.feeds.NVDA).toMatchObject({ basis: "per-share", token: null, maxAgeMs: 3_600_000 });
    expect(r.feeds.TSLA).toMatchObject({ basis: "per-token", token: TOKEN, maxAgeMs: 120_000 });
    expect(() =>
      resolveFeeds(null, { X: { proxy: "0x00000000000000000000000000000000000000c3", basis: "per-token" } }, { defaultMaxAgeMs: 1, heartbeatGraceMs: 0 }),
    ).toThrow("needs its Stock Token");
    expect(() => loadOracleConfig({ ORACLE_CHAINLINK_FEEDS: '{"X":{"proxy":"0x00000000000000000000000000000000000000c3","basis":"per-token"}}' })).toThrow(
      "needs its Stock Token",
    );
  });

  test("buildSources on mainnet never constructs synthetic sources", () => {
    const built = buildSources(loadOracleConfig({ CHAIN_ID: "4663", ORACLE_SEED: "x".repeat(40) }), silentLog);
    expect(built.syntheticRefused).toContain("impossible on Robinhood Chain mainnet");
    expect(built.market).toBeNull();
    expect(built.sources.map((s) => s.name)).toEqual(["chainlink"]);
  });
});
