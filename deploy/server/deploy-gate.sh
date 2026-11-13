# Deploy gate (sourced by update.sh BEFORE any code of the new commit is installed or run).
#
# Owner rule (2026-11-13): a change written by anyone else must be security-reviewed before it is deployed.
# Every commit between the last deployed commit and the one to deploy must be either
#   - signed by a trusted key (the root-owned allowed-signers file, never a file from the repository), or
#   - named in a "Security-Reviewed: <full sha>" line of a commit in the same range that IS trusted-signed
#     (the approval commit scripts/approve-commits.sh creates after the review).
# Anything else refuses the deploy and lists the commits to review. The first run records a baseline.
#
#   deploy_gate <repo> <last deployed sha or empty> <sha to deploy> <allowed signers file>

deploy_gate() {
  local repo="$1" last="$2" want="$3" signers="$4"
  local -a range=() bad=()
  local c approved=""

  [ -f "$signers" ] && [ ! -L "$signers" ] || { echo "!! deploy gate: trusted signers file $signers missing" >&2; return 1; }
  [ "$(stat -c %u "$signers")" = "${DEPLOY_GATE_OWNER_UID:-0}" ] || { echo "!! deploy gate: $signers is not owned by root" >&2; return 1; }
  [[ "$want" =~ ^[0-9a-f]{40}$ ]] || { echo "!! deploy gate: bad commit '$want'" >&2; return 1; }

  if [ -z "$last" ]; then
    # no record yet: only the commit to deploy is checked (the baseline is what runs today)
    range=("$want")
  else
    [[ "$last" =~ ^[0-9a-f]{40}$ ]] || { echo "!! deploy gate: bad last deployed commit '$last'" >&2; return 1; }
    git -C "$repo" merge-base --is-ancestor "$last" "$want" || {
      echo "!! deploy gate: $want does not descend from the deployed $last (history rewritten?): refusing" >&2; return 1; }
    mapfile -t range < <(git -C "$repo" rev-list "$last..$want")
  fi
  [ "${#range[@]}" -gt 0 ] || return 0

  trusted() { git -C "$repo" -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$signers" verify-commit "$1" >/dev/null 2>&1; }

  # approvals: "Security-Reviewed: <sha>" lines, only from trusted-signed commits of the range
  for c in "${range[@]}"; do
    if trusted "$c"; then
      approved+=" $(git -C "$repo" log -1 --format=%B "$c" | sed -n 's/^Security-Reviewed: \([0-9a-f]\{40\}\)$/\1/p' | tr '\n' ' ')"
    fi
  done
  for c in "${range[@]}"; do
    trusted "$c" && continue
    [[ " $approved " == *" $c "* ]] && continue
    bad+=("$c")
  done

  if [ "${#bad[@]}" -gt 0 ]; then
    echo "!! deploy gate: ${#bad[@]} commit(s) are not signed by a trusted key and not security-reviewed:" >&2
    for c in "${bad[@]}"; do
      echo "!!   $(git -C "$repo" log -1 --format='%H  %an <%ae>  %s' "$c" | cut -c1-160)" >&2
    done
    echo "!! Review them, then approve with scripts/approve-commits.sh (a signed Security-Reviewed commit). Nothing deployed." >&2
    return 1
  fi
  echo "==> deploy gate: ${#range[@]} commit(s) since the last deploy, all trusted-signed or security-reviewed"
}
