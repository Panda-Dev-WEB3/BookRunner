// Turns API / wallet failures into friendly, actionable messages. Duck-typed so it works on
// TRPCClientError, viem errors and plain fetch failures alike (and is unit-testable without them).

export type ErrorKind =
  | "offline"
  | "not_found"
  | "unsupported"
  | "precondition"
  | "bad_request"
  | "forbidden"
  | "conflict"
  | "unavailable"
  | "rejected"
  | "unknown";

export interface FriendlyError {
  kind: ErrorKind;
  title: string;
  message: string;
}

interface ErrLike {
  message?: unknown;
  shortMessage?: unknown;
  name?: unknown;
  data?: { code?: unknown; httpStatus?: unknown } | null;
  cause?: unknown;
  code?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function errorCode(e: unknown): string | null {
  const o = (e ?? {}) as ErrLike;
  const c = o.data && typeof o.data === "object" ? o.data.code : undefined;
  return typeof c === "string" ? c : null;
}

/** True when the procedure does not exist on this API version (optional endpoints). */
export function isMissingProcedure(e: unknown): boolean {
  const o = (e ?? {}) as ErrLike;
  return errorCode(e) === "NOT_FOUND" && /no procedure found/i.test(str(o.message));
}

function isNetwork(e: unknown): boolean {
  const o = (e ?? {}) as ErrLike;
  const msg = `${str(o.message)} ${str((o.cause as ErrLike | undefined)?.message)}`;
  return !errorCode(e) && /failed to fetch|networkerror|load failed|fetch failed|ECONNREFUSED|network request failed/i.test(msg);
}

export function describeError(e: unknown): FriendlyError {
  const o = (e ?? {}) as ErrLike;
  const message = str(o.shortMessage) || str(o.message) || "Unexpected error";
  if (isNetwork(e)) {
    return {
      kind: "offline",
      title: "API unreachable",
      message:
        "The Bookrunner API did not answer. Start it with `bun run --cwd services/api start`; if it is running, check that it allows this page's origin (WEB_ORIGIN). This view retries automatically.",
    };
  }
  if (/user rejected|user denied|rejected the request/i.test(message) || o.code === 4001) {
    return { kind: "rejected", title: "Signature declined", message: "The wallet declined the request. Nothing was sent." };
  }
  if (isMissingProcedure(e)) {
    return { kind: "unsupported", title: "Not exposed by this API", message: "This API version does not serve this data yet." };
  }
  switch (errorCode(e)) {
    case "NOT_FOUND":
      return { kind: "not_found", title: "Not found", message };
    case "PRECONDITION_FAILED":
      return { kind: "precondition", title: "Not possible right now", message };
    case "BAD_REQUEST":
      return { kind: "bad_request", title: "Check the inputs", message };
    case "FORBIDDEN":
      return { kind: "forbidden", title: "Not permitted", message };
    case "CONFLICT":
      return { kind: "conflict", title: "Already done", message };
    case "SERVICE_UNAVAILABLE":
      return { kind: "unavailable", title: "Chain read failed", message };
    default:
      return { kind: "unknown", title: "Something went wrong", message };
  }
}
