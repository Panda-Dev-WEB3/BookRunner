import { baseEnvSchema } from "@bookrunner/shared";
import { z } from "zod";

export const indexerEnvShape = {
  /** Blocks behind head treated as final (0 on devnet; set >0 on Robinhood Chain). */
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(0),
  /** Max blocks per eth_getLogs range. */
  INDEXER_BATCH_BLOCKS: z.coerce.number().int().positive().default(2000),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(2000),
  /** Consecutive failures of one range before logs are applied one by one (failing logs skipped). */
  INDEXER_POISON_ATTEMPTS: z.coerce.number().int().positive().default(8),
  /** Optional override of deployment.startBlock (only used when no cursor exists yet). */
  INDEXER_START_BLOCK: z.coerce.number().int().min(0).optional(),
  /** Max addresses per eth_getLogs call. */
  INDEXER_ADDRESS_CHUNK: z.coerce.number().int().positive().default(200),
  DEPLOYMENT_RETRY_MS: z.coerce.number().int().positive().default(10_000),
};

export const indexerEnvSchema = baseEnvSchema.extend(indexerEnvShape);
export type IndexerEnv = z.infer<typeof indexerEnvSchema>;

export function loadIndexerEnv(source: Record<string, string | undefined> = process.env): IndexerEnv {
  const parsed = indexerEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** chain_cursor names (one per contract group). */
export const CURSORS = {
  protocol: "indexer:protocol", // MarketCharter, RiskCommittee, BookFactory, MarkRegistry
  books: "indexer:books", // every book's Book, Senior, Junior, RevenueRouter, MMMandate
} as const;
