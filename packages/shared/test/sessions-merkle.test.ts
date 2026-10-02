import { describe, expect, test } from "bun:test";
import { HEDGE_ALLOW_LEAF, hedgeAllowTree, proofFor, receiptsTree, verifyProof } from "../src/merkle";
import { SESSIONS_24X5, SESSIONS_NYSE_RTH, decodeSessions, encodeSessions, isOpen } from "../src/sessions";
import { HEDGE_VENUES, bytes32ToStr, strToBytes32, tokenUnderlying } from "../src/bytes32";
import { checkCopy } from "../src/copy";

describe("sessions", () => {
  test("encode/decode roundtrip", () => {
    for (const s of [SESSIONS_NYSE_RTH, SESSIONS_24X5]) expect(decodeSessions(encodeSessions(s))).toEqual(s);
  });

  test("NYSE RTH open/closed", () => {
    // Thu 2026-10-01 14:00 UTC = 10:00 ET (open); 21:00 UTC = 17:00 ET (closed); Sat closed
    expect(isOpen(SESSIONS_NYSE_RTH, new Date("2026-10-01T14:00:00Z"))).toBe(true);
    expect(isOpen(SESSIONS_NYSE_RTH, new Date("2026-10-01T21:00:00Z"))).toBe(false);
    expect(isOpen(SESSIONS_NYSE_RTH, new Date("2026-10-03T15:00:00Z"))).toBe(false);
    // Thanksgiving 2026-11-26 closed
    expect(isOpen(SESSIONS_NYSE_RTH, new Date("2026-11-26T15:00:00Z"))).toBe(false);
  });

  test("24/5 holds over the weekend, reopens Sunday 20:00 ET", () => {
    expect(isOpen(SESSIONS_24X5, new Date("2026-10-03T12:00:00Z"))).toBe(false); // Sat
    expect(isOpen(SESSIONS_24X5, new Date("2026-10-05T01:00:00Z"))).toBe(true); // Sun 21:00 ET
    expect(isOpen(SESSIONS_24X5, new Date("2026-10-02T23:30:00Z"))).toBe(true); // Fri 19:30 ET
    expect(isOpen(SESSIONS_24X5, new Date("2026-10-03T00:30:00Z"))).toBe(false); // Fri 20:30 ET
  });

  test("24/5 has no gap at Sunday 23:59 ET (close = 1439 is inclusive)", () => {
    expect(isOpen(SESSIONS_24X5, new Date("2026-10-05T03:58:30Z"))).toBe(true); // Sun 23:58:30 ET
    expect(isOpen(SESSIONS_24X5, new Date("2026-10-05T03:59:30Z"))).toBe(true); // Sun 23:59:30 ET
    expect(isOpen(SESSIONS_24X5, new Date("2026-10-05T04:00:30Z"))).toBe(true); // Mon 00:00:30 ET
    // already-filed charters keep the same encoding: the fix lives in the codec, not the preset
    const filed = decodeSessions(encodeSessions(SESSIONS_24X5));
    expect(isOpen(filed, new Date("2026-10-05T03:59:30Z"))).toBe(true);
    // a session that ends before 23:59 still has an exclusive close
    expect(isOpen(SESSIONS_24X5, new Date("2026-10-03T00:00:30Z"))).toBe(false); // Fri 20:00:30 ET
    expect(isOpen(SESSIONS_24X5, new Date("2026-10-02T23:59:30Z"))).toBe(true); // Fri 19:59:30 ET
  });
});

describe("merkle", () => {
  test("hedge allow proof verifies", () => {
    const nvda = tokenUnderlying("0x00000000000000000000000000000000000000aa");
    const tree = hedgeAllowTree([
      { asset: nvda, venue: HEDGE_VENUES.UNIV3 },
      { asset: nvda, venue: HEDGE_VENUES.UNIV4 },
    ]);
    const proof = proofFor(tree, [nvda, HEDGE_VENUES.UNIV3]);
    expect(verifyProof(tree.root, HEDGE_ALLOW_LEAF, [nvda, HEDGE_VENUES.UNIV3], proof)).toBe(true);
  });

  test("receipts tree is deterministic regardless of key order", () => {
    const a = receiptsTree([{ kind: 1, bookId: 1n, ts: 10n, payload: { px: 1, qty: 2 } }]);
    const b = receiptsTree([{ kind: 1, bookId: 1n, ts: 10n, payload: { qty: 2, px: 1 } }]);
    expect(a.root).toBe(b.root);
  });

  test("bytes32 strings", () => {
    expect(bytes32ToStr(strToBytes32("PERP_NVDA_USDC"))).toBe("PERP_NVDA_USDC");
  });
});

describe("copy", () => {
  test("bans yield/APY/guaranteed; allows fee flow", () => {
    expect(checkCopy("Senior tranche: guaranteed 12% APY").map((v) => v.term)).toEqual(["APY", "guaranteed"]);
    expect(checkCopy("Observed accrual over the mark period; last loss in the waterfall.")).toEqual([]);
  });
});
