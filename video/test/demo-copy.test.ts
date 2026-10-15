import { describe, expect, test } from "bun:test";
import { checkCopy } from "../../packages/shared/src/copy";
import { scenario as site } from "../demo/scenarios/1-site.mjs";
import { scenario as allocator } from "../demo/scenarios/2-allocator.mjs";
import { scenario as sponsor } from "../demo/scenarios/3-sponsor.mjs";
import { scenario as risk } from "../demo/scenarios/4-risk.mjs";
import { DEMO_COPY, DEMO_IDS } from "../src/demo-copy";

const SCENARIOS = [site, allocator, sponsor, risk] as Array<{ id: string; name: string; steps: string[] }>;
const RESERVED = ["__sync", "loaded"];
const all = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(all) : v && typeof v === "object" ? Object.values(v).flatMap(all) : []);

describe("demo copy", () => {
  test("one scenario per clip, in clip order, with unique step keys and none reserved", () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual([...DEMO_IDS]);
    for (const s of SCENARIOS) {
      expect(s.name).toMatch(/^[1-4]-[a-z]+$/);
      expect(new Set(s.steps).size).toBe(s.steps.length);
      for (const r of RESERVED) expect(s.steps).not.toContain(r);
    }
  });
  test("every step a scenario logs has a caption, and every caption belongs to a step", () => {
    for (const s of SCENARIOS) {
      const copy = DEMO_COPY[s.id as keyof typeof DEMO_COPY];
      expect(Object.keys(copy.steps).sort()).toEqual([...s.steps].sort());
      for (const k of s.steps) expect(copy.steps[k]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
  test("captions are one short line (at most 90 characters); every clip has a title and subtitle", () => {
    for (const id of DEMO_IDS) {
      const c = DEMO_COPY[id];
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.subtitle.length).toBeGreaterThan(0);
      for (const t of Object.values(c.steps)) {
        expect(t.length).toBeLessThanOrEqual(90);
        expect(t).not.toContain("\n");
      }
    }
  });
  test("passes the repo copy rules", () => {
    expect(checkCopy(all(DEMO_COPY).join("\n"))).toEqual([]);
  });
  test("every clip says it runs on testnet; the deposit clip says the USDC is test USDC", () => {
    for (const id of DEMO_IDS) expect(all(DEMO_COPY[id]).join(" ")).toMatch(/testnet/i);
    expect(all(DEMO_COPY.allocator).join(" ")).toMatch(/test USDC/);
    expect(all(DEMO_COPY.allocator).join(" ")).not.toMatch(/(?<!test )\bUSDC\b/);
  });
});
