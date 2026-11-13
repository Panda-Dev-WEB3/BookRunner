// POST /csp-report: Content-Security-Policy violation reports from browsers (nginx `location = /csp-report`, its own
// tight per-IP rate-limit zone and a 16 KB body cap; the CSP names it in report-uri and, through Reporting-Endpoints,
// report-to). Accepts both wire formats:
//   application/csp-report    report-uri: {"csp-report": {"blocked-uri", "effective-directive", "document-uri", ...}}
//   application/reports+json  report-to:  [{"type": "csp-violation", "body": {"blockedURL", "effectiveDirective", "documentURL", ...}}]
// Keeps three sanitized fields per report and counts them in Redis (KEYS.cspReports, 5-minute buckets, TTL 2 h;
// @bookrunner/shared/cspReports): the blocked resource's origin (scheme or CSP keyword when it has none), the directive's
// name, the document's path. Never a query string, a fragment, an IP address or a user agent; the raw report is
// neither stored nor logged. services/alerts raises csp_violations from the counts.
import { CSP_REPORT_MAX_FIELDS, CSP_REPORT_OVERFLOW_FIELD, CSP_REPORT_TTL_SEC, type CspViolation, cspBucket, cspField } from "@bookrunner/shared/cspReports";

export const CSP_REPORT_MAX_BYTES = 16 * 1024;
export const CSP_REPORT_TYPES = ["application/csp-report", "application/reports+json"] as const;
/** Reports kept from one request (a report-to batch); the rest are dropped. */
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

/** Where the counts go (Redis in production, memory in tests). */
export interface CspReportSink {
  record(violations: CspViolation[], nowMs: number): Promise<void>;
}

/** Structural subset of an ioredis client (EVAL), keeping the tests free of Redis. */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * One atomic step per request: HINCRBY each field of the bucket's hash (a NEW field only while the hash holds fewer
 * than CSP_REPORT_MAX_FIELDS, else the overflow field: a flood of distinct paths cannot grow it without bound), then
 * EXPIRE. ARGV: ttl, max fields, overflow field, fields...
 */
export const CSP_COUNT_SCRIPT = `local ttl = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
for i = 4, #ARGV do
  local f = ARGV[i]
  if redis.call('HEXISTS', KEYS[1], f) == 1 or redis.call('HLEN', KEYS[1]) < max then
    redis.call('HINCRBY', KEYS[1], f, 1)
  else
    redis.call('HINCRBY', KEYS[1], ARGV[3], 1)
  end
end
redis.call('EXPIRE', KEYS[1], ttl)
return 1`;

export class RedisCspReportSink implements CspReportSink {
  constructor(
    private readonly redis: RedisEval,
    private readonly key: (bucketStartSec: number) => string,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  async record(violations: CspViolation[], nowMs: number): Promise<void> {
    if (violations.length === 0) return;
    try {
      await this.redis.eval(CSP_COUNT_SCRIPT, 1, this.key(cspBucket(nowMs)), CSP_REPORT_TTL_SEC, CSP_REPORT_MAX_FIELDS, CSP_REPORT_OVERFLOW_FIELD, ...violations.map(cspField));
    } catch (err) {
      this.onError(err);
    }
  }
}

/** In-memory sink (tests; an API without Redis). Same field cap as the Redis script. */
export class MemoryCspReportSink implements CspReportSink {
  readonly buckets = new Map<number, Map<string, number>>();
  async record(violations: CspViolation[], nowMs: number): Promise<void> {
    const b = cspBucket(nowMs);
    const h = this.buckets.get(b) ?? new Map<string, number>();
    this.buckets.set(b, h);
    for (const v of violations) {
      const f = cspField(v);
      const key = h.has(f) || h.size < CSP_REPORT_MAX_FIELDS ? f : CSP_REPORT_OVERFLOW_FIELD;
      h.set(key, (h.get(key) ?? 0) + 1);
    }
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
