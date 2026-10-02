import { baseEnvSchema } from "@bookrunner/shared";
import { z } from "zod";

/** Default model jury (ARCHITECTURE §4 charter row). Order is the seat order in the verdict. */
export const DEFAULT_JURY_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"] as const;

export const charterEnvShape = {
  CHARTER_PORT: z.coerce.number().int().positive().default(4430),
  // loopback by default like the other services: the intake API is reached through the API / a proxy
  CHARTER_HOST: z.string().min(1).default("127.0.0.1"),
  /** Model jury runs only when set; otherwise the deterministic rule-based ensemble votes. */
  ANTHROPIC_API_KEY: z.string().optional(),
  JURY_MODELS: z.string().default(DEFAULT_JURY_MODELS.join(",")),
  /** Applied only to models that accept sampling parameters (see jury/modelCaps.ts). */
  JURY_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.2),
  /** output_config.effort for models that support it (Opus/Sonnet 5.x). */
  JURY_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  JURY_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
  JURY_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  /** Server-side refusal fallbacks (`fallbacks: "default"`) on models that support it. */
  JURY_FALLBACKS: z.enum(["default", "off"]).default("default"),
  /** Structured outputs (output_config.format json_schema). Output is still zod-validated. */
  JURY_STRUCTURED_OUTPUT: z.stringbool().default(true),
  /** How often to scan for Filed charters without a posted verdict (DB + chain). */
  JURY_POLL_MS: z.coerce.number().int().positive().default(15_000),
  JURY_CONCURRENCY: z.coerce.number().int().positive().default(1),
  /** Optional per-underlying venue/DEX depth in USD, e.g. {"NVDA":"5000000"}. VERIFY on RHC. */
  JURY_LIQUIDITY_JSON: z.string().optional(),
  COMMITTEE_SYNC_MS: z.coerce.number().int().positive().default(60_000),
  /** Emit committee.deadline_approaching when less than this remains in the committee window. */
  COMMITTEE_DEADLINE_WARN_SECONDS: z.coerce.number().int().positive().default(12 * 3600),
  DEPLOYMENT_RETRY_MS: z.coerce.number().int().positive().default(10_000),
};

// Same contract as shared loadEnv(extra), but keeps the extended type (shared loadEnv's return type
// collapses to the base schema; see sharedAdditionsSuggested).
export const charterEnvSchema = baseEnvSchema.extend(charterEnvShape);
export type CharterEnv = z.infer<typeof charterEnvSchema>;

export function loadCharterEnv(source: Record<string, string | undefined> = process.env): CharterEnv {
  const parsed = charterEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function juryModels(env: Pick<CharterEnv, "JURY_MODELS">): string[] {
  return env.JURY_MODELS.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}
