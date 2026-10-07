// AUDIT (area 6, off-chain): the testnet oracle signs synthetic GBM prices seeded with the PUBLIC repo
// default ORACLE_SEED ("bookrunner-devnet"). Every future signed price is a pure function of
// (seed, ticker, step) and the step origin is just the process start, so anyone can compute tomorrow's
// signed prints today and trade the in-house pool / venue against them with perfect foresight.
// Live PoC (2026-10-07): prices predicted at 07:30:03Z for 07:32:09/18/27Z matched the API's signed
// prices to all 8 decimals (NVDA 195.00278361, 194.83787086, 194.94592281).
// Secure behaviour asserted here: on a public chain the synthetic market never runs on the public seed.
import { describe, expect, test } from "bun:test";
import { loadOracleConfig } from "../src/config";
import { buildSources } from "../src/sources";
import { SyntheticMarket } from "../src/sources/synthetic";
import { silentLog } from "./fakes";

const PUBLIC_DEFAULT_SEED = "bookrunner-devnet";

describe("audit: synthetic oracle seed on a public chain", () => {
  test("testnet (46630) refuses to seed signed synthetic prices with the public repo default seed", () => {
    // exactly what scripts/dev.ts --network testnet passes (it never sets ORACLE_SEED)
    const cfg = loadOracleConfig({ CHAIN_ID: "46630", ORACLE_PUSH_MODE: "pull", ORACLE_TICK_MS: "2000" });
    const { market } = buildSources(cfg, silentLog, () => Date.parse("2026-10-07T07:28:59Z"));
    // secure: either no synthetic market at all, or one keyed by a non-public secret seed
    expect(market === null || market.opts.seed !== PUBLIC_DEFAULT_SEED).toBe(true);
  });

  test("future synthetic prints must not be computable from public inputs alone", () => {
    const cfg = loadOracleConfig({ CHAIN_ID: "46630" });
    const startMs = Date.parse("2026-10-03T00:00:00Z");
    const { market } = buildSources(cfg, silentLog, () => startMs);
    if (!market) return; // no synthetic market: nothing to predict
    // an outsider rebuilds the market from the repo defaults and the (observable) step origin
    const outsider = new SyntheticMarket({ seed: PUBLIC_DEFAULT_SEED, stepMs: 1000, epochMs: market.opts.epochMs, tickers: { NVDA: { s0: 190, vol: 0.45 } } });
    const future = startMs + 86_400_000;
    expect(outsider.observe("NVDA", 0, future)).not.toEqual(market.observe("NVDA", 0, future));
  });
});
