// Site security alerts (rules-security.ts): csp_violations from the API's CSP report buckets, and the published-file
// check (siteFiles.ts) behind site_files_changed / site_manifest_missing.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSP_REPORT_OVERFLOW_FIELD, cspBucket } from "@bookrunner/shared/cspReports";
import { KEYS } from "@bookrunner/shared/queues";
import { buildSiteManifest } from "@bookrunner/shared/siteManifest";
import { cspBucketStarts, collect, emptyMemory, parseCspBucket } from "../src/collect";
import { loadConfig } from "../src/config";
import { evaluate } from "../src/rules";
import { cspIgnored, cspViolations, siteFiles } from "../src/rules-security";
import { SiteFilesChecker } from "../src/siteFiles";
import type { Condition, CspSnap, SiteFilesSnap } from "../src/types";
import { NOW, rules, snap } from "./fixtures";

const ks = (cs: Condition[]) => cs.map((c) => [c.key, c.severity]);
const B = cspBucket(NOW);
const row = (blocked: string, count: number, directive = "script-src-elem", path = "/app/") => ({ blocked, directive, path, count });
const csp = (...buckets: CspSnap["buckets"]): CspSnap => ({ buckets });

describe("csp_violations", () => {
  test("quiet below the threshold; warning at it; critical at the burst; per blocked origin", () => {
    const c = rules();
    expect(c.cspViolations).toBe(5);
    expect(c.cspWindowSec).toBe(900);
    expect(c.cspBurst).toBe(50);
    expect(cspViolations(snap({ csp: csp({ start: B, counts: [row("https://evil.example", 4)], overflow: 0 }) }), c)).toEqual([]);
    expect(ks(cspViolations(snap({ csp: csp({ start: B, counts: [row("https://evil.example", 3)], overflow: 0 }, { start: B - 300, counts: [row("https://evil.example", 2)], overflow: 0 }) }), c))).toEqual([
      ["csp_violations:https://evil.example", "warning"],
    ]);
    const burst = cspViolations(snap({ csp: csp({ start: B, counts: [row("https://evil.example", 49), row("https://evil.example", 1, "connect-src", "/dashboard/"), row("inline", 6)], overflow: 0 }) }), c);
    expect(ks(burst)).toEqual([
      ["csp_violations:https://evil.example", "critical"],
      ["csp_violations:inline", "warning"],
    ]);
    expect(burst[0]!.summary).toContain("50 violations blocking https://evil.example in 15m");
    expect(burst[0]!.summary).toContain("script-src-elem ×49, connect-src ×1");
    expect(burst[0]!.summary).toContain("/app/ ×49, /dashboard/ ×1");
  });

  test("buckets outside the window do not count", () => {
    const old = B - 900 - 300; // ended before now - 15 min
    expect(cspViolations(snap({ csp: csp({ start: old, counts: [row("https://evil.example", 40)], overflow: 0 }) }), rules())).toEqual([]);
  });

  test("browser-extension schemes and ALERT_CSP_IGNORE (Framer's blocked editing bar by default) never alert", () => {
    const c = rules();
    expect(c.cspIgnore).toEqual(["https://framer.com"]);
    for (const x of ["chrome-extension:", "moz-extension:", "safari-web-extension:", "webkit-masked-url:", "https://framer.com"]) expect(cspIgnored(x, c)).toBe(true);
    for (const x of ["https://evil.example", "inline", "data:", "eval"]) expect(cspIgnored(x, c)).toBe(false);
    const noisy = csp({ start: B, counts: [row("chrome-extension:", 500), row("moz-extension:", 80), row("https://framer.com", 900, "script-src-elem", "/")], overflow: 0 });
    expect(cspViolations(snap({ csp: noisy }), c)).toEqual([]);
    const custom = { ...c, cspIgnore: ["https://translate.googleapis.com"] };
    expect(ks(cspViolations(snap({ csp: noisy }), custom))).toEqual([["csp_violations:https://framer.com", "critical"]]);
  });

  test("an overflowing bucket (a flood of distinct reports) alerts on its own", () => {
    const out = cspViolations(snap({ csp: csp({ start: B, counts: [], overflow: 60 }) }), rules());
    expect(ks(out)).toEqual([["csp_violations:(too many distinct reports)", "critical"]]);
  });

  test("not read (Redis failed, no port): quiet; env thresholds apply", () => {
    expect(cspViolations(snap(), rules())).toEqual([]);
    const c = loadConfig({ NETWORK: "mainnet", ALERT_CSP_VIOLATIONS: "2", ALERT_CSP_WINDOW_MINUTES: "30", ALERT_CSP_BURST: "1", ALERT_CSP_IGNORE: "https://Framer.com, inline" }).rules;
    expect([c.cspViolations, c.cspWindowSec, c.cspBurst, c.cspIgnore]).toEqual([2, 1800, 2, ["https://framer.com", "inline"]]);
  });
});

