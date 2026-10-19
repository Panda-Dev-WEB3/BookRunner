// Audit 2026-10 lead "Redis is a shared trust domain": an attacker with Redis write access must not be able to make the
// agent quote off-price (only oracle-signed prints of the book's price id are used), nor halt it (only a RISK-signed
// kill order does); the agent signs the quotes it publishes so risk can tell them from forged ones.
import { describe, expect, test } from "bun:test";
import {
  type BusForgedMsg,
  DESK_REJECTS_WINDOW_SEC,
  ForgedLog,
  KEYS,
  KillVerifier,
  type LimitState,
  OraclePriceVerifier,
  type OraclePriceMsg,
  type PriceUpdate,
  type QuotingVenue,
  SESSIONS_24X7,
  type TwoSidedQuote,
  type VenueAccount,
  devAccount,
  encodePriceData,
  killNonce,
  priceId,
  priceTypedData,
  RiskStateVerifier,
  recoverQuoteSigner,
  signKill,
  signRiskState,
  signQuote,
  usd,
} from "@bookrunner/shared";
import { type Address, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type AgentChain, BookAgent, type BookAgentConfig, type BookAgentDeps } from "../src/agent/book-agent";
import { DeskRejects } from "../src/agent/desk-rejects";
import { AgentKillGate, AgentRiskStateGate } from "../src/agent/kill-gate";
import { PriceFeed, VerifiedPriceInput } from "../src/agent/price-feed";
import { PullPrices } from "../src/chain/pull-prices";
import { DEFAULT_QUOTING_CONFIG } from "../src/domain/quoting";
import { RuleBasedSizing } from "../src/domain/sizing";
import { DEFAULT_VOL_CONFIG, EwmaVolatility } from "../src/domain/volatility";
import { FakeBus, FakeStore, nvdaMandate, silentLog } from "./helpers";

const CHAIN = 31337;
const ORACLE = "0x00000000000000000000000000000000000000aa" as Address;
const NVDA = priceId("NVDA");
const TSLA = priceId("TSLA");
const oracleKey = devAccount("oracleSigner");
const attacker = privateKeyToAccount(keccak256(toHex("redis-writer")));
const T0 = 1_760_000_000;

const upd = (price: number, at: number, id = NVDA): PriceUpdate => ({
  underlying: id,
  priceWad: BigInt(Math.round(price * 1e6)) * 10n ** 12n,
  publishedAt: BigInt(at),
  held: false,
  sourceCount: 3,
  sourcesHash: keccak256(toHex(`${id}:${at}`)),
});

async function signed(u: PriceUpdate, who: { signTypedData: typeof oracleKey.signTypedData } = oracleKey): Promise<OraclePriceMsg> {
  const signature = await who.signTypedData(priceTypedData(CHAIN, ORACLE, u));
  return { priceId: "NVDA", underlying: u.underlying, priceWad: u.priceWad.toString(), price: Number(u.priceWad) / 1e18, publishedAt: Number(u.publishedAt), held: u.held, sourceCount: u.sourceCount, sources: [], sourcesHash: u.sourcesHash, signature };
}

const verifier = () => new OraclePriceVerifier({ chainId: CHAIN, oracle: ORACLE, isOracleSigner: async (a) => a.toLowerCase() === oracleKey.address.toLowerCase() });

class FakeVenue implements QuotingVenue {
  kind = "orderly" as const;
  replaced: TwoSidedQuote[] = [];
  cancels = 0;
  async replaceQuote(q: TwoSidedQuote) {
    this.replaced.push(q);
  }
  async cancelAll() {
    this.cancels++;
  }
  async account(): Promise<VenueAccount> {
    return { equityUsd: usd(75_000), freeCollateralUsd: usd(75_000), position: null };
  }
  async fillsSince() {
    return [];
  }
}

const chain: AgentChain = { readMandate: async () => nvdaMandate(), mandateKilled: async () => false, mandateOffHours: async () => false, bookState: async () => "Live" };

const cfg: BookAgentConfig = {
  quoting: DEFAULT_QUOTING_CONFIG,
  quoteIntervalMs: 5,
  stateRefreshMs: 5,
  fillPollMs: 5,
  hedgeIntervalMs: 5,
  priceStaleSec: 30,
  chainPriceFallbackSec: 10,
  maxPriceAgeSec: 300,
  requoteBps: 1,
  requoteSizeFrac: 0.2,
  requoteMaxMs: 10_000,
  quoteSampleMs: 1_000,
  quoteReceiptMs: 5_000,
  receiptsIntervalSec: 60,
  heartbeatTtlMs: 60_000,
  quoteTtlMs: 10_000,
  fillLookbackMs: 60_000,
};

