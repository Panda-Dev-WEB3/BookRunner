#!/usr/bin/env bash
# Mutation testing (audit 2026-10, Task 7c) of Tranche, BookLogic, MMMandate and PoolEngine, in the pinned Foundry
# image of scripts/forge.sh (no other tool, nothing downloaded). Two engines:
#
#   sample (default)  scripts/mutation-gen.ts makes one mutant per site (flipped comparison, swapped arithmetic or
#                     logical operator, removed guard / require / access modifier, deleted state write, negation,
#                     boolean or constant change), keeps every access mutant and draws the rest by weighted random
#                     sampling with a fixed seed, guards and money lines first (MUTATION_SAMPLE, default 40, 0 = all;
#                     MUTATION_SEED; MUTATION_IDS=1,2,3 re-tests given mutants); scripts/mutation-run.sh tests them in
#                     the container with an incremental compile per mutant. Time-boxed by MUTATION_MINUTES.
#   forge             Foundry's built-in `forge test --mutate` (forge 1.8.1): every operator against every other one,
#                     a full compile per mutant. It runs here, but at ~3 mutants a minute on 12 cores (930 mutants for
#                     MMMandate alone), so it is the long, exhaustive option (MUTATION_ENGINE=forge).
#
# Each target runs in its own workspace, contracts/cache/mutation-ws/<target> (gitignored): lib/ plus only the
# suites that exercise the target and the src / test files they import, transitively. Fuzz and invariant campaigns
# are shortened (MUTATION_FUZZ_RUNS, MUTATION_INVARIANT_RUNS x MUTATION_INVARIANT_DEPTH); the full ones stay in CI.
#
# Throttled by default (a developer machine stays usable): one container, FORGE_DOCKER_ARGS="--cpus=2 --memory=3g"
# unless set (empty: no limit), MUTATION_JOBS=2 workers, one forge thread each (MUTATION_THREADS).
#
#   bash scripts/mutation.sh <Tranche|BookLogic|MMMandate|PoolEngine>
#   FORGE_DOCKER_ARGS= MUTATION_JOBS=10 MUTATION_SAMPLE=0 MUTATION_MINUTES=120 bash scripts/mutation.sh PoolEngine
#   bash scripts/mutation.sh --list                               the suites each target runs
#   MUTATION_BASELINE=1 bash scripts/mutation.sh MMMandate        its suites once, no mutants
#
# Output: contracts/cache/mutation-ws/<target>.log and <target>.md (score per operator, survivors).
# Results and the triage of survivors: docs/MUTATION-2026-10.md.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS="$(cd "$HERE/../contracts" && pwd)"

declare -A SRC=(
  [Tranche]=src/Tranche.sol
  [BookLogic]=src/libraries/BookLogic.sol
  [MMMandate]=src/MMMandate.sol
  [PoolEngine]=src/PoolEngine.sol
)
# Suites (paths under contracts/test) that exercise each target. Invariant suites are included with short campaigns.
declare -A SUITES=(
  [Tranche]="book/Tranche.t.sol book/Book.t.sol book/BookReviewFixes.t.sol book/BookInvariant.t.sol
    audit/ext2026/M1HeldMarkSettlement.t.sol audit/ext2026/LeadStuckSubscription.t.sol audit/area1/CapitalCoreAudit.t.sol book/TrancheMutationKills.t.sol"
  [BookLogic]="book/Book.t.sol book/BookReviewFixes.t.sol book/BackstopRepayment.t.sol book/BookInvariant.t.sol
    audit/ext2026/M1HeldMarkSettlement.t.sol audit/ext2026/L1FeeFlowSeniorFirst.t.sol audit/ext2026/LeadSettlePrice.t.sol
    audit/ext2026/LeadStuckSubscription.t.sol audit/area1/CapitalCoreAudit.t.sol"
  [MMMandate]="mandate/MMMandate.t.sol mandate/MandateRedTeam.t.sol mandate/MandateFuzz.t.sol
    mandate/MandateReviewRegressions.t.sol mandate/MandateInvariant.t.sol mandate/BookrunnerDesk.t.sol
    mandate/DeskRiskControls.t.sol audit/ext2026/M3PoolDrainSkew.t.sol mandate/MandateMutationKills.t.sol"
  [PoolEngine]="engine/PoolEngine.t.sol engine/PoolEngineFuzz.t.sol engine/EngineCloseOut.t.sol
    engine/EngineReviewRegressions.t.sol engine/PoolEnginePull.t.sol engine/PoolEngineAdapter.t.sol
    engine/PoolEngineInvariant.t.sol audit/area2/Area2EngineAudit.t.sol audit/ext2026/M3PoolDrainSkew.t.sol
    audit/ext2026/N1EngineSplit.t.sol audit/ext2026/LeadKeeperReward.t.sol audit/ext2026/LeadLossBudgetBreach.t.sol
    audit/ext2026/LeadSettlePrice.t.sol"
)

if [ "${1:-}" = "--list" ]; then
  for t in Tranche BookLogic MMMandate PoolEngine; do echo "$t (${SRC[$t]}):"; for s in ${SUITES[$t]}; do echo "  $s"; done; done
  exit 0
fi
TARGET="${1:?usage: scripts/mutation.sh <Tranche|BookLogic|MMMandate|PoolEngine> [forge test args]}"
shift
[ -n "${SRC[$TARGET]:-}" ] || { echo "unknown target: $TARGET" >&2; exit 2; }

