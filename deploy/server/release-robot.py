#!/usr/bin/env python3
# SPDX-License-Identifier: BUSL-1.1
"""BookRunner scheduled release robot (root, systemd timer every 5 min).

Releases a queue of PRE-SIGNED commits one at a time, at T0, T0 + 1 h, T0 + 2 h, ...:
  1. checks the next commit is signed by a key in the root-owned /etc/bookrunner/allowed_signers;
  2. pushes it to GitHub main as a fast-forward only (if main moved, the queue pauses: nothing is overwritten);
  3. deploys it with the installed update.sh (which runs the deploy gate again);
  4. posts the release note to the Telegram alert group (at T0 also the tech update document, once).
Any failure pauses the queue and posts why; `bookrunner-release resume` continues after a fix.

  bookrunner-release status | arm <T0 ISO-8601 UTC> [interval-minutes] | pause | resume | skip | tick
Files: /etc/bookrunner/release-plan.json (items: sha, title, note, webOnly), /var/lib/bookrunner-release/
(queue.bundle, repo/, state.json, tech-updates.pdf), /root/.ssh/bookrunner_release (GitHub deploy key, write).
"""
import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

PLAN = "/etc/bookrunner/release-plan.json"
ENV = "/etc/bookrunner/mainnet.env"
SIGNERS = "/etc/bookrunner/allowed_signers"
HOME = "/var/lib/bookrunner-release"
REPO = f"{HOME}/repo"
BUNDLE = f"{HOME}/queue.bundle"
STATE = f"{HOME}/state.json"
DOC = f"{HOME}/tech-updates.pdf"
LOG = "/var/log/bookrunner-release.log"
UPDATE = "/usr/local/lib/bookrunner-deploy/update.sh"
GIT_SSH = "ssh -i /root/.ssh/bookrunner_release -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
REMOTE = "git@github.com:Panda-Dev-WEB3/BookRunner.git"


def log(msg: str) -> None:
    line = f"{dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')} {msg}"
    print(line)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(path, obj) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def env_value(key: str):
    with open(ENV) as f:
        for line in f:
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    return None


def telegram(text: str = "", document: str = None, caption: str = "") -> None:
    url, chat = env_value("ALERT_WEBHOOK_URL"), env_value("ALERT_TELEGRAM_CHAT_ID")
    if not url or not chat or "api.telegram.org/bot" not in url:
        log("telegram: not configured, message not sent")
        return
    base = url.rsplit("/", 1)[0]
    try:
        if document:
            # curl builds the multipart body; the token never reaches the command line (config on stdin)
            q = lambda s: s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
            cfg = (f'url = "{q(base)}/sendDocument"\nform = "chat_id={q(chat)}"\nform = "document=@{q(document)}"\n'
                   f'form-string = "caption={q(caption[:1000])}"\n')
            subprocess.run(["curl", "-sS", "-m", "60", "-o", "/dev/null", "-K", "-"], input=cfg.encode(), check=True)
        else:
            body = urllib.parse.urlencode({"chat_id": chat, "text": text[:4000], "disable_web_page_preview": "true"}).encode()
            urllib.request.urlopen(urllib.request.Request(f"{base}/sendMessage", data=body), timeout=30).read()
    except Exception as e:  # never print the URL: it carries the bot token
        log(f"telegram: send failed ({type(e).__name__})")


def git(*args, check=True):
    env = {**os.environ, "GIT_SSH_COMMAND": GIT_SSH}
    return subprocess.run(["git", "-C", REPO, *args], env=env, check=check, capture_output=True, text=True)


def trusted(sha: str) -> bool:
    r = git("-c", "gpg.format=ssh", "-c", f"gpg.ssh.allowedSignersFile={SIGNERS}", "verify-commit", sha, check=False)
    return r.returncode == 0


def ensure_repo() -> None:
    if not os.path.isdir(f"{REPO}/.git"):
        os.makedirs(HOME, exist_ok=True)
        subprocess.run(["git", "clone", "-q", REMOTE, REPO], env={**os.environ, "GIT_SSH_COMMAND": GIT_SSH}, check=True)
    git("fetch", "-q", BUNDLE, "+refs/heads/*:refs/queue/*")
    git("fetch", "-q", "origin", "main")


def pause(state, why: str) -> None:
    state["paused"] = why
    save(STATE, state)
    log(f"PAUSED: {why}")
    telegram(f"[BookRunner release] queue PAUSED: {why}\nNothing further is released until `sudo bookrunner-release resume`.")


