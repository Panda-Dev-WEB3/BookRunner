import pino from "pino";

/**
 * Provider API keys inside URLs anywhere in a log line (viem errors quote the request URL, e.g. Alchemy
 * `/v2/<key>`; query keys `?apikey=` / `key=` / `token=`): masked before the line is written.
 */
export function maskSecrets(line: string): string {
  return line
    .replace(/(\/v[23]\/)[A-Za-z0-9_-]{16,}/g, "$1<redacted>")
    .replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token)=)[^&"\s\\]+/gi, "$1<redacted>");
}

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info") {
  return pino({
    name: service,
    level,
    base: { service },
    serializers: { err: pino.stdSerializers.err },
    formatters: { level: (label) => ({ level: label }) },
    hooks: { streamWrite: maskSecrets },
  });
}

export type Logger = ReturnType<typeof createLogger>;

/** JSON.stringify replacer that renders bigint as decimal strings. */
export const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