describe("CSP buckets in the collector", () => {
  test("bucket starts cover the window; parse skips malformed fields and keeps the overflow", () => {
    expect(cspBucketStarts(NOW, 900)).toEqual([B - 900, B - 600, B - 300, B]);
    expect(parseCspBucket(B, { "https://evil.example|script-src|/": "3", bad: "4", "a|b|c": "x", [CSP_REPORT_OVERFLOW_FIELD]: "7" })).toEqual({
      start: B,
      counts: [{ blocked: "https://evil.example", directive: "script-src", path: "/", count: 3 }],
      overflow: 7,
    });
  });

  test("collect reads the namespaced bucket keys with HGETALL", async () => {
    const asked: string[] = [];
    const kv = {
      get: async () => null,
      mget: async (k: string[]) => k.map(() => null),
      hgetall: async (k: string): Promise<Record<string, string>> => {
        asked.push(k);
        return k === KEYS.cspReports(B) ? { "inline|script-src|/": "9" } : {};
      },
    };
    const db = { books: async () => [], latestMarkPeriodEnds: async () => [], killsSince: async () => [], cursors: async () => [] };
    const chain = { head: async () => ({ number: 1, timestamp: 1 }), balance: async () => 0n, buybackPending: async () => null, markInterval: async () => null };
    const settings = { network: "testnet", chainId: 46630, apiUrl: "http://x", markIntervalSec: 3600, roles: [], rpcWindowSec: 900, cspWindowSec: 900 };
    const fetch = (async () => new Response("{}")) as unknown as typeof globalThis.fetch;
    const { snapshot } = await collect({ db, kv, chain, fetch, now: () => NOW }, settings, emptyMemory(), 86_400);
    expect(asked).toEqual(cspBucketStarts(NOW, 900).map((b) => KEYS.cspReports(b)));
    expect(snapshot.csp!.buckets.at(-1)).toEqual({ start: B, counts: [{ blocked: "inline", directive: "script-src", path: "/", count: 9 }], overflow: 0 });
    expect(ks(evaluate(snapshot, rules()).filter((c) => c.rule === "csp_violations"))).toEqual([["csp_violations:inline", "warning"]]);
  });
});

const site = (o: Partial<SiteFilesSnap> = {}): SiteFilesSnap => ({
  status: "ok",
  manifestPath: "/usr/local/lib/bookrunner-deploy/site-manifest.json",
  root: "/var/www/bookrunner",
  commit: "bbbf520",
  generatedAt: "2026-11-13T00:00:00.000Z",
  added: [],
  removed: [],
  modified: [],
  checkedAt: NOW,
  ...o,
});

