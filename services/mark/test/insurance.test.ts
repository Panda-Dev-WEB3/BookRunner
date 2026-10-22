// 2026-10 insurance pool (owner ruling N-1): the mark signs the IF equity of the SAME snapshot it values the IF with
// (MarkInput.insuranceEquityUsd), the EIP-712 struct hash matches the contracts' parity vector, the commitAndApply
// selector follows the generated ABI, and a pool-funded book's informational NAV is net of the pool's debt.
import { describe, expect, test } from "bun:test";
import { type MarkInput, VENUE, devAccount, markTypes, usd } from "@bookrunner/shared";
import { type Hex, hashStruct, toFunctionSelector } from "viem";
import { type SignedVenueReport, signVenueReport } from "../../ops-venue/src/report712";
import { readIfInTransit, readInsuranceDebt } from "../src/adapters/chain";
import { COMMIT_AND_APPLY_SELECTOR } from "../src/adapters/lowgasAbi";
import { composeNav, markInsuranceEquityUsd, navCrossChecks, poolDebtNetted } from "../src/domain/nav";
import { applySignedVenueReport } from "../src/domain/venue";
import { LocalMarkSigner, MarkPipeline, RetryableMarkError } from "../src/index";
import { createLogger } from "@bookrunner/shared";
import { MemoryEventSink } from "@bookrunner/waterfall";
import { FakeMarkChain, FakeMarkStore, FakeReceipts, P, ref, snapshot } from "./fixtures";

/** == MARK_STRUCT_HASH_VECTOR of contracts/test/core/MarkRegistry.t.sol and packages/shared/test/eip712.test.ts. */
const MARK_STRUCT_HASH_VECTOR = "0xf0973c16daebdd63754469fc19c8668b1a8c26e8eb5f9d494f03ae105108d834";
const REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

describe("signed IF equity (MarkInput.insuranceEquityUsd)", () => {
  test("the mark struct hash matches the shared / contract parity vector", () => {
    const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
    const mark: MarkInput = {
      bookId: 7n,
      periodEnd: 1_700_006_400n,
      navUsd: 110_600_000_000n,
      deployedValueUsd: 108_600_000_000n,
      flowNonce: 3n,
      inventoryRoot: word(0x11),
      pnlJsonHash: word(0x22),
      receiptsRoot: word(0x33),
      held: true,
      insuranceEquityUsd: 25_000_000_000n,
    };
    expect(hashStruct({ data: mark, primaryType: "Mark", types: markTypes })).toBe(MARK_STRUCT_HASH_VECTOR);
  });

  test("commitAndApply's selector carries the new MarkInput tuple", () => {
    expect(COMMIT_AND_APPLY_SELECTOR).toBe(
      toFunctionSelector("commitAndApply((uint256,uint64,uint256,uint256,uint64,bytes32,bytes32,bytes32,bool,uint256),bytes,bytes,bytes)"),
    );
  });

  test("the signed value is the IF equity of the valuation's snapshot (after the venue overlay), and it is signed", async () => {
    const chain = new FakeMarkChain();
    chain.snap = snapshot({ venue: { ...snapshot().venue, insuranceUsd: usd("23456.789012") } });
    const store = new FakeMarkStore();
    const signer = new LocalMarkSigner(devAccount("markSigner"), 31337, REGISTRY);
    const book = ref(1);
    const pipeline = new MarkPipeline({
      books: { get: async (id) => (id === 1 ? book : undefined) },
      chain,
      store,
      receipts: new FakeReceipts(),
      signer,
      events: new MemoryEventSink(),
      log: createLogger("mark-insurance-test", "silent"),
      maxRetries: 3,
      confirmations: 0n,
      receiptsWaitMs: 20,
      dbRetries: 2,
      dbRetryBaseMs: 1,
    });
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    const row = store.rows.get(1)!;
    expect(row.input.insuranceEquityUsd).toBe(usd("23456.789012"));
    expect(await signer.recover(row.input, row.signature)).toBe(signer.address);
    expect(await signer.recover({ ...row.input, insuranceEquityUsd: row.input.insuranceEquityUsd + 1n }, row.signature)).not.toBe(signer.address);
  });

  test("a negative venue IF figure signs as 0 (uint256)", () => {
    expect(markInsuranceEquityUsd({ venue: { ...snapshot().venue, insuranceUsd: -5n } })).toBe(0n);
  });
});

