import { describe, expect, test } from "bun:test";
import { BPS, absBig, checkHedgeLeg, hedgeInBand, hedgeRatioBps, usd, wad } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { type HedgeComponent, type HedgeLeg, type HedgePlanInput, type HedgePlannerConfig, engineWithdrawableUsd, planHedge, qtyForUsd, valueUsdOf } from "../src/domain/hedge-planner";
import { nvdaMandate } from "./helpers";

const m = nvdaMandate(); // 50k max inventory, band 5000-12000 bps
const NVDA = "0x00000000000000000000000000000000000000a1" as Address;
const cfg: HedgePlannerConfig = { minTradeUsd: usd(250), slippageBps: 100, perpEnabled: false, returnDustUsd: usd(1) };

function comp(balanceUsd: number, over: Partial<HedgeComponent> = {}): HedgeComponent {
  const priceWad = over.priceWad ?? wad(190);
  const multiplierWad = over.multiplierWad ?? wad(1);
  const decimals = over.decimals ?? 18;
  return {
    token: NVDA,
    assetId: ("0x" + "00".repeat(12) + NVDA.slice(2)) as Hex,
    weightBps: 10_000,
    decimals,
    priceWad,
    multiplierWad,
    balanceRaw: qtyForUsd(usd(balanceUsd), priceWad, multiplierWad, decimals),
    floatCapRaw: 10n ** 30n,
    proof: [],
    ...over,
  };
}

function input(expUsd: number, hedgeUsd: number, over: Partial<HedgePlanInput> = {}): HedgePlanInput {
  const components = over.components ?? [comp(hedgeUsd)];
  const held = components.reduce((s, c) => s + valueUsdOf(c.balanceRaw, c.priceWad, c.multiplierWad, c.decimals), 0n);
  const usdc = over.deskUsdcUsd ?? usd(100_000);
  return {
    mandate: m,
    netExposureUsd: usd(expUsd),
    deskHedgeUsd: held,
    perpHedgeUsd: 0n,
    deskUsdcUsd: usdc,
    deskValueUsd: usdc + held,
    vaultDeployableUsd: usd(1_000_000),
    components,
    offHours: false,
    mode: "normal",
    perpAllowed: false,
    ...over,
  };
}

const sum = (legs: HedgeLeg[], kind: HedgeLeg["kind"]) =>
  legs.reduce((s, l) => s + (l.kind === kind && "notionalUsd" in l ? l.notionalUsd : 0n), 0n);

describe("valuation helpers", () => {
  test("multiplier is applied exactly once", () => {
    const one = valueUsdOf(10n ** 18n, wad(190), wad(1), 18);
    const two = valueUsdOf(10n ** 18n, wad(190), wad(2), 18);
    expect(one).toBe(usd(190));
    expect(two).toBe(2n * one);
  });
  test("qtyForUsd inverts valueUsdOf (floor)", () => {
    for (const dec of [6, 8, 18]) {
      const q = qtyForUsd(usd(12_345.678901), wad(437.5), wad(1.25), dec);
      const v = valueUsdOf(q, wad(437.5), wad(1.25), dec);
      const oneRawUnit = valueUsdOf(10n ** 18n, wad(437.5), wad(1.25), 18) / 10n ** BigInt(dec); // value of 1 raw unit
      expect(v <= usd(12_345.678901)).toBe(true);
      expect(usd(12_345.678901) - v <= oneRawUnit + 1n).toBe(true);
    }
  });
});

