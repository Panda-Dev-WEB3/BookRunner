import { describe, expect, test } from "bun:test";
import { HEDGE_ALLOW_LEAF, HEDGE_VENUES, RECEIPT_KIND, hedgeAllowTree, payloadHash, strToBytes32, tokenUnderlying, verifyProof } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { buildHedgeUniverse, defaultAllowPairs, parseAllowPairs } from "../src/domain/hedge-universe";
import { buildReceipt, hedgeReceipt, hourStartSec, jsonSafe, quoteReceipt } from "../src/domain/receipts";

describe("receipt leaves", () => {
  test("hour_start = floor(ts / interval) * interval; ts truncated to seconds", () => {
    expect(hourStartSec(1_760_000_059, 60)).toBe(1_760_000_040);
    expect(hourStartSec(1_760_000_059, 3600)).toBe(1_759_996_800);
    const r = buildReceipt(3, RECEIPT_KIND.FILL, 1_760_000_059_987, { a: 1 }, 60);
    expect(r.ts.getTime()).toBe(1_760_000_059_000);
    expect(r.hourStart.getTime()).toBe(1_760_000_040_000);
    expect(r.kind).toBe(RECEIPT_KIND.FILL);
    expect(r.bookId).toBe(3);
  });

  test("payload is JSON-safe and the hash matches a recomputation from the stored payload", () => {
    const r = hedgeReceipt(
      { bookId: 1, ts: 1_000, action: "buy", token: "0xabc", venue: "UNIV3", qtyRaw: -5n * 10n ** 30n, amountIn: 1n, amountOut: 2n, valueUsd: 3n, txHash: "0x01" },
      60,
    );
    expect(r.payload.qtyRaw).toBe("-5000000000000000000000000000000");
    expect(r.payloadHash).toBe(payloadHash(JSON.parse(JSON.stringify(r.payload))));
    expect(r.kind).toBe(RECEIPT_KIND.HEDGE);
    const q = quoteReceipt({ bookId: 1, ts: 5_000, bid: 1, ask: 2, size: 3, mid: 1.5, oracle: 1.5, inventoryUsd: 0, skewBps: 0, widthBps: 1, sides: { bid: true, ask: true } }, 60);
    expect(q.payload.type).toBe("quote");
    expect(jsonSafe({ x: 1n })).toEqual({ x: "1" });
  });
});

describe("hedge allow-list universe", () => {
  const tokens = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"] as Address[];

  test("single-token book: root matches the charter allow-list and the proof verifies", () => {
    const comps = [{ token: tokens[0]!, weightBps: 10_000 }];
    const root = hedgeAllowTree(defaultAllowPairs(comps)).root;
    const u = buildHedgeUniverse(comps, root);
    expect(u.rootMatches).toBe(true);
    const c = u.components[0]!;
    expect(c.allowed).toBe(true);
    expect(verifyProof(root, HEDGE_ALLOW_LEAF, [tokenUnderlying(tokens[0]!), HEDGE_VENUES.UNIV3], c.proof)).toBe(true);
    expect(u.perpAllowed).toBe(false);
  });

  test("index book: every component on UNIV3 gets a valid proof", () => {
    const comps = tokens.map((token) => ({ token, weightBps: 3_333 }));
    const root = hedgeAllowTree(defaultAllowPairs(comps)).root;
    const u = buildHedgeUniverse(comps, root);
    expect(u.rootMatches).toBe(true);
    for (const c of u.components) expect(verifyProof(root, HEDGE_ALLOW_LEAF, [c.assetId, HEDGE_VENUES.UNIV3], c.proof)).toBe(true);
  });

  test("mismatching roots are detected; overrides can add perp venues and exclude tokens", () => {
    const comps = tokens.map((token) => ({ token, weightBps: 3_333 }));
    const u = buildHedgeUniverse(comps, ("0x" + "11".repeat(32)) as Hex);
    expect(u.rootMatches).toBe(false);
    const pairs = parseAllowPairs(JSON.stringify([{ asset: tokens[0], venue: "UNIV3" }, { asset: "PERP_NVDA_USDC", venue: "ORDERLY" }]));
    expect(pairs[1]).toEqual({ asset: strToBytes32("PERP_NVDA_USDC"), venue: HEDGE_VENUES.ORDERLY });
    const v = buildHedgeUniverse(comps, hedgeAllowTree(pairs).root, pairs);
    expect(v.rootMatches).toBe(true);
    expect(v.perpAllowed).toBe(true);
    expect(v.components.map((c) => c.allowed)).toEqual([true, false, false]);
  });
});
