// Audit 2026-10 lead "Redis is a shared trust domain": an attacker with Redis write access must not be able to make the
// agent quote off-price (only oracle-signed prints of the book's price id are used), and a forged kill must at worst
// stop the agent (cancel-all + halt), nothing else.
import { describe, expect, test } from "bun:test";
import {
  DESK_REJECTS_WINDOW_SEC,
  KEYS,
  OraclePriceVerifier,
  type OraclePriceMsg,
  type PriceUpdate,
  type QuotingVenue,
  SESSIONS_24X7,
  type TwoSidedQuote,
  type VenueAccount,
  devAccount,
  encodePriceData,
  priceId,
  priceTypedData,
  usd,
} from "@bookrunner/shared";
import { type Address, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type AgentChain, BookAgent, type BookAgentConfig } from "../src/agent/book-agent";
import { DeskRejects } from "../src/agent/desk-rejects";
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

function setup() {
  let now = T0 * 1000;
  const venue = new FakeVenue();
  const vol = new EwmaVolatility(DEFAULT_VOL_CONFIG);
  const price = new PriceFeed("NVDA", vol);
  const input = new VerifiedPriceInput(verifier(), NVDA, silentLog);
  const agent = new BookAgent(
    { bookId: 1, venue, chain, price, vol, sizing: new RuleBasedSizing(), store: new FakeStore(), bus: new FakeBus(), hedger: null, sessions: SESSIONS_24X7, initialMandate: nvdaMandate(), log: silentLog, now: () => now },
    cfg,
  );
  /** what the agent's channel subscription does with a raw Redis message */
  const publish = async (raw: unknown) => agent.onPrice(await input.accept(typeof raw === "string" ? raw : JSON.stringify(raw)));
  return { agent, venue, price, input, publish, advance: (ms: number) => (now += ms) };
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

describe("kill channel: a forged kill is at worst a safe stop", () => {
  test("any kill message for the book (even unreadable) cancels and halts; quoting stops, nothing else happens", async () => {
    for (const raw of [JSON.stringify({ bookId: 1, ts: 0, reason: "FORGED", breaches: [] }), "garbage"]) {
      const t = setup();
      await t.publish(await signed(upd(190, T0)));
      await t.agent.refreshState();
      await t.agent.quoteTick();
      const placed = t.venue.replaced.length;
      t.agent.onKill(raw);
      const res = await t.agent.run();
      expect(res.halted).toBe(true);
      expect(t.venue.cancels).toBeGreaterThanOrEqual(1);
      await t.agent.quoteTick();
      expect(t.venue.replaced.length).toBe(placed); // stopped: no new quote, no other venue action
    }
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
