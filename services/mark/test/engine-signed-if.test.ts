// Review m-11 (insurance pool follow-ups): on a PoolEngine book the mark values the engine pool at the SIGNED price
// (MarkChainAdapter.engineAtSignedPrice: the views re-read after AttestedOracle.update in one eth_call) and the IF equity
// it signs (MarkInput.insuranceEquityUsd) is that call's adapter.insuranceEquityUsd, not the stored-price view. Engine fake:
// a PublicClient stand-in answering the snapshot's reads, plus the eth_call seam returning the engine at the signed price.
import { describe, expect, test } from "bun:test";
import { type Deployment, VENUE, WAD, usd } from "@bookrunner/shared";
import type { TxSender } from "@bookrunner/waterfall";
import type { Address, Hex, PublicClient } from "viem";
import { MarkChainAdapter } from "../src/adapters/chain";
import type { readAfterPriceUpdate } from "../src/adapters/priceSim";
import { markInsuranceEquityUsd } from "../src/domain/nav";
import type { SignedPrice } from "../src/domain/prices";
import { P, ref } from "./fixtures";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const C = {
  config: addr(0xc0),
  usdc: addr(0xc1),
  backstop: addr(0xc2),
  stockRegistry: addr(0xc3),
  oracle: addr(0xc4),
  poolEngine: addr(0xc5),
  markRegistry: addr(0xc6),
};
const BOOK = ref(4, VENUE.POOL_ENGINE);
const { book, vault, adapter, desk, senior, junior, mandate } = BOOK.components;
const PRICE_ID = `0x${"4e".padEnd(64, "0")}` as Hex;
const UNDERLYING_TOKEN = addr(0xa1);
const BLOCK = 500n;
const BLOCK_TS = BigInt(P + 30);
const STORED_AT = BigInt(P - 120);

/** The engine's views at the STORED oracle price (what a plain readContract returns). */
const STORED = { insuranceUsd: usd("20000"), marginUsd: usd("70000"), netExposureUsd: -usd("5000"), deployedValueUsd: usd("90000"), poolCashUsd: usd("71000"), poolEquityUsd: usd("70000") };
/** The engine's views after the signed price landed (the fake eth_call). */
const AT_SIGNED = { insuranceUsd: usd("23456.789012"), marginUsd: usd("68000"), netExposureUsd: -usd("5100"), deployedValueUsd: usd("91456.789012"), poolCashUsd: usd("71000"), poolEquityUsd: usd("68000") };

/** PublicClient stand-in: the reads MarkChainAdapter.snapshot makes for a PoolEngine book, by contract and view. */
function fakeClient(): PublicClient {
  const views: Record<string, (args: readonly unknown[]) => unknown> = {
    [`${book}:state`]: () => 2, // Live
    [`${book}:flowNonce`]: () => 7n,
    [`${book}:unfundedClaims`]: () => 0n,
    [`${book}:trancheNav`]: () => [usd("63000"), usd("27000")],
    [`${book}:seniorImpairment`]: () => 0n,
    [`${book}:perfIndex`]: () => [WAD, WAD],
    [`${book}:lastMarkPeriodEnd`]: () => BigInt(P - 300),
    [`${book}:getCharter`]: () => ({ underlying: UNDERLYING_TOKEN }),
    [`${book}:backstopDebt`]: () => [0n, 0n],
    [`${book}:insuranceDebt`]: () => [addr(0xd0), usd("20000"), usd("20000"), false, false],
    [`${C.usdc}:balanceOf`]: (a) => (a[0] === vault ? usd("2000") : 0n),
    [`${vault}:idle`]: () => usd("2000"),
    [`${senior}:totalSupply`]: () => usd("63000"),
    [`${junior}:totalSupply`]: () => usd("27000"),
    [`${C.backstop}:balance`]: () => usd("5000"),
    [`${mandate}:getMandate`]: () => ({ maxInventoryUsd: usd("100000"), maxSkewBps: 500, minQuoteWidthBps: 10, maxHedgeLeverage: 1, hedgeRatioMinBps: 0, hedgeRatioMaxBps: 10_000, noNewRiskOffHours: false, killAtDrawdownBps: -2000, hedgeAllowRoot: `0x${"0".repeat(64)}` }),
    [`${mandate}:killed`]: () => false,
    [`${adapter}:insuranceEquityUsd`]: () => STORED.insuranceUsd,
    [`${adapter}:marginEquityUsd`]: () => STORED.marginUsd,
    [`${adapter}:netExposureUsd`]: () => STORED.netExposureUsd,
    [`${adapter}:inTransitUsd`]: () => 0n,
    [`${adapter}:deployedValueUsd`]: () => STORED.deployedValueUsd,
    [`${adapter}:valuationAt`]: () => BLOCK_TS,
    [`${adapter}:marketId`]: () => 1n,
    [`${adapter}:engine`]: () => C.poolEngine,
    [`${C.config}:maxPriceAge`]: () => 300n,
    [`${C.stockRegistry}:priceIdOf`]: () => PRICE_ID,
    [`${C.oracle}:latest`]: () => ({ priceWad: 190n * WAD, publishedAt: STORED_AT, held: false }),
    [`${C.poolEngine}:state`]: () => ({ poolCashUsd: STORED.poolCashUsd, insuranceUsd: STORED.insuranceUsd }),
    [`${C.poolEngine}:poolEquityUsd`]: () => STORED.poolEquityUsd,
    [`${desk}:heldTokens`]: () => [],
    [`${desk}:valueUsd`]: () => 0n,
    [`${desk}:hedgeNotionalUsd`]: () => 0n,
  };
  return {
    chain: undefined,
    request: async () => {
      throw new Error("no raw RPC in this fake (the eth_call goes through the seam)");
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: BLOCK_TS }),
    getStorageAt: async () => `0x${"0".repeat(64)}`,
    getCode: async () => "0x", // the oracle has no settle path (Task 7): no settle price
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const v = views[`${address}:${functionName}`];
      if (!v) throw new Error(`fake client: no view ${address}.${functionName}`);
      return v(args ?? []);
    },
  } as unknown as PublicClient;
}

