#!/usr/bin/env bash
# Approve commits written by someone else AFTER their security review (deploy gate, deploy/server/deploy-gate.sh).
# Creates one empty commit, signed with the trusted key of this machine, carrying a "Security-Reviewed: <sha>" line per
# reviewed commit; update.sh then deploys them. Never approve a commit you have not reviewed.
#
#   bash scripts/approve-commits.sh "<one-line review summary>" <sha> [<sha>...]
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: approve-commits.sh \"<review summary>\" <sha> [<sha>...]" >&2; exit 2; }
summary="$1"; shift
[ "$(git config --get commit.gpgsign)" = true ] || { echo "!! commit signing is not enabled in this repository" >&2; exit 1; }
lines=""
for c in "$@"; do
  full="$(git rev-parse --verify "$c^{commit}")"
  git merge-base --is-ancestor "$full" HEAD || { echo "!! $full is not in the current branch" >&2; exit 1; }
  lines+="Security-Reviewed: $full"$'\n'
done
git commit --allow-empty -S -q -F - <<EOF
security review: approve $# commit(s) for deployment

$summary

$lines
EOF
git verify-commit HEAD >/dev/null 2>&1 || { echo "!! the approval commit is not signed by the trusted key" >&2; exit 1; }
echo "approved: $(git log -1 --format=%h) ($# commit(s)); push it, then deploy"
