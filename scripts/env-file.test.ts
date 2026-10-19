// One env-file rule for every reader (scripts/env-file.ts) and its awk mirror for root (deploy/server/env-parse.sh).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvText, readEnvFileStrict } from "./env-file";

const dir = mkdtempSync(join(tmpdir(), "bkrn-envfile-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

const SAMPLE = [
  "# comment",
  "BKRN_TESTNET_LIVE_MNEMONIC=alpha bravo charlie",
  '  ORACLE_SEED = "abc123"  ',
  "RHC_TESTNET_RPC_URL='https://rpc.example/v1?key=k&x=1'",
  "lowercase=ignored",
  "EMPTY=",
  "CRLF=value\r",
  "  # INDENTED=comment",
].join("\n");

describe("env-file rule", () => {
  test("values: quotes stripped, blanks around = trimmed, comments / lowercase keys ignored", () => {
    const f = parseEnvText(SAMPLE);
    expect(f.duplicates).toEqual([]);
    expect(f.values).toEqual({
      BKRN_TESTNET_LIVE_MNEMONIC: "alpha bravo charlie",
      ORACLE_SEED: 'abc123"  ', // trailing blanks after the closing quote keep it (same in the awk mirror)
      RHC_TESTNET_RPC_URL: "https://rpc.example/v1?key=k&x=1",
      EMPTY: "",
      CRLF: "value",
    });
  });

  test("a key defined twice refuses the file (first-line and last-line readers must never disagree)", () => {
    const text = "BKRN_TESTNET_LIVE_MNEMONIC=first words here\nORACLE_SEED=x\nBKRN_TESTNET_LIVE_MNEMONIC=second words here\n";
    expect(parseEnvText(text).duplicates).toEqual(["BKRN_TESTNET_LIVE_MNEMONIC"]);
    const p = file("dup.env", text);
    expect(() => readEnvFileStrict(p)).toThrow("defines BKRN_TESTNET_LIVE_MNEMONIC more than once");
    expect(() => readEnvFileStrict(p)).not.toThrow("first words"); // never echoes a value
    // the CLI deploy-testnet.sh runs before it sources an env file
    const r = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "env-file.ts"), "check", p]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("more than once");
    expect(r.stderr.toString()).not.toContain("words");
    expect(Bun.spawnSync([process.execPath, resolve(import.meta.dir, "env-file.ts"), "check", file("ok.env", SAMPLE)]).exitCode).toBe(0);
  });

  // root's awk mirror (deploy/server/env-parse.sh) must give the same answers as the TypeScript rule
  const bash = Bun.which("bash");
  test.skipIf(!bash)("root's awk mirror agrees with the rule (values and duplicates)", () => {
    const lib = resolve(import.meta.dir, "../deploy/server/env-parse.sh").replace(/\\/g, "/");
    const run = (script: string) => Bun.spawnSync([bash as string, "-c", `. "${lib}"; ${script}`]).stdout.toString();
    const p = file("mirror.env", SAMPLE).replace(/\\/g, "/");
    const f = parseEnvText(SAMPLE);
    for (const k of Object.keys(f.values)) expect(run(`env_get "${p}" ${k}`).replace(/\n$/, "")).toBe(f.values[k] as string);
    expect(run(`env_get "${p}" MISSING`)).toBe("");
    expect(run(`env_dupes "${p}"`)).toBe("");
    const d = file("mirror-dup.env", "A=1\nB=2\n A = 3\nB=4\nC=5\n").replace(/\\/g, "/");
    expect(run(`env_dupes "${d}"`).trim().split("\n")).toEqual(parseEnvText("A=1\nB=2\n A = 3\nB=4\nC=5\n").duplicates);
  });
});
