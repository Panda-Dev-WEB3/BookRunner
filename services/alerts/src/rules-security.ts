// Site security alerts (2026-11 site security pack). Pure Snapshot -> Conditions, registered in rules.ts RULES.
//
// - csp_violations:<blocked origin> — browsers reported at least ALERT_CSP_VIOLATIONS (5) Content-Security-Policy
//   violations for one blocked origin within ALERT_CSP_WINDOW_MINUTES (15): WARNING; CRITICAL at ALERT_CSP_BURST (50).
//   A blocked script / connection on the pages that build wallet transactions is what an injection attempt looks like
//   from the browser. Ignored: browser-extension and browser-internal schemes (a wallet extension injecting its own
//   script into every page is the usual noise; services/api attributes an inline violation whose source file is an
//   extension to that extension), and ALERT_CSP_IGNORE (default https://framer.com: Framer's on-page editing bar, which
//   the policy blocks on purpose on every Framer page view).
// - site_files_changed — a file under the web root was added, removed or modified since the last deploy's manifest
//   (deploy/server update.sh): CRITICAL after 2 minutes (a deploy writes the new manifest seconds after its publish).
// - site_manifest_missing — no manifest to compare with (never deployed with this version, the file was removed,
//   unreadable), the web root is missing, or the comparison keeps failing: WARNING after 5 minutes.
import { CSP_REPORT_BUCKET_SEC } from "@bookrunner/shared/cspReports";
import type { RuleConfig } from "./config";
import type { Condition, Snapshot } from "./types";

/** Schemes of browser extensions and of browser-internal pages: never the site's own resources. */
export const CSP_NOISE_SCHEMES = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-extension:",
  "safari-web-extension:",
  "ms-browser-extension:",
  "webkit-masked-url:", // Safari's stand-in for an extension's URL
  "chromenull:",
  "chromeinvoke:",
  "chromeinvokeimmediate:",
  "mxaddon-pkg:",
  "jar:",
  "file:",
  "ucjsbridge:",
  "webviewprogressproxy:",
  "symres:",
  "mbinit:",
]);

export function cspIgnored(blocked: string, c: Pick<RuleConfig, "cspIgnore">): boolean {
  return CSP_NOISE_SCHEMES.has(blocked) || c.cspIgnore.includes(blocked);
}

const OVERFLOW = "(too many distinct reports)";
const top = (m: Map<string, number>, n = 3) =>
  [...m]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k, v]) => `${k} ×${v}`)
    .join(", ");

export function cspViolations(s: Snapshot, c: RuleConfig): Condition[] {
  if (!s.csp) return [];
  const from = s.now / 1000 - c.cspWindowSec;
  const per = new Map<string, { count: number; directives: Map<string, number>; paths: Map<string, number> }>();
  const add = (origin: string, n: number, directive: string | null, path: string | null) => {
    const e = per.get(origin) ?? { count: 0, directives: new Map(), paths: new Map() };
    per.set(origin, e);
    e.count += n;
    if (directive) e.directives.set(directive, (e.directives.get(directive) ?? 0) + n);
    if (path) e.paths.set(path, (e.paths.get(path) ?? 0) + n);
  };
  for (const b of s.csp.buckets) {
    if (b.start + CSP_REPORT_BUCKET_SEC <= from || b.start > s.now / 1000) continue; // bucket outside the window
    for (const x of b.counts) if (!cspIgnored(x.blocked, c)) add(x.blocked, x.count, x.directive, x.path);
    if (b.overflow > 0) add(OVERFLOW, b.overflow, null, null);
  }
  const mins = Math.round(c.cspWindowSec / 60);
  const out: Condition[] = [];
  for (const [origin, e] of [...per].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (e.count < c.cspViolations) continue;
    const burst = e.count >= c.cspBurst;
    out.push({
      key: `csp_violations:${origin}`,
      rule: "csp_violations",
      severity: burst ? "critical" : "warning",
      summary:
        origin === OVERFLOW
          ? `CSP: ${e.count} violation reports beyond the per-bucket cap of distinct entries in ${mins}m: a flood of fake reports or an injection hitting many pages; check the nginx access log for /csp-report`
          : `CSP: ${e.count} violations blocking ${origin} in ${mins}m${burst ? ` (burst: ${c.cspBurst}+)` : ""}; directives: ${top(e.directives)}; pages: ${top(e.paths)}. A page tried to load or send to a host the policy refuses: check those pages for injected script (deploy/server HARDENING.md CSP notes); add the origin to ALERT_CSP_IGNORE only if it is known browser noise`,
    });
  }
  return out;
}

const MAX_PATHS = 8;
function listPaths(f: { added: string[]; removed: string[]; modified: string[] }): string {
  const all = [...f.modified.map((p) => `modified ${p}`), ...f.added.map((p) => `added ${p}`), ...f.removed.map((p) => `removed ${p}`)];
  return all.slice(0, MAX_PATHS).join("; ") + (all.length > MAX_PATHS ? `; and ${all.length - MAX_PATHS} more` : "");
}

export function siteFiles(s: Snapshot, _c: RuleConfig): Condition[] {
  const f = s.siteFiles;
  if (!f) return [];
  if (f.status === "ok" && !f.error) {
    const n = f.added.length + f.removed.length + f.modified.length;
    if (n === 0) return [];
    return [
      {
        key: "site_files_changed",
        rule: "site_files_changed",
        severity: "critical",
        forSec: 120,
        summary: `web root ${f.root}: ${n} file${n === 1 ? "" : "s"} changed since the deploy of ${f.commit ?? "?"} (${f.generatedAt ?? "?"}): ${listPaths(f)}. Nothing but update.sh should write there: compare with the build, check who wrote them, and re-run update.sh --web-only to restore the published files`,
      },
    ];
  }
  const why =
    f.status === "missing"
      ? `no manifest at ${f.manifestPath} (written by update.sh after each publish: run sudo /usr/local/lib/bookrunner-deploy/update.sh --web-only)`
      : f.status === "invalid"
        ? `the manifest ${f.manifestPath} is unreadable or not a manifest${f.error ? ` (${f.error})` : ""}`
        : f.status === "no_root"
          ? `the web root ${f.root} is missing`
          : `the comparison with ${f.manifestPath} fails (${f.error})`;
  return [{ key: "site_manifest_missing", rule: "site_manifest_missing", severity: "warning", forSec: 300, summary: `published-file check unavailable: ${why}; site_files_changed cannot fire` }];
}

export const SECURITY_RULES = {
  csp_violations: cspViolations,
  site_files: siteFiles,
} as const;
