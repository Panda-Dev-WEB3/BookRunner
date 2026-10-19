// Image pins (audit 2026-10 E-1; runs in CI with `bun test`): the same image is pinned in several places (compose
// files, CI services, backup.sh, the restore procedure, scripts/forge.sh, comments). Every occurrence of a pinned
// image must carry the same digest, and no floating tag of these images may come back, so a bump cannot drift.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && /(\.ya?ml|\.sh|\.ts|\.md|\.toml|Dockerfile|\.service)$/.test(f) && !f.startsWith("docs/superpowers/") && !f.startsWith("apps/site/public/"));
const texts = tracked.map((f) => ({ f, t: readFileSync(resolve(ROOT, f), "utf8") }));

const IMAGES: Record<string, RegExp> = {
  redis: /\bredis@sha256:([0-9a-f]{64})/g,
  timescaledb: /timescale\/timescaledb@sha256:([0-9a-f]{64})/g,
  foundry: /ghcr\.io\/foundry-rs\/foundry@sha256:([0-9a-f]{64})/g,
};
const FLOATING = /\b(?:redis:7-alpine|timescale\/timescaledb:latest-pg17|ghcr\.io\/foundry-rs\/foundry:latest)\b/;

describe("pinned images", () => {
  for (const [name, re] of Object.entries(IMAGES)) {
    test(`${name}: one digest everywhere`, () => {
      const seen = new Map<string, string[]>();
      for (const { f, t } of texts) for (const m of t.matchAll(re)) seen.set(m[1] as string, [...(seen.get(m[1] as string) ?? []), f]);
      expect(seen.size, JSON.stringify(Object.fromEntries(seen))).toBe(1);
    });
  }

  test("no floating tag of a pinned image is used (comments naming the tag stay allowed)", () => {
    const hits: string[] = [];
    for (const { f, t } of texts) {
      t.split("\n").forEach((line, i) => {
        const code = line.replace(/(^|\s)#.*$/, "").replace(/\/\/.*$/, "");
        if (FLOATING.test(code) && !/\.md$/.test(f)) hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