function setup(o: { chain?: Partial<AgentChain>; cfg?: Partial<BookAgentConfig>; deps?: Partial<BookAgentDeps> } = {}) {
  let now = T0 * 1000;
  const venue = new FakeVenue();
  const vol = new EwmaVolatility(DEFAULT_VOL_CONFIG);
  const price = new PriceFeed("NVDA", vol);
  const input = new VerifiedPriceInput(verifier(), NVDA, silentLog);
  const bus = new FakeBus();
  const agent = new BookAgent(
    { bookId: 1, venue, chain: { ...chain, ...o.chain }, price, vol, sizing: new RuleBasedSizing(), store: new FakeStore(), bus, hedger: null, sessions: SESSIONS_24X7, initialMandate: nvdaMandate(), log: silentLog, now: () => now, ...o.deps },
    { ...cfg, ...o.cfg },
  );
  /** what the agent's channel subscription does with a raw Redis message */
  const publish = async (raw: unknown) => agent.onPrice(await input.accept(typeof raw === "string" ? raw : JSON.stringify(raw)));
  return { agent, venue, price, input, publish, bus, advance: (ms: number) => (now += ms) };
}

const mid = (q: TwoSidedQuote) => (q.bid!.px + q.ask!.px) / 2;

describe("quote price from Redis: only oracle-signed prints of this book's price id", () => {
  test("a forged print never moves the quote (wrong signer, tampered price, unsigned, another underlying)", async () => {
    const t = setup();
    await t.publish(await signed(upd(190, T0)));
    await t.agent.refreshState();
    await t.agent.quoteTick();
    expect(mid(t.venue.replaced.at(-1)!)).toBeCloseTo(190, 0);

    const genuine = await signed(upd(190, T0 + 1));
    const forged: unknown[] = [
      await signed(upd(250, T0 + 2), attacker), // signed by a non-signer
      { ...genuine, priceWad: (250n * 10n ** 18n).toString(), price: 250, publishedAt: T0 + 2 }, // tampered after signing
      { ...genuine, price: 250, priceWad: (250n * 10n ** 18n).toString(), signature: "0x" }, // unsigned
      { priceId: "NVDA", price: 250, publishedAt: T0 + 2, held: false }, // the old unsigned shape
      { ...(await signed(upd(250, T0 + 2, TSLA))), priceId: "NVDA" }, // a genuine TSLA print relabelled as NVDA
      "not json",
    ];
    for (const f of forged) await t.publish(f);
    expect(t.input.rejected).toBe(forged.length);
    expect(t.price.latest()?.price).toBe(190);
    expect(t.price.latest()?.publishedAt).toBe(T0);
    t.advance(1_000);
    await t.agent.quoteTick();
    for (const q of t.venue.replaced) expect(mid(q)).toBeCloseTo(190, 0);
  });

  test("a far-future forged print cannot freeze the feed; a replayed genuine print is ignored", async () => {
    const t = setup();
    await t.publish(await signed(upd(190, T0)));
    await t.publish({ ...(await signed(upd(190, T0 + 10_000), attacker)) }); // would block every later print if accepted
    await t.publish(await signed(upd(191, T0 + 1)));
    expect(t.price.latest()?.price).toBe(191);
    await t.publish(await signed(upd(190, T0))); // replay of an older genuine print
    expect(t.price.latest()?.price).toBe(191);
  });

  test("the signed fields win over the message's own unsigned price", async () => {
    const t = setup();
    await t.publish({ ...(await signed(upd(190, T0))), price: 250 });
    expect(t.price.latest()?.price).toBe(190);
  });
});

