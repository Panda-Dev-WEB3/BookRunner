import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { config } from "../lib/config";
import { isMissingProcedure } from "../lib/errors";
import { untypedClient } from "./trpc";

export interface Health {
  ok: boolean;
  chainId: number | null;
  deployment: boolean;
  db?: string;
  redis?: string;
  /** tRPC procedure paths the API serves (null: an older API that does not list them). */
  procedures: string[] | null;
}

/** GET /health of the API (chain id, deployment presence). Polls; never throws into the UI. */
export function useHealth() {
  return useQuery({
    queryKey: ["api-health"],
    queryFn: async (): Promise<Health> => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4_000);
      try {
        const r = await fetch(`${config.apiUrl}/health`, { signal: ctl.signal });
        const j = (await r.json()) as Record<string, unknown>;
        return {
          ok: r.ok && j.ok === true,
          chainId: typeof j.chainId === "number" ? j.chainId : null,
          deployment: j.deployment === true,
          db: typeof j.db === "string" ? j.db : undefined,
          redis: typeof j.redis === "string" ? j.redis : undefined,
          procedures: Array.isArray(j.procedures) ? j.procedures.filter((p): p is string => typeof p === "string") : null,
        };
      } finally {
        clearTimeout(t);
      }
    },
    refetchInterval: 10_000,
    retry: false,
  });
}

export interface Optional<T> {
  supported: boolean;
  data: T;
}

/**
 * Query a procedure that this API version may not expose yet (e.g. book.fills). A missing procedure
 * resolves to {supported: false} and stops polling; other errors surface normally.
 */
/** Procedures this API answered "no procedure found" for (asked once per page load, not per mount). */
const missingProcedures = new Set<string>();

/** The API lists its procedures and `path` is not one of them (null: unknown, probe it). */
export const procedureListed = (procedures: string[] | null | undefined, path: string): boolean | null => (procedures ? procedures.includes(path) : null);

export function useOptional<T>(path: string, input: unknown, parse: (raw: unknown) => T, opts: { refetchInterval?: number; enabled?: boolean } = {}) {
  const health = useHealth();
  // wait for /health (or its failure): when it lists the procedures, an absent one is never requested
  const healthSettled = health.data !== undefined || health.isError;
  const listed = procedureListed(health.data?.procedures, path);
  return useQuery({
    queryKey: ["optional", path, input, listed],
    enabled: (opts.enabled ?? true) && healthSettled,
    queryFn: async (): Promise<Optional<T>> => {
      if (listed === false || missingProcedures.has(path)) return { supported: false, data: parse([]) };
      try {
        return { supported: true, data: parse(await untypedClient.query(path, input)) };
      } catch (e) {
        if (isMissingProcedure(e)) {
          missingProcedures.add(path);
          return { supported: false, data: parse([]) };
        }
        throw e;
      }
    },
    refetchInterval: (q) => (q.state.data?.supported === false ? false : opts.refetchInterval),
  });
}

interface ErrorSource {
  data: unknown;
  error: unknown;
  failureReason?: unknown;
}

/**
 * The query's error, kept until data arrives. TanStack Query v5 resets a data-less query to
 * "pending" (error cleared) on every refetch, so with polling an unreachable API would otherwise
 * flash between skeleton and error forever; this keeps the error state steady while it retries.
 */
export function useQueryError(q: ErrorSource): unknown {
  const last = useRef<unknown>(null);
  const now = q.error ?? q.failureReason ?? null;
  if (q.data !== undefined) last.current = null;
  else if (now) last.current = now;
  return q.data !== undefined ? q.error ?? null : last.current;
}

/** Ticks every `ms` so ages ("12s ago") re-render without refetching. */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
