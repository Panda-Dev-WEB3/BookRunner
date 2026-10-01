// apps/web imports `type AppRouter` from src/router.ts; every file in that import graph is then
// typechecked under the web's (browser) config. The @bookrunner/shared barrel re-exports
// deployments.ts (Bun's import.meta.dir, node:fs), so router-graph files must use shared subpaths
// (@bookrunner/shared/units, /types, ...). Full check: `bun run typecheck:router-dom`.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function graph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
      const base = resolve(dirname(file), m[1]!);
      const next = [`${base}.ts`, resolve(base, "index.ts")].find((p) => existsSync(p));
      if (next) visit(next);
    }
  };
  visit(entry);
  return [...seen];
}

describe("router type graph", () => {
  test("no @bookrunner/shared barrel import and no runtime-only modules", () => {
    const files = graph(resolve(import.meta.dir, "../src/router.ts"));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => {
      const s = readFileSync(f, "utf8");
      return /from "@bookrunner\/shared"/.test(s) || /from "node:/.test(s) || /\bBun\./.test(s) || /from "(ioredis|bullmq|@modelcontextprotocol\/sdk[^"]*)"/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});
