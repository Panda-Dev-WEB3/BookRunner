import { describe, expect, test } from "bun:test";
import { navSection } from "../src/lib/navSection";

describe("header section", () => {
  test("a book page reached from Invest stays in Invest", () => {
    expect(navSection("/books/1", "", "#invest")).toBe("invest");
    expect(navSection("/books/1", "?tranche=junior", "#invest")).toBe("invest");
    expect(navSection("/books/2", "?tranche=senior")).toBe("invest");
    expect(navSection("/books/3", "?tab=withdraw")).toBe("invest");
    expect(navSection("/invest")).toBe("invest");
  });
  test("operator views stay under Protocol", () => {
    expect(navSection("/books")).toBe("protocol");
    expect(navSection("/books/1")).toBe("protocol");
    expect(navSection("/books/1", "", "#verify")).toBe("protocol");
    expect(navSection("/charters/new")).toBe("protocol");
    expect(navSection("/risk")).toBe("protocol");
    expect(navSection("/")).toBeNull();
    expect(navSection("/portfolio")).toBeNull();
  });
});
