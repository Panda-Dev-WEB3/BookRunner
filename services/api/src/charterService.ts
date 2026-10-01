// HTTP client for services/charter draft validation (CHARTER_URL). The response contract is
// VERIFY against services/charter; it is parsed tolerantly:
//   { reasons: string[] | {code, field?, message?}[] } | { reason: string } | { ok|valid: boolean, ... }
// Any transport error or unexpected shape yields null, and the API falls back to local validation.
import type { Logger } from "@bookrunner/shared";
import type { CharterServiceClient } from "./deps";
import type { CharterDraftInput, CharterIssue } from "./domain/charter";

export function parseCharterServiceReply(body: unknown): CharterIssue[] | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const toIssue = (r: unknown): CharterIssue | null => {
    if (typeof r === "string") return r ? { code: r, field: null, message: r, source: "charter-service" } : null;
    if (r && typeof r === "object") {
      const x = r as Record<string, unknown>;
      const code = typeof x.code === "string" ? x.code : typeof x.reason === "string" ? x.reason : null;
      if (!code) return null;
      return {
        code,
        field: typeof x.field === "string" ? x.field : typeof x.path === "string" ? x.path : null,
        message: typeof x.message === "string" ? x.message : code,
        source: "charter-service",
      };
    }
    return null;
  };
  const list = Array.isArray(o.reasons) ? o.reasons : Array.isArray(o.issues) ? o.issues : Array.isArray(o.errors) ? o.errors : null;
  if (list) return list.map(toIssue).filter((x): x is CharterIssue => x !== null);
  if (typeof o.reason === "string") return o.reason && o.reason !== "OK" ? [toIssue(o.reason) as CharterIssue] : [];
  const flag = typeof o.ok === "boolean" ? o.ok : typeof o.valid === "boolean" ? o.valid : null;
  if (flag === true) return [];
  return null;
}

export class HttpCharterServiceClient implements CharterServiceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly path: string,
    private readonly log: Logger,
    private readonly timeoutMs = 3000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async validate(draft: CharterDraftInput): Promise<CharterIssue[] | null> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${this.path}`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      // 4xx with a structured body still carries validation reasons.
      const parsed = parseCharterServiceReply(body);
      if (parsed === null) this.log.warn({ url, status: res.status }, "charter service reply not understood; using local validation");
      return parsed;
    } catch (err) {
      this.log.warn({ err, url }, "charter service unreachable; using local validation");
      return null;
    }
  }
}