describe("pool-funded NAV (informational)", () => {
  test("the debt is netted until due; once due it is already in unfundedClaims", () => {
    const base = snapshot();
    const plain = composeNav(base);
    const owing = composeNav({ ...base, insuranceDebt: { debt: usd("25000"), claim: usd("25000"), due: false } });
    expect(plain.navUsd - owing.navUsd).toBe(usd("25000"));
    expect(owing.deployedValueUsd).toBe(plain.deployedValueUsd);
    // an exhausted book: the claim (debt capped by its own capital) is netted, the shortfall is provisional
    expect(poolDebtNetted({ insuranceDebt: { debt: usd("25000"), claim: usd("20000"), due: false } })).toBe(usd("20000"));
    expect(poolDebtNetted({ insuranceDebt: { debt: usd("25000"), claim: usd("25000"), due: true } })).toBe(0n);
    expect(poolDebtNetted({ insuranceDebt: null })).toBe(0n);
  });
});

describe("review I-1: a failed Book.insuranceDebt() read refuses the mark", () => {
  const POOL = "0x00000000000000000000000000000000000000d0" as const;
  const ZERO = "0x0000000000000000000000000000000000000000" as const;

  test("the read: pool-funded -> the claim; book-funded -> null; no such view (old book) -> null; any other failure -> refused", async () => {
    expect(await readInsuranceDebt(async () => [POOL, usd("25000"), usd("20000"), false, false], async () => true)).toEqual({ debt: usd("25000"), claim: usd("20000"), due: false });
    expect(await readInsuranceDebt(async () => [ZERO, 0n, 0n, false, false], async () => true)).toBeNull();
    const fail = async (): Promise<never> => {
      throw new Error("HTTP request failed: timeout");
    };
    expect(await readInsuranceDebt(fail, async () => false)).toBeNull();
    await expect(readInsuranceDebt(fail, async () => true)).rejects.toBeInstanceOf(RetryableMarkError);
    // the bytecode probe itself failing: assume the view exists (refuse rather than sign without the claim)
    await expect(readInsuranceDebt(fail, async () => Promise.reject(new Error("rpc down")))).rejects.toBeInstanceOf(RetryableMarkError);
  });

  test("the pipeline: a refused snapshot signs and commits nothing", async () => {
    const chain = new FakeMarkChain();
    chain.snapshot = async () => {
      throw new RetryableMarkError("Book.insuranceDebt() unreadable");
    };
    const store = new FakeMarkStore();
    const signer = new LocalMarkSigner(devAccount("markSigner"), 31337, REGISTRY);
    const pipeline = new MarkPipeline({
      books: { get: async (id) => (id === 1 ? ref(1) : undefined) },
      chain,
      store,
      receipts: new FakeReceipts(),
      signer,
      events: new MemoryEventSink(),
      log: createLogger("mark-insurance-test", "silent"),
      maxRetries: 3,
      confirmations: 0n,
      receiptsWaitMs: 20,
      dbRetries: 2,
      dbRetryBaseMs: 1,
    });
    await expect(pipeline.run({ bookId: 1, periodEnd: P })).rejects.toBeInstanceOf(RetryableMarkError);
    expect(chain.commitCalls).toBe(0);
    expect(store.rows.size).toBe(0);
  });
});

