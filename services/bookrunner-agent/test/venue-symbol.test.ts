import { describe, expect, test } from "bun:test";
import { VenueSymbolError, agentVenueSymbol, idleUntilAborted } from "../src/venues/symbol";

const live = { ORDERLY_MODE: "live" as const, ORDERLY_BROKER_ID: "bookrunner" };
const mock = { ORDERLY_MODE: "mock" as const, ORDERLY_BROKER_ID: "bookrunner" };

describe("agent venue symbol (VERIFY O19)", () => {
  test("live: the builder market; mock: the charter symbol", () => {
    expect(agentVenueSymbol("PERP_NVDA_USDC", live)).toBe("PERP_NVDA_USDC_bookrunner");
    expect(agentVenueSymbol("PERP_NVDA_USDC", mock)).toBe("PERP_NVDA_USDC");
  });

  test("live: no Orderly market -> VenueSymbolError (the agent idles that book, no retry loop)", () => {
    expect(() => agentVenueSymbol("NVDA-PERP", live)).toThrow(VenueSymbolError);
    expect(() => agentVenueSymbol("PERP_AAPL_USDC_mythos", live)).toThrow(/broker mythos/);
  });

  test("a charter symbol breaking the charter rule is warned about (mock surfaces it before the switch)", () => {
    const warnings: string[] = [];
    expect(agentVenueSymbol("NVDA-PERP", mock, (w) => warnings.push(w))).toBe("PERP_NVDA-PERP_USDC");
    expect(warnings[0]).toMatch(/would not trade with ORDERLY_MODE=live/);
    expect(agentVenueSymbol("PERP_NVDA_USDC", mock, (w) => warnings.push(w))).toBe("PERP_NVDA_USDC");
    expect(warnings).toHaveLength(1);
  });

  test("idleUntilAborted resolves on abort only", async () => {
    const ctl = new AbortController();
    let done = false;
    const p = idleUntilAborted(ctl.signal).then(() => (done = true));
    await Bun.sleep(5);
    expect(done).toBe(false);
    ctl.abort();
    await p;
    expect(done).toBe(true);
    await idleUntilAborted(ctl.signal); // already aborted: immediate
  });
});
