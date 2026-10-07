// Synthetic sources off devnet: a secret seed is required, and every step mixes CSPRNG entropy so the
// signed path is not reproducible even by someone who knows the seed. Devnet stays reproducible.
import { describe, expect, test } from "bun:test";
import { PUBLIC_DEFAULT_ORACLE_SEED, loadOracleConfig, syntheticSeedProblem } from "../src/config";
import { GbmPath } from "../src/domain/gbm";
import { csprngNormal } from "../src/domain/rng";
import { buildSources } from "../src/sources";
import { silentLog } from "./fakes";

const SECRET = "4f1c2b9e8d7a6c5b4f1c2b9e8d7a6c5b";
const START = Date.parse("2026-10-03T00:00:00Z");

describe("synthetic seed policy", () => {
  test("devnet accepts the public default; any other chain needs a long secret seed", () => {
    expect(syntheticSeedProblem(31337, PUBLIC_DEFAULT_ORACLE_SEED)).toBeNull();
    expect(syntheticSeedProblem(46630, PUBLIC_DEFAULT_ORACLE_SEED)).toContain("public");
    expect(syntheticSeedProblem(46630, "short")).toContain("shorter");
    expect(syntheticSeedProblem(46630, SECRET)).toBeNull();
  });

  test("testnet without ORACLE_SEED: no synthetic market, and the refusal is reported", () => {
    const built = buildSources(loadOracleConfig({ CHAIN_ID: "46630" }), silentLog, () => START);
    expect(built.market).toBeNull();
    expect(built.sources).toHaveLength(0);
    expect(built.syntheticRefused).toContain("ORACLE_SEED");
  });

  test("testnet with a secret seed: synthetic sources run with per-step entropy", async () => {
    const built = buildSources(loadOracleConfig({ CHAIN_ID: "46630", ORACLE_SEED: SECRET }), silentLog, () => START + 5_000);
    expect(built.syntheticRefused).toBeNull();
    expect(built.market?.opts.entropy).toBeDefined();
    expect(built.sources.map((s) => s.name)).toEqual(["synthetic-a", "synthetic-b", "synthetic-c"]);
  });

  test("two testnet markets with the SAME secret seed and origin diverge (not reproducible from the seed)", () => {
    const cfg = loadOracleConfig({ CHAIN_ID: "46630", ORACLE_SEED: SECRET });
    const a = buildSources(cfg, silentLog, () => START).market!;
    const b = buildSources(cfg, silentLog, () => START).market!;
    const at = START + 3_600_000;
    expect(a.basePrice("NVDA", at)).not.toEqual(b.basePrice("NVDA", at));
  });

  test("devnet paths stay reproducible", () => {
    const cfg = loadOracleConfig({ CHAIN_ID: "31337" });
    const a = buildSources(cfg, silentLog, () => START).market!;
    const b = buildSources(cfg, silentLog, () => START).market!;
    expect(a.opts.entropy).toBeUndefined();
    expect(a.basePrice("NVDA", START + 60_000)).toEqual(b.basePrice("NVDA", START + 60_000));
  });
});

describe("entropy GBM path", () => {
  const params = { s0: 100, volAnnual: 0.4, stepMs: 1000 };

  test("a step read again returns the same price (recent history), forward reads continue the path", () => {
    const p = new GbmPath("s", "X", params, csprngNormal);
    const p50 = p.priceAt(50);
    const p60 = p.priceAt(60);
    expect(p.priceAt(50)).toBe(p50);
    expect(p.priceAt(60)).toBe(p60);
    expect(p.priceAt(0)).toBe(100);
  });

  test("realised volatility still matches the configured one (the mix keeps unit variance)", () => {
    const p = new GbmPath("s", "X", { s0: 100, volAnnual: 0.5, stepMs: 60_000 }, csprngNormal);
    const n = 20_000;
    let prev = p.priceAt(0);
    let sum = 0;
    let sumSq = 0;
    for (let i = 1; i <= n; i++) {
      const cur = p.priceAt(i);
      const r = Math.log(cur / prev);
      sum += r;
      sumSq += r * r;
      prev = cur;
    }
    const mean = sum / n;
    const stepVol = Math.sqrt(sumSq / n - mean * mean);
    const annual = stepVol / Math.sqrt(60 / (365 * 24 * 3600));
    expect(Math.abs(annual - 0.5) / 0.5).toBeLessThan(0.05);
  });
});
