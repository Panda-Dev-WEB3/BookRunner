import { baseEnvSchema } from "@bookrunner/shared";
import { z } from "zod";

const bool = (d: boolean) =>
  z
    .enum(["1", "0", "true", "false", "on", "off", "yes", "no"])
    .default(d ? "true" : "false")
    .transform((v) => ["1", "true", "on", "yes"].includes(v));

export const opsEnvSchema = baseEnvSchema.extend({
  // signed (default, docs/LOW_GAS.md §2): sign each venue report off-chain (EIP-712, src/report712.ts) and
  // publish it to Redis; the mark keeper relays the latest one inside its MarkRegistry.commitAndApply — no
  // report tx. onchain: the pre-low-gas loop (OrderlyAdapter.report every interval).
  OPS_REPORT_MODE: z.enum(["signed", "onchain"]).default("signed"),
  OPS_REPORT_INTERVAL_MS: z.coerce.number().default(15_000),
  OPS_REPORT_MAX_DROP_BPS: z.coerce.number().default(5_000), // hold reports showing a sharper unexplained fall
  OPS_REPORT_DROP_CONFIRMATIONS: z.coerce.number().default(3),
  // no report within this many chain seconds of an on-chain venue flow (deposit/confirm/fail): the venue
  // credits deposits asynchronously (mock indexer poll; Orderly cross-chain, VERIFY latency)
  OPS_REPORT_SETTLE_S: z.coerce.number().default(30),
  OPS_BOOK_POLL_MS: z.coerce.number().default(5_000),
  OPS_LOG_POLL_MS: z.coerce.number().default(3_000),
  OPS_FEE_POLL_MS: z.coerce.number().default(10_000),
  OPS_FEE_SETTLE_GRACE_S: z.coerce.number().default(20),
  OPS_FEE_SWEEP_AUTO: bool(true),
  OPS_DEPLOYMENT_RETRY_MS: z.coerce.number().default(10_000),
  OPS_LOG_MAX_RANGE: z.coerce.number().default(2_000),
  OPS_CONFIRMATIONS: z.coerce.number().default(0),
  OPS_TX_POLL_MS: z.coerce.number().default(500),
  OPS_KEYS_DIR: z.string().default(".data/keys"),
  OPS_SAGA_FILE: z.string().default(".data/ops-venue/sagas.json"),
  OPS_TRADE_KEY_TTL_DAYS: z.coerce.number().default(30),
  OPS_OPS_KEY_TTL_DAYS: z.coerce.number().default(365),
  OPS_WITHDRAW_MAX_ATTEMPTS: z.coerce.number().default(40),
  OPS_WORKER_CONCURRENCY: z.coerce.number().default(2),
  ORDERLY_BROKER_ID: z.string().default("bookrunner"),
  ORDERLY_BUILDER_ACCOUNT_ID: z.string().optional(),
  ORDERLY_BUILDER_KEY_SECRET: z.string().optional(), // base58 ed25519 seed (else generated into OPS_KEYS_DIR/builder.json)
  ORDERLY_EIP712_CHAIN_ID: z.coerce.number().optional(), // chainId in Orderly messages (default CHAIN_ID) — VERIFY for RHC
  ORDERLY_LEDGER_ADDRESS: z.string().optional(), // Withdraw domain verifyingContract (default mainnet Ledger)
  ORDERLY_ORACLE_WS_URL: z.string().optional(),
  ORDERLY_SYMBOL_PRICE_SOURCE: z.enum(["builder", "chainlink"]).default("builder"),
  // Settlement token symbol on Orderly (holding rows, withdraw / transfer messages): USDC on devnet, USDG on
  // Robinhood Chain (VERIFY O3/O7). Must match the OrderlyAdapter tokenHash (keccak256 of this symbol).
  ORDERLY_TOKEN: z.string().default("USDC"),
  // Orderly native deposit fee (VERIFY O5): adapter ETH is checked every book poll; > 0 lets ops-venue top an
  // adapter up (adapter.fundNative, from the OPS_VENUE key) by at most this many wei, to headroom x the fee.
  OPS_NATIVE_TOPUP_MAX_WEI: z.coerce.bigint().default(0n),
  OPS_NATIVE_FEE_HEADROOM: z.coerce.bigint().default(2n),
  OPS_NATIVE_TOPUP_COOLDOWN_MS: z.coerce.number().default(3_600_000),
});

export type OpsEnv = z.infer<typeof opsEnvSchema>;

export function loadOpsEnv(source: Record<string, string | undefined> = process.env): OpsEnv {
  const parsed = opsEnvSchema.safeParse(source);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}
