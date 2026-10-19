// The spool directory from MARK_SPOOL_DIR: a relative path resolves against the repo root (the stack's writable
// .data/ under the systemd sandbox, HARDENING.md), never against the service's own cwd (services/mark, read-only
// on the server); an absolute path is used as is.
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "@bookrunner/shared";
import { MarkSpool } from "../src/spool";

describe("MarkSpool directory", () => {
  test("relative MARK_SPOOL_DIR resolves against the repo root", () => {
    expect(new MarkSpool(".data/testnet/mark-spool").dir).toBe(resolve(REPO_ROOT, ".data/testnet/mark-spool"));
  });

  test("absolute MARK_SPOOL_DIR is kept", () => {
    const abs = join(REPO_ROOT, "x", "spool");
    expect(new MarkSpool(abs).dir).toBe(abs);
  });
});
