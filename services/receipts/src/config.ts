import { baseEnvSchema } from "@bookrunner/shared";
import { z } from "zod";

export const receiptsEnvShape = {
  /** Seconds after a window's end before it is rooted (lets in-flight inserts land). */
  RECEIPTS_GRACE_SECONDS: z.coerce.number().int().min(0).default(10),
  /** Automatic back-fill horizon; older windows are still rooted on demand (marks, proofs). */
  RECEIPTS_BACKFILL_SECONDS: z.coerce.number().int().positive().default(86_400),
  RECEIPTS_MAX_WINDOWS_PER_TICK: z.coerce.number().int().positive().default(2_000),
  /** Loop cadence; default min(15, interval / 4) seconds. */
  RECEIPTS_TICK_SECONDS: z.coerce.number().positive().optional(),
};

// baseEnvSchema.extend directly (shared loadEnv() loses the extension's static type).
const schema = baseEnvSchema.extend(receiptsEnvShape);

export function loadReceiptsConfig(source: Record<string, string | undefined> = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const env = parsed.data;
  const tickSeconds = env.RECEIPTS_TICK_SECONDS ?? Math.max(1, Math.min(15, env.RECEIPTS_INTERVAL_SECONDS / 4));
  return { ...env, tickSeconds };
}

export type ReceiptsConfig = ReturnType<typeof loadReceiptsConfig>;
