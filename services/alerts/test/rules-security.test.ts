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
import { cspIgnored, cspViolations, defang, plain, siteFiles } from "../src/rules-security";
import { MemoryCspReportSink, handleCspReport } from "../../api/src/cspReport";
import { SiteFilesChecker } from "../src/siteFiles";
import type { Condition, CspSnap, SiteFilesSnap } from "../src/types";
import { NOW, rules, snap } from "./fixtures";

const ks = (cs: Condition[]) => cs.map((c) => [c.key, c.severity]);
const B = cspBucket(NOW);
const row = (blocked: string, count: number, directive = "script-src-elem", path = "/app/") => ({ blocked, directive, path, count });
const csp = (...buckets: CspSnap["buckets"]): CspSnap => ({ buckets });

describe("csp_violations", () => {
  test("one warning (never critical) when one origin reaches the threshold; the top 3 origins are named, defanged", () => {
    const c = rules();
    expect([c.cspViolations, c.cspWindowSec]).toEqual([5, 900]);
    expect(cspViolations(snap({ csp: csp({ start: B, counts: [row("https://evil.example", 4), row("inline", 4)], overflow: 0 }) }), c)).toEqual([]);
    expect(ks(cspViolations(snap({ csp: csp({ start: B, counts: [row("https://evil.example", 3)], overflow: 0 }, { start: B - 300, counts: [row("https://evil.example", 2)], overflow: 0 }) }), c))).toEqual([
      ["csp_violations", "warning"],
    ]);
    const many = cspViolations(
      snap({
        csp: csp({
          start: B,
          counts: [row("https://evil.example", 4900), row("https://evil.example", 100, "connect-src", "/dashboard/"), row("inline", 6), row("https://b.example", 3), row("https://c.example", 2)],
          overflow: 0,
        }),
      }),
      c,
    );
    expect(ks(many)).toEqual([["csp_violations", "warning"]]);
    const t = many[0]!.summary;
    expect(t).toContain("blocked origins (requests): https[:]//evil[.]example ×5000, inline ×6, https[:]//b[.]example ×3 and 1 more");
    expect(t).toContain("directives: script-src-elem ×4911, connect-src ×100");
    expect(t).not.toMatch(/https:\/\//); // nothing a chat client turns into a link
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
    expect(ks(cspViolations(snap({ csp: noisy }), custom))).toEqual([["csp_violations", "warning"]]);
  });

  test("requests beyond the per-bucket caps raise the same single warning", () => {
    const out = cspViolations(snap({ csp: csp({ start: B, counts: [], overflow: 60 }) }), rules());
    expect(ks(out)).toEqual([["csp_violations", "warning"]]);
    expect(out[0]!.summary).toContain("60 requests beyond the per-bucket caps");
  });

  test("a forged flood (100 requests x 20 reports, many origins) is ONE warning", async () => {
    const sink = new MemoryCspReportSink();
    const origins = Array.from({ length: 20 }, (_, i) => `https://forged${i}.example/x.js`);
    for (let r = 0; r < 100; r++) {
      const body = JSON.stringify(origins.map((u, i) => ({ type: "csp-violation", body: { blockedURL: u, effectiveDirective: "script-src-elem", documentURL: `https://bookrunner.tech/p${(r * 20 + i) % 700}` } })));
      const req = new Request("http://127.0.0.1:4400/csp-report", { method: "POST", body, headers: { "content-type": "application/reports+json" } });
      expect((await handleCspReport(req, sink, NOW)).status).toBe(204);
    }
    const h = sink.buckets.get(B)!;
    // counted per request: 3 distinct fields at most per request, never more than the 50-origin cap
    expect([...h.values()].reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(100 * 3 + 100);
    expect(sink.origins.get(B)!.size).toBeLessThanOrEqual(50);
    const snapCsp = { buckets: [parseCspBucket(B, Object.fromEntries([...h].map(([k, v]) => [k, String(v)])))] };
    const out = evaluate(snap({ csp: snapCsp }), rules()).filter((x) => x.rule === "csp_violations");
    expect(ks(out)).toEqual([["csp_violations", "warning"]]);
  });

  test("not read (Redis failed, no port): quiet; env thresholds apply", () => {
    expect(cspViolations(snap(), rules())).toEqual([]);
    const c = loadConfig({ NETWORK: "mainnet", ALERT_CSP_VIOLATIONS: "2", ALERT_CSP_WINDOW_MINUTES: "30", ALERT_CSP_IGNORE: "https://Framer.com, inline" }).rules;
    expect([c.cspViolations, c.cspWindowSec, c.cspIgnore]).toEqual([2, 1800, ["https://framer.com", "inline"]]);
  });
});

describe("attacker-chosen text in summaries", () => {
  test("plain: control characters and line breaks neutralised, length capped; defang: no clickable URL", () => {
    expect(plain("a\nRESOLVED: all clear\r\u0000\u2028b")).toBe("a?RESOLVED: all clear???b");
    expect(plain("x".repeat(300)).length).toBe(120);
    expect(defang("https://evil.example:8443")).toBe("https[:]//evil[.]example:8443");
    expect(defang("/evil.com/x")).toBe("/evil[.]com/x");
  });

  test("site_files_changed quotes each file name with its control characters neutralised", () => {
    const out = siteFiles(snap({ siteFiles: site({ added: ["evil.js\n\u2705 RESOLVED site_files_changed"] }) }), rules());
    expect(out[0]!.summary).toContain('added "evil.js?\u2705 RESOLVED site_files_changed"');
    expect(out[0]!.summary).not.toContain("\n");
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
    expect(ks(evaluate(snapshot, rules()).filter((c) => c.rule === "csp_violations"))).toEqual([["csp_violations", "warning"]]);
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
    expect(out[0]!.summary).toContain('modified "app/index.html"; added "evil.js"; removed "status/index.html"');
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
