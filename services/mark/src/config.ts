import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServiceEnv } from "@bookrunner/waterfall";
import { z } from "zod";

export const markEnvShape = {
  /** Max wait after periodEnd for the period's distribution (and in-flight recalls) before marking anyway. */
  MARK_WAIT_SECONDS: z.coerce.number().min(0).default(90),
  MARK_TICK_SECONDS: z.coerce.number().positive().default(5),
  /** Recompute + recommit attempts when flowNonce moves under the mark. */
  MARK_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  /** Snapshot block = head - confirmations (0 on devnet). */
  MARK_CONFIRMATIONS: z.coerce.bigint().min(0n).default(0n),
  /** Do not start a mark within this many seconds of the registry's maxMarkAge. */
  MARK_SAFETY_SECONDS: z.coerce.number().min(0).default(60),
  /** Wait for the period's last receipts window to close (grace) before failing the attempt. */
  MARK_RECEIPTS_WAIT_SECONDS: z.coerce.number().min(0).default(20),
  RECEIPTS_GRACE_SECONDS: z.coerce.number().int().min(0).default(10),
  MARK_SPOOL_DIR: z.string().default(join(tmpdir(), "bookrunner-mark-spool")),
  MARK_LOG_CHUNK_BLOCKS: z.coerce.bigint().positive().default(10_000n),
  MARK_LOG_LOOKBACK_BLOCKS: z.coerce.bigint().min(0n).default(0n),
};

export function loadMarkConfig(source: Record<string, string | undefined> = process.env) {
  return loadServiceEnv(markEnvShape, source);
}

export type MarkConfig = ReturnType<typeof loadMarkConfig>;
