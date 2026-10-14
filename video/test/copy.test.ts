import { describe, expect, test } from "bun:test";
import { checkCopy } from "../../packages/shared/src/copy";
import { COPY, SCENE_IDS } from "../src/copy";
const all = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(all) : v && typeof v === "object" ? Object.values(v).flatMap(all) : []);
describe("video copy", () => {
  test("every scene has copy", () => { for (const id of SCENE_IDS) expect(all(COPY[id]).length).toBeGreaterThan(0); });
  test("passes the repo copy rules", () => { expect(checkCopy(all(COPY).join("\n"))).toEqual([]); });
  test("states testnet status and the US-person restriction", () => {
    const text = all(COPY).join(" ");
    expect(text).toMatch(/testnet/i);
    expect(text).toMatch(/US persons/);
  });
});
