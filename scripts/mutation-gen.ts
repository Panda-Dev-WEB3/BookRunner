// Mutant generation and reporting for scripts/mutation.sh (audit 2026-10, Task 7c). Foundry's built-in
// `forge test --mutate` works here, but it recompiles the whole project for every mutant and tests every binary
// operator against every other one: about 930 mutants and 5-6 hours for MMMandate alone on 12 cores. This
// generator makes one meaningful mutant per site instead (a flipped comparison, a swapped arithmetic or logical
// operator, a removed guard or access modifier, a deleted state write, a changed constant) and samples them (weighted
// towards guards and money lines, fixed seed); scripts/mutation-run.sh tests each one with an incremental compile.
//
//   bun scripts/mutation-gen.ts gen <src.sol> <outDir> [--sample N] [--seed S] [--ids 1,2] -> outDir/index.tsv + <id>.line
//   bun scripts/mutation-gen.ts report <outDir> [<title>]                       -> summary (markdown) on stdout
//
// index.tsv: id, operator, line (1-based), description. <id>.line: the whole mutated source line.
// results (written by mutation-run.sh): outDir/results/*.tsv with id, status (killed | survived | timeout | stillborn),
// the first failing test.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Mutant {
  id: number;
  op: string;
  line: number; // 1-based
  text: string; // the mutated line
  desc: string;
}

/** Mutants always kept when sampling: a removed access modifier. */
export const ALWAYS_KEPT = new Set(["access"]);
/**
 * Sampling weight per operator (weighted sampling without replacement, Efraimidis-Spirakis): the lines that guard money,
 * access and liveness first. A removed guard / require is a missing check; a deleted state write or a swapped
 * arithmetic operator changes an amount; a flipped comparison moves a bound; the others change control flow.
 */
export const WEIGHT: Record<string, number> = { guard: 4, require: 4, delete: 3, arith: 3, cmp: 2, logic: 1, not: 1, bool: 1, constant: 1 };

/** The line with comments and string contents blanked (same length), so operators are only matched in code. */
export function codeOnly(lines: string[]): string[] {
  let inBlock = false;
  return lines.map((l) => {
    let out = "";
    let inStr: string | null = null;
    for (let i = 0; i < l.length; i++) {
      const c = l[i]!;
      const two = l.slice(i, i + 2);
      if (inBlock) {
        if (two === "*/") {
          inBlock = false;
          out += "  ";
          i++;
        } else out += " ";
        continue;
      }
      if (inStr) {
        out += c === inStr ? c : " ";
        if (c === "\\") {
          out += " ";
          i++;
        } else if (c === inStr) inStr = null;
        continue;
      }
      if (two === "//") {
        out += " ".repeat(l.length - i);
        break;
      }
      if (two === "/*") {
        inBlock = true;
        out += "  ";
        i++;
        continue;
      }
      if (c === '"' || c === "'") inStr = c;
      out += c;
    }
    return out;
  });
}

const TYPE_START = /^(u?int\d*|address|bool|bytes\d*|string|mapping|[A-Z]\w*(\.\w+)?(\[\])?\s+(memory|storage|calldata)?\s*\w+\s*=|[A-Z]\w*\.\w+\s+\w+|[A-Z]\w*\s+\w+\s*[=;])/;
const CMP: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">", "==": "!=", "!=": "==" };
const ARITH: Record<string, string> = { "+": "-", "-": "+", "*": "/", "/": "*", "%": "*" };

/** The index of the parenthesis closing the one at `open` (or -1). */
function closing(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") d++;
    else if (s[i] === ")" && --d === 0) return i;
  }
  return -1;
}

