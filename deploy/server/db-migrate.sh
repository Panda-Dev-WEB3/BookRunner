# shellcheck shell=bash
# Database migrations for update.sh (ROOT, from the root-owned deploy copy; sourced after env-parse.sh). The stack
# applies no migration of its own (scripts/dev.ts only migrates the Redis bus), so update.sh runs them here, BEFORE it
# restarts the stack: a new indexer / api must never start on a schema it does not know (e.g. 0001/0002_insurance_pool).
#
# db_migrate INFRA_ENV APP DB
#   Applies packages/db's migrations (drizzle + timescale, `bun run --cwd packages/db migrate`) to database DB AS THE
#   STACK USER, from the app checkout APP (the commit update.sh just built). The Postgres password is POSTGRES_PASSWORD
#   from the root-owned INFRA_ENV, PARSED with env-parse.sh (never sourced; a key defined twice refuses the file);
#   absent = the historical default "bookrunner" (scripts/dev.ts). It reaches the migration ONLY through its
#   environment, as PGPASSWORD (postgres.js reads it when DATABASE_URL carries no password): never on a command line,
#   never in a URL. Returns non-zero, after saying why, when the migration fails.
#
# DB_MIGRATE_AS (array, tests only): the command prefix that runs as the stack user; default sudo to bookrunner keeping
# exactly PGPASSWORD and DATABASE_URL.

db_migrate() {
  local infra="$1" app="$2" db="$3" pw="" dups
  [[ "$db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "!! db_migrate: malformed database name '$db'" >&2; return 2; }
  if [ -e "$infra" ]; then
    [ -f "$infra" ] && [ ! -L "$infra" ] || { echo "!! $infra is not a regular file: refusing to migrate" >&2; return 1; }
    dups="$(env_dupes "$infra")"
    [ -z "$dups" ] || { echo "!! $infra defines $(echo "$dups" | tr '\n' ' ')more than once: keep exactly one line per key" >&2; return 1; }
    pw="$(env_get "$infra" POSTGRES_PASSWORD)"
  fi
  local -a as=(sudo --preserve-env=PGPASSWORD,DATABASE_URL -u bookrunner HOME=/opt/bookrunner)
  if [ -n "${DB_MIGRATE_AS+x}" ]; then as=("${DB_MIGRATE_AS[@]}"); fi
  echo "==> database migrations ($db)"
  if ! ( cd "$app" && export PGPASSWORD="${pw:-bookrunner}" DATABASE_URL="postgres://bookrunner@127.0.0.1:54400/$db" \
    && "${as[@]}" node_modules/.bin/bun run --cwd packages/db migrate ); then
    echo "!! database migrations FAILED on $db (see the output above)." >&2
    echo "!! The stack was NOT restarted: it keeps running the previous code (until it next restarts on its own)." >&2
    echo "!! Fix the cause (Postgres up? the POSTGRES_PASSWORD in $infra?), then re-run update.sh." >&2
    return 1
  fi
}