describe("site_files_changed / site_manifest_missing", () => {
  test("a clean tree is quiet; not configured is quiet", () => {
    expect(siteFiles(snap({ siteFiles: site() }), rules())).toEqual([]);
    expect(siteFiles(snap(), rules())).toEqual([]);
  });

  test("any added, removed or modified file is critical, naming the paths (capped)", () => {
    const out = siteFiles(snap({ siteFiles: site({ modified: ["app/index.html"], added: ["evil.js"], removed: ["status/index.html"] }) }), rules());
    expect(ks(out)).toEqual([["site_files_changed", "critical"]]);
    expect(out[0]!.forSec).toBe(120);
    expect(out[0]!.summary).toContain("3 files changed since the deploy of bbbf520");
    expect(out[0]!.summary).toContain("modified app/index.html; added evil.js; removed status/index.html");
    const many = siteFiles(snap({ siteFiles: site({ added: Array.from({ length: 12 }, (_, i) => `x${i}.js`) }) }), rules());
    expect(many[0]!.summary).toContain("; and 4 more");
  });

  test("missing / invalid manifest, missing web root, failing comparison: warning", () => {
    for (const s of [site({ status: "missing" }), site({ status: "invalid" }), site({ status: "no_root" }), site({ error: "EACCES" })]) {
      const out = siteFiles(snap({ siteFiles: s }), rules());
      expect(ks(out)).toEqual([["site_manifest_missing", "warning"]]);
    }
  });

  test("on for testnet / mainnet by default (the deploy paths), off on devnet and for ALERT_SITE_EXPECTED=0", () => {
    expect(loadConfig({ NETWORK: "mainnet" }).site).toEqual({ root: "/var/www/bookrunner", manifestPath: "/usr/local/lib/bookrunner-deploy/site-manifest.json", everySec: 300 });
    expect(loadConfig({ NETWORK: "devnet" }).site).toBeNull();
    expect(loadConfig({ NETWORK: "testnet", ALERT_SITE_EXPECTED: "0" }).site).toBeNull();
  });
});

describe("SiteFilesChecker", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function setup() {
    const d = mkdtempSync(join(tmpdir(), "bkrn-alerts-site-"));
    dirs.push(d);
    const root = join(d, "www");
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<p>site</p>");
    writeFileSync(join(root, "app/index.html"), "<p>app</p>");
    const manifestPath = join(d, "site-manifest.json");
    let now = NOW;
    const checker = new SiteFilesChecker({ root, manifestPath, everyMs: 300_000, now: () => now });
    return { root, manifestPath, checker, tick: (ms: number) => (now += ms), deploy: () => writeFileSync(manifestPath, JSON.stringify(buildSiteManifest(root, { commit: "abc1234" }))) };
  }

  test("missing manifest, then clean after a deploy; a clean tree is not re-hashed before the interval", () => {
    const t = setup();
    expect(t.checker.check().status).toBe("missing");
    t.deploy();
    t.tick(60_000);
    const first = t.checker.check(); // dirty last time: checked again at once
    expect([first.status, first.commit, first.added, first.modified, first.removed]).toEqual(["ok", "abc1234", [], [], []]);
    expect(t.checker.hashedLastCheck).toBe(2);
    writeFileSync(join(t.root, "index.html"), "<p>defaced</p>");
    t.tick(60_000);
    expect(t.checker.check().modified).toEqual([]); // clean result cached for 5 minutes
    t.tick(300_000);
    const later = t.checker.check();
    expect(later.modified).toEqual(["index.html"]);
    expect(t.checker.hashedLastCheck).toBe(1); // only the changed file was re-hashed
    expect(ks(siteFiles(snap({ siteFiles: later }), rules()))).toEqual([["site_files_changed", "critical"]]);
  });

  test("a dirty result is re-checked every pass, so a deploy's new manifest clears it", () => {
    const t = setup();
    t.deploy();
    writeFileSync(join(t.root, "new.js"), "x");
    expect(t.checker.check().added).toEqual(["new.js"]);
    t.deploy(); // update.sh writes the manifest of the new tree
    t.tick(60_000);
    expect(t.checker.check().added).toEqual([]);
  });

  test("an unreadable manifest and a missing web root are reported", () => {
    const t = setup();
    writeFileSync(t.manifestPath, "{not json");
    expect(t.checker.check().status).toBe("invalid");
    rmSync(t.root, { recursive: true, force: true });
    t.tick(60_000);
    expect(t.checker.check().status).toBe("no_root");
  });
});
