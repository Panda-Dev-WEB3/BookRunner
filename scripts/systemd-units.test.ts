// The systemd units of deploy/server (audit 2026-10, "shared service user", deploy/server/HARDENING.md): every
// state path the stack writes is inside the unit's ReadWritePaths (ProtectSystem=strict makes everything else
// read-only, so a path outside fails at run time with EROFS), the mark spool is not left in the unit's PrivateTmp
// (emptied on every restart), and the sandbox directives stay in place.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAINNET_FIXED } from "./network-profile";

const ROOT = resolve(import.meta.dir, "..");
const APP = "/opt/bookrunner/app";
const unit = (name: string) => readFileSync(resolve(ROOT, "deploy/server", name), "utf8");

/** All values of `key=` lines (systemd allows the key several times). */
function values(text: string, key: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`))
    .flatMap((l) => l.slice(key.length + 1).trim().split(/\s+/))
    .filter(Boolean);
}

function writable(text: string, path: string): boolean {
  return values(text, "ReadWritePaths").some((p) => {
    const dir = p.replace(/^-/, "");
    return path === dir || path.startsWith(`${dir}/`);
  });
}

/** The `.data/testnet/...` state paths scripts/dev.ts sets for the testnet profile. */
function testnetStatePaths(): Record<string, string> {
  const src = readFileSync(resolve(ROOT, "scripts/dev.ts"), "utf8");
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/^\s+([A-Z_]+): "(\.data\/testnet\/[^"]+)",/gm)) out[m[1]!] = m[2]!;
  return out;
}

const SANDBOX = [
  "NoNewPrivileges=true",
  "ProtectSystem=strict",
  "ProtectHome=yes",
  "PrivateTmp=true",
  "PrivateDevices=yes",
  "RestrictSUIDSGID=yes",
  "RestrictNamespaces=yes",
  "CapabilityBoundingSet=",
  "RemoveIPC=yes",
  "SystemCallErrorNumber=EPERM",
];

describe("bookrunner.service (testnet stack)", () => {
  const text = unit("bookrunner.service");

  test("every state path of the testnet profile is writable", () => {
    const paths = testnetStatePaths();
    expect(Object.keys(paths).sort()).toEqual(["MARK_SPOOL_DIR", "MOCK_ORDERLY_SNAPSHOT_FILE", "OPS_KEYS_DIR", "OPS_SAGA_FILE"]);
    for (const [k, p] of Object.entries(paths)) expect(`${k} ${writable(text, `${APP}/${p}`)}`).toBe(`${k} true`);
    // the log systemd appends to, and the deployment file the first launch writes
    expect(writable(text, `${APP}/.data/testnet/dev.log`)).toBe(true);
    expect(writable(text, `${APP}/contracts/deployments/46630.json`)).toBe(true);
    // and nothing else of the app tree
    expect(writable(text, `${APP}/services/mark/.data`)).toBe(false);
    expect(writable(text, `${APP}/node_modules`)).toBe(false);
  });

  test("sandbox directives", () => {
    for (const d of SANDBOX) expect(text.split("\n")).toContain(d);
    expect(values(text, "InaccessiblePaths")).toEqual(expect.arrayContaining(["-/run/docker.sock", "-/var/run/docker.sock"]));
    expect(values(text, "SystemCallFilter").join(" ")).toStartWith("~@clock");
    expect(text).not.toContain("MemoryDenyWriteExecute=yes"); // bun's JIT needs W+X pages
  });
});

describe("bookrunner@.service (mainnet host)", () => {
  const text = unit("bookrunner@.service");

  test("the mainnet profile's state paths are writable and the spool is not in PrivateTmp", () => {
    const state = Object.entries(MAINNET_FIXED).filter(([, v]) => typeof v === "string" && v.startsWith(".data/"));
    expect(state.map(([k]) => k).sort()).toEqual(["MARK_SPOOL_DIR", "OPS_KEYS_DIR", "OPS_SAGA_FILE"]);
    for (const [k, p] of state) expect(`${k} ${writable(text, `${APP}/${p}`)}`).toBe(`${k} true`);
  });

  test("sandbox directives", () => {
    for (const d of SANDBOX) expect(text.split("\n")).toContain(d);
    expect(values(text, "InaccessiblePaths")).toEqual(expect.arrayContaining(["-/run/docker.sock"]));
  });
});

describe("root units", () => {
  test("bookrunner-infra.service: the Docker CLI runs sandboxed", () => {
    const lines = unit("bookrunner-infra.service").split("\n");
    for (const d of ["NoNewPrivileges=true", "ProtectSystem=full", "PrivateTmp=true", "RestrictSUIDSGID=yes"]) expect(lines).toContain(d);
  });

  test("bookrunner-backup.service keeps its write set to the backup dir", () => {
    const text = unit("bookrunner-backup.service");
    expect(values(text, "ReadWritePaths")).toEqual(["/var/backups/bookrunner", "/run"]);
    expect(text.split("\n")).toContain("RestrictSUIDSGID=yes");
  });
});
