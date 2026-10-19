# shellcheck shell=bash
# Env-file parsing for ROOT (deploy/server, root-owned; sourced by rehearsal-deploy.sh): the awk mirror of
# scripts/env-file.ts (THE rule, tested against this file by scripts/env-file.test.ts). Never evaluates a file:
#   KEY=VALUE lines, KEY in [A-Z0-9_]+ (blanks around KEY and `=` allowed), `#` lines ignored, a trailing CR dropped;
#   VALUE = the rest of the line, leading blanks trimmed, one leading and one trailing quote (" or ') stripped;
#   a key defined more than once refuses the file (env_dupes lists them; callers stop when it prints anything).

# env_dupes FILE: the keys FILE defines more than once, one per line (sorted)
env_dupes() {
  awk '{ sub(/\r$/, "") } /^[ \t]*#/ { next }
    match($0, /^[ \t]*[A-Z0-9_]+[ \t]*=/) { k = substr($0, RSTART, RLENGTH); sub(/^[ \t]*/, "", k); sub(/[ \t]*=$/, "", k); if (seen[k]++) d[k] = 1 }
    END { for (k in d) print k }' "$1" | sort
}

# env_get FILE KEY: the value of KEY in FILE (empty when absent); call env_dupes first
env_get() {
  awk -v want="$2" '{ sub(/\r$/, "") } /^[ \t]*#/ { next }
    match($0, /^[ \t]*[A-Z0-9_]+[ \t]*=/) {
      k = substr($0, RSTART, RLENGTH); sub(/^[ \t]*/, "", k); sub(/[ \t]*=$/, "", k)
      if (k != want) next
      v = substr($0, RSTART + RLENGTH); sub(/^[ \t]*/, "", v); sub(/^["\047]/, "", v); sub(/["\047]$/, "", v)
      print v; exit
    }' "$1"
}
