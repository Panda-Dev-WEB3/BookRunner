// Copy-rule check for apps/web (CI: `bun run lint:copy`). Extracts JSX text and string literals from
// src/**/*.{ts,tsx} plus index.html and runs the shared checkCopy over them. Exit 1 on violations.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type FileViolation, checkSnippets, extractCopy, extractHtmlCopy } from "./copy-extract";

export const WEB_ROOT = resolve(import.meta.dir, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** All violations in the app's user-facing sources (paths relative to apps/web). */
export function checkApp(root = WEB_ROOT): { files: number; snippets: number; violations: FileViolation[] } {
  const files = walk(join(root, "src"));
  const snippets = files.flatMap((f) => extractCopy(readFileSync(f, "utf8"), relative(root, f).replace(/\\/g, "/")));
  const html = join(root, "index.html");
  snippets.push(...extractHtmlCopy(readFileSync(html, "utf8"), "index.html"));
  return { files: files.length + 1, snippets: snippets.length, violations: checkSnippets(snippets) };
}

if (import.meta.main) {
  const r = checkApp();
  if (r.violations.length === 0) {
    console.log(`copy check: ok (${r.snippets} strings in ${r.files} files)`);
  } else {
    for (const v of r.violations) console.error(`${v.file}:${v.line}  "${v.term}" in: ${v.text}\n    use instead: ${v.use}`);
    console.error(`copy check: ${r.violations.length} violation(s)`);
    process.exit(1);
  }
}