/** Every mutant of a Solidity source, in source order. */
export function generate(source: string): Mutant[] {
  const lines = source.split("\n");
  const code = codeOnly(lines);
  const out: Mutant[] = [];
  const add = (op: string, n: number, start: number, end: number, rep: string, desc?: string) => {
    const orig = lines[n]!;
    const text = orig.slice(0, start) + rep + orig.slice(end);
    out.push({ id: 0, op, line: n + 1, text, desc: desc ?? `\`${orig.slice(start, end).trim()}\` -> \`${rep.trim() || "(removed)"}\`` });
  };
  let inSignature = false; // inside a function signature (it may span lines), up to its body or `;`
  for (let n = 0; n < lines.length; n++) {
    const c = code[n]!;
    if (/^\s*function\b/.test(c)) inSignature = true;
    const signature = inSignature;
    if (inSignature && /[{;]/.test(c)) inSignature = false;
    if (/^\s*(pragma|import|event|error|interface|using)\b/.test(c) || c.trim() === "") continue;

    // access control: a modifier `onlyX` / `onlyRole(...)` on a function signature (multi-line signatures included)
    for (const m of c.matchAll(/\bonly[A-Z]\w*(\([^)]*\))?/g)) {
      if (!signature) continue;
      add("access", n, m.index!, m.index! + m[0].length, "", `modifier \`${m[0]}\` removed`);
    }
    // constants: `constant NAME = <number>` -> + 1
    const k = /\bconstant\s+\w+\s*=\s*([0-9][0-9_]*(?:e\d+)?)\s*(?:\*\s*\d+)?\s*;/.exec(c);
    if (k) {
      const s = c.indexOf(k[1]!, k.index);
      add("constant", n, s, s + k[1]!.length, `(${k[1]} + 1)`);
      continue;
    }
    if (/\bconstant\b|\bimmutable\b/.test(c) && !/\(/.test(c)) continue;

    // guards: `if (cond) revert ...` on one line -> the condition never holds
    for (const m of c.matchAll(/\bif\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = closing(c, open);
      if (close > 0 && /^\s*revert\b/.test(c.slice(close + 1))) add("guard", n, open + 1, close, "false", `guard \`if (${lines[n]!.slice(open + 1, close).trim()}) revert\` removed`);
    }
    // require(cond, ...) -> require(true, ...)
    for (const m of c.matchAll(/\brequire\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      let d = 0;
      let end = -1;
      for (let i = open; i < c.length; i++) {
        if (c[i] === "(") d++;
        else if (c[i] === ")") d--;
        if ((c[i] === "," && d === 1) || d === 0) {
          end = i;
          break;
        }
      }
      if (end > 0) add("require", n, open + 1, end, "true", "require condition removed");
    }
    // comparisons
    for (const m of c.matchAll(/(<=|>=|==|!=|<(?![<=])|>(?![>=]))/g)) {
      const i = m.index!;
      if (c[i - 1] === "<" || c[i - 1] === ">" || c[i - 1] === "=" || (m[0] === ">" && c[i - 1] === "-")) continue;
      add("cmp", n, i, i + m[0].length, CMP[m[0]]!);
    }
    // arithmetic (binary operators are spaced by forge fmt; `x - 1` and `a * b / c` alike)
    for (const m of c.matchAll(/ ([+\-*/%]) (?!=)/g)) add("arith", n, m.index! + 1, m.index! + 2, ARITH[m[1]!]!);
    for (const m of c.matchAll(/ ([+-])= /g)) add("arith", n, m.index! + 1, m.index! + 2, m[1] === "+" ? "-" : "+");
    // logical operators
    for (const m of c.matchAll(/ (&&|\|\|) /g)) add("logic", n, m.index! + 1, m.index! + 3, m[1] === "&&" ? "||" : "&&");
    // negation removed
    for (const m of c.matchAll(/!(?!=)(?=[\w($.])/g)) add("not", n, m.index!, m.index! + 1, "");
    // boolean literals
    for (const m of c.matchAll(/\b(true|false)\b/g)) add("bool", n, m.index!, m.index! + m[0].length, m[0] === "true" ? "false" : "true");
    // a state write deleted: `x = ...;`, `x += ...;`, `x++;`, `delete x;` statements (not declarations)
    const t = c.trim();
    if (
      /;$/.test(t) &&
      !TYPE_START.test(t) &&
      !/^(return|emit|revert|if|for|while|require|assembly|unchecked|else)\b/.test(t) &&
      (/^[$a-z_][\w$]*(\.[\w$]+|\[[^\]]*\])*\s*(=|\+=|-=)\s/.test(t) || /^[$a-z_][\w$.\[\]]*(\+\+|--);$/.test(t) || /^delete\s/.test(t))
    ) {
      const s = lines[n]!.indexOf(t);
      add("delete", n, s, s + t.length, "{}", `statement \`${t.length > 70 ? `${t.slice(0, 67)}...` : t}\` deleted`);
    }
  }
  return out.map((m, i) => ({ ...m, id: i + 1 }));
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every ALWAYS_KEPT mutant, plus a seeded weighted random sample of the others (WEIGHT) up to `n` in total
 * (0 = all). Reproducible: the same source, n and seed give the same mutants.
 */
export function sample(all: Mutant[], n: number, seed: number): Mutant[] {
  if (n <= 0 || n >= all.length) return all;
  const kept = all.filter((m) => ALWAYS_KEPT.has(m.op));
  const r = rng(seed);
  const rest = all
    .filter((m) => !ALWAYS_KEPT.has(m.op))
    .map((m) => ({ m, key: r() ** (1 / (WEIGHT[m.op] ?? 1)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.m);
  return [...kept, ...rest.slice(0, Math.max(0, n - kept.length))].sort((a, b) => a.id - b.id);
}

export interface Result {
  id: number;
  status: "killed" | "survived" | "timeout" | "stillborn";
  test: string;
}

export function readResults(dir: string): Result[] {
  const rdir = join(dir, "results");
  if (!existsSync(rdir)) return [];
  return readdirSync(rdir)
    .filter((f) => f.endsWith(".tsv"))
    .flatMap((f) => readFileSync(join(rdir, f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => {
      const [id, status, test] = l.split("\t");
      return { id: Number(id), status: status as Result["status"], test: test ?? "" };
    });
}

/** Score = (killed + timeout) / (killed + timeout + survived); stillborn mutants (do not compile) are excluded. */
export function score(results: Result[]) {
  const c = { killed: 0, survived: 0, timeout: 0, stillborn: 0 };
  for (const r of results) c[r.status]++;
  const valid = c.killed + c.timeout + c.survived;
  return { ...c, valid, score: valid ? (c.killed + c.timeout) / valid : 0 };
}

/** Wilson 95% interval of a kill rate measured on `n` sampled mutants (the population's score, from a sample). */
export function wilson95(killed: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = killed / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

function readIndex(dir: string): Mutant[] {
  return readFileSync(join(dir, "index.tsv"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id, op, line, desc] = l.split("\t");
      return { id: Number(id), op: op!, line: Number(line), desc: desc!, text: "" };
    });
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name: string, d: number) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : d;
  };
  if (cmd === "gen") {
    const [src, dir] = args;
    if (!src || !dir) throw new Error("usage: gen <src.sol> <outDir> [--sample N] [--seed S] [--ids 1,2,3]");
    const all = generate(readFileSync(src, "utf8"));
    const ids = args.includes("--ids") ? new Set(args[args.indexOf("--ids") + 1]!.split(",").map(Number)) : null;
    const picked = ids ? all.filter((m) => ids.has(m.id)) : sample(all, opt("--sample", 0), opt("--seed", 20261019));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "results"), { recursive: true });
    writeFileSync(join(dir, "index.tsv"), picked.map((m) => `${m.id}\t${m.op}\t${m.line}\t${m.desc.replace(/\s+/g, " ")}`).join("\n") + "\n");
    for (const m of picked) writeFileSync(join(dir, `${m.id}.line`), m.text + "\n");
    const byOp = (ms: Mutant[]) => Object.entries(ms.reduce<Record<string, number>>((a, m) => ((a[m.op] = (a[m.op] ?? 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`${src}: ${all.length} mutants (${byOp(all)}); testing ${picked.length} (${byOp(picked)})`);
  } else if (cmd === "report") {
    const [dir, title] = args;
    if (!dir) throw new Error("usage: report <outDir> [title]");
    const idx = new Map(readIndex(dir).map((m) => [m.id, m]));
    const res = readResults(dir);
    const s = score(res);
    console.log(`## ${title ?? dir}\n`);
    console.log(`${idx.size} mutants tested; ${res.length} results: killed ${s.killed}, timeout ${s.timeout}, survived ${s.survived}, stillborn ${s.stillborn}; score ${(s.score * 100).toFixed(1)}% of ${s.valid} valid (Wilson 95% interval when the tested mutants are a sample: ${wilson95(s.killed + s.timeout, s.valid).map((x) => (x * 100).toFixed(1)).join("-")}%)\n`);
    const ops = [...new Set([...idx.values()].map((m) => m.op))].sort();
    console.log("| Operator | Valid | Killed | Survived |\n|---|---|---|---|");
    for (const op of ops) {
      const r = res.filter((x) => idx.get(x.id)?.op === op && x.status !== "stillborn");
      console.log(`| ${op} | ${r.length} | ${r.filter((x) => x.status !== "survived").length} | ${r.filter((x) => x.status === "survived").length} |`);
    }
    console.log("\nSurvivors:\n");
    for (const r of res.filter((x) => x.status === "survived").sort((a, b) => a.id - b.id)) {
      const m = idx.get(r.id)!;
      const lineFile = join(dir, `${m.id}.line`);
      const mutated = existsSync(lineFile) ? readFileSync(lineFile, "utf8").trim().replace(/\s+/g, " ") : "";
      console.log(`- #${m.id} line ${m.line} (${m.op}): ${m.desc}${mutated ? `; mutated line: \`${mutated.length > 110 ? `${mutated.slice(0, 107)}...` : mutated}\`` : ""}`);
    }
    const missing = [...idx.keys()].filter((id) => !res.some((r) => r.id === id));
    if (missing.length) console.log(`\nNot run (time box): ${missing.length}`);
  } else {
    console.error("usage: bun scripts/mutation-gen.ts gen|report ...");
    process.exit(2);
  }
}
