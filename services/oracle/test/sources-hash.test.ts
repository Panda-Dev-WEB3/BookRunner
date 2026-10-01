import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@bookrunner/shared";
import { keccak256, stringToHex } from "viem";
import { canonicalSources, sourcesHash } from "../src/domain/sources-hash";

const a = { name: "synthetic-a", price: 190.01, ts: 1000 };
const b = { name: "synthetic-b", price: 190.02, ts: 1000 };
const c = { name: "chainlink", price: 189.99, ts: 900 };

describe("sourcesHash", () => {
  test("independent of source order", () => {
    expect(sourcesHash([a, b, c])).toBe(sourcesHash([c, b, a]));
    expect(sourcesHash([b, a, c])).toBe(sourcesHash([a, c, b]));
  });

  test("independent of key order and extra fields", () => {
    const shuffled = { ts: 1000, price: 190.01, name: "synthetic-a", maxAgeMs: 5, reason: "x" } as typeof a;
    expect(sourcesHash([shuffled, b])).toBe(sourcesHash([a, b]));
  });

  test("equals keccak256(canonicalJson(sources sorted by name))", () => {
    const expected = keccak256(stringToHex(canonicalJson([c, a, b])));
    expect(sourcesHash([a, b, c])).toBe(expected);
    expect(canonicalJson(canonicalSources([b, c, a]))).toBe(
      '[{"name":"chainlink","price":189.99,"ts":900},{"name":"synthetic-a","price":190.01,"ts":1000},{"name":"synthetic-b","price":190.02,"ts":1000}]',
    );
  });

  test("any change in price, ts or membership changes the hash", () => {
    const h = sourcesHash([a, b, c]);
    expect(sourcesHash([{ ...a, price: 190.011 }, b, c])).not.toBe(h);
    expect(sourcesHash([{ ...a, ts: 1001 }, b, c])).not.toBe(h);
    expect(sourcesHash([a, b])).not.toBe(h);
  });
});
