// Published-file manifest (packages/shared/src/siteManifest.ts): sha256 of every file under a web root, as JSON on
// STDOUT. deploy/server/update.sh runs it AS the bookrunner user right after publishing the site and the app, and root
// writes the output to the root-owned /usr/local/lib/bookrunner-deploy/site-manifest.json (services/alerts compares
// the web root against it: site_files_changed / site_manifest_missing). Writes no file itself.
//   bun scripts/site-manifest.ts /var/www/bookrunner --commit <sha>
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { buildSiteManifest } from "../packages/shared/src/siteManifest";

export function manifestJson(root: string, commit: string | null, now = new Date()): string {
  return `${JSON.stringify(buildSiteManifest(root, { commit, now }), null, 1)}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--commit");
  const commit = at >= 0 ? (args[at + 1] ?? null) : null;
  const root = args.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
    console.error("usage: bun scripts/site-manifest.ts <web root directory> [--commit <sha>]");
    process.exit(2);
  }
  if (commit !== null && !/^[0-9a-f]{7,64}$/.test(commit)) {
    console.error(`--commit must be a hex commit id (got "${commit}")`);
    process.exit(2);
  }
  process.stdout.write(manifestJson(resolve(root), commit));
}
