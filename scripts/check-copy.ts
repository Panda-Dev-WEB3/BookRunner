// CI copy linter (Overview §10 "What not to say"). Scans user-facing copy:
//   README.md, docs/public/**/*.md, apps/web/src/**/*.{ts,tsx} (JSX text + string literals only)
// Exits 1 on any banned term. Usage: bun scripts/check-copy.ts
//
// TS / TSX sources are parsed with the TypeScript compiler (the same extractor as apps/web's own copy check,
// apps/web/scripts/copy-extract.ts): only JSX text, string literals and template text a reader can see are
// checked — never code (a `return (` is a keyword, not the banned word "returns"), import specifiers, literal
// types, property names, class names or other technical attribute values. The banned-word rules themselves
// (packages/shared/src/copy.ts) are unchanged.
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { extractCopy } from "../apps/web/scripts/copy-extract";
import { checkCopy } from "../packages/shared/src/copy";

const ROOT = resolve(import.meta.dir, "..");

/** Extracts user-visible prose from TS/TSX: JSX text, string literals and template chunks (code is ignored). */
export function extractProse(src: string, file = "inline.tsx"): string {
  return extractCopy(src, file)
    .map((s) => s.text)
    .join("\n");
}

if (import.meta.main) {
  const targets: string[] = [];
  const add = (pattern: string, cwd: string) => {
    if (!existsSync(cwd)) return;
    for (const f of new Bun.Glob(pattern).scanSync({ cwd, absolute: true })) targets.push(f);
  };
  if (existsSync(resolve(ROOT, "README.md"))) targets.push(resolve(ROOT, "README.md"));
  add("**/*.md", resolve(ROOT, "docs/public"));
  add("**/*.{ts,tsx}", resolve(ROOT, "apps/web/src"));

  let violations = 0;
  for (const file of targets) {
    const raw = readFileSync(file, "utf8");
    const prose = /\.(ts|tsx)$/.test(file) ? extractProse(raw, file) : raw;
    for (const v of checkCopy(prose)) {
      violations++;
      console.error(`${relative(ROOT, file)}: "${v.term}" — use: ${v.use}\n    ${v.text}`);
    }
  }
  if (violations) {
    console.error(`\ncopy check failed: ${violations} violation(s)`);
    process.exit(1);
  }
  console.log(`copy check passed (${targets.length} files)`);
}
