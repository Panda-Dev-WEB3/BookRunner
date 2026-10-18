import { describe, expect, test } from "bun:test";
import {
  assertVenueSymbolConfig,
  baseAssetOf,
  charterSymbolOf,
  isOrderlyBrokerId,
  orderlyCharterSymbolIssue,
  parseVenueSymbol,
  resolveVenueSymbol,
  symbolBroker,
  venueSymbol,
} from "../src";

describe("parseVenueSymbol", () => {
  test("Orderly-native and builder (broker-suffixed) perps", () => {
    expect(parseVenueSymbol("PERP_NVDA_USDC")).toEqual({ base: "NVDA", quote: "USDC", broker: null });
    expect(parseVenueSymbol("PERP_NVDA_USDC_bookrunner")).toEqual({ base: "NVDA", quote: "USDC", broker: "bookrunner" });
    // live /v1/public/info forms (2026-10-18)
    expect(parseVenueSymbol("PERP_AAPL_USDC_mythos")).toEqual({ base: "AAPL", quote: "USDC", broker: "mythos" });
    expect(parseVenueSymbol("PERP_1000BONK_USDC")).toEqual({ base: "1000BONK", quote: "USDC", broker: null });
    // broker ids may contain an underscore; the base never does, so the split stays unambiguous
    expect(parseVenueSymbol("PERP_ETH_USDC_woofi_pro")).toEqual({ base: "ETH", quote: "USDC", broker: "woofi_pro" });
  });

  test("invalid symbols -> null", () => {
    for (const s of [
      "",
      "NVDA",
      "NVDA-PERP",
      "SPOT_ETH_USDC",
      "PERP_NVDA_USDT",
      "PERP_NVDA_USDC_",
      "PERP__USDC",
      "PERP_nvda_USDC",
      "PERP_NVDA_USDC_BookRunner",
      "PERP_NV_DA_USDC",
      " PERP_NVDA_USDC",
      "PERP_NVDA_USDC\0",
    ]) {
      expect(parseVenueSymbol(s)).toBeNull();
    }
  });
});

describe("broker ids", () => {
  test("lowercase alphanumerics, '_' and '-'", () => {
    expect(isOrderlyBrokerId("bookrunner")).toBe(true);
    expect(isOrderlyBrokerId("woofi_pro")).toBe(true);
    expect(isOrderlyBrokerId("")).toBe(false);
    expect(isOrderlyBrokerId("_bookrunner")).toBe(false);
    expect(isOrderlyBrokerId("BookRunner")).toBe(false);
    expect(isOrderlyBrokerId("book runner")).toBe(false);
  });

  test("symbolBroker: live mode appends the broker id, mock mode none", () => {
    expect(symbolBroker({ mode: "live", brokerId: "bookrunner" })).toBe("bookrunner");
    expect(symbolBroker({ mode: "mock", brokerId: "bookrunner" })).toBeNull();
    expect(symbolBroker({ mode: "mock" })).toBeNull();
    expect(() => symbolBroker({ mode: "live" })).toThrow(/ORDERLY_BROKER_ID/);
    expect(() => symbolBroker({ mode: "live", brokerId: "Book Runner" })).toThrow(/broker id/);
  });
});

describe("venueSymbol (charter -> Orderly)", () => {
  test("mock mode keeps the charter symbol (current behaviour)", () => {
    expect(venueSymbol({ charterSymbol: "PERP_NVDA_USDC", mode: "mock", brokerId: "bookrunner" })).toBe("PERP_NVDA_USDC");
    expect(venueSymbol({ charterSymbol: "PERP_NVDA_USDC", mode: "mock" })).toBe("PERP_NVDA_USDC");
    // plain ticker -> PERP_<T>_USDC (what risk did before)
    expect(venueSymbol({ charterSymbol: "TSLA", mode: "mock" })).toBe("PERP_TSLA_USDC");
    // not validated in mock mode: verbatim, as before
    expect(venueSymbol({ charterSymbol: "PERP_odd", mode: "mock" })).toBe("PERP_odd");
  });

  test("live mode -> the builder market PERP_<T>_USDC_<broker>", () => {
    expect(venueSymbol({ charterSymbol: "PERP_NVDA_USDC", mode: "live", brokerId: "bookrunner" })).toBe("PERP_NVDA_USDC_bookrunner");
    expect(venueSymbol({ charterSymbol: "TSLA", mode: "live", brokerId: "bookrunner" })).toBe("PERP_TSLA_USDC_bookrunner");
    // a charter that already names our builder market is kept
    expect(venueSymbol({ charterSymbol: "PERP_NVDA_USDC_bookrunner", mode: "live", brokerId: "bookrunner" })).toBe("PERP_NVDA_USDC_bookrunner");
  });

  test("live mode refuses symbols Orderly cannot carry and another broker's market", () => {
    expect(() => venueSymbol({ charterSymbol: "NVDA-PERP", mode: "live", brokerId: "bookrunner" })).toThrow(/not an Orderly perp symbol/);
    expect(() => venueSymbol({ charterSymbol: "", mode: "live", brokerId: "bookrunner" })).toThrow(/not an Orderly perp symbol/);
    expect(() => venueSymbol({ charterSymbol: "PERP_NVDA_USDT", mode: "live", brokerId: "bookrunner" })).toThrow(/not an Orderly perp symbol/);
    expect(() => venueSymbol({ charterSymbol: "PERP_AAPL_USDC_mythos", mode: "live", brokerId: "bookrunner" })).toThrow(/broker mythos/);
    expect(() => venueSymbol({ charterSymbol: "PERP_NVDA_USDC", mode: "live" })).toThrow(/ORDERLY_BROKER_ID/);
  });
});

