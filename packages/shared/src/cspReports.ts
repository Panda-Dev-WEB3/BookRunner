// CSP violation reports: browsers POST them to nginx /csp-report (deploy/server nginx-bookrunner-locations.conf),
// services/api counts them in Redis (KEYS.cspReports, one hash per 5-minute bucket) and services/alerts raises
// csp_violations from those counts. Only three sanitized fields are kept per report, joined into the hash field:
// the blocked resource's origin (or scheme / CSP keyword), the violated directive's name and the document's path.
// No query string, no fragment, no IP address, no user agent.

/** Width of one counting bucket (s). */
export const CSP_REPORT_BUCKET_SEC = 300;
/** Bucket hashes expire after this (s): longer than the longest alert window (ALERT_CSP_WINDOW_MINUTES <= 60). */
export const CSP_REPORT_TTL_SEC = 7_200;
/** Distinct (blocked, directive, path) fields per bucket; reports beyond it count under CSP_REPORT_OVERFLOW_FIELD. */
export const CSP_REPORT_MAX_FIELDS = 500;
/** Distinct blocked origins per bucket (a set next to the hash); a field of a new origin beyond it counts as overflow. */
export const CSP_REPORT_MAX_ORIGINS = 50;
export const CSP_REPORT_OVERFLOW_FIELD = "overflow";
/**
 * Counting is per REQUEST, not per report: one report-to request may carry many reports (a forger's or a real
 * batch), so the API counts each distinct field of a request once, and at most CSP_REPORT_FIELDS_PER_REQUEST of them.
 * A field's count is therefore the number of requests that reported it.
 */
export const CSP_REPORT_FIELDS_PER_REQUEST = 3;

/** The origin-set key next to a bucket's hash. */
export const cspOriginsKey = (bucketKey: string): string => `${bucketKey}:origins`;

/** Start (unix s) of the bucket holding `nowMs`. */
export const cspBucket = (nowMs: number): number => Math.floor(nowMs / 1000 / CSP_REPORT_BUCKET_SEC) * CSP_REPORT_BUCKET_SEC;

export interface CspViolation {
  /** origin of the blocked resource (https://host[:port]), its scheme (`chrome-extension:`, `data:`) or a CSP keyword (`inline`, `eval`) */
  blocked: string;
  /** directive name only, e.g. `script-src-elem` */
  directive: string;
  /** path of the page the violation happened on, e.g. `/app/books/1` (no query, no fragment) */
  path: string;
}

/** Separator of the hash field: never part of a sanitized value (cspReport.ts in services/api allows none of `|`). */
const SEP = "|";

export function cspField(v: CspViolation): string {
  return [v.blocked, v.directive, v.path].join(SEP);
}

export function parseCspField(field: string): CspViolation | null {
  const parts = field.split(SEP);
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  return { blocked: parts[0]!, directive: parts[1]!, path: parts[2]! };
}
