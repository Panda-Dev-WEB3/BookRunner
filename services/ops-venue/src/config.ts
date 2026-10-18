import { baseEnvSchema } from "@bookrunner/shared";
import { z } from "zod";
import { parseIfBuilderAccounts } from "./domain/ifAccount";

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
  // ORDERLY_BROKER_ID: shared base env (packages/shared/src/env.ts)
  ORDERLY_BUILDER_ACCOUNT_ID: z.string().optional(),
  ORDERLY_BUILDER_KEY_SECRET: z.string().optional(), // base58 ed25519 seed (else generated into OPS_KEYS_DIR/builder.json)
  ORDERLY_EIP712_CHAIN_ID: z.coerce.number().optional(), // chainId in Orderly messages (default CHAIN_ID) — VERIFY for RHC
  ORDERLY_LEDGER_ADDRESS: z.string().optional(), // Withdraw domain verifyingContract (default mainnet Ledger)
  // Live builder price push (Builder Oracle WebSocket, src/builderOracle, docs/VERIFY.md O18). Domain: this, else
  // derived from ORDERLY_BASE_URL (api.orderly.org -> wss://ws-oracle.orderly.org [documented]; testnet-api.orderly.org
  // -> wss://testnet-ws-oracle.orderly.org [VERIFY: undocumented]); anything else must set it.
  ORDERLY_ORACLE_WS_URL: z.string().optional(),
  // The account that pushes ORACLE_<broker> and its Orderly key: default the builder account + builder key. VERIFY O18 /
  // O21: whether Orderly accepts a non-admin account of the broker; else an Orderly key of the admin account (added by
  // the admin wallet, never the wallet key itself) goes here.
  ORDERLY_ORACLE_ACCOUNT_ID: z.string().optional(),
  ORDERLY_ORACLE_KEY_SECRET: z.string().optional(),
  OPS_BUILDER_PRICE_PUSH: bool(true), // ORDERLY_MODE=live + ORDERLY_SYMBOL_PRICE_SOURCE=builder only
  OPS_BUILDER_PRICE_INTERVAL_MS: z.coerce.number().int().min(100).max(1_000).default(1_000), // Orderly: >= 1 publish/s in session
  // older signed prices (held or not) are not re-sent; never below 3 x the oracle's ORACLE_TICK_MS (carried in its feed;
  // testnet ticks every 2 s, mainnet / devnet 1 s), so a slow oracle tick cannot make every price stale between ticks
  OPS_BUILDER_PRICE_MAX_AGE_MS: z.coerce.number().int().min(1_000).default(10_000),
  OPS_BUILDER_ORACLE_RECONNECT_MS: z.coerce.number().int().min(100).default(5_000), // first retry (docs sample: 5 s), doubling
  OPS_BUILDER_ORACLE_MAX_RECONNECT_MS: z.coerce.number().int().min(100).default(60_000),
  OPS_BUILDER_ORACLE_IDLE_MS: z.coerce.number().int().min(0).default(60_000), // no server message (ping) this long: reconnect; 0 = off
  // client WebSocket ping frames while authenticated; no pong / message for the timeout: reconnect. Detects a half-open
  // connection (send() still succeeds) within ~20 s, inside the 30 s builder_price_push alert window. 0 = off
  OPS_BUILDER_ORACLE_LIVENESS_MS: z.coerce.number().int().min(0).default(5_000),
  OPS_BUILDER_ORACLE_LIVENESS_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  ORDERLY_SYMBOL_PRICE_SOURCE: z.enum(["builder", "chainlink"]).default("builder"),
  // Who lists each book's market (docs/VERIFY.md O20). api: ops-venue (mock contract; live listing bodies VERIFY O13);
  // manual: the admin in Orderly One, ops-venue only checks GET /v1/public/info/{symbol} and never calls a listing /
  // symbol-status endpoint. Default: api with ORDERLY_MODE=mock, manual with ORDERLY_MODE=live (resolveListingMode).
  ORDERLY_LISTING_MODE: z.enum(["api", "manual"]).optional(),
  // listing re-check while a market is not listed (or after a failed check): first delay, doubling up to the max; a
  // listed market is re-checked every max (its status: REDUCE_ONLY / DELISTING are logged)
  OPS_LISTING_RECHECK_MS: z.coerce.number().int().min(1_000).default(15_000),
  OPS_LISTING_RECHECK_MAX_MS: z.coerce.number().int().min(1_000).default(300_000),
  // one listing check (public GET) still running after this counts as failed; at most this many run at once, so a hung
  // request never stalls the books loop
  OPS_LISTING_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  OPS_LISTING_CHECK_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // manual listing mode: an IF withdrawal of a retiring book waits this long for the admin's delisting in Orderly One
  // (re-tried every minute, no attempt burnt, alert venue_delist_pending); past it the venue error counts again
  OPS_DELIST_WAIT_MAX_MS: z.coerce.number().int().min(60_000).default(86_400_000),
  // Insurance-fund account model (src/domain/ifAccount.ts, docs/VERIFY.md O10). contract: the book's OrderlyIFAccount
  // (delegate account, today's path); builder: an operator EOA's Orderly account bound on-chain by the timelock's
  // adapter.setIfAccountOwner(eoa), listed per book in ORDERLY_IF_BUILDER_ACCOUNTS (<bookId>=<accountId>,...; must match
  // the chain). builder needs ORDERLY_MODE=live (the mock venue has no operator-wallet flows).
  ORDERLY_IF_MODE: z.enum(["contract", "builder"]).default("contract"),
  ORDERLY_IF_BUILDER_ACCOUNTS: z.string().optional(),
  // Orderly's per-market IF requirement in whole USD (the IF must be strictly above it): default from ORDERLY_BASE_URL
  // (testnet-api.orderly.org 100, api.orderly.org 25,000; none for mock-orderly). Checked by the fund_if job.
  ORDERLY_IF_REQUIREMENT_USD: z.coerce.number().min(0).optional(),
  // builder IF mode: an IF withdrawal waiting for the operator (withdraw on Orderly, return the USDG to the adapter) is
  // re-checked this often (no attempt burnt; alert venue_if_operator_pending)
  OPS_IF_OPERATOR_RECHECK_MS: z.coerce.number().int().min(1_000).default(60_000),
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

