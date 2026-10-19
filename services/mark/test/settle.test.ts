// Task 7 settle path in the mark service (review I-2, I-4): the valuation choices the chain adapter makes for the
// underlying and each desk token, and the settle-price reader (a failed read refuses the mark, never "none").
import { describe, expect, test } from "bun:test";
import { WAD, createLogger, devAccount } from "@bookrunner/shared";
import { MemoryEventSink, selectorPush } from "@bookrunner/waterfall";
import type { Hex } from "viem";
import { SETTLE_PRICE_SELECTOR, SettlePriceReader } from "../src/adapters/settleRead";
import { markHeld } from "../src/domain/held";
import type { SignedPrice } from "../src/domain/prices";
import { type SettleState, deskPriceChoice, underlyingAtSettle } from "../src/domain/settle";
import { loadMarkConfig } from "../src/config";
import { LocalMarkSigner, MarkPipeline, RetryableMarkError } from "../src/index";
import { FakeMarkChain, FakeMarkStore, FakeReceipts, P, ref, snapshot } from "./fixtures";

const PID = `0x${"4e56444100".padEnd(64, "0")}` as Hex;
const DAY = 86_400n;
const PROPOSED = 1_000_000n;
const REF_TS = PROPOSED + 10n * DAY;
const inForce: SettleState = { priceWad: 80n * WAD, proposedAt: PROPOSED, effectiveAt: PROPOSED + 3n * DAY, pending: false, effective: true };
const pending: SettleState = { ...inForce, pending: true, effective: false };
const print = (publishedAt: bigint, held: boolean): SignedPrice => ({
  priceId: "NVDA",
  underlying: PID,
  priceWad: 101n * WAD,
  publishedAt,
  held,
  sourceCount: 3,
  sourcesHash: `0x${"00".repeat(32)}` as Hex,
  signature: `0x${"11".repeat(65)}` as Hex,
});
// the stored price: held at $100 since the halt (last live print 20 days before the reference time)
const heldU = { priceId: PID, priceWad: 100n * WAD, publishedAt: Number(REF_TS - 60n), held: true, stale: false };
const stored = { priceWad: 100n * WAD, publishedAt: REF_TS - 60n, held: true };
const LAST_LIVE = REF_TS - 20n * DAY;

describe("underlying at the settle price (chain adapter snapshot, review I-4)", () => {
  test("in force: the underlying is valued at it, live and fresh, and the mark is not held", () => {
    const u = underlyingAtSettle(heldU, PID, inForce, null, REF_TS);
    expect(u).toEqual({ priceId: PID, priceWad: 80n * WAD, publishedAt: Number(REF_TS), held: false, stale: false, settled: true });
    expect(markHeld({ underlyingPrice: u, desk: { ...snapshot().desk, positions: [] } }).held).toBe(false);
  });

  test("a newer held signed print does not void it; a newer live print published after the proposal does", () => {
    expect(underlyingAtSettle(heldU, PID, inForce, print(REF_TS - 5n, true), REF_TS)?.settled).toBe(true);
    expect(underlyingAtSettle(heldU, PID, inForce, print(REF_TS - 5n, false), REF_TS)).toBe(heldU);
  });

  test("pending or none: unchanged (held: the mark defers)", () => {
    expect(underlyingAtSettle(heldU, PID, pending, null, REF_TS)).toBe(heldU);
    expect(underlyingAtSettle(heldU, PID, null, null, REF_TS)).toBe(heldU);
    expect(underlyingAtSettle(null, null, inForce, null, REF_TS)).toBeNull();
  });
});

describe("desk token at the settle price (chain adapter position, review I-4)", () => {
  const base = { stored, lastLiveAt: LAST_LIVE, refTs: REF_TS, maxPriceAgeSec: 300n };

  test("in force: valued at it, not held, not stale, basis = the proposal; a newer held print is not used (not pushed)", () => {
    const c = deskPriceChoice({ ...base, signed: print(REF_TS - 5n, true), settle: inForce });
    expect(c).toEqual({ priceWad: 80n * WAD, publishedAt: REF_TS, held: false, stale: false, basis: PROPOSED, signed: null, settled: true });
  });

  test("voided by a newer live print: the print is used (and rides in the mark tx), basis = its publishedAt", () => {
    const p = print(REF_TS - 5n, false);
    const c = deskPriceChoice({ ...base, signed: p, settle: inForce });
    expect(c).toMatchObject({ priceWad: 101n * WAD, held: false, stale: false, basis: REF_TS - 5n, settled: false });
    expect(c.signed).toBe(p);
  });

  test("pending: the stored held price, basis = the last live print (the mark is held)", () => {
    const c = deskPriceChoice({ ...base, signed: null, settle: pending });
    expect(c).toEqual({ priceWad: 100n * WAD, publishedAt: REF_TS - 60n, held: true, stale: false, basis: LAST_LIVE, signed: null, settled: false });
  });

  test("underlying and desk token are decided per price id: a desk token's settle price leaves the underlying held", () => {
    const u = underlyingAtSettle(heldU, PID, null, null, REF_TS); // the underlying has none
    const d = deskPriceChoice({ ...base, signed: null, settle: inForce }); // the desk token's price id has one
    const pos = { ...snapshot().desk.positions[0]!, priceWad: d.priceWad, priceStale: d.stale, ...(d.held ? { priceHeld: true } : {}), settlePrice: true };
    expect(markHeld({ underlyingPrice: u, desk: { ...snapshot().desk, positions: [pos] } }).reasons).toEqual(["underlying_held"]);
    expect(markHeld({ underlyingPrice: { ...heldU, held: false }, desk: { ...snapshot().desk, positions: [pos] } }).held).toBe(false);
  });
});