WS_REL="cache/mutation-ws/$TARGET"
WS="$CONTRACTS/$WS_REL"
rm -rf "$WS"
mkdir -p "$WS"
cp -r "$CONTRACTS/lib" "$CONTRACTS/foundry.toml" "$WS/"
# src/ and test/: only the listed suites and what they import, transitively (relative imports; lib/ is compiled
# only where imported). A mutant's compile is then the target's dependency closure, not the whole repo.
relative_imports() {
  local f="$1" imp
  while read -r imp; do
    case "$imp" in ./*|../*) (cd "$(dirname "$f")" && realpath -m "$imp") ;; esac
  done < <(grep -oE '(from|import) +"[^"]+"' "$f" | sed -E 's/^(from|import) +"//; s/"$//')
}
queue=()
for s in ${SUITES[$TARGET]}; do queue+=("$CONTRACTS/test/$s"); done
queue+=("$CONTRACTS/${SRC[$TARGET]}")
declare -A kept=()
nsuites=0
while [ "${#queue[@]}" -gt 0 ]; do
  f="${queue[0]}"; queue=("${queue[@]:1}")
  [ -n "${kept[$f]:-}" ] && continue
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 2; }
  kept[$f]=1
  rel="${f#"$CONTRACTS/"}"
  mkdir -p "$WS/$(dirname "$rel")"
  cp "$f" "$WS/$rel"
  case "$f" in *.t.sol) nsuites=$((nsuites + 1)) ;; esac
  while read -r i; do queue+=("$i"); done < <(relative_imports "$f")
done
echo "mutation workspace $WS_REL: ${#kept[@]} files, $nsuites suites"

LOG="$CONTRACTS/cache/mutation-ws/$TARGET.log"
# Short campaigns, written into the workspace foundry.toml (forge re-reads the copied project for every mutant;
# environment overrides do not reach those runs). A mutant only needs one failing test: failed invariant sequences
# are not shrunk, and every run stops at the first failure (--fail-fast).
fuzz_runs="${MUTATION_FUZZ_RUNS:-64}"; inv_runs="${MUTATION_INVARIANT_RUNS:-16}"; inv_depth="${MUTATION_INVARIANT_DEPTH:-32}"
awk -v fr="$fuzz_runs" -v ir="$inv_runs" -v id="$inv_depth" '
  /^\[/ { sec = $0 }
  sec == "[profile.default.fuzz]" && /^runs *=/ { $0 = "runs = " fr }
  sec == "[profile.default.invariant]" && /^runs *=/ { $0 = "runs = " ir }
  sec == "[profile.default.invariant]" && /^depth *=/ { $0 = "depth = " id "\nshrink_run_limit = 0" }
  { print }
' "$CONTRACTS/foundry.toml" > "$WS/foundry.toml"
grep -q "^shrink_run_limit = 0" "$WS/foundry.toml" || { echo "foundry.toml layout changed: update scripts/mutation.sh" >&2; exit 2; }
export FORGE_SUBDIR="$WS_REL"
export FORGE_DOCKER_ARGS="${FORGE_DOCKER_ARGS---cpus=2 --memory=3g}"
JOBS="${MUTATION_JOBS:-2}"
THREADS="${MUTATION_THREADS:-1}"
start=$(date +%s)
set +e
if [ -n "${MUTATION_BASELINE:-}" ]; then
  # the workspace's suites once, without mutants: it compiles, passes, and how long one run takes
  bash "$HERE/forge.sh" test --threads "$THREADS" "$@" 2>&1 | tee "$LOG"
  rc=${PIPESTATUS[0]}
elif [ "${MUTATION_ENGINE:-sample}" = "forge" ]; then
  bash "$HERE/forge.sh" test --mutate "${SRC[$TARGET]}" \
    --threads "$THREADS" --mutation-jobs "$JOBS" --mutation-timeout "${MUTATION_TIMEOUT:-300}" --fail-fast "$@" 2>&1 | tee "$LOG"
  rc=${PIPESTATUS[0]}
else
  BUN="$HERE/../node_modules/bun/bin/bun.exe"
  [ -x "$BUN" ] || BUN=bun
  "$BUN" "$HERE/mutation-gen.ts" gen "$WS/${SRC[$TARGET]}" "$WS/mutants" \
    --sample "${MUTATION_SAMPLE:-40}" --seed "${MUTATION_SEED:-20261019}" ${MUTATION_IDS:+--ids "$MUTATION_IDS"} | tee "$LOG"
  deadline=0
  [ "${MUTATION_MINUTES:-0}" -gt 0 ] && deadline=$(( $(date +%s) + MUTATION_MINUTES * 60 ))
  FOUNDRY_TOOL=bash bash "$HERE/forge.sh" /repo/scripts/mutation-run.sh "${SRC[$TARGET]}" "$JOBS" \
    "${MUTATION_TIMEOUT:-300}" "$deadline" "$THREADS" 2>&1 | tee -a "$LOG"
  rc=${PIPESTATUS[0]}
  "$BUN" "$HERE/mutation-gen.ts" report "$WS/mutants" "$TARGET (${SRC[$TARGET]})" | tee "$CONTRACTS/cache/mutation-ws/$TARGET.md"
fi
set -e
echo "mutation $TARGET: exit $rc after $(( $(date +%s) - start )) s; log $LOG"
exit "$rc"
