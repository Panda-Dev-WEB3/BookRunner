#!/usr/bin/env bash
# Integration suite (BKRN_IT=1): every *.it.test.ts plus the two BKRN_IT-gated integration.test.ts files, each
# file in its own `bun test` run against its OWN freshly migrated *_it database (no test can see another's rows).
# Used by the "integration" job of .github/workflows/ci.yml; runs locally too:
#
#   bash scripts/forge.sh build                       # mark / agent / oracle IT tests read contracts/out
#   IT_PG_BASE=postgres://bookrunner:bookrunner@127.0.0.1:54400 REDIS_URL=redis://127.0.0.1:63790 \
#     bash scripts/ci-integration.sh [filter]         # filter: substring of the test path, e.g. ops-venue
#
# Needs: Postgres with the Timescale extension (the migrations create hypertables), Redis, an `anvil` binary on
# PATH (or ANVIL_BIN): the chain tests start PRIVATE anvils on their own ports, and the charter / indexer tests use
# the shared one this script starts on IT_SHARED_ANVIL_PORT (default 18547) unless BKRN_ANVIL_URL is set.
# Never point IT_PG_BASE at a database server whose *_it databases matter: they are dropped and recreated.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FILTER="${1:-}"
BUN="${BUN:-$ROOT/node_modules/bun/bin/bun.exe}"
[ -x "$BUN" ] || BUN="$(command -v bun)"
PG_BASE="${IT_PG_BASE:-postgres://bookrunner:bookrunner@127.0.0.1:54400}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:63790}"
export RISK_IT_REDIS_URL="${RISK_IT_REDIS_URL:-$REDIS_URL/15}"
export BKRN_IT=1
export BKRN_CONTRACTS_OUT="${BKRN_CONTRACTS_OUT:-$ROOT/contracts/out}"
ANVIL="${ANVIL_BIN:-anvil}"

[ -f "$BKRN_CONTRACTS_OUT/MarkRegistry.sol/MarkRegistry.json" ] || { echo "ci-integration: $BKRN_CONTRACTS_OUT has no MarkRegistry: run bash scripts/forge.sh build" >&2; exit 1; }

SHARED_ANVIL_PID=""
cleanup() { [ -z "$SHARED_ANVIL_PID" ] || kill "$SHARED_ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT
if [ -z "${BKRN_ANVIL_URL:-}" ]; then
  PORT="${IT_SHARED_ANVIL_PORT:-18547}"
  "$ANVIL" --port "$PORT" --silent &
  SHARED_ANVIL_PID=$!
  export BKRN_ANVIL_URL="http://127.0.0.1:$PORT"
fi

# <workspace dir> <test file relative to it>; one database per line (name derived from both)
TESTS=$(git ls-files 'services/*/test/*.it.test.ts' 'packages/*/test/*.it.test.ts' services/api/test/integration.test.ts services/oracle/test/integration.test.ts)
[ -z "$FILTER" ] || TESTS=$(printf '%s\n' "$TESTS" | grep -F -- "$FILTER" || true)
[ -n "$TESTS" ] || { echo "ci-integration: no test matches '$FILTER'" >&2; exit 1; }

dbname() { # services/ops-venue/test/chain.it.test.ts -> bkrn_ops_venue_chain_it
  local ws file
  ws=$(basename "$(dirname "$(dirname "$1")")")
  file=$(basename "$1" .test.ts)
  file="${file%.it}"
  printf 'bkrn_%s_%s_it\n' "$ws" "$file" | tr 'A-Z.-' 'a-z__'
}

DBS=$(for t in $TESTS; do dbname "$t"; done | tr '\n' ' ')
echo "==> databases: $DBS"
(cd packages/db && IT_DBS="$DBS" IT_PG_BASE="$PG_BASE" "$BUN" -e '
import postgres from "postgres";
const sql = postgres(process.env.IT_PG_BASE + "/postgres", { max: 1, onnotice: () => {} });
for (const d of process.env.IT_DBS!.trim().split(/\s+/)) {
  if (!/^[a-z0-9_]+_it$/.test(d)) throw new Error(`refusing database name ${d}`);
  await sql.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
  await sql.unsafe(`CREATE DATABASE "${d}"`);
}
await sql.end();')
for d in $DBS; do DATABASE_URL="$PG_BASE/$d" "$BUN" run --cwd packages/db migrate >/dev/null; done

FAILED=()
for t in $TESTS; do
  ws_dir=$(dirname "$(dirname "$t")")
  url="$PG_BASE/$(dbname "$t")"
  echo "==> $t"
  if ! (cd "$ws_dir" && DATABASE_URL="$url" API_IT_DATABASE_URL="$url" "$BUN" test "./${t#"$ws_dir"/}"); then
    FAILED+=("$t")
  fi
done
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "ci-integration: FAILED: ${FAILED[*]}" >&2
  exit 1
fi
echo "ci-integration: all integration files passed"
