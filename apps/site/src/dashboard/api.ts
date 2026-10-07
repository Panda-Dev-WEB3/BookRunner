// Minimal tRPC v11 (superjson) client over fetch: GET /trpc/<path>?input=... for queries, POST with
// the serialized input for mutations. Responses are {result:{data:{json,meta}}} or {error:{json}}.
// The URL / body / response helpers are pure (unit-tested); `query` and `mutate` add fetch.
import superjson from "superjson";
import { API_BASE } from "./config";
import type { Health, ProcInput, ProcOutput, ProcPath } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    /** tRPC error code ("NOT_FOUND", "PRECONDITION_FAILED", ...) or null for transport failures. */
    readonly code: string | null,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** GET URL of a query. `undefined` input sends no input parameter. */
export function queryUrl(path: string, input: unknown, base = API_BASE): string {
  const url = `${base}/trpc/${path}`;
  if (input === undefined) return url;
  return `${url}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`;
}

/** POST body of a mutation. */
export function mutationBody(input: unknown): string {
  return JSON.stringify(superjson.serialize(input));
}

interface Envelope {
  result?: { data?: unknown };
  error?: unknown;
}

/** zod's issue list (a JSON array in the message) -> its messages joined; else the message. */
export function readableMessage(message: string): string {
  const m = message.trim();
  if (!m.startsWith("[")) return m;
  try {
    const issues = JSON.parse(m) as unknown;
    if (!Array.isArray(issues)) return m;
    const texts = issues.map((i) => (i && typeof i === "object" && typeof (i as { message?: unknown }).message === "string" ? (i as { message: string }).message : "")).filter(Boolean);
    if (!texts.length) return m;
    const out = [...new Set(texts)].join("; ");
    return out.charAt(0).toUpperCase() + out.slice(1);
  } catch {
    return m;
  }
}

/** Response JSON -> data, or throws ApiError with the server's message and code. */
export function decodeResponse<T>(body: unknown, httpStatus: number): T {
  const env = (body ?? {}) as Envelope;
  if (env.error !== undefined) {
    const raw = env.error as { json?: unknown; meta?: unknown };
    const err = (raw && typeof raw === "object" && "json" in raw ? superjson.deserialize(raw as never) : raw) as {
      message?: unknown;
      data?: { code?: unknown; httpStatus?: unknown };
    };
    const message = typeof err?.message === "string" ? readableMessage(err.message) : `API error (${httpStatus})`;
    const code = typeof err?.data?.code === "string" ? err.data.code : null;
    const status = typeof err?.data?.httpStatus === "number" ? err.data.httpStatus : httpStatus;
    throw new ApiError(message, code, status);
  }
  const data = env.result?.data;
  if (data === undefined) throw new ApiError(`Unexpected API response (${httpStatus})`, null, httpStatus);
  return (data && typeof data === "object" && "json" in data ? superjson.deserialize(data as never) : data) as T;
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError("The BookRunner API did not answer. This view retries automatically.", null, null);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`The BookRunner API answered ${res.status} without JSON.`, null, res.status);
  }
  return decodeResponse<T>(body, res.status);
}

export function query<P extends ProcPath>(path: P, input?: ProcInput<P>): Promise<ProcOutput<P>> {
  return send<ProcOutput<P>>(queryUrl(path, input));
}

export function mutate<P extends ProcPath>(path: P, input: ProcInput<P>): Promise<ProcOutput<P>> {
  return send<ProcOutput<P>>(`${API_BASE}/trpc/${path}`, { method: "POST", body: mutationBody(input) });
}

/** /health -> Health (never throws: an unreachable API is {ok:false}). */
export async function health(): Promise<Health> {
  try {
    const r = await fetch(`${API_BASE}/health`);
    const j = (await r.json()) as Record<string, unknown>;
    return parseHealth(j, r.ok);
  } catch {
    return { ok: false, chainId: null, deployment: false, db: null, redis: null, procedures: null };
  }
}

export function parseHealth(j: Record<string, unknown>, httpOk = true): Health {
  return {
    ok: httpOk && j.ok === true,
    chainId: typeof j.chainId === "number" ? j.chainId : null,
    deployment: j.deployment === true,
    db: typeof j.db === "string" ? j.db : null,
    redis: typeof j.redis === "string" ? j.redis : null,
    procedures: Array.isArray(j.procedures) ? j.procedures.filter((p): p is string => typeof p === "string") : null,
  };
}
