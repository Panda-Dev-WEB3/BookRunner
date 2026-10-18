import { describe, expect, test } from "bun:test";
import { baseAssetOf, charterSymbolOf, isOrderlyBrokerId, parseVenueSymbol, symbolBroker, venueSymbol } from "../src";

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
