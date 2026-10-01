import { describe, expect, test } from "bun:test";
import { usd } from "@bookrunner/shared";
import { type Hex, decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, toHex } from "viem";
import {
  DESK_ACTION,
  type DeskAction,
  decodeSetQuote,
  encodeFlatten,
  encodeFundDesk,
  encodeHedge,
  encodeReturnToVault,
  encodeSetQuote,
} from "../src/chain/desk-actions";
import {
  DEFAULT_RESEND,
  type EngineChain,
  type EngineQuoteParams,
  type EngineState,
  type EngineTrade,
  EngineVenue,
  engineParamsFromQuote,
  shouldResend,
  tradeToFill,
} from "../src/venues/engine";
import { nvdaMandate } from "./helpers";

const m = nvdaMandate({ maxInventoryUsd: usd(75_000), maxSkewBps: 25, minQuoteWidthBps: 10 }); // RHX5 launch mandate

describe("desk action encoding", () => {
  test("SetQuote = abi.encode(uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd)", () => {
    const a = encodeSetQuote(12, -7, usd(75_000));
    expect(a.kind).toBe(DESK_ACTION.SetQuote);
    expect(a.kind).toBe(5);
    expect(a.proof).toEqual([]);
    // three static 32-byte words
    expect((a.data.length - 2) / 2).toBe(96);
    const words = [0, 1, 2].map((i) => a.data.slice(2 + i * 64, 2 + (i + 1) * 64));
    expect(BigInt(`0x${words[0]}`)).toBe(12n);
    expect(words[1]).toBe("f".repeat(63) + "9"); // -7 sign-extended two's complement
    expect(BigInt(`0x${words[2]}`)).toBe(75_000_000_000n);
    expect(decodeSetQuote(a.data)).toEqual({ spreadBps: 12, skewBps: -7, maxNetExposureUsd: usd(75_000) });
  });

  test("SetQuote rejects out-of-range values", () => {
    expect(() => encodeSetQuote(70_000, 0, 1n)).toThrow();
    expect(() => encodeSetQuote(10, 40_000, 1n)).toThrow();
    expect(() => encodeSetQuote(10.5, 0, 1n)).toThrow();
    expect(() => encodeSetQuote(10, 0, -1n)).toThrow();
    expect(() => encodeSetQuote(10, 0, 1n << 128n)).toThrow();
  });

  test("Hedge / Flatten / FundDesk / ReturnToVault layouts", () => {
    const token = getAddress("0x00000000000000000000000000000000000000a1");
    const venue = toHex("UNIV3", { size: 32 });
    const proof = [keccak256("0x01")];
    const h = encodeHedge({ token, buy: true, amountIn: 1_000_000n, minAmountOut: 5n, poolFee: 3000, proof });
    expect(h.kind).toBe(DESK_ACTION.Hedge);
    expect(h.proof).toEqual(proof);
    expect(decodeAbiParameters([{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint24" }, { type: "bytes32" }], h.data)).toEqual([
      token,
      true,
      1_000_000n,
      5n,
      3000,
      venue,
    ]);
    const f = encodeFlatten({ token, amountIn: 7n, minAmountOut: 6n, poolFee: 500 });
    expect(f.kind).toBe(DESK_ACTION.Flatten);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint24" }, { type: "bytes32" }], f.data)).toEqual([token, 7n, 6n, 500, venue]);
    expect(encodeFundDesk(9n)).toEqual({ kind: DESK_ACTION.FundDesk, data: encodeAbiParameters([{ type: "uint256" }], [9n]), proof: [] });
    expect(encodeReturnToVault(9n).kind).toBe(DESK_ACTION.ReturnToVault);
  });
});

describe("engineParamsFromQuote", () => {
  const ctx = { oraclePx: 100, netExposureUsd: 0n, mandate: m, exposureStepBps: 500 };
  const quote = (bid: number, ask: number, qty = 25) => ({
    bid: { px: bid, qty },
    ask: { px: ask, qty },
    oraclePx: 100,
    theoretical: { bidPx: bid, askPx: ask },
  });

  test("spread rounds up, skew truncates toward zero (mandate-safe rounding)", () => {
    const p = engineParamsFromQuote(quote(100.025, 100.125), ctx)!; // mid 100.075: width 9.99 bps, skew +7.5 bps
    expect(p.spreadBps).toBe(10);
    expect(p.skewBps).toBe(7);
    const neg = engineParamsFromQuote(quote(99.825, 100.025), ctx)!; // mid 99.925: width 20.01 bps, skew -7.5 bps
    expect(neg.skewBps).toBe(-7);
    expect(neg.spreadBps).toBe(21);
  });

  test("never below min width / above max skew", () => {
    const tight = engineParamsFromQuote(quote(99.999, 100.001), ctx)!;
    expect(tight.spreadBps).toBe(10);
    const skewed = engineParamsFromQuote(quote(101, 101.2), ctx)!;
    expect(skewed.skewBps).toBe(25);
  });

  test("capacity: growth rounds up to the exposure step; capped at maxInventoryUsd", () => {
    // flat, 25 units * ~100 = 2.5k per side -> reach 2.5k -> step 3.75k
    expect(engineParamsFromQuote(quote(99.95, 100.05), ctx)!.maxNetExposureUsd).toBe(usd(3_750));
    const nearCap = engineParamsFromQuote(quote(99.95, 100.05, 500), { ...ctx, netExposureUsd: usd(40_000) })!;
    expect(nearCap.maxNetExposureUsd).toBe(usd(75_000));
  });

  test("reducing side only: capacity freezes at |exposure| and never rises above the last cap", () => {
    const longCtx = { ...ctx, netExposureUsd: usd(50_000) };
    const askOnly = { ask: { px: 100.05, qty: 10 }, oraclePx: 100, theoretical: { bidPx: 99.95, askPx: 100.05 } };
    expect(engineParamsFromQuote(askOnly, longCtx)!.maxNetExposureUsd).toBe(usd(50_000));
    expect(engineParamsFromQuote(askOnly, { ...longCtx, prevMaxNetExposureUsd: usd(48_000) })!.maxNetExposureUsd).toBe(usd(48_000));
  });

  test("one-sided quote without an envelope uses min width around the given side", () => {
    const p = engineParamsFromQuote({ ask: { px: 100.06, qty: 1 } }, ctx)!;
    expect(p.spreadBps).toBeGreaterThanOrEqual(10);
    expect(engineParamsFromQuote({}, ctx)).toBeNull();
  });
});

describe("shouldResend (change-threshold logic)", () => {
  const base: EngineQuoteParams = { spreadBps: 12, skewBps: 3, maxNetExposureUsd: usd(37_500) };
  const sent = (p: EngineQuoteParams, at = 0) => ({ params: p, sentAtMs: at });
  const cfg = DEFAULT_RESEND; // min 5s, refresh 60s, 2 bps thresholds, 5% step (3.75k)

  test("initial send; identical params are never re-sent", () => {
    expect(shouldResend(null, base, 0, cfg, m)).toMatchObject({ send: true, reason: "INITIAL" });
    expect(shouldResend(sent(base), base, 10 * 60_000, cfg, m)).toMatchObject({ send: false, reason: "UNCHANGED" });
  });

  test("rate limit, threshold and periodic refresh", () => {
    const small = { ...base, spreadBps: 13 };
    const big = { ...base, skewBps: 6 };
    expect(shouldResend(sent(base, 0), big, 1_000, cfg, m)).toMatchObject({ send: false, reason: "RATE_LIMITED" });
    expect(shouldResend(sent(base, 0), big, 6_000, cfg, m)).toMatchObject({ send: true, reason: "CHANGED" });
    expect(shouldResend(sent(base, 0), small, 6_000, cfg, m)).toMatchObject({ send: false, reason: "BELOW_THRESHOLD" });
    expect(shouldResend(sent(base, 0), small, 61_000, cfg, m)).toMatchObject({ send: true, reason: "REFRESH" });
    expect(shouldResend(sent(base, 0), { ...base, maxNetExposureUsd: usd(41_250) }, 6_000, cfg, m).reason).toBe("CHANGED");
  });

  test("capacity reductions and out-of-mandate previous params are urgent", () => {
    const down = { ...base, maxNetExposureUsd: usd(30_000) };
    expect(shouldResend(sent(base, 0), down, 100, cfg, m)).toMatchObject({ send: true, urgent: true, reason: "CAPACITY_DOWN" });
    const remandated = nvdaMandate({ maxInventoryUsd: usd(75_000), minQuoteWidthBps: 15 });
    expect(shouldResend(sent(base, 0), { ...base, spreadBps: 15 }, 100, cfg, remandated)).toMatchObject({ send: true, reason: "PREV_OUT_OF_MANDATE" });
  });

  test("never sends params outside the mandate", () => {
    expect(shouldResend(null, { ...base, spreadBps: 5 }, 0, cfg, m).send).toBe(false);
    expect(shouldResend(null, { ...base, skewBps: 26 }, 0, cfg, m).send).toBe(false);
    expect(shouldResend(null, { ...base, maxNetExposureUsd: usd(75_001) }, 0, cfg, m).send).toBe(false);
  });
});

class FakeDesk {
  actions: DeskAction[] = [];
  fail = 0;
  async execute(a: DeskAction): Promise<Hex> {
    if (this.fail > 0) {
      this.fail--;
      throw new Error("NotDeskKey");
    }
    this.actions.push(a);
    return `0x${this.actions.length.toString(16).padStart(64, "0")}` as Hex;
  }
}

class FakeEngineChain implements EngineChain {
  state: EngineState = { netExposureUsd: 0n, marginEquityUsd: usd(100_000), insuranceEquityUsd: usd(25_000), poolEquityUsd: usd(100_500), poolCashUsd: usd(100_000), netSize: 0n, reduceOnly: false };
  onChain: EngineQuoteParams | null = null;
  trades: EngineTrade[] = [];
  async readState() {
    return this.state;
  }
  async readQuote() {
    return this.onChain;
  }
  async tradesSince() {
    return this.trades;
  }
}

describe("EngineVenue", () => {
  function setup() {
    let now = 1_000_000;
    const desk = new FakeDesk();
    const chain = new FakeEngineChain();
    const venue = new EngineVenue(
      { chain, desk, mandate: () => m, oraclePx: () => 100, symbol: "RHX5-PERP", now: () => now },
      { ...DEFAULT_RESEND, failureBackoffMs: 15_000 },
    );
    return { desk, chain, venue, advance: (ms: number) => (now += ms) };
  }
  const q = (skewPx = 0, qty = 25) => ({
    bid: { px: 99.94 + skewPx, qty },
    ask: { px: 100.06 + skewPx, qty },
    oraclePx: 100,
    theoretical: { bidPx: 99.94 + skewPx, askPx: 100.06 + skewPx },
  });

  test("sends SetQuote once, then only on threshold changes", async () => {
    const { desk, venue, advance } = setup();
    await venue.replaceQuote(q());
    expect(desk.actions.length).toBe(1);
    expect(desk.actions[0]!.kind).toBe(DESK_ACTION.SetQuote);
    expect(decodeSetQuote(desk.actions[0]!.data)).toEqual({ spreadBps: 12, skewBps: 0, maxNetExposureUsd: usd(3_750) });
    advance(1_000);
    await venue.replaceQuote(q());
    expect(desk.actions.length).toBe(1);
    advance(1_000);
    await venue.replaceQuote(q(0.055)); // +5.5 bps skew, but rate limited
    expect(desk.actions.length).toBe(1);
    advance(5_000);
    await venue.replaceQuote(q(0.055));
    expect(desk.actions.length).toBe(2);
    expect(decodeSetQuote(desk.actions[1]!.data).skewBps).toBe(5);
  });

  test("seeds from on-chain params: no tx when the chain already matches", async () => {
    const { desk, chain, venue } = setup();
    chain.onChain = { spreadBps: 12, skewBps: 0, maxNetExposureUsd: usd(3_750) };
    await venue.replaceQuote(q());
    expect(desk.actions.length).toBe(0);
  });

  test("cancelAll freezes capacity at |exposure| immediately", async () => {
    const { desk, chain, venue, advance } = setup();
    await venue.replaceQuote(q());
    chain.state = { ...chain.state, netExposureUsd: -usd(2_000) };
    advance(100);
    await venue.cancelAll();
    expect(desk.actions.length).toBe(2);
    expect(decodeSetQuote(desk.actions[1]!.data)).toEqual({ spreadBps: 12, skewBps: 0, maxNetExposureUsd: usd(2_000) });
  });

  test("a failed SetQuote backs off non-urgent re-sends", async () => {
    const { desk, venue, advance } = setup();
    desk.fail = 1;
    await expect(venue.replaceQuote(q())).rejects.toThrow("NotDeskKey");
    expect(venue.lastSent).toBeNull();
    advance(1_000);
    await venue.replaceQuote(q()); // INITIAL is urgent: retried
    expect(desk.actions.length).toBe(1);
    desk.fail = 1;
    advance(20_000);
    await expect(venue.replaceQuote(q(0.055))).rejects.toThrow();
    advance(6_000);
    await venue.replaceQuote(q(0.055)); // CHANGED but within the 15s failure backoff
    expect(desk.actions.length).toBe(1);
    advance(10_000);
    await venue.replaceQuote(q(0.055));
    expect(desk.actions.length).toBe(2);
  });

  test("account() maps PoolEngineAdapter views; fills are from the book's perspective", async () => {
    const { chain, venue } = setup();
    chain.state = { ...chain.state, netExposureUsd: usd(-1_000), netSize: -(10n ** 19n) };
    const acct = await venue.account();
    expect(acct.equityUsd).toBe(usd(100_000));
    expect(acct.position?.netExposureUsd).toBe(usd(-1_000));
    expect(acct.position?.netQty).toBe(-10);
    expect(acct.position?.unrealizedPnlUsd).toBe(usd(500));
    const t: EngineTrade = {
      txHash: `0x${"ab".repeat(32)}`,
      logIndex: 3,
      blockNumber: 10n,
      tsMs: 5_000,
      trader: "0x00000000000000000000000000000000000000Ff",
      sizeDelta: 2n * 10n ** 18n,
      fillPriceWad: 100_060_000_000_000_000_000n,
      feeUsd: 100_000n,
    };
    expect(tradeToFill(t, "RHX5-PERP")).toEqual({
      tradeId: `0x${"ab".repeat(32)}:3`,
      symbol: "RHX5-PERP",
      side: "sell",
      qty: 2,
      px: 100.06,
      feeUsd: -0.1,
      ts: 5_000,
      maker: true,
      trader: "0x00000000000000000000000000000000000000ff",
    });
    chain.trades = [t, { ...t, logIndex: 4, tsMs: 1_000, sizeDelta: -(10n ** 18n) }];
    const fills = await venue.fillsSince(2_000);
    expect(fills.length).toBe(1);
  });
});