// ------------------------------------------------------------------ pool follow-up m-6: IF in flight
describe("pool follow-up m-6: the IF in flight is signed as IF equity", () => {
  const CHAIN = 31337;
  const ADAPTER = ref(1).components.adapter;
  const opts = { venue: VENUE.ORDERLY, adapter: ADAPTER, chainId: CHAIN };

  test("a wind-down IF recall in flight (confirmed, not swept): venue IF + its in-transit part, never the MM's", () => {
    const base = snapshot();
    // 10k of the 25k IF left the venue (IF part of in-transit) and 20k of MM is in transit too
    const recalling = snapshot({
      venue: { ...base.venue, insuranceUsd: usd("15000"), marginUsd: usd("55500"), inTransitUsd: usd("30000"), insuranceInTransitUsd: usd("10000"), deployedValueUsd: usd("100500") },
    });
    expect(markInsuranceEquityUsd(recalling)).toBe(usd("25000"));
    expect(markInsuranceEquityUsd(base)).toBe(usd("25000"));
    // the engine / an adapter before v5: no IF part
    expect(markInsuranceEquityUsd({ venue: { ...base.venue, inTransitUsd: usd("30000") } })).toBe(usd("25000"));
    expect(navCrossChecks(recalling, composeNav(recalling))).toEqual([]);
    const broken = snapshot({ venue: { ...base.venue, inTransitUsd: 1n, insuranceInTransitUsd: 2n } });
    expect(navCrossChecks(broken, composeNav(broken)).some((m) => m.includes("insuranceInTransitUsd 2 > inTransitUsd 1"))).toBe(true);
  });

  test("an IF deposit in flight: the adapter's credited IF stands; a venue report from before it never values the snapshot", async () => {
    // the window's 25k IF deposit landed on-chain at P (adapter: insurance 25k at once); the venue had not credited it yet
    const s = snapshot({ venue: { ...snapshot().venue, lastFlowAt: P, valuationAt: P - 10 } });
    const values = { insuranceUsd: 0n, marginUsd: usd("75500"), netExposureUsd: 0n, asOf: BigInt(P) };
    const signature = await signVenueReport(devAccount("opsVenue"), CHAIN, ADAPTER, values);
    const preCredit: SignedVenueReport = { ...values, bookId: 1, chainId: CHAIN, adapter: ADAPTER, signer: devAccount("opsVenue").address, signature, signedAt: 0 };
    const o = applySignedVenueReport(s, [preCredit], opts);
    expect(o.report).toBeNull();
    expect(markInsuranceEquityUsd(o.snapshot)).toBe(usd("25000"));
  });

  test("a negative venue IF still signs as 0, plus the IF in transit", () => {
    expect(markInsuranceEquityUsd({ venue: { ...snapshot().venue, insuranceUsd: -5n, insuranceInTransitUsd: usd("3") } })).toBe(usd("3"));
  });

  test("readIfInTransit: the value; an adapter without the view (before v5) -> 0; any other failure refuses the mark", async () => {
    expect(await readIfInTransit(async () => usd("10000"), async () => true)).toBe(usd("10000"));
    const fail = async (): Promise<never> => {
      throw new Error("HTTP request failed: timeout");
    };
    expect(await readIfInTransit(fail, async () => false)).toBe(0n);
    await expect(readIfInTransit(fail, async () => true)).rejects.toBeInstanceOf(RetryableMarkError);
    await expect(readIfInTransit(fail, async () => Promise.reject(new Error("rpc down")))).rejects.toBeInstanceOf(RetryableMarkError);
  });

  test("the pipeline signs it", async () => {
    const chain = new FakeMarkChain();
    chain.snap = snapshot({ venue: { ...snapshot().venue, insuranceUsd: usd("15000"), inTransitUsd: usd("10000"), insuranceInTransitUsd: usd("10000") } });
    const store = new FakeMarkStore();
    const signer = new LocalMarkSigner(devAccount("markSigner"), 31337, REGISTRY);
    const pipeline = new MarkPipeline({
      books: { get: async (id) => (id === 1 ? ref(1) : undefined) },
      chain,
      store,
      receipts: new FakeReceipts(),
      signer,
      events: new MemoryEventSink(),
      log: createLogger("mark-insurance-test", "silent"),
      maxRetries: 3,
      confirmations: 0n,
      receiptsWaitMs: 20,
      dbRetries: 2,
      dbRetryBaseMs: 1,
    });
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(store.rows.get(1)!.input.insuranceEquityUsd).toBe(usd("25000"));
  });
});
