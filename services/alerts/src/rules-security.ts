// Site security alerts (2026-11 site security pack). Pure Snapshot -> Conditions, registered in rules.ts RULES.
//
// - csp_violations — WARNING only, ONE alert (review I-1: reports are unauthenticated, so a forger must never page
//   critical nor fan out into one alert per origin). The API counts REQUESTS (each distinct field of a request once,
//   at most 3 per request, at most 50 origins per bucket), so a field's count is the number of requests that reported
//   it. Fires when one non-ignored blocked origin was reported by at least ALERT_CSP_VIOLATIONS (5) requests within
//   ALERT_CSP_WINDOW_MINUTES (15), or as many requests overflowed the per-bucket caps; the summary names the top 3
//   origins with their counts. A blocked script / connection on the pages that build wallet transactions is what an
//   injection attempt looks like from the browser. Ignored: browser-extension and browser-internal schemes (a wallet
//   extension injecting its own script into every page is the usual noise; services/api attributes an inline
//   violation whose source file is an extension to that extension), and ALERT_CSP_IGNORE (default https://framer.com:
//   Framer's on-page editing bar, which the policy blocks on purpose on every Framer page view).
// - site_files_changed — a file under the web root was added, removed or modified since the last deploy's manifest
//   (deploy/server update.sh): CRITICAL after 2 minutes (a deploy writes the new manifest seconds after its publish).
// - site_manifest_missing — no manifest to compare with (never deployed with this version, the file was removed,
//   unreadable), the web root is missing, or the comparison keeps failing: WARNING after 5 minutes.
import { CSP_REPORT_BUCKET_SEC } from "@bookrunner/shared/cspReports";
import type { RuleConfig } from "./config";
import type { Condition, Snapshot } from "./types";

/**
 * Attacker-chosen text (a reported origin or page, a file name under the web root) as inert plain text for the alert
 * channels: control characters and line breaks become "?" (no fake "RESOLVED" line), length capped. Delivery is plain
 * text (no Telegram parse_mode), so no markup can be injected.
 */
export function plain(s: string, max = 120): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A reported origin or page that chat and mail clients must not turn into a link: `https[:]//evil[.]example`. */
export function defang(s: string): string {
  return plain(s).replace(/:\/\//g, "[:]//").replace(/\./g, "[.]");
}

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

const top = (m: Map<string, number>, n = 3) =>
  [...m]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k, v]) => `${defang(k)} ×${v}`)
    .join(", ");

export function cspViolations(s: Snapshot, c: RuleConfig): Condition[] {
  if (!s.csp) return [];
  const from = s.now / 1000 - c.cspWindowSec;
  const origins = new Map<string, number>();
  const directives = new Map<string, number>();
  const paths = new Map<string, number>();
  let overflow = 0;
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const b of s.csp.buckets) {
    if (b.start + CSP_REPORT_BUCKET_SEC <= from || b.start > s.now / 1000) continue; // bucket outside the window
    for (const x of b.counts) {
      if (cspIgnored(x.blocked, c)) continue;
      bump(origins, x.blocked, x.count);
      bump(directives, x.directive, x.count);
      bump(paths, x.path, x.count);
    }
    overflow += b.overflow;
  }
  const peak = Math.max(0, ...origins.values());
  if (peak < c.cspViolations && overflow < c.cspViolations) return [];
  const mins = Math.round(c.cspWindowSec / 60);
  const parts = [
    origins.size ? `blocked origins (requests): ${top(origins)}${origins.size > 3 ? ` and ${origins.size - 3} more` : ""}` : null,
    origins.size ? `directives: ${top(directives)}` : null,
    origins.size ? `pages: ${top(paths)}` : null,
    overflow ? `${overflow} requests beyond the per-bucket caps of distinct origins / entries (a flood of fake reports, or an injection hitting many pages)` : null,
  ].filter(Boolean);
  return [
    {
      key: "csp_violations",
      rule: "csp_violations",
      severity: "warning",
      summary: `CSP violations in the last ${mins}m: ${parts.join("; ")}. Reports are unauthenticated: confirm in the browser on those pages before acting. A page that tries to load or send to a host the policy refuses may carry injected script (deploy/server HARDENING.md CSP notes); add an origin to ALERT_CSP_IGNORE only if it is known browser noise`,
    },
  ];
}

const MAX_PATHS = 8;
function listPaths(f: { added: string[]; removed: string[]; modified: string[] }): string {
  // file names are attacker-chosen: control characters neutralised, length capped, quoted
  const q = (p: string) => JSON.stringify(plain(p));
  const all = [...f.modified.map((p) => `modified ${q(p)}`), ...f.added.map((p) => `added ${q(p)}`), ...f.removed.map((p) => `removed ${q(p)}`)];
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
        summary: `web root ${plain(f.root)}: ${n} file${n === 1 ? "" : "s"} changed since the deploy of ${f.commit ?? "?"} (${f.generatedAt ?? "?"}): ${listPaths(f)}. Nothing but update.sh should write there: compare with the build, check who wrote them, and re-run update.sh --web-only to restore the published files`,
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