describe("kill channel: only a RISK-signed kill order halts the agent", () => {
  const CONFIG = "0x00000000000000000000000000000000000c0f19" as Address;
  const RISK = privateKeyToAccount(keccak256(toHex("risk-key")));

  function gate(t: ReturnType<typeof setup>, o: { down?: boolean } = {}) {
    const forged: BusForgedMsg[] = [];
    const v = new KillVerifier({
      chainId: CHAIN,
      config: CONFIG,
      now: () => T0 * 1000 + 5_000,
      isRiskSigner: async (a) => {
        if (o.down) throw new Error("rpc down");
        return a.toLowerCase() === RISK.address.toLowerCase();
      },
    });
    const g = new AgentKillGate(1, v, new ForgedLog("agent-1", async (m) => void forged.push(m), () => T0 * 1000), silentLog);
    /** what the agent's kill subscription does with a raw Redis message */
    const deliver = async (raw: unknown) => {
      const m = await g.accept(typeof raw === "string" ? raw : JSON.stringify(raw));
      if (m) t.agent.onKill(m);
    };
    return { deliver, forged };
  }
  const order = (who = RISK, over: { bookId?: number; issuedAt?: number; episode?: string } = {}) =>
    signKill(who, CHAIN, CONFIG, { bookId: over.bookId ?? 1, reason: "DRAWDOWN", breaches: ["DRAWDOWN"], issuedAt: over.issuedAt ?? T0, nonce: killNonce(over.bookId ?? 1, over.episode ?? "ep1") });

  test("unsigned, forged, tampered and unreadable kills are ignored (no cancel, no halt) and counted", async () => {
    const t = setup();
    const g = gate(t);
    await t.publish(await signed(upd(190, T0)));
    await t.agent.refreshState();
    await t.agent.quoteTick();
    const placed = t.venue.replaced.length;
    for (const raw of [
      { bookId: 1, ts: 0, reason: "FORGED", breaches: [] }, // the pre-fix unsigned shape
      await order(attacker), // signed by a key without RISK_ROLE
      { ...(await order(RISK, { episode: "ep2" })), reason: "TAMPERED" },
      "garbage",
    ]) await g.deliver(raw);
    expect(t.agent.halted).toBeNull();
    expect(t.venue.cancels).toBe(0);
    expect(g.forged.at(-1)?.events).toHaveLength(4);
    t.advance(1_000);
    await t.agent.quoteTick(); // still quoting
    expect(t.venue.replaced.length).toBeGreaterThanOrEqual(placed);
    expect(t.agent.halted).toBeNull();
  });

  test("a RISK-signed kill cancels and halts; a replay, a stale one or another book's is ignored", async () => {
    const t = setup();
    const g = gate(t);
    await g.deliver(await order(RISK, { episode: "old", issuedAt: T0 - 3_600 })); // stale
    await g.deliver(await order(RISK, { bookId: 2, episode: "b2" })); // another book's (valid) order
    expect(t.agent.halted).toBeNull();
    const k = await order();
    await g.deliver(k);
    expect(t.agent.halted).toBe("KILL_MSG:DRAWDOWN");
    const res = await t.agent.run();
    expect(res.halted).toBe(true);
    expect(t.venue.cancels).toBeGreaterThanOrEqual(1);
    expect(g.forged).toHaveLength(0); // none of these is a forgery
  });

  test("RISK role check unavailable (RPC): ignored, not a halt (the on-chain kill still halts via mandate.killed)", async () => {
    const t = setup();
    const g = gate(t, { down: true });
    await g.deliver(await order());
    expect(t.agent.halted).toBeNull();
  });
});

