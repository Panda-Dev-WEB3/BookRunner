// Deploy gate (deploy/server/deploy-gate.sh, owner rule 2026-11-13): a commit not signed by the trusted key must be named
// in a trusted-signed "Security-Reviewed: <sha>" commit before update.sh deploys it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const fwd = (p: string) => p.split("\\").join("/");
const dir = mkdtempSync(join(tmpdir(), "bkrn-gate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bash = Bun.which("bash") as string;

function sh(script: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync([bash, "-c", script], { cwd: dir, env: { ...process.env, ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const repo = fwd(join(dir, "repo"));
const trusted = fwd(join(dir, "trusted"));
const foreign = fwd(join(dir, "foreign"));
const signers = fwd(join(dir, "allowed_signers"));
const gateScript = fwd(resolve(ROOT, "deploy/server/deploy-gate.sh"));

/** One empty commit; signed with `key` (an ssh private key path) or unsigned. Returns its sha. */
function commit(msg: string, key: string | null): string {
  const msgFile = fwd(join(dir, `msg-${Math.random().toString(36).slice(2)}.txt`));
  writeFileSync(msgFile, msg);
  const r = key
    ? sh(`cd "${repo}" && git -c user.signingkey="${key}.pub" commit -q --allow-empty -S -F "${msgFile}" && git rev-parse HEAD`)
    : sh(`cd "${repo}" && git commit -q --allow-empty --no-gpg-sign -F "${msgFile}" && git rev-parse HEAD`);
  if (r.code !== 0) throw new Error(`commit failed: ${r.err}`);
  return r.out.trim();
}

const uid = () => sh("id -u").out.trim();
const gate = (last: string, want: string, signersFile = signers) =>
  sh(`. "${gateScript}"; deploy_gate "${repo}" "${last}" "${want}" "${signersFile}"`, { DEPLOY_GATE_OWNER_UID: uid() });

describe("deploy_gate", () => {
  test("setup", () => {
    const s = sh(`set -e
      ssh-keygen -q -t ed25519 -N "" -f "${trusted}"
      ssh-keygen -q -t ed25519 -N "" -f "${foreign}"
      printf 'owner namespaces="git" %s\\n' "$(cut -d' ' -f1,2 "${trusted}.pub")" > "${signers}"
      git init -q "${repo}"
      cd "${repo}"
      git config user.name t
      git config user.email t@example.invalid
      git config gpg.format ssh
      git config gpg.ssh.allowedSignersFile "${signers}"`);
    expect(s.err).toBe("");
    expect(s.code).toBe(0);
  }, 60_000);

  test("trusted-signed commits pass; foreign-signed and unsigned are refused and listed; a trusted approval lets them through", () => {
    const base = commit("base", trusted);
    const ok = commit("ours", trusted);
    expect(gate(base, ok).code).toBe(0);
    const theirs = commit("theirs", foreign);
    const unsigned = commit("unsigned", null);
    const refused = gate(base, unsigned);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(theirs);
    expect(refused.err).toContain(unsigned);
    expect(refused.err).not.toContain(ok);
    // an approval signed by the FOREIGN key does not count
    const fakeApproval = commit(`approve\n\nSecurity-Reviewed: ${theirs}\nSecurity-Reviewed: ${unsigned}\n`, foreign);
    expect(gate(base, fakeApproval).code).toBe(1);
    // a trusted approval naming only one of them still refuses the others
    const partial = commit(`approve\n\nSecurity-Reviewed: ${theirs}\n`, trusted);
    const p = gate(base, partial);
    expect(p.code).toBe(1);
    expect(p.err).toContain(unsigned);
    expect(p.err).not.toContain(theirs);
    // the full trusted approval: deployable
    const approval = commit(`approve\n\nSecurity-Reviewed: ${unsigned}\nSecurity-Reviewed: ${fakeApproval}\n`, trusted);
    const g = gate(base, approval);
    expect(g.err).toBe("");
    expect(g.code).toBe(0);
  }, 120_000);

  test("no baseline: only the commit to deploy is checked", () => {
    expect(gate("", commit("head", trusted)).code).toBe(0);
    expect(gate("", commit("head2", null)).code).toBe(1);
  }, 60_000);

  test("a rewritten history (target not descending from the deployed commit) is refused", () => {
    const deployed = commit("deployed", trusted);
    const r = sh(`cd "${repo}" && git checkout -q --orphan other && git -c user.signingkey="${trusted}.pub" commit -q --allow-empty -S -m other && git rev-parse HEAD`);
    expect(r.code).toBe(0);
    const g = gate(deployed, r.out.trim());
    expect(g.code).toBe(1);
    expect(g.err).toContain("does not descend");
  }, 60_000);

  test("a missing signers file refuses", () => {
    expect(gate("", commit("x", trusted), fwd(join(dir, "nope"))).code).toBe(1);
  });
});