/** Minimal client: an oracle whose bytecode dispatches settlePrice (or not), and scripted read failures. */
function client(opts: { hasSelector: boolean; readFailures?: number; probeFailures?: number }) {
  const calls = { getCode: 0, readContract: 0 };
  let readFails = opts.readFailures ?? 0;
  let probeFails = opts.probeFailures ?? 0;
  const code = `0x6080${opts.hasSelector ? selectorPush(SETTLE_PRICE_SELECTOR) : "63deadbeef"}57` as Hex;
  const pc = {
    async getStorageAt() {
      return `0x${"00".repeat(32)}` as Hex;
    },
    async getCode() {
      calls.getCode++;
      if (probeFails-- > 0) throw new Error("rpc timeout");
      return code;
    },
    async readContract() {
      calls.readContract++;
      if (readFails-- > 0) throw new Error("rpc timeout");
      return [80n * WAD, PROPOSED, PROPOSED + 3n * DAY, false, true] as const;
    },
  };
  return { pc: pc as never, calls };
}

describe("SettlePriceReader (review I-2: a failed read is never 'no settle price')", () => {
  const ORACLE = "0x000000000000000000000000000000000000000c" as const;

  test("transient failures are retried with backoff", async () => {
    const { pc, calls } = client({ hasSelector: true, readFailures: 2 });
    const waits: number[] = [];
    const r = new SettlePriceReader(pc, ORACLE, { sleep: async (ms) => void waits.push(ms) });
    expect(await r.read(PID, 100n)).toEqual(inForce);
    expect(waits).toEqual([250, 500]);
    expect(calls.readContract).toBe(3);
  });

  test("a read that keeps failing refuses the mark attempt (RetryableMarkError), never returns null", async () => {
    const { pc, calls } = client({ hasSelector: true, readFailures: 10 });
    const r = new SettlePriceReader(pc, ORACLE, { sleep: async () => {} });
    await expect(r.read(PID, 100n)).rejects.toBeInstanceOf(RetryableMarkError);
    expect(calls.readContract).toBe(3);
  });

  test("a failed support probe refuses too; the probe result is cached once it succeeds", async () => {
    const { pc, calls } = client({ hasSelector: true, probeFailures: 5 });
    const r = new SettlePriceReader(pc, ORACLE, { sleep: async () => {} });
    await expect(r.read(PID, 100n)).rejects.toBeInstanceOf(RetryableMarkError);
    const ok = client({ hasSelector: true });
    const r2 = new SettlePriceReader(ok.pc, ORACLE);
    await r2.read(PID, 100n);
    await r2.read(PID, 101n);
    expect(ok.calls.getCode).toBe(1);
    expect(calls.getCode).toBe(3);
  });

  test("an oracle without the settle path (pre-Task-7): none, and settlePrice is never called", async () => {
    const { pc, calls } = client({ hasSelector: false });
    const r = new SettlePriceReader(pc, ORACLE);
    expect(await r.read(PID, 100n)).toBeNull();
    expect(calls.readContract).toBe(0);
  });
});

describe("MarkPipeline: a refused settle-price read commits nothing", () => {
  test("the snapshot's RetryableMarkError propagates; no mark is signed or committed", async () => {
    class FailingChain extends FakeMarkChain {
      override async snapshot(): Promise<never> {
        throw new RetryableMarkError("AttestedOracle.settlePrice(0x..) failed after 3 attempts");
      }
    }
    const chain = new FailingChain();
    const book = ref(1);
    const pipeline = new MarkPipeline({
      books: { get: async (id) => (id === 1 ? book : undefined) },
      chain,
      store: new FakeMarkStore(),
      receipts: new FakeReceipts(),
      signer: new LocalMarkSigner(devAccount("markSigner"), 31337, "0x5FbDB2315678afecb367f032d93F642f64180aa3"),
      events: new MemoryEventSink(),
      log: createLogger("mark-test", "silent"),
      maxRetries: 3,
      confirmations: 0n,
      receiptsWaitMs: 20,
    });
    await expect(pipeline.run({ bookId: 1, periodEnd: P })).rejects.toBeInstanceOf(RetryableMarkError);
    expect(chain.commitCalls).toBe(0);
  });
});

describe("MARK_RETIRE_TOKEN_DUST_USD bound (review M-5)", () => {
  const base = { NETWORK: "devnet" };
  test("startup refuses a dust bound above 1 USD; 1 USD and the default load", () => {
    expect(() => loadMarkConfig({ ...base, MARK_RETIRE_TOKEN_DUST_USD: "1000001" })).toThrow();
    expect(loadMarkConfig({ ...base, MARK_RETIRE_TOKEN_DUST_USD: "1000000" }).MARK_RETIRE_TOKEN_DUST_USD).toBe(1_000_000n);
    expect(loadMarkConfig(base).MARK_RETIRE_TOKEN_DUST_USD).toBe(1_000n);
  });
});