describe("planHedge decisions", () => {
  test("short exposure, under-hedged: buy to the band midpoint", () => {
    const p = planHedge(input(-40_000, 0), cfg);
    expect(p.action).toBe("buy");
    expect(p.reason).toBe("UNDER_HEDGED");
    expect(sum(p.legs, "buy")).toBe(usd(34_000)); // 40k * 8500 bps
    expect(hedgeInBand(m, p.ratioAfter)).toBe(true);
    const buy = p.legs.find((l) => l.kind === "buy")!;
    if (buy.kind !== "buy") throw new Error("unreachable");
    expect(buy.minAmountOutRaw).toBe((buy.expectedOutRaw * 9_900n) / BPS);
  });

  test("in band: no action", () => {
    expect(planHedge(input(-40_000, 30_000), cfg)).toMatchObject({ action: "none", reason: "IN_BAND" });
  });

  test("over-hedged: sell back to the midpoint, never more than held", () => {
    const p = planHedge(input(-20_000, 30_000), cfg); // 150%
    expect(p.action).toBe("sell");
    const sold = sum(p.legs, "sell");
    expect(absBig(sold - usd(13_000)) <= usd(0.01)).toBe(true);
    expect(hedgeInBand(m, p.ratioAfter)).toBe(true);
  });

  test("long venue exposure: spot cannot offset; held spot is flattened, otherwise skew only", () => {
    const withSpot = planHedge(input(30_000, 10_000), cfg);
    expect(withSpot.action).toBe("flatten");
    expect(withSpot.reason).toBe("LONG_EXPOSURE_NO_SPOT_HEDGE");
    expect(withSpot.legs.every((l) => l.kind === "flatten")).toBe(true);
    expect(planHedge(input(30_000, 0), cfg)).toMatchObject({ action: "none", reason: "LONG_EXPOSURE_SKEW_ONLY" });
  });

  test("perp hedge for long exposure only behind the feature flag and an allow-listed venue", () => {
    const flagOn = { ...cfg, perpEnabled: true };
    expect(planHedge(input(30_000, 0), flagOn).action).toBe("none"); // venue not allow-listed
    const p = planHedge(input(30_000, 0, { perpAllowed: true }), flagOn);
    expect(p.action).toBe("perp");
    const leg = p.legs[0]!;
    expect(leg.kind === "perp" && leg.notionalUsd).toBe(-usd(25_500));
    expect(planHedge(input(30_000, 0, { perpAllowed: true, perpHedgeUsd: -usd(25_000) }), flagOn).action).toBe("none");
  });

  test("below the enforcement threshold (5% of max inventory): no buys; trims oversized hedges", () => {
    expect(planHedge(input(-2_000, 0), cfg)).toMatchObject({ action: "none", reason: "BELOW_THRESHOLD" });
    const trim = planHedge(input(-2_000, 10_000), cfg);
    expect(trim.action).toBe("sell");
    expect(absBig(sum(trim.legs, "sell") - usd(8_300)) <= usd(0.01)).toBe(true);
  });

  test("FundDesk first when the desk lacks USDC, within the FundDesk cap", () => {
    const p = planHedge(input(-40_000, 0, { deskUsdcUsd: 0n }), cfg);
    expect(p.legs[0]).toEqual({ kind: "fund_desk", amountUsd: usd(34_000) });
    // cap: desk value after <= 50k * 12000 / 1e4 = 60k; desk already worth 55k -> only 5k more
    const capped = planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, deskValueUsd: usd(55_000) }), cfg);
    expect(capped.legs[0]).toEqual({ kind: "fund_desk", amountUsd: usd(5_000) });
    expect(sum(capped.legs, "buy")).toBe(usd(5_000));
    expect(capped.action).toBe("buy"); // strictly closer to the band
    // no budget at all
    expect(planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, deskValueUsd: usd(60_000) }), cfg).reason).toBe("NO_BUDGET");
  });

  test("FundDesk never exceeds vault.deployable() (InsufficientIdle): no recall capacity -> NO_VAULT_IDLE", () => {
    // live book: closeWindow deployed the whole raise, the vault holds ~1,069 USD of fee-flow dust
    const p = planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: usd(1_069.836017) }), cfg);
    expect(p.action).toBe("buy");
    expect(p.legs[0]).toEqual({ kind: "fund_desk", amountUsd: usd(1_069.836017) });
    expect(sum(p.legs, "buy")).toBe(usd(1_069.836017));
    expect(planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: 0n }), cfg)).toMatchObject({ action: "none", reason: "NO_VAULT_IDLE", legs: [] });
  });

  test("engine book (sync recall): InventoryToVault(MM) the shortfall, then FundDesk, then buy - in one plan", () => {
    const rc = { recallableUsd: usd(90_000), inFlightUsd: 0n, sync: true };
    const p = planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: usd(1_000), mmRecall: rc }), cfg);
    expect(p.action).toBe("buy");
    expect(p.legs.map((l) => l.kind)).toEqual(["recall_mm", "fund_desk", "buy"]);
    expect(p.legs[0]).toEqual({ kind: "recall_mm", amountUsd: usd(33_000) });
    expect(p.legs[1]).toEqual({ kind: "fund_desk", amountUsd: usd(34_000) });
    // recall bounded by the engine's withdrawable amount
    const tight = planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: 0n, mmRecall: { ...rc, recallableUsd: usd(10_000) } }), cfg);
    expect(tight.legs[0]).toEqual({ kind: "recall_mm", amountUsd: usd(10_000) });
    expect(tight.legs[1]).toEqual({ kind: "fund_desk", amountUsd: usd(10_000) });
    // nothing withdrawable -> no FundDesk that would revert
    expect(planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: 0n, mmRecall: { ...rc, recallableUsd: 0n } }), cfg).reason).toBe("NO_VAULT_IDLE");
    // enough idle: no recall leg
    expect(planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: usd(50_000), mmRecall: rc }), cfg).legs.map((l) => l.kind)).toEqual(["fund_desk", "buy"]);
  });

  test("Orderly book (async recall): recall alone, wait while in flight, buy once the funds are idle", () => {
    const rc = { recallableUsd: usd(60_000), inFlightUsd: 0n, sync: false };
    const p = planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: usd(10), mmRecall: rc }), cfg);
    expect(p).toMatchObject({ action: "recall", reason: "NO_VAULT_IDLE_RECALL_MM", legs: [{ kind: "recall_mm", amountUsd: usd(33_990) }] });
    // the next cycles never re-recall while the withdrawal is in flight
    expect(planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: usd(10), mmRecall: { ...rc, inFlightUsd: usd(33_990) } }), cfg)).toMatchObject({ action: "none", reason: "RECALL_IN_FLIGHT" });
    // landed: FundDesk + buy from idle, no recall
    const landed = planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: usd(34_000), mmRecall: rc }), cfg);
    expect(landed.legs.map((l) => l.kind)).toEqual(["fund_desk", "buy"]);
    // off-hours / reduce-only: FundDesk is blocked, so no recall either
    expect(planHedge(input(-40_000, 0, { deskUsdcUsd: 0n, vaultDeployableUsd: 0n, mmRecall: rc, mode: "reduce_only" }), cfg).legs).toEqual([]);
  });

  test("engine withdrawable = min(pool cash, equity - required - buffer)", () => {
    expect(engineWithdrawableUsd(usd(100_000), usd(100_037), usd(7_400))).toBe(usd(100_037) - usd(7_400) - usd(370) - usd(1));
    expect(engineWithdrawableUsd(usd(50_000), usd(100_000), usd(1_000))).toBe(usd(50_000));
    expect(engineWithdrawableUsd(usd(50_000), usd(1_000), usd(1_000))).toBe(0n);
    expect(engineWithdrawableUsd(usd(50_000), -usd(10), 0n)).toBe(0n);
  });

  test("float cap bounds the buy (worst-case fill within the remaining float)", () => {
    const c = comp(0);
    const capRaw = qtyForUsd(usd(5_000), c.priceWad, c.multiplierWad, c.decimals);
    const p = planHedge(input(-40_000, 0, { components: [{ ...c, floatCapRaw: capRaw }] }), cfg);
    const leg = p.legs.find((l) => l.kind === "buy");
    expect(leg).toBeDefined();
    if (leg?.kind !== "buy") throw new Error("unreachable");
    expect((leg.expectedOutRaw * (BPS + 100n)) / BPS <= capRaw).toBe(true);
    expect(planHedge(input(-40_000, 0, { components: [{ ...c, floatCapRaw: 0n }] }), cfg).reason).toBe("FLOAT_CAP");
  });

  test("index books hedge the weighted basket", () => {
    const tokens = ["a1", "a2", "a3", "a4", "a5"].map((t) => ("0x" + "0".repeat(38) + t) as Address);
    const prices = [190, 440, 255, 520, 230];
    const comps = tokens.map((token, i) => ({ ...comp(0, { priceWad: wad(prices[i]!) }), token, weightBps: 2_000 }));
    const p = planHedge(input(-60_000, 0, { components: comps }), { ...cfg });
    // 60k exceeds max inventory: ratio still enforced; buy 51k split 5 ways
    const buys = p.legs.filter((l) => l.kind === "buy");
    expect(buys.length).toBe(5);
    for (const b of buys) if (b.kind === "buy") expect(b.notionalUsd).toBe(usd(10_200));
  });

  test("flatten mode (Retiring): flatten every holding then return desk USDC to the vault", () => {
    const tokens = ["b1", "b2"].map((t) => ("0x" + "0".repeat(38) + t) as Address);
    const comps = tokens.map((token) => ({ ...comp(4_000), token, weightBps: 5_000 }));
    const p = planHedge(input(-40_000, 0, { components: comps, mode: "flatten", deskUsdcUsd: usd(500) }), cfg);
    expect(p.action).toBe("flatten");
    expect(p.legs.map((l) => l.kind)).toEqual(["flatten", "flatten", "return_to_vault"]);
    expect(planHedge(input(-40_000, 0, { components: [comp(0)], mode: "flatten", deskUsdcUsd: 0n }), cfg).reason).toBe("FLAT");
    expect(planHedge(input(-40_000, 0, { mode: "off" }), cfg).reason).toBe("DISABLED");
  });

  test("flatten mode (Retiring) sweeps sub-dollar residue: finalizeRetirement needs deployedValueUsd == 0", async () => {
    const { hedgeConfigFrom, loadAgentEnv } = await import("../src/config");
    const retireCfg = hedgeConfigFrom(loadAgentEnv({ BOOK_ID: "1" }));
    expect(retireCfg.returnDustUsd).toBe(0n); // default: return every unit of desk USDC
    // 0.20 USD of swap-rounding USDC left on the desk, no tokens
    const usdcOnly = planHedge(input(-1_000, 0, { components: [comp(0)], mode: "flatten", deskUsdcUsd: usd(0.2) }), retireCfg);
    expect(usdcOnly.legs).toEqual([{ kind: "return_to_vault", amountUsd: "all" }]);
    // a token remainder worth 0.43 USD is flattened (below the 1 USD per-leg floor of normal mode)
    const dust = planHedge(input(-1_000, 0, { components: [comp(0.43)], mode: "flatten", deskUsdcUsd: 0n }), retireCfg);
    expect(dust.legs.map((l) => l.kind)).toEqual(["flatten", "return_to_vault"]);
  });

  test("reduce-only mode never sells past net-flat and never funds the desk", () => {
    const p = planHedge(input(-40_000, 60_000, { mode: "reduce_only" }), cfg);
    expect(p.action).toBe("sell");
    expect(absBig(sum(p.legs, "sell") - usd(20_000)) <= usd(0.01)).toBe(true); // down to |exposure|, not 34k
    const buy = planHedge(input(-40_000, 0, { mode: "reduce_only", deskUsdcUsd: 0n }), cfg);
    expect(buy.reason).toBe("NO_BUDGET");
  });
});

