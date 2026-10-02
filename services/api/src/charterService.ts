// HTTP client for services/charter draft validation (CHARTER_URL, POST /charters/draft).
//   request : the charter service's draft schema (services/charter/src/domain/draft.ts), built from
//             the API's converted on-chain struct (the two human-unit draft schemas differ:
//             subscriptionWindow vs subscriptionWindowSeconds, 0.01x leverage units, bytes32 forms)
//   200     : { ok, reasons: ReasonCode[], ... }                 -> one issue per reason
//   400     : { error: "invalid_draft", issues: [{path, message}] } -> INVALID_DRAFT issues
//   also tolerated: { reasons: {code, field?, message?}[] } | { reason } | { ok|valid: boolean }
// Transport errors and unexpected shapes yield null (local + on-chain validation still apply); a 404
// is a configuration error (CHARTER_VALIDATE_PATH) and is logged as such.
import type { Logger } from "@bookrunner/shared";
import type { Charter } from "@bookrunner/shared/types";
import type { CharterServiceClient } from "./deps";
import type { CharterDraftInput, CharterIssue } from "./domain/charter";
import { usdStr } from "./format";

/** The converted charter in services/charter's draft schema (raw on-chain forms where it accepts them). */
export function toCharterServiceDraft(c: Charter, meta?: CharterDraftInput["meta"]): Record<string, unknown> {
  return {
    sponsor: c.sponsor,
    underlying: c.underlying,
    venue: c.venue,
    oracle: c.oracle,
    sessions: c.sessions,
    ifTargetUsd: usdStr(c.ifTargetUsd),
    mmInventoryUsd: usdStr(c.mmInventoryUsd),
    mandate: {
      maxInventoryUsd: usdStr(c.mandate.maxInventoryUsd),
      maxSkewBps: c.mandate.maxSkewBps,
      minQuoteWidthBps: c.mandate.minQuoteWidthBps,
      maxHedgeLeverage: c.mandate.maxHedgeLeverage,
      hedgeRatioMinBps: c.mandate.hedgeRatioMinBps,
      hedgeRatioMaxBps: c.mandate.hedgeRatioMaxBps,
      noNewRiskOffHours: c.mandate.noNewRiskOffHours,
      killAtDrawdownBps: c.mandate.killAtDrawdownBps,
      hedgeAllowRoot: c.mandate.hedgeAllowRoot,
    },
    seniorHurdleBps: c.seniorHurdleBps,
    seniorCapBps: c.seniorCapBps,
    subscriptionWindow: c.subscriptionWindow,
    juniorNoticeSeconds: c.juniorNoticeSeconds.toString(),
    perWalletCapUsd: usdStr(c.perWalletCapUsd),
    symbol: c.symbol,
    takerFeeBps: c.takerFeeBps,
    makerFeeBps: c.makerFeeBps,
    ...(meta ? { meta } : {}),
  };
}

export function parseCharterServiceReply(body: unknown): CharterIssue[] | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const toIssue = (r: unknown): CharterIssue | null => {
    if (typeof r === "string") return r ? { code: r, field: null, message: r, source: "charter-service" } : null;
    if (r && typeof r === "object") {
      const x = r as Record<string, unknown>;
      // charter service 400 issues are {path, message} without a code: still a rejection
      const code = typeof x.code === "string" ? x.code : typeof x.reason === "string" ? x.reason : typeof x.message === "string" ? "INVALID_DRAFT" : null;
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

  async validate(draft: CharterDraftInput, charter: Charter): Promise<CharterIssue[] | null> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${this.path}`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toCharterServiceDraft(charter, draft.meta)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        this.log.error({ url }, "charter service has no such route: CHARTER_VALIDATE_PATH is misconfigured (expected /charters/draft); its checks are NOT applied");
        return null;
      }
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
