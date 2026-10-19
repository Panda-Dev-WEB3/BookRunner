// Slither gate for CI (.github/workflows/security.yml): reads Slither's --json output and fails on every Medium or
// High finding that is not in the reviewed allowlist contracts/slither-allowlist.json. An entry names the detector
// and the function / variable / contract the finding is about (not a line number, so it survives unrelated edits)
// and why it is a false positive; entries that no longer match anything are reported so the list stays honest.
//   bun scripts/slither-gate.ts contracts/slither-out.json [contracts/slither-allowlist.json]
import { readFileSync } from "node:fs";

export interface SlitherElement {
  type: string;
  name: string;
  type_specific_fields?: { parent?: SlitherElement };
}
export interface SlitherResult {
  check: string;
  impact: string;
  confidence: string;
  description: string;
  elements: SlitherElement[];
}
export interface AllowEntry {
  check: string;
  target: string;
  reason: string;
}

const GATED = new Set(["High", "Medium"]);

/** Contract.function, Contract.function.local, Contract.stateVar or Contract for the finding's first element. */
export function targetOf(r: Pick<SlitherResult, "elements">): string {
  const e = r.elements[0];
  if (!e) return "?";
  const p = e.type_specific_fields?.parent;
  if (e.type === "variable" && p?.type === "function") return `${p.type_specific_fields?.parent?.name ?? "?"}.${p.name}.${e.name}`;
  if (p && (e.type === "function" || e.type === "variable" || e.type === "node")) return `${p.name}.${e.name}`;
  return e.name;
}

export function gate(results: SlitherResult[], allow: AllowEntry[]): { blocking: Array<SlitherResult & { target: string }>; stale: AllowEntry[] } {
  for (const a of allow) if (!a.reason?.trim()) throw new Error(`allowlist entry ${a.check} ${a.target} has no reason`);
  const key = (check: string, target: string) => `${check}|${target}`;
  const allowed = new Set(allow.map((a) => key(a.check, a.target)));
  const used = new Set<string>();
  const blocking: Array<SlitherResult & { target: string }> = [];
  for (const r of results) {
    if (!GATED.has(r.impact)) continue;
    const target = targetOf(r);
    const k = key(r.check, target);
    if (allowed.has(k)) used.add(k);
    else blocking.push({ ...r, target });
  }
  return { blocking, stale: allow.filter((a) => !used.has(key(a.check, a.target))) };
}

if (import.meta.main) {
  const [out = "contracts/slither-out.json", list = "contracts/slither-allowlist.json"] = process.argv.slice(2);
  const json = JSON.parse(readFileSync(out, "utf8")) as { success: boolean; error: string | null; results?: { detectors?: SlitherResult[] } };
  if (!json.success) {
    console.error(`slither failed: ${json.error}`);
    process.exit(2);
  }
  const allow = (JSON.parse(readFileSync(list, "utf8")) as { entries: AllowEntry[] }).entries;
  const results = json.results?.detectors ?? [];
  const { blocking, stale } = gate(results, allow);
  for (const s of stale) console.log(`stale allowlist entry (nothing matches it any more, remove it): ${s.check} ${s.target}`);
  for (const b of blocking) console.log(`\n[${b.impact}/${b.confidence}] ${b.check} ${b.target}\n${b.description.trim()}`);
  console.log(`\nslither: ${results.length} findings, ${results.filter((r) => GATED.has(r.impact)).length} Medium/High, ${blocking.length} not in the allowlist, ${stale.length} stale entries`);
  if (blocking.length > 0) {
    console.log(`fix them, or (after review) add {check, target, reason} to ${list}`);
    process.exit(1);
  }
}
