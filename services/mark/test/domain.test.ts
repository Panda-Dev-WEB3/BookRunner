import { describe, expect, test } from "bun:test";
import { INVENTORY_LEAF, MULTIPLIER_VECTOR as V, WAD, canonicalJson, devAccount, inventoryTree, markTypedData, payloadHash, proofFor, usd, verifyProof } from "@bookrunner/shared";
import { getAddress, hashTypedData, keccak256, stringToHex } from "viem";
import {
  LOCATION,
  buildInventory,
  buildMarkPnl,
  composeNav,
  deskLocation,
  inventoryItems,
  liquidityShort,
  markDigest,
  markReadiness,
  navCrossChecks,
  parseUsd6,
  pnlJsonHash,
  previewTranches,
  rawHedgeRatioBps,
  recoverMarkSigner,
  signMark,
} from "../src/index";
import { markHeld, priceIsStale } from "../src/domain/held";
import { priceBasisAt, resolveSplitWindow } from "../src/domain/split";
import { NVDA, P, TSLA, USDC, snapshot } from "./fixtures";

describe("NAV composition", () => {
  test("vault idle - unfunded claims + adapter deployed value + desk (USDC + registry valuation)", () => {
    const s = snapshot();
    const nav = composeNav(s);
    expect(nav.deskHedgeValueUsd).toBe(usd("7600"));
    expect(nav.deskValueUsd).toBe(usd("8100"));
    expect(nav.deployedValueUsd).toBe(usd("108600"));
    expect(nav.navUsd).toBe(usd("110600"));
    expect(navCrossChecks(s, nav)).toEqual([]);
  });

  test("unfunded claims are a liability of the whole book (markedNavNet), NAV never below zero", () => {
    expect(composeNav(snapshot({ unfundedClaims: usd("500") })).navUsd).toBe(usd("110100"));
    // claims exceed idle: the excess is netted against deployed value too (2k idle + 108.6k deployed - 9k)
    expect(composeNav(snapshot({ unfundedClaims: usd("9000") })).navUsd).toBe(usd("101600"));
    expect(composeNav(snapshot({ unfundedClaims: usd("200000") })).navUsd).toBe(0n);
  });

  test("multiplier applied once: valuation comes from registry.valueUsd, never re-multiplied", () => {
    const s = snapshot();
    const pos = { ...s.desk.positions[0]!, multiplierWad: 2n * WAD, valueUsd: usd("15200") }; // registry already applied 2x
    const nav = composeNav({ ...s, desk: { ...s.desk, positions: [pos] } });
    expect(nav.deskHedgeValueUsd).toBe(usd("15200"));
  });

  test("pinned convention (VERIFY C2): the registry value of a live-uiMultiplier position is taken as is", () => {
    const s = snapshot();
    const pos = { ...s.desk.positions[0]!, qtyRaw: V.qtyRaw, priceWad: V.perSharePriceWad, multiplierWad: V.uiMultiplierWad, valueUsd: V.valueUsd6 };
    const nav = composeNav({ ...s, desk: { ...s.desk, positions: [pos] } });
    expect(nav.deskHedgeValueUsd).toBe(V.valueUsd6); // = qty x Chainlink per-token feed, never x multiplier again
  });

  test("cross-checks flag adapter / desk / vault disagreements", () => {
    const s = snapshot({ vaultIdleView: usd("1"), desk: { ...snapshot().desk, onchainValueUsd: usd("1") } });
    expect(navCrossChecks(s, composeNav(s))).toHaveLength(2);
  });
});

