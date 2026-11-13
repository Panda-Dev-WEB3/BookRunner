// Published-file integrity check (rules-security.ts site_files_changed / site_manifest_missing): the web root compared
// with the root-owned manifest deploy/server/update.sh writes after each publish (@bookrunner/shared/siteManifest).
//
// Cheap by design: a clean tree is re-checked every ALERT_SITE_CHECK_SECONDS (300), and a file is re-hashed only when
// its lstat identity (inode, size, mtime, ctime) changed since the last check; ctime cannot be set back from user space,
// so a rewrite that restores mtime is still re-hashed. A dirty or missing result is re-checked every pass, so a deploy's
// few seconds between the publish and the new manifest clear before the alert's anti-flap delay ends.
// update.sh's `chown -R` changes every ctime, so the first check after a deploy (or an alerts restart) re-hashes the whole
// web root once (well under a second; readFileSync holds one file at a time). The manifest itself is hashed at deploy
// time, after the publish, by the bookrunner user: what it does not cover is in HARDENING.md "Notes and residual risk".
import { readFileSync, statSync } from "node:fs";
import { diffSiteFiles, entryDigest, parseSiteManifest, walkTree } from "@bookrunner/shared/siteManifest";
import type { SiteFilesSnap } from "./types";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);

export interface SiteFilesOptions {
  root: string;
  manifestPath: string;
  everyMs: number;
  now: () => number;
}

export class SiteFilesChecker {
  private readonly digests = new Map<string, { stamp: string; digest: string }>();
  private last: SiteFilesSnap | null = null;
  /** files hashed by the last check (tests: the stat cache works) */
  hashedLastCheck = 0;

  constructor(private readonly o: SiteFilesOptions) {}

  private dirty(s: SiteFilesSnap): boolean {
    return s.status !== "ok" || !!s.error || s.added.length + s.removed.length + s.modified.length > 0;
  }

  check(): SiteFilesSnap {
    const now = this.o.now();
    if (this.last && !this.dirty(this.last) && now - this.last.checkedAt < this.o.everyMs) return this.last;
    this.last = this.compare(now);
    return this.last;
  }

  private compare(now: number): SiteFilesSnap {
    const base = { manifestPath: this.o.manifestPath, root: this.o.root, commit: null, generatedAt: null, added: [], removed: [], modified: [], checkedAt: now };
    this.hashedLastCheck = 0;
    try {
      if (!statSync(this.o.root, { throwIfNoEntry: false })?.isDirectory()) return { ...base, status: "no_root" };
    } catch (err) {
      return { ...base, status: "no_root", error: errMsg(err) };
    }
    let raw: string;
    try {
      raw = readFileSync(this.o.manifestPath, "utf8");
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      return { ...base, status: missing ? "missing" : "invalid", ...(missing ? {} : { error: errMsg(err) }) };
    }
    const manifest = parseSiteManifest(raw);
    if (!manifest) return { ...base, status: "invalid" };
    try {
      const actual: Record<string, string> = {};
      const seen = new Set<string>();
      for (const e of walkTree(this.o.root)) {
        seen.add(e.rel);
        const hit = this.digests.get(e.rel);
        if (hit && hit.stamp === e.stamp) {
          actual[e.rel] = hit.digest;
          continue;
        }
        const digest = entryDigest(e);
        this.hashedLastCheck++;
        this.digests.set(e.rel, { stamp: e.stamp, digest });
        actual[e.rel] = digest;
      }
      for (const k of [...this.digests.keys()]) if (!seen.has(k)) this.digests.delete(k);
      return { ...base, status: "ok", commit: manifest.commit, generatedAt: manifest.generatedAt || null, ...diffSiteFiles(manifest.files, actual) };
    } catch (err) {
      // a file vanished mid-walk (a deploy in progress) or an unreadable entry: retried next pass
      return { ...base, status: "ok", commit: manifest.commit, generatedAt: manifest.generatedAt || null, error: errMsg(err) };
    }
  }
}
