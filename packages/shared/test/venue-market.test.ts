import { describe, expect, test } from "bun:test";
import { isKnownMarketStatus, marketStatusClass, parseVenueMarkets, type VenueMarketMsg, venueMarketGate } from "../src/venueMarket";

const m = (over: Partial<VenueMarketMsg> = {}): VenueMarketMsg => ({ symbol: "PERP_NVDA_USDC_bookrunner", bookIds: [1, 3], phase: "listed", venueStatus: "ACTIVE", openForRisk: true, everListed: true, since: 1, checkedAt: 2, failures: 0, error: null, ...over });

describe("Orderly market state (VERIFY O20)", () => {
  test("status classes: NEW / PENDING not launched, ACTIVE / none open, POST_ONLY, everything else restricted", () => {
    expect(["NEW", "pending"].map(marketStatusClass)).toEqual(["not_launched", "not_launched"]);
    expect([marketStatusClass("ACTIVE"), marketStatusClass(null), marketStatusClass("")]).toEqual(["open", "open", "open"]);
    expect(marketStatusClass("POST_ONLY")).toBe("post_only");
    expect(["REDUCE_ONLY", "DELISTING", "DELISTED", "HALTED"].map(marketStatusClass)).toEqual(["restricted", "restricted", "restricted", "restricted"]);
    expect([isKnownMarketStatus("delisting"), isKnownMarketStatus("HALTED")]).toEqual([true, false]);
  });

  test("parse: string or object, malformed entries dropped, malformed JSON empty", () => {
    const raw = JSON.stringify({ markets: [m(), { symbol: 1 }, { ...m(), phase: "weird" }, null] });
    expect(parseVenueMarkets(raw)).toEqual([m()]);
    expect(parseVenueMarkets(JSON.parse(raw))).toEqual([m()]);
    expect(parseVenueMarkets("{nope")).toEqual([]);
    expect(parseVenueMarkets(null)).toEqual([]);
    expect(parseVenueMarkets({ markets: "x" })).toEqual([]);
  });

  test("agent gate: restricts only; unknown / absent never gates", () => {
    expect(venueMarketGate([m()], 3)).toBeNull();
    expect(venueMarketGate([m({ venueStatus: null })], 1)).toBeNull();
    expect(venueMarketGate([m({ phase: "awaiting", venueStatus: "PENDING", openForRisk: false })], 1)).toEqual({ reason: "VENUE_NOT_LISTED", symbol: "PERP_NVDA_USDC_bookrunner" });
    expect(venueMarketGate([m({ phase: "missing", venueStatus: null, openForRisk: false })], 1)?.reason).toBe("VENUE_MARKET_MISSING");
    expect(venueMarketGate([m({ venueStatus: "REDUCE_ONLY", openForRisk: false })], 1)?.reason).toBe("VENUE_REDUCE_ONLY");
    expect(venueMarketGate([m({ venueStatus: "delisted", openForRisk: false })], 1)?.reason).toBe("VENUE_DELISTED");
    expect(venueMarketGate([m({ venueStatus: "POST_ONLY", openForRisk: false })], 1)?.reason).toBe("VENUE_POST_ONLY");
    expect(venueMarketGate([m({ venueStatus: "POST_ONLY", openForRisk: false })], 1, { allowPostOnly: true })).toBeNull();
    expect(venueMarketGate([m({ phase: "unknown", venueStatus: null, openForRisk: false })], 1)).toBeNull();
    expect(venueMarketGate([m({ phase: "awaiting" })], 2)).toBeNull(); // not this book
    expect(venueMarketGate([], 1)).toBeNull();
  });
});