describe("inventory tree", () => {
  test("fixed locations always present, zero-qty positions skipped, deterministic root", () => {
    const s = snapshot();
    const items = inventoryItems(s);
    expect(items.map((i) => i.location)).toEqual([LOCATION.VAULT, LOCATION.VENUE_IF, LOCATION.VENUE_MM, LOCATION.IN_TRANSIT, LOCATION.DESK_USDC, deskLocation("NVDA")]);
    const withZero = snapshot({ desk: { ...s.desk, positions: [...s.desk.positions, { ...s.desk.positions[0]!, token: TSLA, ticker: "TSLA", qtyRaw: 0n, valueUsd: 0n }] } });
    expect(buildInventory(withZero).root).toBe(buildInventory(s).root);
    // leaf order does not matter
    expect(inventoryTree([...items].reverse()).root).toBe(buildInventory(s).root);
    // any amount change changes the root
    expect(buildInventory(snapshot({ vaultIdle: usd("2000.000001") })).root).not.toBe(buildInventory(s).root);
  });

  test("negative MM margin is committed as a signed amount with zero value", () => {
    const s = snapshot({ venue: { ...snapshot().venue, marginUsd: -usd("10") } });
    const mm = inventoryItems(s).find((i) => i.location === LOCATION.VENUE_MM)!;
    expect(mm.amount).toBe(-usd("10"));
    expect(mm.valueUsd).toBe(0n);
    const inv = buildInventory(s);
    const leaf = [mm.location, mm.asset, mm.amount, mm.valueUsd];
    expect(verifyProof(inv.root, INVENTORY_LEAF, leaf, proofFor(inv.tree, leaf))).toBe(true);
  });

  test("desk location naming", () => {
    expect(deskLocation("nvda")).toBe(deskLocation("NVDA"));
    expect(() => deskLocation("A".repeat(60))).not.toThrow();
  });
});

describe("tranche preview (applyMarkPnl)", () => {
  test("gain goes to Junior; prices from supplies", () => {
    const s = snapshot();
    const p = previewTranches(s, composeNav(s).navUsd);
    expect(p.result.pnl).toBe(usd("10600"));
    expect(p.result.seniorNav).toBe(usd("70000"));
    expect(p.result.juniorNav).toBe(usd("40600"));
    expect(p.seniorPrice).toBe(WAD);
    expect(p.juniorPrice).toBe((usd("40600") * WAD) / usd("30000"));
    expect(p.killAtMark).toBe(false);
  });

  test("loss: Junior first, then Senior with backstop once Junior is exhausted", () => {
    const s = snapshot();
    const p = previewTranches(s, usd("60000")); // loss 40k > J 30k
    expect(p.result.juniorNav).toBe(0n);
    expect(p.result.seniorLoss).toBe(usd("10000"));
    expect(p.result.backstopCovered).toBe(usd("5000"));
    expect(p.result.seniorNav).toBe(usd("65000"));
    expect(p.killAtMark).toBe(true); // -40% drawdown <= -8%
  });
});

