// Post-filter for generated text stored for display (model rationales, risks, summaries). Uses the
// shared copy rules (ARCHITECTURE §6): banned terms are replaced with neutral wording; anything the
// replacements cannot fix is redacted line by line.
import { checkCopy } from "@bookrunner/shared";

interface Replacement {
  pattern: RegExp;
  with: string | ((m: string) => string);
}

const keepCase = (word: string) => (m: string) => (m[0] && m[0] === m[0].toUpperCase() ? word[0]!.toUpperCase() + word.slice(1) : word);

const REPLACEMENTS: Replacement[] = [
  { pattern: /\bAPY\b/gi, with: "observed accrual" },
  { pattern: /\bAPR\b/gi, with: "observed accrual" },
  { pattern: /\byields\b/gi, with: keepCase("fee flows") },
  { pattern: /\byield\b/gi, with: keepCase("fee flow") },
  { pattern: /\breturns\b/gi, with: keepCase("results") },
  { pattern: /\breturn\b/gi, with: keepCase("result") },
  { pattern: /\btargets\b/gi, with: keepCase("sizes") },
  { pattern: /\btarget\b/gi, with: keepCase("size") },
  { pattern: /\bguaranteed\b/gi, with: keepCase("contractual") },
  { pattern: /\bguarantees?\b/gi, with: keepCase("commitment") },
  { pattern: /\bprotected\b/gi, with: keepCase("buffered") },
  { pattern: /\bprotection\b/gi, with: keepCase("loss buffer") },
  { pattern: /\bprotect\b/gi, with: keepCase("buffer") },
  { pattern: /\binsured\b/gi, with: keepCase("backstopped up to the pool") },
  { pattern: /\brisk[- ]free\b/gi, with: keepCase("last in the loss order") },
  { pattern: /\bmarket[- ]make for you\b/gi, with: "quote the book under its mandate" },
  { pattern: /\bpartners?\b/gi, with: keepCase("public-contract venue") },
];

export interface SanitizedText {
  text: string;
  replaced: string[]; // banned terms that were found
}

export function sanitizeCopy(input: string): SanitizedText {
  // strip control characters (Postgres jsonb rejects NUL) but keep newlines/tabs
  let text = input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const found = checkCopy(text).map((v) => v.term);
  if (found.length === 0) return { text, replaced: [] };
  for (const r of REPLACEMENTS) {
    text = typeof r.with === "string" ? text.replace(r.pattern, r.with) : text.replace(r.pattern, r.with);
  }
  // anything still violating (should not happen) is redacted line by line
  const lines = text.split(/\r?\n/);
  const bad = new Set(checkCopy(text).map((v) => v.line));
  if (bad.size) text = lines.map((l, i) => (bad.has(i + 1) ? "[redacted: copy rules]" : l)).join("\n");
  return { text, replaced: [...new Set(found)] };
}

export function sanitizeList(items: string[]): { items: string[]; replaced: string[] } {
  const replaced = new Set<string>();
  const out = items.map((i) => {
    const s = sanitizeCopy(i);
    s.replaced.forEach((r) => replaced.add(r));
    return s.text;
  });
  return { items: out, replaced: [...replaced] };
}
