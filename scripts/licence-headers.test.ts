// Licence and pragma headers of the Solidity tree (audit 2026-10 F-2 / F-3; runs in CI with `bun test`):
//   - MIT: every file under contracts/src/interfaces/ (pragma ^0.8.24, importable by integrators on any compiler
//     from 0.8.24) and contracts/src/libraries/UniswapV3Twap.sol (with its Uniswap v4-core TickMath notice);
//     LICENSE carves exactly these out of the BUSL-1.1 Licensed Work and LICENSE-MIT holds the MIT text.
//   - BUSL-1.1 with the fixed `pragma solidity 0.8.30;`: every other file under contracts/{src,script,test}.
//   - An MIT file imports only MIT files (other MIT files of this repo, or OpenZeppelin, which is MIT), so no
//     BUSL code is pulled into the MIT surface.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const C = join(ROOT, "contracts");
const rel = (p: string) => relative(C, p).split("\\").join("/");

const MIT_DIRS = ["src/interfaces/"];
const MIT_FILES = ["src/libraries/UniswapV3Twap.sol"];
const isMit = (r: string) => MIT_DIRS.some((d) => r.startsWith(d)) || MIT_FILES.includes(r);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith(".sol") ? [p] : [];
  });
}
const files = ["src", "script", "test"].flatMap((d) => walk(join(C, d))).map((p) => ({ path: p, rel: rel(p), text: readFileSync(p, "utf8") }));
const spdx = (t: string) => /^\/\/ SPDX-License-Identifier: (\S+)/m.exec(t)?.[1];
const pragma = (t: string) => /^pragma solidity ([^;]+);/m.exec(t)?.[1];

describe("Solidity licence and pragma headers", () => {
  test("the tree is there", () => {
    expect(files.length).toBeGreaterThan(150);
    expect(files.filter((f) => isMit(f.rel)).length).toBe(28);
  });

  test("interfaces/ and UniswapV3Twap.sol are MIT, everything else BUSL-1.1", () => {
    const wrong = files.filter((f) => spdx(f.text) !== (isMit(f.rel) ? "MIT" : "BUSL-1.1")).map((f) => `${f.rel}: ${spdx(f.text)}`);
    expect(wrong).toEqual([]);
  });

  test("pragma: ^0.8.24 for the interfaces, the fixed 0.8.30 everywhere else (deployed code)", () => {
    const wrong = files
      .filter((f) => pragma(f.text) !== (f.rel.startsWith("src/interfaces/") ? "^0.8.24" : "0.8.30"))
      .map((f) => `${f.rel}: ${pragma(f.text)}`);
    expect(wrong).toEqual([]);
  });

  test("an MIT file imports only MIT files (no BUSL code in the MIT surface)", () => {
    const bad: string[] = [];
    for (const f of files.filter((x) => isMit(x.rel))) {
      for (const m of f.text.matchAll(/^import\s+(?:[^"']*\s+from\s+)?["']([^"']+)["'];/gm)) {
        const spec = m[1] as string;
        if (spec.startsWith("@openzeppelin/")) continue; // OpenZeppelin Contracts: MIT
        const target = spec.startsWith(".") ? rel(normalize(join(dirname(f.path), spec))) : spec;
        if (!isMit(target)) bad.push(`${f.rel} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("UniswapV3Twap.sol carries the Uniswap v4-core TickMath (MIT) notice", () => {
    const t = files.find((f) => f.rel === "src/libraries/UniswapV3Twap.sol")?.text ?? "";
    expect(t).toContain("https://github.com/Uniswap/v4-core/blob/main/src/libraries/TickMath.sol");
    expect(t).toContain("Copyright 2023 Universal Navigation Inc.");
    expect(t).not.toMatch(/OracleLibrary|getQuoteAtTick/); // nothing from v3-periphery (GPL-2.0-or-later)
  });

  test("LICENSE carves out exactly the MIT paths; LICENSE-MIT has both copyright lines", () => {
    const busl = readFileSync(join(ROOT, "LICENSE"), "utf8");
    const params = busl.slice(busl.indexOf("Parameters"), busl.indexOf("Terms"));
    for (const p of [...MIT_DIRS, ...MIT_FILES]) expect(params).toContain(`contracts/${p}`);
    const mit = readFileSync(join(ROOT, "LICENSE-MIT"), "utf8");
    expect(mit).toContain("Copyright (c) 2026 Panda-Dev-WEB3 (BookRunner)");
    expect(mit).toContain("Copyright 2023 Universal Navigation Inc.");
  });
});