def tick() -> int:
    plan, state = load(PLAN, None), load(STATE, {"next": 0, "docSent": False, "lastAt": 0, "paused": None})
    if not plan or not plan.get("t0"):
        return 0
    items = plan["items"]
    if state.get("paused") or state["next"] >= len(items):
        return 0
    t0 = dt.datetime.fromisoformat(plan["t0"].replace("Z", "+00:00")).timestamp()
    interval = int(plan.get("intervalSec", 3600))
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    n = state["next"]
    # never two releases in one interval, even after downtime: the queue just slides
    if now < t0 + n * interval or now - state.get("lastAt", 0) < interval * 0.9:
        return 0

    if not state.get("docSent"):
        if os.path.exists(DOC):
            lines = [f"{i + 1}. {it['title']}" for i, it in enumerate(items)]
            telegram(document=DOC, caption="BookRunner technical update schedule: releases start now, one per hour.\n" + "\n".join(lines))
        state["docSent"] = True
        save(STATE, state)

    it = items[n]
    sha = it["sha"]
    try:
        ensure_repo()
    except subprocess.CalledProcessError as e:
        pause(state, f"#{n + 1} {it['title']}: git fetch failed ({(e.stderr or '').strip()[:200]})")
        return 1
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not trusted(sha):
        pause(state, f"#{n + 1} {it['title']}: {sha[:12]} is not signed by a trusted key")
        return 1
    if git("merge-base", "--is-ancestor", "FETCH_HEAD", sha, check=False).returncode != 0:
        pause(state, f"#{n + 1} {it['title']}: GitHub main moved and is not an ancestor of {sha[:12]} (someone pushed): rebuild the queue")
        return 1
    r = git("push", "-q", "origin", f"{sha}:refs/heads/main", check=False)
    if r.returncode != 0:
        pause(state, f"#{n + 1} {it['title']}: push refused ({r.stderr.strip()[:200]})")
        return 1
    log(f"pushed #{n + 1} {sha[:12]} {it['title']}")
    cmd = ["bash", UPDATE] + (["--web-only"] if it.get("webOnly") else [])
    with open(LOG, "a") as f:
        d = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)
    if d.returncode != 0:
        pause(state, f"#{n + 1} {it['title']}: pushed, but the deploy failed (exit {d.returncode}, see {LOG}); the site runs the previous commit")
        return 1
    state.update(next=n + 1, lastAt=now)
    save(STATE, state)
    left = len(items) - n - 1
    telegram(f"[BookRunner release] #{n + 1}/{len(items)} live: {it['title']}\n{it.get('note', '')}\ncommit {sha[:12]}"
             + (f"\nNext in {interval // 60} min." if left else "\nAll scheduled updates are live."))
    log(f"released #{n + 1} {sha[:12]}")
    return 0


def main(argv) -> int:
    if os.geteuid() != 0:
        print("run as root")
        return 1
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    with open(f"{HOME}/.lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        cmd = argv[1] if len(argv) > 1 else "status"
        state = load(STATE, {"next": 0, "docSent": False, "lastAt": 0, "paused": None})
        plan = load(PLAN, {"items": []})
        if cmd == "tick":
            return tick()
        if cmd == "arm":
            t0 = dt.datetime.fromisoformat(argv[2].replace("Z", "+00:00"))
            if t0.tzinfo is None:
                print("give T0 with a timezone, e.g. 2026-11-20T14:00:00Z")
                return 1
            plan["t0"] = t0.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
            if len(argv) > 3:
                plan["intervalSec"] = int(argv[3]) * 60
            save(PLAN, plan)
            save(STATE, {"next": 0, "docSent": False, "lastAt": 0, "paused": None})
            print(f"armed: {len(plan['items'])} releases from {plan['t0']}, every {plan.get('intervalSec', 3600) // 60} min")
            return 0
        if cmd == "pause":
            state["paused"] = "paused by hand"
        elif cmd == "resume":
            state["paused"] = None
        elif cmd == "skip":
            state["next"] = state.get("next", 0) + 1
        elif cmd != "status":
            print(__doc__)
            return 1
        save(STATE, state) if cmd != "status" else None
        print(json.dumps({"t0": plan.get("t0"), "intervalSec": plan.get("intervalSec", 3600), "state": state,
                          "items": [f"{'x' if i < state['next'] else ' '} {i + 1}. {it['sha'][:12]} {it['title']}" for i, it in enumerate(plan["items"])]}, indent=2))
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
