import { loadEnv } from "@bookrunner/shared";
import { z } from "zod";

/** Service-specific environment on top of the shared base env. */
export const apiEnvShape = {
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4400),
  API_HOST: z.string().default("127.0.0.1"),
  /**
   * Comma-separated list of allowed browser origins. Loopback-only (the default): the devnet web origins
   * are added; any public origin: exactly this list (see webOrigins).
   */
  WEB_ORIGIN: z.string().default("http://127.0.0.1:5180"),
  /** Optional charter service base URL (services/charter, port 4430). Local validation when unset. */
  CHARTER_URL: z.string().optional(),
  /** services/charter draft validation endpoint (POST /charters/draft, services/charter/src/http/app.ts). */
  CHARTER_VALIDATE_PATH: z.string().default("/charters/draft"),
  /** Bearer token for webhook management (/v1/webhooks). Webhook management is disabled while unset. */
  API_ADMIN_TOKEN: z.string().optional(),
  /**
   * Explicit allow-list (comma separated host names / IP literals) of webhook targets exempt from the
   * SSRF rules (loopback / private / link-local), e.g. "127.0.0.1,localhost" for a local receiver.
   */
  WEBHOOK_ALLOW_HOSTS: z.string().default(""),
  /** Webhook delivery tuning. */
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  WEBHOOK_BACKOFF_MS: z.coerce.number().int().min(10).default(5_000),
  WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /** Disable the webhook dispatcher + worker (e.g. when another api replica runs them). */
  WEBHOOKS_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  /** TTL (seconds) of cached chain reads (wallet positions, protocol params). */
  CHAIN_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(5),
  /** Oracle staleness bound used for display when the chain is not reachable. */
  MAX_PRICE_AGE_SECONDS: z.coerce.number().int().min(1).default(300),
};

export type ApiConfig = ReturnType<typeof loadApiConfig>;

export function loadApiConfig(source: Record<string, string | undefined> = process.env) {
  // loadEnv validates base + extras together; the extras are re-parsed for precise typing
  // (shared loadEnv's return type is the base env when the extension is generic).
  const base = loadEnv(apiEnvShape, source);
  const parsed = z.object(apiEnvShape).safeParse(source);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const env = { ...base, ...parsed.data };
  return { ...env, webOrigins: webOrigins(env.WEB_ORIGIN) };
}

const isLoopbackOrigin = (o: string) => {
  try {
    const h = new URL(o).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch {
    return false;
  }
};

/**
 * Allowed CORS origins. A public deployment (any non-loopback WEB_ORIGIN entry, e.g. the server's
 * https://bookrunner.use-cert.com) allows exactly its WEB_ORIGIN entries; a local setup (loopback only,
 * the default) also gets the devnet web app on both loopback names.
 */
export function webOrigins(webOrigin: string): string[] {
  const defaults = ["http://127.0.0.1:5180", "http://localhost:5180"];
  const extra = webOrigin
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const isPublic = extra.some((o) => !isLoopbackOrigin(o));
  return [...new Set(isPublic ? extra : [...extra, ...defaults])];
}