describe("planHedge property grid (exposure x hedge)", () => {
  const exposures: number[] = [];
  for (let e = -70_000; e <= 70_000; e += 2_500) exposures.push(e);
  const hedges: number[] = [];
  for (let h = 0; h <= 90_000; h += 2_500) hedges.push(h);

  for (const offHours of [false, true]) {
    test(`every planned leg passes the mandate rule (offHours=${offHours})`, () => {
      let acted = 0;
      for (const e of exposures) {
        for (const h of hedges) {
          const inp = input(e, h, { offHours });
          const p = planHedge(inp, cfg);
          const bought = sum(p.legs, "buy");
          const sold = sum(p.legs, "sell");
          const flattened = sum(p.legs, "flatten");
          if (p.action !== "none") acted++;
          // spot is long-only: never buy against long / flat exposure
          if (inp.netExposureUsd >= 0n) expect(bought).toBe(0n);
          // never sell or flatten more than held
          expect(sold + flattened <= inp.deskHedgeUsd + usd(0.01)).toBe(true);
          if (p.action === "buy" || p.action === "sell") {
            const after = inp.deskHedgeUsd + bought - sold;
            expect(checkHedgeLeg(m, inp.netExposureUsd, inp.deskHedgeUsd, after, offHours, 100).ok).toBe(true);
          }
          if (offHours) {
            // off-hours: no FundDesk and every action reduces |exposure + hedge|
            expect(p.legs.some((l) => l.kind === "fund_desk")).toBe(false);
            const after = inp.deskHedgeUsd + bought - sold - flattened;
            expect(absBig(inp.netExposureUsd + after) <= absBig(inp.netExposureUsd + inp.deskHedgeUsd) + usd(0.01)).toBe(true);
          }
          // in band -> nothing to do
          const r = hedgeRatioBps(m, inp.netExposureUsd, inp.deskHedgeUsd);
          if (inp.netExposureUsd < 0n && r !== null && hedgeInBand(m, r)) expect(p.action).toBe("none");
          // long exposure with spot held -> flatten
          if (inp.netExposureUsd > 0n && inp.deskHedgeUsd >= cfg.minTradeUsd) expect(p.action).toBe("flatten");
          // with ample budget an under-hedged short book lands inside the band (in session)
          if (!offHours && p.action === "buy") expect(hedgeInBand(m, p.ratioAfter)).toBe(true);
          if (p.action === "sell") expect(p.ratioAfter === null || hedgeInBand(m, p.ratioAfter) || offHours).toBe(true);
        }
      }
      expect(acted).toBeGreaterThan(50);
    });
  }
});
