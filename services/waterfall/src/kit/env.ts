import { baseEnvSchema, parseFixed } from "@bookrunner/shared";
import { z } from "zod";

/**
 * baseEnvSchema.extend(shape).parse(source) with the extension's static type preserved
 * (shared loadEnv() widens to the base type).
 */
export function loadServiceEnv<T extends z.ZodRawShape>(shape: T, source: Record<string, string | undefined> = process.env) {
  const parsed = baseEnvSchema.extend(shape).safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** "1", "true", "yes" -> true; "0", "false", "no" -> false. */
export const zBool = (def: boolean) =>
  z
    .enum(["0", "1", "true", "false", "yes", "no"])
    .default(def ? "true" : "false")
    .transform((v) => v === "1" || v === "true" || v === "yes");

/** Decimal USD string -> raw 6dp bigint. */
export const zUsd = (def: string) =>
  z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "USD amount like 1.00")
    .default(def)
    .transform((v) => parseFixed(v, 6));

/** Decimal string -> WAD bigint. */
export const zWad = (def: string) =>
  z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/, "decimal number")
    .default(def)
    .transform((v) => parseFixed(v, 18));
