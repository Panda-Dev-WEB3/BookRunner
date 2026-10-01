import { z } from "zod";

/** Common environment for every service. Services extend with their own fields via `loadEnv(extra)`. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().default("postgres://bookrunner:bookrunner@127.0.0.1:54400/bookrunner"),
  REDIS_URL: z.string().default("redis://127.0.0.1:63790"),
  CHAIN_ID: z.coerce.number().default(31337),
  RPC_URL: z.string().default("http://127.0.0.1:8547"),
  DEPLOYMENT_FILE: z.string().default("contracts/deployments/31337.json"),
  DEV_MNEMONIC: z.string().optional(),
  MARK_INTERVAL_SECONDS: z.coerce.number().default(300),
  RECEIPTS_INTERVAL_SECONDS: z.coerce.number().default(60),
  SESSIONS_MODE: z.enum(["charter", "24x7"]).default("24x7"),
  ORDERLY_MODE: z.enum(["mock", "live"]).default("mock"),
  ORDERLY_BASE_URL: z.string().default("http://127.0.0.1:4420"),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export function loadEnv<T extends z.ZodRawShape>(extra?: T, source: Record<string, string | undefined> = process.env) {
  const schema = extra ? baseEnvSchema.extend(extra) : baseEnvSchema;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data as z.infer<typeof schema>;
}
