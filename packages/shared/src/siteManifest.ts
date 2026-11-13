// Published-file integrity (deploy/server update.sh -> services/alerts site_files_changed). After update.sh publishes
// the public site and the operator app to the web root, it runs scripts/site-manifest.ts AS the bookrunner user (root
// runs no app-tree code) and writes its stdout to a ROOT-OWNED file outside the web root
// (/usr/local/lib/bookrunner-deploy/site-manifest.json, 0644). services/alerts re-hashes the web root every few minutes
// and compares: a file added, removed or modified after the deploy is a critical alert. The bookrunner user (which owns
// the web root) cannot rewrite the manifest, so a change made through that user stays visible until the next deploy.
//
// Excluded (legitimately written outside a deploy): `.well-known/acme-challenge/` (certbot's webroot plugin drops and
// removes challenge files there; the live host uses `certbot --nginx`, which serves challenges from nginx itself and
// writes nothing under the web root, so the rule only matters if the renewal method ever changes). Nothing else writes
// to the web root: the stack serves its API through nginx proxies, logs go to .data/, backups to /var/backups.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const SITE_MANIFEST_VERSION = 1;
/** Paths (relative to the web root, `/`-separated) that may change between deploys. */
export const SITE_MANIFEST_EXCLUDE: readonly RegExp[] = [/^\.well-known\/acme-challenge(?:\/|$)/];

export interface SiteManifest {
  v: 1;
  /** the web root the manifest describes */
  root: string;
  /** the deployed commit (update.sh $WANT), null when not given */
  commit: string | null;
  /** ISO time of the write */
  generatedAt: string;
  /** relative path -> sha256 hex of the content; a symbolic link -> `symlink:<target>` */
  files: Record<string, string>;
}

export const siteExcluded = (rel: string): boolean => SITE_MANIFEST_EXCLUDE.some((re) => re.test(rel));

export interface TreeEntry {
  rel: string;
  abs: string;
  kind: "file" | "symlink";
  /** lstat identity: a changed one means the content may have changed (alerts' hash cache) */
  stamp: string;
}

/** Every regular file and symbolic link under `root` (links are never followed), excluded paths left out, sorted. */
export function walkTree(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const visit = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (siteExcluded(rel)) continue;
      const st = lstatSync(abs);
      const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      if (st.isSymbolicLink()) out.push({ rel, abs, kind: "symlink", stamp });
      else if (st.isDirectory()) visit(abs, rel);
      else if (st.isFile()) out.push({ rel, abs, kind: "file", stamp });
      // sockets, fifos, devices: never part of a published tree; ignored
    }
  };
  visit(root, "");
  return out;
}

/** The manifest value of one entry: sha256 of a file's bytes, or the target of a link. */
export function entryDigest(e: Pick<TreeEntry, "abs" | "kind">): string {
  if (e.kind === "symlink") return `symlink:${readlinkSync(e.abs)}`;
  return createHash("sha256").update(readFileSync(e.abs)).digest("hex");
}

export function hashTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const e of walkTree(root)) files[e.rel] = entryDigest(e);
  return files;
}

export function buildSiteManifest(root: string, opts: { commit?: string | null; now?: Date } = {}): SiteManifest {
  return { v: 1, root, commit: opts.commit ?? null, generatedAt: (opts.now ?? new Date()).toISOString(), files: hashTree(root) };
}

/** A manifest file's content, or null when it is not one (wrong version, malformed entries). */
export function parseSiteManifest(raw: string | null | undefined): SiteManifest | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const m = o as Partial<SiteManifest>;
  if (m.v !== SITE_MANIFEST_VERSION || typeof m.root !== "string" || !m.files || typeof m.files !== "object" || Array.isArray(m.files)) return null;
  for (const [k, v] of Object.entries(m.files)) if (typeof k !== "string" || typeof v !== "string" || !(/^[0-9a-f]{64}$/.test(v) || v.startsWith("symlink:"))) return null;
  return { v: 1, root: m.root, commit: typeof m.commit === "string" ? m.commit : null, generatedAt: typeof m.generatedAt === "string" ? m.generatedAt : "", files: m.files };
}

export interface SiteDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

/** What changed from the manifest (`expected`) to the tree as it is now (`actual`), each list sorted. */
export function diffSiteFiles(expected: Record<string, string>, actual: Record<string, string>): SiteDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [p, h] of Object.entries(actual)) {
    if (siteExcluded(p)) continue;
    if (!(p in expected)) added.push(p);
    else if (expected[p] !== h) modified.push(p);
  }
  for (const p of Object.keys(expected)) if (!siteExcluded(p) && !(p in actual)) removed.push(p);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}
