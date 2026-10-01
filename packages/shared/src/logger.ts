import pino from "pino";

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info") {
  return pino({
    name: service,
    level,
    base: { service },
    serializers: { err: pino.stdSerializers.err },
    formatters: { level: (label) => ({ level: label }) },
  });
}

export type Logger = ReturnType<typeof createLogger>;

/** JSON.stringify replacer that renders bigint as decimal strings. */
export const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