type SimArgs = Parameters<typeof readAfterPriceUpdate>[1];

/** MarkChainAdapter with the deployless eth_call replaced by the engine fake. */
class EngineFakeAdapter extends MarkChainAdapter {
  calls: SimArgs[] = [];
  constructor(private readonly engineAtPrice: (o: SimArgs) => unknown[] | null) {
    super(fakeClient(), {} as TxSender, { contracts: C } as unknown as Deployment, () => Number(BLOCK_TS) * 1000);
  }
  protected override async readAfterPriceUpdate(o: SimArgs): Promise<unknown[] | null> {
    this.calls.push(o);
    return this.engineAtPrice(o);
  }
}

const signed: SignedPrice = {
  priceId: "NVDA",
  underlying: PRICE_ID,
  priceWad: 191n * WAD,
  publishedAt: BigInt(P + 20),
  held: false,
  sourceCount: 3,
  sourcesHash: `0x${"ab".repeat(32)}`,
  signature: "0x",
};
const prices = new Map([[PRICE_ID.toLowerCase(), signed]]);

/** The engine at the signed price, in the order engineAtSignedPrice asks for the views. */
const atSigned = (o: SimArgs): unknown[] => [
  { publishedAt: o.views[0]!.functionName === "latest" ? signed.publishedAt : 0n },
  AT_SIGNED.insuranceUsd,
  AT_SIGNED.marginUsd,
  AT_SIGNED.netExposureUsd,
  AT_SIGNED.deployedValueUsd,
  { poolCashUsd: AT_SIGNED.poolCashUsd },
  AT_SIGNED.poolEquityUsd,
];

describe("review m-11: a PoolEngine book signs the IF equity of the engine at the signed price", () => {
  test("the signed IF equity == engineAtSignedPrice's insuranceUsd (the views of the same eth_call), not the stored-price view", async () => {
    const chain = new EngineFakeAdapter(atSigned);
    const s = await chain.snapshot(BOOK, BLOCK, prices);
    expect(chain.calls).toHaveLength(1);
    const call = chain.calls[0]!;
    expect(call.oracle).toBe(C.oracle);
    expect(call.blockNumber).toBe(BLOCK);
    expect(call.views.map((v) => `${v.address}:${v.functionName}`)).toEqual([
      `${C.oracle}:latest`,
      `${adapter}:insuranceEquityUsd`,
      `${adapter}:marginEquityUsd`,
      `${adapter}:netExposureUsd`,
      `${adapter}:deployedValueUsd`,
      `${C.poolEngine}:state`,
      `${C.poolEngine}:poolEquityUsd`,
    ]);
    expect(s.venue.source).toBe("engine_signed_price");
    expect(s.venue.insuranceUsd).toBe(AT_SIGNED.insuranceUsd);
    expect(s.venue.deployedValueUsd).toBe(AT_SIGNED.deployedValueUsd);
    expect(s.venue.insuranceInTransitUsd ?? 0n).toBe(0n); // the engine is synchronous: nothing in transit
    expect(markInsuranceEquityUsd(s)).toBe(AT_SIGNED.insuranceUsd);
    expect(markInsuranceEquityUsd(s)).not.toBe(STORED.insuranceUsd);
    expect(s.signedPrices).toEqual([signed]);
  });

  test("the update did not take (or the eth_call failed): the stored-price views, signed consistently with them", async () => {
    for (const engine of [() => null, (o: SimArgs) => [{ publishedAt: 0n }, ...atSigned(o).slice(1)]]) {
      const s = await new EngineFakeAdapter(engine).snapshot(BOOK, BLOCK, prices);
      expect(s.venue.source).toBe("adapter");
      expect(s.venue.insuranceUsd).toBe(STORED.insuranceUsd);
      expect(s.venue.deployedValueUsd).toBe(STORED.deployedValueUsd);
      expect(markInsuranceEquityUsd(s)).toBe(STORED.insuranceUsd);
    }
  });

  test("no signed price newer than the stored one: no eth_call, the stored views", async () => {
    const chain = new EngineFakeAdapter(atSigned);
    const s = await chain.snapshot(BOOK, BLOCK, new Map());
    expect(chain.calls).toHaveLength(0);
    expect(markInsuranceEquityUsd(s)).toBe(STORED.insuranceUsd);
  });
});