describe("published quotes are signed by the desk key (risk checks only those)", () => {
  test("the quote in Redis carries an AgentQuote signature that recovers to the desk key", async () => {
    const desk = privateKeyToAccount(keccak256(toHex("desk-key")));
    const mandate = "0x00000000000000000000000000000000000a0a02" as Address;
    const now = T0 * 1000;
    const bus = new FakeBus();
    const vol = new EwmaVolatility(DEFAULT_VOL_CONFIG);
    const price = new PriceFeed("NVDA", vol);
    price.ingest(await new VerifiedPriceInput(verifier(), NVDA, silentLog).accept(JSON.stringify(await signed(upd(190, T0)))));
    const agent = new BookAgent(
      { bookId: 1, venue: new FakeVenue(), chain, price, vol, sizing: new RuleBasedSizing(), store: new FakeStore(), bus, hedger: null, sessions: SESSIONS_24X7, initialMandate: nvdaMandate(), log: silentLog, now: () => now, signQuote: (q) => signQuote(desk, CHAIN, mandate, q) },
      cfg,
    );
    await agent.refreshState();
    await agent.quoteTick();
    for (let i = 0; i < 20 && bus.quotes.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const q = bus.quotes[0]!;
    expect(q.signature).toBeDefined();
    expect(await recoverQuoteSigner(CHAIN, mandate, q)).toBe(desk.address);
  });
});

describe("pull prices: forged signed updates are never selected", () => {
  test("a forged future-dated update in the Redis bundle is dropped by the local signature check", async () => {
    const good = upd(190, T0);
    const bad = upd(250, T0 + 3_600);
    const bundle = {
      priceData: encodePriceData([good, bad], [await oracleKey.signTypedData(priceTypedData(CHAIN, ORACLE, good)), await attacker.signTypedData(priceTypedData(CHAIN, ORACLE, bad))]),
      publishedAt: T0 + 3_600,
      chainId: CHAIN,
      oracle: ORACLE,
      priceIds: [NVDA, NVDA],
    };
    const v = verifier();
    const checked = new PullPrices({ sources: [{ name: "redis", get: async () => bundle }], domain: { chainId: CHAIN, oracle: ORACLE }, verify: async (u, s) => (await v.verify(u, s)).ok, now: () => (T0 + 10) * 1000 });
    expect((await checked.point(NVDA, 600))?.priceWad).toBe(good.priceWad);
    // without the check (trader simulator) the forged one would win the freshest selection
    const unchecked = new PullPrices({ sources: [{ name: "redis", get: async () => bundle }], domain: { chainId: CHAIN, oracle: ORACLE }, now: () => (T0 + 10) * 1000 });
    expect((await unchecked.point(NVDA, 600))?.priceWad).toBe(bad.priceWad);
  });
});

describe("desk StaleTradePrice rejections (alerts desk_stale_trade_price)", () => {
  test("counted within the window, published to Redis, other refusals ignored, reloaded after a restart", async () => {
    let now = T0 * 1000;
    const bus = new FakeBus();
    const r = new DeskRejects(1, bus, silentLog, () => now);
    await r.load();
    r.note("MandateViolation", "Hedge");
    expect(bus.kv.get(KEYS.agentDeskRejects(1))).toBeUndefined();
    r.note("StaleTradePrice", "Hedge");
    now += 60_000;
    r.note("StaleTradePrice", "Flatten");
    expect(bus.kv.get(KEYS.agentDeskRejects(1))).toEqual({ v: 1, bookId: 1, ts: now, staleTradePrice: [T0 * 1000, T0 * 1000 + 60_000] });
    const restarted = new DeskRejects(1, bus, silentLog, () => now);
    await restarted.load();
    expect(restarted.recent()).toHaveLength(2);
    now += DESK_REJECTS_WINDOW_SEC * 1000 - 30_000; // the first one ages out
    expect(restarted.recent()).toEqual([T0 * 1000 + 60_000]);
  });
});

describe("risk state: only a RISK-signed state is acted on; none for the timeout = reduce-only, never a halt", () => {
  const CONFIG = "0x00000000000000000000000000000000000c0f19" as Address;
  const RISK = privateKeyToAccount(keccak256(toHex("risk-key")));
  const stateMsg = async (state: LimitState, tsMs: number, who = RISK) => ({ state, breaches: [], stateSig: { tsMs, signature: await signRiskState(who, CHAIN, CONFIG, { bookId: 1, state, tsMs }) } });

  function guarded() {
    const forged: BusForgedMsg[] = [];
    let clock = T0 * 1000;
    const gate = new AgentRiskStateGate(
      new RiskStateVerifier({ chainId: CHAIN, config: CONFIG, bookId: 1, isRiskSigner: async (a) => a.toLowerCase() === RISK.address.toLowerCase(), now: () => clock }),
      new ForgedLog("agent-1", async (m) => void forged.push(m), () => clock),
      silentLog,
      () => clock,
    );
    const t = setup({ deps: { verifyRiskState: (raw) => gate.accept(raw), now: () => clock }, cfg: { riskStateTimeoutMs: 30_000 } });
    const settle = () => new Promise((r) => setTimeout(r, 10));
    return { ...t, forged, settle, tick: (ms: number) => (clock += ms), clock: () => clock };
  }

  test("an unsigned or forged 'killed' state never halts (counted as forged); a RISK-signed one does", async () => {
    const g = guarded();
    await g.publish(await signed(upd(190, T0)));
    g.agent.onRiskState(JSON.stringify({ state: "killed" })); // the pre-fix shape
    g.agent.onRiskState(JSON.stringify(await stateMsg("killed", g.clock(), attacker)));
    await g.settle();
    expect(g.agent.halted).toBeNull();
    expect(g.forged.at(-1)?.events).toHaveLength(2);
    g.agent.onRiskState(JSON.stringify(await stateMsg("killed", g.clock())));
    await g.settle();
    expect(g.agent.halted).toBe("RISK_KILLED");
  });

  test("no verified state for the timeout: reduce-only (no two-sided quote), never a halt; a signed state lifts it", async () => {
    const g = guarded();
    await g.publish(await signed(upd(190, T0)));
    await g.agent.refreshState();
    await g.agent.quoteTick(); // within the timeout from the start: quotes
    expect(g.venue.replaced.at(-1)?.bid && g.venue.replaced.at(-1)?.ask).toBeTruthy();
    g.tick(31_000);
    g.advance(31_000);
    await g.publish(await signed(upd(190, T0 + 31)));
    const before = g.venue.replaced.length;
    await g.agent.quoteTick();
    for (const q of g.venue.replaced.slice(before)) expect(!!q.bid && !!q.ask).toBe(false);
    expect(g.agent.halted).toBeNull();
    g.agent.onRiskState(JSON.stringify(await stateMsg("ok", g.clock())));
    await g.settle();
    g.advance(1_000);
    await g.agent.quoteTick();
    expect(g.venue.replaced.at(-1)?.bid && g.venue.replaced.at(-1)?.ask).toBeTruthy();
    // a replay of an older signed state is ignored, not counted as forged
    g.agent.onRiskState(JSON.stringify(await stateMsg("killed", g.clock() - 5_000)));
    await g.settle();
    expect(g.agent.halted).toBeNull();
    expect(g.forged).toHaveLength(0);
  });
});

describe("desk session key: quoting new risk needs an active key", () => {
  test("no desk key: reduce-only (never a two-sided quote), status 'missing'; quotes are unsigned", async () => {
    const t = setup({ cfg: { requireDeskKey: true }, deps: { signQuote: async () => "0x01" } });
    await t.publish(await signed(upd(190, T0)));
    await t.agent.refreshState();
    await t.agent.quoteTick();
    for (const q of t.venue.replaced) expect(!!q.bid && !!q.ask).toBe(false);
    expect(t.bus.kv.get(KEYS.agentStatus(1))).toMatchObject({ deskKey: "missing", deskKeySince: T0 * 1000 });
    expect(t.bus.quotes.every((q) => q.signature === undefined)).toBe(true);
  });

  test("a key expiring mid-session: reduce-only and status 'inactive' (alert agent_no_desk_key), signatures stop", async () => {
    let active = true;
    const desk = privateKeyToAccount(keccak256(toHex("desk-key")));
    const mandate = "0x00000000000000000000000000000000000a0a02" as Address;
    const t = setup({ cfg: { requireDeskKey: true }, chain: { deskKeyActive: async () => active }, deps: { signQuote: (q) => signQuote(desk, CHAIN, mandate, q) } });
    await t.publish(await signed(upd(190, T0)));
    await t.agent.refreshState();
    await t.agent.quoteTick();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.venue.replaced.at(-1)?.bid && t.venue.replaced.at(-1)?.ask).toBeTruthy();
    const q = t.bus.quotes.at(-1)!;
    expect(q.ref?.priceWad).toBe((190n * 10n ** 18n).toString()); // the reference print is in the message ...
    expect(await recoverQuoteSigner(CHAIN, mandate, q)).toBe(desk.address); // ... and under the desk key's signature
    active = false; // validUntil passed / REVOKE_KEY
    t.advance(1_000);
    await t.agent.refreshState();
    const n = t.venue.replaced.length;
    await t.agent.quoteTick();
    for (const r of t.venue.replaced.slice(n)) expect(!!r.bid && !!r.ask).toBe(false);
    expect(t.bus.kv.get(KEYS.agentStatus(1))).toMatchObject({ deskKey: "inactive" });
    const quotesAfter = t.bus.quotes.length;
    await t.agent.quoteTick();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.bus.quotes.slice(quotesAfter).every((x) => x.signature === undefined)).toBe(true);
    expect(t.agent.halted).toBeNull();
  });
});