describe("MarkPnl JSON", () => {
  const build = (over = {}) => {
    const s = snapshot(over);
    const nav = composeNav(s);
    return buildMarkPnl({ snapshot: s, periodEnd: P, nav, preview: previewTranches(s, nav.navUsd), held: false, extras: { feeFlowUsd: usd("10"), fundingUsd: 0n, prevUnrealizedUsd: 0n, lastQuoteSkewBps: -5 } });
  };

  test("shape and formats", () => {
    const pnl = build();
    expect(pnl.bookId).toBe("1");
    expect(pnl.navUsd).toBe("110600.000000");
    expect(pnl.venue.netExposureUsd).toBe("-10000.000000");
    expect(pnl.desk.positions).toEqual([{ token: getAddress(NVDA), qtyRaw: "40000000000000000000", priceWad: "190000000000000000000", multiplierWad: "1000000000000000000", valueUsd: "7600.000000" }]);
    expect(pnl.pnl).toEqual({ realizedUsd: "10600.000000", unrealizedUsd: "0.000000", feeFlowUsd: "10.000000", fundingUsd: "0.000000", markPnlUsd: "10600.000000" });
    expect(pnl.tranches.juniorPrice).toBe("1.353333333333333333");
    expect(pnl.limits).toEqual({ inventoryUtil: 0.2, skewUtil: 0.2, hedgeRatioBps: 7600, drawdownBps: 0 });
  });

  test("canonical hash is stable: key order independent, equals payloadHash, pinned value", () => {
    const pnl = build();
    const shuffled = Object.fromEntries(Object.entries(pnl).reverse());
    expect(pnlJsonHash(shuffled as typeof pnl)).toBe(pnlJsonHash(pnl));
    expect(pnlJsonHash(pnl)).toBe(payloadHash(pnl));
    expect(pnlJsonHash(pnl)).toBe(keccak256(stringToHex(canonicalJson(pnl))));
    expect(canonicalJson(pnl).startsWith('{"bookId":"1","deployedValueUsd":"108600.000000","desk":{"hedgeValueUsd":"7600.000000"')).toBe(true);
    expect(pnlJsonHash(build())).toBe(pnlJsonHash(pnl)); // deterministic rebuild
    // pinned: any change to formats / field set / canonicalisation must be deliberate
    expect(pnlJsonHash(pnl)).toBe("0x9d77b843d377467d3dea1082000fdfa962dd2d20da3bb1a49b6e9a40d92dfba3");
    expect(pnlJsonHash(build({ vaultIdle: usd("2001") }))).not.toBe(pnlJsonHash(pnl));
  });

  test("engine books report pool MTM as unrealized; realized excludes its change", () => {
    const s = snapshot();
    const pnl = buildMarkPnl({
      snapshot: { ...s, venue: { ...s.venue, poolCashUsd: usd("75000"), poolEquityUsd: usd("75500") } },
      periodEnd: P,
      nav: composeNav(s),
      preview: previewTranches(s, composeNav(s).navUsd),
      held: false,
      extras: { feeFlowUsd: 0n, fundingUsd: usd("100"), prevUnrealizedUsd: usd("200"), lastQuoteSkewBps: null },
    });
    expect(pnl.pnl.unrealizedUsd).toBe("500.000000");
    // 10600 - 100 - (500 - 200)
    expect(pnl.pnl.realizedUsd).toBe("10200.000000");
    expect(pnl.limits.skewUtil).toBe(0);
  });

  test("helpers", () => {
    expect(parseUsd6("-12.5")).toBe(-usd("12.5"));
    expect(parseUsd6(undefined)).toBe(0n);
    expect(rawHedgeRatioBps(0n, 5n)).toBe(0);
    expect(rawHedgeRatioBps(usd("100"), usd("50"))).toBe(0); // long exposure, long hedge: no offset
    expect(rawHedgeRatioBps(-usd("100"), usd("50"))).toBe(5000);
  });
});

describe("EIP-712 mark signature", () => {
  test("signature recovers to the mark signer; digest matches shared typed data", async () => {
    const signer = devAccount("markSigner");
    const registry = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
    const input = { bookId: 1n, periodEnd: BigInt(P), navUsd: usd("110600"), deployedValueUsd: usd("108600"), flowNonce: 7n, inventoryRoot: `0x${"11".repeat(32)}`, pnlJsonHash: `0x${"22".repeat(32)}`, receiptsRoot: `0x${"33".repeat(32)}`, held: false } as const;
    const sig = await signMark(signer, 31337, registry, input);
    expect((await recoverMarkSigner(31337, registry, input, sig)).toLowerCase()).toBe(signer.address.toLowerCase());
    expect(markDigest(31337, registry, input)).toBe(hashTypedData(markTypedData(31337, registry, input)));
    // tampered fields / other chain / other registry do not recover to the signer
    expect((await recoverMarkSigner(31337, registry, { ...input, navUsd: input.navUsd + 1n }, sig)).toLowerCase()).not.toBe(signer.address.toLowerCase());
    expect((await recoverMarkSigner(4663, registry, input, sig)).toLowerCase()).not.toBe(signer.address.toLowerCase());
    expect((await recoverMarkSigner(31337, USDC, input, sig)).toLowerCase()).not.toBe(signer.address.toLowerCase());
  });
});