describe("charter-time check (orderlyCharterSymbolIssue), mode-independent", () => {
  test("accepts PERP_<BASE>_USDC and our own builder market", () => {
    expect(orderlyCharterSymbolIssue("PERP_NVDA_USDC")).toBeNull();
    expect(orderlyCharterSymbolIssue("PERP_NVDA_USDC", "bookrunner")).toBeNull();
    expect(orderlyCharterSymbolIssue("PERP_NVDA_USDC_bookrunner", "bookrunner")).toBeNull();
    // broker unknown to the caller: the suffix form is still a valid Orderly symbol
    expect(orderlyCharterSymbolIssue("PERP_NVDA_USDC_bookrunner")).toBeNull();
  });

  test("rejects what no book could trade", () => {
    expect(orderlyCharterSymbolIssue("NVDA-PERP")).toMatch(/not an Orderly perp symbol/);
    expect(orderlyCharterSymbolIssue("NVDA")).toMatch(/not an Orderly perp symbol/);
    expect(orderlyCharterSymbolIssue("PERP_nvda_USDC")).toMatch(/not an Orderly perp symbol/);
    expect(orderlyCharterSymbolIssue("")).toMatch(/not an Orderly perp symbol/);
    expect(orderlyCharterSymbolIssue("PERP_AAPL_USDC_mythos", "bookrunner")).toMatch(/broker mythos/);
  });
});

describe("resolveVenueSymbol (what the services call per book)", () => {
  test("live: symbol or error, never a throw", () => {
    expect(resolveVenueSymbol({ charterSymbol: "PERP_NVDA_USDC", mode: "live", brokerId: "bookrunner" })).toEqual({ symbol: "PERP_NVDA_USDC_bookrunner", error: null, warning: null });
    const bad = resolveVenueSymbol({ charterSymbol: "NVDA-PERP", mode: "live", brokerId: "bookrunner" });
    expect(bad.symbol).toBeNull();
    expect(bad.error).toMatch(/not an Orderly perp symbol/);
    // a plain ticker still maps (PERP_<T>_USDC_<broker>) but is flagged
    const t = resolveVenueSymbol({ charterSymbol: "TSLA", mode: "live", brokerId: "bookrunner" });
    expect(t.symbol).toBe("PERP_TSLA_USDC_bookrunner");
    expect(t.warning).toMatch(/not an Orderly perp symbol/);
  });

  test("mock: charter symbol verbatim, a bad charter only warns", () => {
    expect(resolveVenueSymbol({ charterSymbol: "PERP_NVDA_USDC", mode: "mock", brokerId: "bookrunner" })).toEqual({ symbol: "PERP_NVDA_USDC", error: null, warning: null });
    const w = resolveVenueSymbol({ charterSymbol: "PERP_odd", mode: "mock", brokerId: "bookrunner" });
    expect(w.symbol).toBe("PERP_odd");
    expect(w.warning).toMatch(/would not trade with ORDERLY_MODE=live/);
  });

  test("startup check: live needs a valid ORDERLY_BROKER_ID, mock does not", () => {
    expect(() => assertVenueSymbolConfig({ mode: "live", brokerId: "bookrunner" })).not.toThrow();
    expect(() => assertVenueSymbolConfig({ mode: "mock", brokerId: "" })).not.toThrow();
    expect(() => assertVenueSymbolConfig({ mode: "live", brokerId: "" })).toThrow(/ORDERLY_BROKER_ID/);
    expect(() => assertVenueSymbolConfig({ mode: "live", brokerId: "Book Runner" })).toThrow(/broker id/);
  });
});

describe("charterSymbolOf / baseAssetOf (Orderly -> charter)", () => {
  test("strips the broker suffix", () => {
    expect(charterSymbolOf("PERP_NVDA_USDC_bookrunner")).toBe("PERP_NVDA_USDC");
    expect(charterSymbolOf("PERP_NVDA_USDC")).toBe("PERP_NVDA_USDC");
    expect(charterSymbolOf("NVDA-PERP")).toBe("NVDA-PERP");
  });

  test("round trip both ways", () => {
    for (const c of ["PERP_NVDA_USDC", "PERP_TSLA_USDC", "PERP_1000BONK_USDC"]) {
      expect(charterSymbolOf(venueSymbol({ charterSymbol: c, mode: "live", brokerId: "bookrunner" }))).toBe(c);
      expect(charterSymbolOf(venueSymbol({ charterSymbol: c, mode: "mock", brokerId: "bookrunner" }))).toBe(c);
    }
  });

  test("base asset of either form; null when not an Orderly perp symbol", () => {
    expect(baseAssetOf("PERP_NVDA_USDC")).toBe("NVDA");
    expect(baseAssetOf("PERP_NVDA_USDC_bookrunner")).toBe("NVDA");
    expect(baseAssetOf("NVDA-PERP")).toBeNull();
  });
});
