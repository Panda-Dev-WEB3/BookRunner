#!/usr/bin/env bash
# Runs inside the Foundry container (scripts/mutation.sh starts it with scripts/forge.sh, cwd = the target's
# workspace). Tests the mutants scripts/mutation-gen.ts wrote to ./mutants: JOBS workers, each on its own copy of
# the workspace in the container's /tmp, built once and then compiled incrementally per mutant (only the mutated
# file and what imports it). A mutant is
#   killed     some test fails (forge test --fail-fast exits non-zero after compiling)
#   survived   every test passes
#   timeout    the run exceeded TIMEOUT seconds (counted as killed in the score: e.g. an unbounded loop)
#   stillborn  it does not compile (excluded from the score)
#   usage: mutation-run.sh <src path in the workspace> <jobs> <timeout s> [deadline unix s] [forge threads per worker]
set -uo pipefail
SRC="$1"
JOBS="$2"
TIMEOUT="$3"
DEADLINE="${4:-0}"
THREADS="${5:-1}"
WS="$PWD"
M="$WS/mutants"
mapfile -t IDS < <(cut -f1 "$M/index.tsv")
rm -rf /tmp/mw && mkdir -p /tmp/mw
cp -r "$WS" /tmp/mw/0
rm -rf /tmp/mw/0/mutants /tmp/mw/0/cache /tmp/mw/0/out
(cd /tmp/mw/0 && forge build --threads "$THREADS" >/tmp/mw/build.log 2>&1) || { echo "baseline build failed"; cat /tmp/mw/build.log; exit 3; }
(cd /tmp/mw/0 && forge test --fail-fast --threads "$THREADS" >/tmp/mw/baseline.log 2>&1) || { echo "baseline tests fail"; tail -30 /tmp/mw/baseline.log; exit 3; }
cp "/tmp/mw/0/$SRC" /tmp/mw/orig.sol
for ((w = 1; w < JOBS; w++)); do cp -r /tmp/mw/0 "/tmp/mw/$w"; done
echo "built; ${#IDS[@]} mutants, $JOBS workers, timeout ${TIMEOUT}s"

worker() {
  local w="$1" dir="/tmp/mw/$1" out="$M/results/$1.tsv" i id line rc log status test
  : >"$out"
  for ((i = w; i < ${#IDS[@]}; i += JOBS)); do
    if [ "$DEADLINE" -gt 0 ] && [ "$(date +%s)" -ge "$DEADLINE" ]; then break; fi
    id="${IDS[$i]}"
    line="$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$M/index.tsv")"
    { head -n $((line - 1)) /tmp/mw/orig.sol; cat "$M/$id.line"; tail -n +$((line + 1)) /tmp/mw/orig.sol; } >"$dir/$SRC"
    log="$(cd "$dir" && timeout "$TIMEOUT" forge test --fail-fast --threads "$THREADS" 2>&1)"
    rc=$?
    test=""
    if [ "$rc" -eq 0 ]; then
      status=survived
    elif [ "$rc" -eq 124 ]; then
      status=timeout
    elif grep -qE "Compiler run failed|Compilation failed|^Error \(" <<<"$log" && ! grep -q "Compiler run successful" <<<"$log"; then
      status=stillborn
    else
      status=killed
      test="$(grep -oE '\[FAIL[^]]*\] [A-Za-z0-9_]+' <<<"$log" | head -1 | sed -E 's/.*\] //')"
      [ -n "$test" ] || test="$(grep -m1 -oE 'FAIL.*' <<<"$log" | cut -c1-80)"
    fi
    printf '%s\t%s\t%s\n' "$id" "$status" "$test" >>"$out"
  done
  cp /tmp/mw/orig.sol "$dir/$SRC"
}
for ((w = 0; w < JOBS; w++)); do worker "$w" & done
wait
echo "done: $(cat "$M"/results/*.tsv | wc -l) results"
