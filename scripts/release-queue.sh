#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Stage a queue of pre-signed releases on the server for the release robot (deploy/server/release-robot.py).
# Every first-parent commit of main..<branch> that carries a "Release-Title:" trailer is one release (it ships with
# the commits before it); "Release-Note:" is the Telegram note, "Release-Web-Only: yes" deploys with --web-only.
#   bash scripts/release-queue.sh <branch> [tech-updates.pdf] [media-dir]
# media-dir (optional): notes.json {"intro":{caption,details},"items":[{n,caption,details}],"spotlights":[{after,title,caption,
# details,image}]} + intro.png, 01.png ... : each release is then announced with its image, a short caption and a detailed
# follow-up message. A spotlight is an announcement without a commit, posted in its own hourly slot after release <after>.
# Then on the server: sudo bookrunner-release arm 2026-11-20T14:00:00Z   (T0, UTC; optional interval in minutes)
set -euo pipefail
BR="${1:?usage: release-queue.sh <branch> [pdf] [media-dir]}"; PDF="${2:-}"; MEDIA="${3:-}"
HOST="${RELEASE_HOST:-usecert-ubuntu}"
git fetch -q origin main
git merge-base --is-ancestor origin/main "$BR" || { echo "!! $BR does not start from origin/main: rebase it first"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
n=0
: > "$TMP/items.tsv"
for c in $(git rev-list --reverse --first-parent "origin/main..$BR"); do
  git verify-commit "$c" >/dev/null 2>&1 || { echo "!! $c is not signed by the trusted key"; exit 1; }
  title="$(git log -1 --format='%(trailers:key=Release-Title,valueonly,unfold)' "$c" | head -1)"
  [ -n "$title" ] || continue
  note="$(git log -1 --format='%(trailers:key=Release-Note,valueonly,unfold)' "$c" | head -1)"
  web="$(git log -1 --format='%(trailers:key=Release-Web-Only,valueonly)' "$c" | head -1)"
  printf '%s\t%s\t%s\t%s\n' "$c" "$title" "$note" "$web" >> "$TMP/items.tsv"
  n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "!! no commit with a Release-Title trailer in origin/main..$BR"; exit 1; }
last="$(tail -1 "$TMP/items.tsv" | cut -f1)"
[ "$last" = "$(git rev-parse "$BR")" ] || echo "note: commits after the last Release-Title commit are not released"
node -e '
const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>l.split("\t"));
fs.writeFileSync(process.argv[2],JSON.stringify({t0:null,intervalSec:3600,items:rows.map(([sha,title,note,web])=>({sha,title,note,webOnly:/^yes$/i.test(web||"")}))},null,2));
const media=process.argv[3];if(media){const p=require("path");const notes=JSON.parse(fs.readFileSync(p.join(media,"notes.json"),"utf8"));
const plan=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));const img=(f)=>fs.existsSync(p.join(media,f))?f:undefined;
if(notes.intro)plan.intro={...notes.intro,image:img("intro.png")};
for(const n of notes.items){const it=plan.items[n.n-1];if(!it)throw new Error("notes item "+n.n+" has no release");if(n.title&&n.title!==it.title)console.error("note: #"+n.n+" title differs: "+n.title);
Object.assign(it,{caption:n.caption,details:n.details,image:img(String(n.n).padStart(2,"0")+".png")});}
for(const sp of (notes.spotlights||[]).slice().sort((a,b)=>b.after-a.after)){ // insert from the end so earlier indexes stay valid
if(!(sp.after>=0&&sp.after<=plan.items.length))throw new Error("spotlight after "+sp.after+" has no release");
if(!sp.title||!sp.caption||sp.caption.length>900)throw new Error("spotlight needs a title and a caption <= 900 chars: "+sp.title);
plan.items.splice(sp.after,0,{kind:"post",title:sp.title,caption:sp.caption,details:sp.details,image:img(sp.image||"")});}
for(const it of plan.items)if(it.caption&&it.caption.length>900)throw new Error("caption too long: "+it.title);
fs.writeFileSync(process.argv[2],JSON.stringify(plan,null,2));}
' "$TMP/items.tsv" "$TMP/release-plan.json" "$MEDIA"
git bundle create -q "$TMP/queue.bundle" "origin/main..$BR" "$BR"
cut -f1,2 "$TMP/items.tsv" | nl
node -e 'const p=require(process.argv[1]);console.log(p.items.length+" slots: "+p.items.map(i=>i.kind==="post"?"S":"R").join(""))' "$TMP/release-plan.json"
files=("$TMP/release-plan.json" "$TMP/queue.bundle"); [ -n "$PDF" ] && files+=("$PDF")
scp -q "${files[@]}" "$HOST:/tmp/"
if [ -n "$MEDIA" ]; then
  ssh "$HOST" 'rm -rf /tmp/release-media && mkdir -p /tmp/release-media'
  scp -q "$MEDIA"/*.png "$HOST:/tmp/release-media/"
  ssh "$HOST" "sudo bash -c 'install -d -o root -g root -m 0700 /var/lib/bookrunner-release/media && rm -f /var/lib/bookrunner-release/media/*.png && install -o root -g root -m 0600 /tmp/release-media/*.png /var/lib/bookrunner-release/media/ && rm -rf /tmp/release-media'"
fi
ssh "$HOST" "sudo bash -c 'set -e; install -o root -g root -m 0600 /tmp/release-plan.json /etc/bookrunner/release-plan.json; \
  install -o root -g root -m 0600 /tmp/queue.bundle /var/lib/bookrunner-release/queue.bundle; \
  if [ -f /tmp/$(basename "${PDF:-none}") ] && [ -n \"$PDF\" ]; then install -o root -g root -m 0600 /tmp/$(basename "${PDF:-none}") /var/lib/bookrunner-release/tech-updates.pdf; fi; \
  rm -f /tmp/release-plan.json /tmp/queue.bundle; echo staged $n releases; echo arm with: sudo bookrunner-release arm YYYY-MM-DDTHH:MM:SSZ'"
