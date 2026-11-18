import pino from "pino";
import { rpcMeter } from "./rpcMeter";

/**
 * Provider API keys inside URLs anywhere in a log line (viem errors quote the request URL, e.g. Alchemy
 * `/v2/<key>`; a Telegram bot token `/bot<id>:<token>`; query keys `?apikey=` / `key=` / `token=`): masked before the line is written.
 */
export function maskSecrets(line: string): string {
  return line
    .replace(/(\/v[23]\/)[A-Za-z0-9_-]{16,}/g, "$1<redacted>")
    .replace(/(\/bot)\d+:[A-Za-z0-9_-]{30,}/g, "$1<redacted>")
    .replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token)=)[^&"\s\\]+/gi, "$1<redacted>");
}

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info") {
  const log = pino({
    name: service,
    level,
    base: { service },
    serializers: { err: pino.stdSerializers.err },
    formatters: { level: (label) => ({ level: label }) },
    hooks: { streamWrite: maskSecrets },
  });
  rpcMeter.attach(service, log); // the hourly "rpc usage" line (rpcMeter.ts)
  return log;
}

export type Logger = ReturnType<typeof createLogger>;

/** JSON.stringify replacer that renders bigint as decimal strings. */
export const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