describe("mark readiness", () => {
  const base = { state: "Live" as const, nowSec: P + 10, periodEnd: P, lastMarkPeriodEnd: P - 300, waitSeconds: 60, maxMarkAge: 3600, safetySeconds: 60, distributed: false, liquidityShort: false };

  test("waits for the distribution, or the timeout", () => {
    expect(markReadiness(base)).toEqual({ ready: false, reason: "waiting_distribution" });
    expect(markReadiness({ ...base, distributed: true })).toEqual({ ready: true, reason: "distributed" });
    expect(markReadiness({ ...base, nowSec: P + 60 })).toEqual({ ready: true, reason: "timeout" });
  });

  test("waits for in-flight recalls when redemptions exceed idle", () => {
    expect(markReadiness({ ...base, distributed: true, liquidityShort: true })).toEqual({ ready: false, reason: "waiting_liquidity" });
    expect(markReadiness({ ...base, distributed: true, liquidityShort: true, nowSec: P + 61 })).toEqual({ ready: true, reason: "timeout" });
    expect(liquidityShort(usd("100"), 0n, usd("50"), usd("60"))).toBe(true);
    expect(liquidityShort(usd("100"), 0n, usd("50"), 0n)).toBe(false); // nothing in flight: waiting cannot help
    expect(liquidityShort(usd("40"), usd("5"), usd("50"), usd("60"))).toBe(false);
  });

  test("guards: state, already marked, not due, too old", () => {
    expect(markReadiness({ ...base, state: "Subscription" }).reason).toBe("state");
    expect(markReadiness({ ...base, state: "Retired" }).reason).toBe("state");
    expect(markReadiness({ ...base, state: "Retiring", distributed: true }).ready).toBe(true);
    expect(markReadiness({ ...base, lastMarkPeriodEnd: P }).reason).toBe("marked");
    expect(markReadiness({ ...base, nowSec: P - 1 }).reason).toBe("not_due");
    expect(markReadiness({ ...base, nowSec: P + 3541 }).reason).toBe("too_old");
  });
});

describe("venue report freshness (Orderly)", () => {
  test("stale only for Orderly books whose last report is older than the bound at the snapshot block", async () => {
    const { venueReportAge } = await import("../src/domain/readiness");
    expect(venueReportAge(0, P - 10, P + 30, 1200)).toEqual({ stale: false, ageSec: 40 });
    expect(venueReportAge(0, P - 1171, P + 30, 1200)).toEqual({ stale: true, ageSec: 1201 });
    expect(venueReportAge(0, 0, P + 30, 1200).stale).toBe(true); // never reported
    expect(venueReportAge(0, P + 40, P + 30, 1200)).toEqual({ stale: false, ageSec: 0 }); // reported after the block
    expect(venueReportAge(1, 0, P + 30, 1200).stale).toBe(false); // engine: valued live on-chain
    expect(venueReportAge(0, 0, P + 30, 0).stale).toBe(false); // 0 disables
  });
});

describe("held marks (audit M-1, fail closed)", () => {
  const s = snapshot();
  const pos = s.desk.positions[0]!;
  const u = s.underlyingPrice!;

  test("not held when every price the valuation used is known, live and fresh", () => {
    expect(markHeld(s)).toEqual({ held: false, reasons: [] });
  });

  test("held: the oracle signed the underlying's price as held (closed session)", () => {
    expect(markHeld({ ...s, underlyingPrice: { ...u, held: true } })).toEqual({ held: true, reasons: ["underlying_held"] });
  });

  test("held: the underlying's price state is unreadable", () => {
    expect(markHeld({ ...s, underlyingPrice: null })).toEqual({ held: true, reasons: ["underlying_unknown"] });
  });

  test("held: the underlying's price is older than maxPriceAge", () => {
    expect(markHeld({ ...s, underlyingPrice: { ...u, stale: true } })).toEqual({ held: true, reasons: ["underlying_stale"] });
  });

  test("held: oracle down over the weekend (last print Friday 20:00 UTC, held transition never signed)", () => {
    const fridayClose = 1_760_731_200; // Fri 2025-10-17 20:00 UTC
    const saturdayMark = fridayClose + 4 * 3600; // Sat 00:00 UTC
    const maxPriceAge = 300;
    const stale = priceIsStale(fridayClose, saturdayMark, maxPriceAge);
    expect(stale).toBe(true);
    // the stored price still says held=false (the oracle never signed the held transition)
    const h = markHeld({ ...s, underlyingPrice: { ...u, publishedAt: fridayClose, held: false, stale } });
    expect(h).toEqual({ held: true, reasons: ["underlying_stale"] });
  });

  test("priceIsStale: never published, at the bound, past the bound", () => {
    expect(priceIsStale(0, 1_000, 300)).toBe(true);
    expect(priceIsStale(700, 1_000, 300)).toBe(false);
    expect(priceIsStale(699n, 1_000n, 300n)).toBe(true);
  });

  test("held: a desk position the NAV values is priced held or stale; empty positions do not count", () => {
    expect(markHeld({ ...s, desk: { ...s.desk, positions: [{ ...pos, priceHeld: true }] } }).reasons).toEqual(["desk_held:NVDA"]);
    expect(markHeld({ ...s, desk: { ...s.desk, positions: [{ ...pos, priceStale: true }] } }).reasons).toEqual(["desk_stale:NVDA"]);
    expect(markHeld({ ...s, desk: { ...s.desk, positions: [{ ...pos, qtyRaw: 0n, priceHeld: true, priceStale: true }] } }).held).toBe(false);
  });

  test("the MarkPnl statement records the flag the caller computed (hashed into pnlJsonHash)", () => {
    const build = (held: boolean) => {
      const nav = composeNav(s);
      return buildMarkPnl({ snapshot: s, periodEnd: P, nav, preview: previewTranches(s, nav.navUsd), held, extras: { feeFlowUsd: 0n, fundingUsd: 0n, prevUnrealizedUsd: 0n, lastQuoteSkewBps: null } });
    };
    expect(build(false).held).toBe(false);
    expect(build(true).held).toBe(true);
    expect(pnlJsonHash(build(true))).not.toBe(pnlJsonHash(build(false)));
  });
});