/** ORDERLY_LISTING_MODE, else api in mock mode (today's behaviour) and manual in live mode (no unverified listing calls). */
export function resolveListingMode(e: Pick<OpsEnv, "ORDERLY_MODE" | "ORDERLY_LISTING_MODE">): "api" | "manual" {
  return e.ORDERLY_LISTING_MODE ?? (e.ORDERLY_MODE === "live" ? "manual" : "api");
}

export function loadOpsEnv(source: Record<string, string | undefined> = process.env): OpsEnv {
  const parsed = opsEnvSchema.safeParse(source);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  // a key of one account signing for another fails Orderly auth forever: both or neither
  if (!!e.ORDERLY_ORACLE_ACCOUNT_ID !== !!e.ORDERLY_ORACLE_KEY_SECRET) {
    throw new Error("invalid environment: ORDERLY_ORACLE_ACCOUNT_ID and ORDERLY_ORACLE_KEY_SECRET must be set together (the pushing account and its Orderly key)");
  }
  if (e.OPS_BUILDER_ORACLE_LIVENESS_MS > 0 && e.OPS_BUILDER_ORACLE_LIVENESS_TIMEOUT_MS <= e.OPS_BUILDER_ORACLE_LIVENESS_MS) {
    throw new Error("invalid environment: OPS_BUILDER_ORACLE_LIVENESS_TIMEOUT_MS must exceed OPS_BUILDER_ORACLE_LIVENESS_MS");
  }
  if (e.ORDERLY_IF_MODE === "builder" && e.ORDERLY_MODE !== "live") {
    throw new Error("invalid environment: ORDERLY_IF_MODE=builder needs ORDERLY_MODE=live (the mock venue has no operator-wallet IF flows)");
  }
  try {
    parseIfBuilderAccounts(e.ORDERLY_IF_BUILDER_ACCOUNTS);
  } catch (err) {
    throw new Error(`invalid environment: ${(err as Error).message}`);
  }
  if (e.OPS_LISTING_RECHECK_MAX_MS < e.OPS_LISTING_RECHECK_MS) {
    throw new Error("invalid environment: OPS_LISTING_RECHECK_MAX_MS must be >= OPS_LISTING_RECHECK_MS");
  }
  return e;
}
