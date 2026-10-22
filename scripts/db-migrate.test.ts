// update.sh applies the database migrations before the stack restarts (insurance-pool follow-ups; migrations
// 0001/0002_insurance_pool were the first a deploy needed): deploy/server/db-migrate.sh runs them as the stack user with
// the Postgres password parsed (never sourced) from the root-owned .env.infra and passed through the environment only,
// and a failure stops update.sh before any restart.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const fwd = (p: string) => p.replace(/\\/g, "/");
const dir = mkdtempSync(join(tmpdir(), "bkrn-dbmigrate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("db_migrate (deploy/server/db-migrate.sh)", () => {
  const bash = Bun.which("bash");
  const app = join(dir, "app");
  mkdirSync(app, { recursive: true });
  // stands in for `sudo -u bookrunner`: records its argv, the two variables it must receive and its working directory
  const rec = join(dir, "as-bookrunner.sh");
  writeFileSync(rec, 'printf "argv=%s\\npgpassword=%s\\ndatabase_url=%s\\ncwd=%s\\n" "$*" "$PGPASSWORD" "$DATABASE_URL" "$(pwd)" > "$REC_OUT"\nexit "${REC_EXIT:-0}"\n');

  function run(infraText: string | null, db = "bookrunner_testnet", exit = 0) {
    const infra = join(dir, `infra-${Math.random().toString(36).slice(2)}.env`);
    if (infraText !== null) writeFileSync(infra, infraText);
    const out = join(dir, `rec-${Math.random().toString(36).slice(2)}.txt`);
    const script = [
      `. "${fwd(resolve(ROOT, "deploy/server/env-parse.sh"))}"`,
      `. "${fwd(resolve(ROOT, "deploy/server/db-migrate.sh"))}"`,
      `export REC_OUT="${fwd(out)}" REC_EXIT=${exit}`,
      `DB_MIGRATE_AS=(bash "${fwd(rec)}")`,
      `db_migrate "${fwd(infra)}" "${fwd(app)}" "${db}"`,
    ].join("\n");
    const r = Bun.spawnSync([bash as string, "-c", script], { cwd: dir });
    const recorded = existsSync(out)
      ? Object.fromEntries(
          readFileSync(out, "utf8")
            .trim()
            .split("\n")
            .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
        )
      : null;
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), recorded };
  }

  test.skipIf(!bash)("runs the packages/db migration in the app checkout; the password only in the environment, never in argv or the URL", () => {
    const r = run("REDIS_PASSWORD=r\nPOSTGRES_PASSWORD=s3cr3t-Pw_1\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("==> database migrations (bookrunner_testnet)");
    expect(r.recorded!.argv).toBe("node_modules/.bin/bun run --cwd packages/db migrate");
    expect(r.recorded!.pgpassword).toBe("s3cr3t-Pw_1");
    expect(r.recorded!.database_url).toBe("postgres://bookrunner@127.0.0.1:54400/bookrunner_testnet");
    expect(r.recorded!.cwd.endsWith("/app")).toBe(true);
    expect(`${r.recorded!.argv} ${r.recorded!.database_url} ${r.stdout} ${r.stderr}`).not.toContain("s3cr3t");
  });

  test.skipIf(!bash)("the file is parsed, never sourced: quotes stripped, a command substitution stays text", () => {
    const marker = fwd(join(dir, "pwned"));
    expect(run(`POSTGRES_PASSWORD="quoted"\n`).recorded!.pgpassword).toBe("quoted");
    const r = run(`POSTGRES_PASSWORD=$(touch ${marker})x\n`);
    expect(r.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(r.recorded!.pgpassword).toBe(`$(touch ${marker})x`);
  });

  test.skipIf(!bash)("no .env.infra or no POSTGRES_PASSWORD: the historical default, like scripts/dev.ts", () => {
    expect(run(null).recorded!.pgpassword).toBe("bookrunner");
    expect(run("REDIS_PASSWORD=r\n").recorded!.pgpassword).toBe("bookrunner");
  });

  test.skipIf(!bash)("a key defined twice refuses the file; nothing runs, no value echoed", () => {
    const r = run("POSTGRES_PASSWORD=first-pw\nPOSTGRES_PASSWORD=second-pw\n");
    expect(r.code).toBe(1);
    expect(r.recorded).toBeNull();
    expect(r.stderr).toContain("POSTGRES_PASSWORD more than once");
    expect(r.stderr).not.toContain("-pw");
  });

  test.skipIf(!bash)("a failed migration: non-zero with a clear message (the stack is not restarted)", () => {
    const r = run("POSTGRES_PASSWORD=p\n", "bookrunner_testnet_live", 3);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("database migrations FAILED on bookrunner_testnet_live");
    expect(r.stderr).toContain("The stack was NOT restarted");
  });

  test.skipIf(!bash)("a malformed database name is refused before anything runs", () => {
    const r = run("POSTGRES_PASSWORD=p\n", "x; rm -rf /");
    expect(r.code).toBe(2);
    expect(r.recorded).toBeNull();
  });
});

describe("update.sh", () => {
  const text = readFileSync(resolve(ROOT, "deploy/server/update.sh"), "utf8");
  const lib = readFileSync(resolve(ROOT, "deploy/server/db-migrate.sh"), "utf8");
  const at = (needle: string) => {
    const i = text.indexOf(needle);
    expect(`${needle} ${i >= 0}`).toBe(`${needle} true`);
    return i;
  };

  test("migrates every stack database after the infra reload and before any restart, stopping on failure", () => {
    const reload = at("systemctl reload bookrunner-infra");
    const pub = at('db_migrate "$INFRA_ENV" "$APP" bookrunner_testnet || exit 1');
    const live = at('db_migrate "$INFRA_ENV" "$APP" bookrunner_testnet_live || exit 1');
    const restart = at("systemctl restart bookrunner\n");
    const restartLive = at("systemctl restart bookrunner@testnet-live");
    expect(reload < pub && pub < live && live < restart && restart < restartLive).toBe(true);
    // only in the full update: --web-only restarts nothing and migrates nothing
    expect(text.lastIndexOf('if [ "${1:-}" != "--web-only" ]; then', pub)).toBeGreaterThan(-1);
  });

  test("the helpers come from the root-owned deploy copy; .env.infra is never sourced", () => {
    at('. "$DEPLOY/env-parse.sh"');
    at('. "$DEPLOY/db-migrate.sh"');
    for (const t of [text, lib]) {
      expect(t).not.toMatch(/^\s*(\.|source)\s+["']?\$\{?(INFRA_ENV|infra)\b/m);
      expect(t).not.toMatch(/^\s*(\.|source)\s+\S*\.env\.infra/m);
    }
  });

  test("the default runner: the bookrunner user keeping exactly PGPASSWORD and DATABASE_URL; no password in the URL", () => {
    expect(lib).toContain("sudo --preserve-env=PGPASSWORD,DATABASE_URL -u bookrunner HOME=/opt/bookrunner");
    expect(lib).toContain('DATABASE_URL="postgres://bookrunner@127.0.0.1:54400/$db"');
    expect(lib).toMatch(/env_dupes "\$infra"/);
    expect(lib).toMatch(/env_get "\$infra" POSTGRES_PASSWORD/);
  });
});