describe("split window (audit M-2, review I-1): revalue at the basis multiplier, refuse only while young", () => {
  const pos = snapshot().desk.positions[0]!; // 40 NVDA at $190, multiplier 1: $7,600
  const fri = 1_000n;
  const sat = 2_000n;
  const day = 86_400n;
  // Friday's held per-share price after a 10:1 split: valueUsdAt (new multiplier) says $76,000
  const split = { ...pos, multiplierWad: 10n * WAD, valueUsd: usd("76000"), priceHeld: true, priceBasisAt: fri, multiplierChangedAt: sat, basisMultiplierWad: WAD, splitWindowSince: sat };

  test("priceBasisAt: a live price's own publishedAt, a held price's last live print", () => {
    expect(priceBasisAt({ held: false, publishedAt: 5_000n, lastLiveAt: fri })).toBe(5_000n);
    expect(priceBasisAt({ held: true, publishedAt: 5_000n, lastLiveAt: fri })).toBe(fri);
  });

  test("young window: valued at the basis multiplier (continuous $7,600, never 10x), refused", () => {
    const r = resolveSplitWindow([split], { nowSec: sat + 3_600n, maxRefuseSec: day });
    expect(r.positions[0]).toMatchObject({ valueUsd: usd("7600"), multiplierWad: WAD, splitWindow: true });
    expect(r.window).toHaveLength(1);
    expect(r.refuse).toEqual(r.window);
    expect(r.window[0]).toContain("predates the multiplier change");
    // and the mark is held
    expect(markHeld({ ...snapshot(), desk: { ...snapshot().desk, positions: r.positions } }).reasons).toContain("desk_split:NVDA");
  });

  test("past the refusal bound, or at a stale price: not refused (committed held); unknown multiplier: 0", () => {
    expect(resolveSplitWindow([split], { nowSec: sat + day, maxRefuseSec: day }).refuse).toEqual([]);
    expect(resolveSplitWindow([{ ...split, priceStale: true }], { nowSec: sat + 60n, maxRefuseSec: day }).refuse).toEqual([]);
    const unknown = resolveSplitWindow([{ ...split, basisMultiplierWad: null }], { nowSec: sat + day, maxRefuseSec: day });
    expect(unknown.positions[0]).toMatchObject({ valueUsd: 0n, splitWindow: true });
    expect(unknown.window[0]).toContain("unknown");
  });

  test("outside the window: untouched (same-second change, no change, empty position, fixtures without the fields)", () => {
    const keep = [{ ...split, priceBasisAt: sat }, { ...split, multiplierChangedAt: 0n }, { ...split, qtyRaw: 0n }, pos];
    const r = resolveSplitWindow(keep, { nowSec: sat + 60n, maxRefuseSec: day });
    expect(r.window).toEqual([]);
    expect(r.positions).toEqual(keep);
  });
});
