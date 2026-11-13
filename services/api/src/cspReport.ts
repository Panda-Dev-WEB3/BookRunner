// POST /csp-report: Content-Security-Policy violation reports from browsers (nginx `location = /csp-report`, its own
// tight per-IP rate-limit zone and a 16 KB body cap; the CSP names it in report-uri and, through Reporting-Endpoints,
// report-to). Accepts both wire formats:
//   application/csp-report    report-uri: {"csp-report": {"blocked-uri", "effective-directive", "document-uri", ...}}
//   application/reports+json  report-to:  [{"type": "csp-violation", "body": {"blockedURL", "effectiveDirective", "documentURL", ...}}]
// Keeps three sanitized fields per report and counts them PER REQUEST in Redis (each distinct field of a request once, at
// most 3 per request, at most 50 blocked origins per bucket; KEYS.cspReports, 5-minute buckets, TTL 2 h;
// @bookrunner/shared/cspReports): the blocked resource's origin (scheme or CSP keyword when it has none), the directive's
// name, the document's path. Never a query string, a fragment, an IP address or a user agent; the raw report is
// neither stored nor logged. services/alerts raises csp_violations from the counts.
import {
  CSP_REPORT_FIELDS_PER_REQUEST,
  CSP_REPORT_MAX_FIELDS,
  CSP_REPORT_MAX_ORIGINS,
  CSP_REPORT_OVERFLOW_FIELD,
  CSP_REPORT_TTL_SEC,
  type CspViolation,
  cspBucket,
  cspField,
  cspOriginsKey,
} from "@bookrunner/shared/cspReports";

export const CSP_REPORT_MAX_BYTES = 16 * 1024;
export const CSP_REPORT_TYPES = ["application/csp-report", "application/reports+json"] as const;
/** Reports parsed from one request (a report-to batch); the rest are dropped. Counting is per request (requestFields). */
export const CSP_REPORT_MAX_PER_REQUEST = 20;

/** CSP source keywords a browser puts in place of a URL (report-uri `blocked-uri`, report-to `blockedURL`). */
const KEYWORDS = new Set(["inline", "eval", "wasm-eval", "trusted-types-policy", "trusted-types-sink", "self", "data", "blob", "about", "empty"]);
/** Schemes of browser extensions: a violation whose source file is one of them is attributed to the extension. */
export const EXTENSION_SCHEMES = new Set(["chrome-extension:", "moz-extension:", "safari-extension:", "safari-web-extension:", "ms-browser-extension:", "webkit-masked-url:"]);
const WEB_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const MAX_LEN = 120;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const clamp = (s: string, allowed: RegExp): string => s.slice(0, MAX_LEN).replace(allowed, "_");

/**
 * The blocked resource as an origin (`https://cdn.example`), a scheme (`chrome-extension:`, `data:`) or a CSP keyword
 * (`inline`, `eval`). Path, query and fragment are dropped. "other" when unreadable.
 */
export function blockedOrigin(raw: unknown): string {
  const s = str(raw).toLowerCase();
  if (!s) return "other";
  if (KEYWORDS.has(s)) return s;
  let out: string;
  try {
    const u = new URL(s);
    out = WEB_SCHEMES.has(u.protocol) ? u.origin : u.protocol;
  } catch {
    // Firefox and Safari report some sources as a bare scheme ("moz-extension", "data")
    const scheme = /^([a-z][a-z0-9+.-]{0,30}):?$/.exec(s)?.[1];
    out = scheme ? `${scheme}:` : "other";
  }
  return clamp(out, /[^a-z0-9.:/[\]_-]/g) || "other";
}

/** A directive's name (`script-src-elem`), never its source list; "other" when unreadable. */
export function directiveName(raw: unknown): string {
  const first = str(raw).toLowerCase().split(/\s+/)[0] ?? "";
  return /^[a-z][a-z-]{1,39}$/.test(first) ? first : "other";
}

