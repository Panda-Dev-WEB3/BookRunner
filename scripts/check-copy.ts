// CI copy linter (Overview §10 "What not to say"). Scans user-facing copy:
//   README.md, docs/public/**/*.md, apps/web/src/**/*.{ts,tsx} (JSX text + string literals only)
// Exits 1 on any banned term. Usage: bun scripts/check-copy.ts
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { checkCopy } from "../packages/shared/src/copy";

const ROOT = resolve(import.meta.dir, "..");

/** Extracts user-visible prose from TS/TSX: string literals, template literal chunks, JSX text. */
export function extractProse(src: string): string {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: string[] = [];
  // string literals (skip import specifiers, class names, ids)
  for (const m of noComments.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const s = m[2] ?? "";
    const before = noComments.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (/\b(from|import)\s*$/.test(before)) continue;
    if (/className=\s*$|class=\s*$/.test(before)) continue;
    if (!/[a-zA-Z]{3,}\s+[a-zA-Z]/.test(s)) continue; // prose has at least two words
    out.push(s.replace(/\$\{[^}]*\}/g, " "));
  }
  // JSX text between tags
  for (const m of noComments.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1] ?? "");
  return out.join("\n");
}

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
  const prose = /\.(ts|tsx)$/.test(file) ? extractProse(raw) : raw;
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
