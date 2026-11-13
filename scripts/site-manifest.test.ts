// Published-file manifest writer (scripts/site-manifest.ts + packages/shared/src/siteManifest.ts) and its place in
// deploy/server/update.sh: run AS the bookrunner user after the publish, written by root outside the web root.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSiteManifest, diffSiteFiles, hashTree, parseSiteManifest, siteExcluded } from "../packages/shared/src/siteManifest";
import { manifestJson } from "./site-manifest";

const ROOT = resolve(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), "bkrn-site-"));
  dirs.push(d);
  mkdirSync(join(d, "app/assets"), { recursive: true });
  mkdirSync(join(d, ".well-known/acme-challenge"), { recursive: true });
  writeFileSync(join(d, "index.html"), "<p>site</p>");
  writeFileSync(join(d, "app/index.html"), "<p>app</p>");
  writeFileSync(join(d, "app/assets/index-abc.js"), "console.log(1)");
  writeFileSync(join(d, ".well-known/security.txt"), "Contact: mailto:x");
  writeFileSync(join(d, ".well-known/acme-challenge/token"), "certbot");
  return d;
}

describe("site manifest", () => {
  test("hashes every published file by relative path; certbot challenges are excluded", () => {
    const d = tree();
    const files = hashTree(d);
    expect(Object.keys(files)).toEqual([".well-known/security.txt", "app/assets/index-abc.js", "app/index.html", "index.html"]);
    expect(files["index.html"]).toBe(sha("<p>site</p>"));
    expect(siteExcluded(".well-known/acme-challenge/token")).toBe(true);
    expect(siteExcluded(".well-known/security.txt")).toBe(false);
  });

  test("records a symbolic link by its target and never follows it", () => {
    const d = tree();
    try {
      symlinkSync("/etc/hostname", join(d, "link"));
    } catch {
      return; // no symlink permission (Windows without developer mode): nothing to check here
    }
    expect(hashTree(d).link).toBe("symlink:/etc/hostname");
  });

  test("the CLI output parses back, with the commit and the root", () => {
    const d = tree();
    const json = manifestJson(d, "bbbf520", new Date("2026-11-13T00:00:00Z"));
    const m = parseSiteManifest(json);
    expect(m).not.toBeNull();
    expect(m!.commit).toBe("bbbf520");
    expect(m!.root).toBe(d);
    expect(m!.generatedAt).toBe("2026-11-13T00:00:00.000Z");
    expect(Object.keys(m!.files).length).toBe(4);
  });

  test("parse refuses what is not a manifest", () => {
    for (const raw of [null, "", "{", "[]", '{"v":2,"root":"/","files":{}}', '{"v":1,"root":"/","files":{"a":"nothex"}}', '{"v":1,"root":"/","files":[]}']) expect(parseSiteManifest(raw)).toBeNull();
  });

  test("diff names added, removed and modified paths", () => {
    const d = tree();
    const before = buildSiteManifest(d).files;
    writeFileSync(join(d, "index.html"), "<p>defaced</p>");
    writeFileSync(join(d, "app/evil.js"), "steal()");
    rmSync(join(d, "app/assets/index-abc.js"));
    writeFileSync(join(d, ".well-known/acme-challenge/other"), "certbot");
    expect(diffSiteFiles(before, hashTree(d))).toEqual({ added: ["app/evil.js"], removed: ["app/assets/index-abc.js"], modified: ["index.html"] });
    expect(diffSiteFiles(before, before)).toEqual({ added: [], removed: [], modified: [] });
  });
});

describe("update.sh writes the manifest", () => {
  const text = readFileSync(resolve(ROOT, "deploy/server/update.sh"), "utf8");
  const install = readFileSync(resolve(ROOT, "deploy/server/install.sh"), "utf8");
  const at = (needle: string) => {
    const i = text.indexOf(needle);
    expect(`${needle} ${i >= 0}`).toBe(`${needle} true`);
    return i;
  };

  test("after both publishes, computed as bookrunner, written by root outside the web root", () => {
    const pubApp = at('rsync -a --safe-links --delete apps/web/dist/ "$WWW/app/"');
    const pubSite = at('rsync -a --safe-links --delete --exclude=/app apps/site/dist/ "$WWW/"');
    const run = at('"${AS[@]}" node_modules/.bin/bun scripts/site-manifest.ts "$WWW" --commit "$WANT" > "$tmp"');
    expect(pubApp < run && pubSite < run).toBe(true);
    at('SITE_MANIFEST="$DEPLOY/site-manifest.json"');
    at('chown root:root "$tmp"');
    at('chmod 0644 "$tmp"');
    at('mv -f "$tmp" "$SITE_MANIFEST"');
    // root never executes the app tree's bun as root: only through the bookrunner user
    expect(text).not.toMatch(/^\s*node_modules\/\.bin\/bun scripts\/site-manifest/m);
  });

  test("the deploy-copy refresh keeps the manifest (rsync --delete would remove it)", () => {
    for (const t of [text, install]) expect(t).toContain("--exclude=/site-manifest.json");
  });
});