/** The path of the page (`/app/books/1`), without query or fragment; "/" when unreadable. */
export function documentPath(raw: unknown): string {
  const s = str(raw);
  let path = "";
  try {
    path = new URL(s).pathname;
  } catch {
    if (s.startsWith("/")) path = s.split(/[?#]/)[0]!;
  }
  if (!path.startsWith("/")) return "/";
  return clamp(path, /[^A-Za-z0-9._~/%-]/g);
}

function sanitize(r: Record<string, unknown>, blockedKey: string, directiveKeys: string[], docKey: string, sourceKey: string): CspViolation {
  const source = blockedOrigin(r[sourceKey]);
  const directive = directiveName(directiveKeys.map((k) => r[k]).find((v) => str(v)) ?? "");
  return {
    // an extension's own script tripping the policy (e.g. a wallet injecting an inline script): report it as the extension
    blocked: EXTENSION_SCHEMES.has(source) ? source : blockedOrigin(r[blockedKey]),
    directive,
    path: documentPath(r[docKey]),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The sanitized violations of one request body; null when the body is not a report of its content type. */
export function parseCspReports(contentType: string, body: string): CspViolation[] | null {
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    return null;
  }
  if (contentType === "application/csp-report") {
    const r = isObj(o) ? o["csp-report"] : null;
    if (!isObj(r)) return null;
    return [sanitize(r, "blocked-uri", ["effective-directive", "violated-directive"], "document-uri", "source-file")];
  }
  if (!Array.isArray(o)) return null;
  return o
    .filter((x): x is Record<string, unknown> => isObj(x) && x.type === "csp-violation" && isObj(x.body))
    .slice(0, CSP_REPORT_MAX_PER_REQUEST)
    .map((x) => sanitize(x.body as Record<string, unknown>, "blockedURL", ["effectiveDirective", "violatedDirective"], "documentURL", "sourceFile"));
}

/** Where the counts go (Redis in production, memory in tests). One call per request. */
export interface CspReportSink {
  record(violations: CspViolation[], nowMs: number): Promise<void>;
}

/**
 * The fields one request counts: its distinct fields, at most CSP_REPORT_FIELDS_PER_REQUEST of them (in report order).
 * Counts are per request (review I-1): a report-to batch of 20 identical or varied reports weighs what one report does.
 */
export function requestFields(violations: CspViolation[]): string[] {
  return [...new Set(violations.map(cspField))].slice(0, CSP_REPORT_FIELDS_PER_REQUEST);
}

/** Structural subset of an ioredis client (EVAL), keeping the tests free of Redis. */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * One atomic step per request. KEYS: the bucket's hash, its origin set. ARGV: ttl, max fields, overflow field, max
 * origins, fields... Each field is counted once (HINCRBY 1) when its origin is already in the set or the set holds
 * fewer than `max origins` (then added), and the field already exists or the hash holds fewer than `max fields`;
 * otherwise the request counts once under the overflow field. A flood of distinct origins or paths cannot grow either
 * key without bound. Both keys expire with the bucket.
 */
export const CSP_COUNT_SCRIPT = `local ttl = tonumber(ARGV[1])
local maxFields = tonumber(ARGV[2])
local maxOrigins = tonumber(ARGV[4])
local overflow = false
for i = 5, #ARGV do
  local f = ARGV[i]
  local origin = string.match(f, '^[^|]+')
  local knownOrigin = redis.call('SISMEMBER', KEYS[2], origin) == 1
  if (knownOrigin or redis.call('SCARD', KEYS[2]) < maxOrigins) and (redis.call('HEXISTS', KEYS[1], f) == 1 or redis.call('HLEN', KEYS[1]) < maxFields) then
    if not knownOrigin then redis.call('SADD', KEYS[2], origin) end
    redis.call('HINCRBY', KEYS[1], f, 1)
  else
    overflow = true
  end
end
if overflow then redis.call('HINCRBY', KEYS[1], ARGV[3], 1) end
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
return 1`;

export class RedisCspReportSink implements CspReportSink {
  constructor(
    private readonly redis: RedisEval,
    private readonly key: (bucketStartSec: number) => string,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  async record(violations: CspViolation[], nowMs: number): Promise<void> {
    const fields = requestFields(violations);
    if (fields.length === 0) return;
    const key = this.key(cspBucket(nowMs));
    try {
      await this.redis.eval(CSP_COUNT_SCRIPT, 2, key, cspOriginsKey(key), CSP_REPORT_TTL_SEC, CSP_REPORT_MAX_FIELDS, CSP_REPORT_OVERFLOW_FIELD, CSP_REPORT_MAX_ORIGINS, ...fields);
    } catch (err) {
      this.onError(err);
    }
  }
}

/** In-memory sink (tests; an API without Redis). Same rules as the Redis script. */
export class MemoryCspReportSink implements CspReportSink {
  readonly buckets = new Map<number, Map<string, number>>();
  readonly origins = new Map<number, Set<string>>();
  async record(violations: CspViolation[], nowMs: number): Promise<void> {
    const fields = requestFields(violations);
    if (fields.length === 0) return;
    const b = cspBucket(nowMs);
    const h = this.buckets.get(b) ?? new Map<string, number>();
    const o = this.origins.get(b) ?? new Set<string>();
    this.buckets.set(b, h);
    this.origins.set(b, o);
    let overflow = false;
    for (const f of fields) {
      const origin = f.split("|")[0]!;
      if ((o.has(origin) || o.size < CSP_REPORT_MAX_ORIGINS) && (h.has(f) || h.size < CSP_REPORT_MAX_FIELDS)) {
        o.add(origin);
        h.set(f, (h.get(f) ?? 0) + 1);
      } else overflow = true;
    }
    if (overflow) h.set(CSP_REPORT_OVERFLOW_FIELD, (h.get(CSP_REPORT_OVERFLOW_FIELD) ?? 0) + 1);
  }
}

/** Reads a request body, refusing more than `max` bytes whatever Content-Length says. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The route: 204 when counted, 413 / 415 / 400 otherwise (browsers ignore the answer). */
export async function handleCspReport(req: Request, sink: CspReportSink | null | undefined, nowMs: number): Promise<Response> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(CSP_REPORT_TYPES as readonly string[]).includes(type)) return new Response(null, { status: 415 });
  const body = await readCapped(req, CSP_REPORT_MAX_BYTES);
  if (body === null) return new Response(null, { status: 413 });
  const violations = parseCspReports(type, body);
  if (violations === null) return new Response(null, { status: 400 });
  await sink?.record(violations, nowMs);
  return new Response(null, { status: 204 });
}
