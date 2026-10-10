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
    return buildMarkPnl({ snapshot: s, periodEnd: P, nav, preview: previewTranches(s, nav.navUsd), extras: { feeFlowUsd: usd("10"), fundingUsd: 0n, prevUnrealizedUsd: 0n, lastQuoteSkewBps: -5 } });
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
    expect(pnlJsonHash(pnl)).toBe("0xec3f522b80265a9e3fa879c5bc4a8f0b0c5daaf917a155a389a7d0e29ee87093");
    expect(pnlJsonHash(build({ vaultIdle: usd("2001") }))).not.toBe(pnlJsonHash(pnl));
  });

  test("engine books report pool MTM as unrealized; realized excludes its change", () => {
    const s = snapshot();
    const pnl = buildMarkPnl({
      snapshot: { ...s, venue: { ...s.venue, poolCashUsd: usd("75000"), poolEquityUsd: usd("75500") } },
      periodEnd: P,
      nav: composeNav(s),
      preview: previewTranches(s, composeNav(s).navUsd),
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
    const input = { bookId: 1n, periodEnd: BigInt(P), navUsd: usd("110600"), deployedValueUsd: usd("108600"), flowNonce: 7n, inventoryRoot: `0x${"11".repeat(32)}`, pnlJsonHash: `0x${"22".repeat(32)}`, receiptsRoot: `0x${"33".repeat(32)}` } as const;
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
