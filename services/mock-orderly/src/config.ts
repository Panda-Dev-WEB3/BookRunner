import { baseEnvSchema, devAccount } from "@bookrunner/shared";
import { z } from "zod";
import { DEFAULT_FLOW, type FlowParams } from "./flow";
import { ORDERLY_LEDGER_MAINNET } from "./orderly712";
import { DEFAULT_VENUE_CONFIG, type VenueConfig } from "./venue";

const bool = (d: boolean) =>
  z
    .enum(["1", "0", "true", "false", "on", "off", "yes", "no"])
    .default(d ? "true" : "false")
    .transform((v) => ["1", "true", "on", "yes"].includes(v));

export const mockEnvShape = {
  MOCK_ORDERLY_PORT: z.coerce.number().default(4420),
  MOCK_ORDERLY_HOST: z.string().default("127.0.0.1"),
  MOCK_ORDERLY_AUTH: z.enum(["strict", "permissive"]).default("permissive"),
  MOCK_ORDERLY_BROKER_ID: z.string().default("bookrunner"),
  MOCK_ORDERLY_LEDGER: z.string().default(ORDERLY_LEDGER_MAINNET),
  MOCK_ORDERLY_DELEGATE_SIGNERS: z.string().optional(), // comma list; default devnet opsVenue address
  MOCK_ORDERLY_BUILDER_ACCOUNT_ID: z.string().optional(),
  MOCK_ORDERLY_SNAPSHOT: bool(true),
  MOCK_ORDERLY_SNAPSHOT_FILE: z.string().default(".data/mock-orderly.json"),
  MOCK_ORDERLY_SNAPSHOT_MS: z.coerce.number().default(5000),
  MOCK_ORDERLY_SEED: z.string().default("bookrunner-mock-orderly"),
  MOCK_ORDERLY_TICK_MS: z.coerce.number().default(1000),
  MOCK_ORDERLY_CHAIN_POLL_MS: z.coerce.number().default(2000),
  MOCK_TAKER_FEE_BPS: z.coerce.number().default(6),
  MOCK_MAKER_FEE_BPS: z.coerce.number().default(0),
  MOCK_BUILDER_SHARE_BPS: z.coerce.number().default(5000),
  MOCK_LIQUIDATION_FEE_BPS: z.coerce.number().default(100),
  MOCK_IF_REQUIREMENT_USD: z.coerce.number().default(100),
  MOCK_IF_LOCK: bool(true),
  MOCK_SETTLE_INTERVAL_SECONDS: z.coerce.number().optional(), // default MARK_INTERVAL_SECONDS
  MOCK_FUNDING_INTERVAL_SECONDS: z.coerce.number().default(3600),
  MOCK_FUNDING_RATE_BPS: z.coerce.number().default(0),
  MOCK_IMR_BPS: z.coerce.number().default(1000),
  MOCK_MMR_BPS: z.coerce.number().default(500),
  MOCK_EXTERNAL_SPREAD_BPS: z.coerce.number().default(10),
  MOCK_AUTO_CREATE_SYMBOLS: bool(true),
  MOCK_MARGIN_CHECK: bool(true),
  MOCK_QUOTE_TICK: z.coerce.number().default(0.01),
  MOCK_BASE_TICK: z.coerce.number().default(0.0001),
  MOCK_ENFORCE_TICKS: bool(false),
  MOCK_ENFORCE_WITHDRAW_NONCE: bool(false),
  MOCK_FLOW_ENABLED: bool(true),
  MOCK_FLOW_RATE_PER_MIN: z.coerce.number().default(DEFAULT_FLOW.ratePerMin),
  MOCK_FLOW_MEDIAN_USD: z.coerce.number().default(DEFAULT_FLOW.medianNotionalUsd),
  MOCK_FLOW_MAX_USD: z.coerce.number().default(DEFAULT_FLOW.maxNotionalUsd),
  MOCK_FLOW_MAX_SLIPPAGE_BPS: z.coerce.number().default(DEFAULT_FLOW.maxSlippageBps),
};

const mockEnvSchema = baseEnvSchema.extend(mockEnvShape);

/** Like shared loadEnv, but keeps the extended field types (shared loadEnv widens to the base schema). */
export function loadMockEnv(source: Record<string, string | undefined> = process.env): z.infer<typeof mockEnvSchema> {
  const parsed = mockEnvSchema.safeParse(source);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function loadMockConfig(source: Record<string, string | undefined> = process.env) {
  const env = loadMockEnv(source);
  const flow: FlowParams = {
    ...DEFAULT_FLOW,
    enabled: env.MOCK_FLOW_ENABLED,
    ratePerMin: env.MOCK_FLOW_RATE_PER_MIN,
    medianNotionalUsd: env.MOCK_FLOW_MEDIAN_USD,
    maxNotionalUsd: env.MOCK_FLOW_MAX_USD,
    maxSlippageBps: env.MOCK_FLOW_MAX_SLIPPAGE_BPS,
  };
  const venue: VenueConfig = {
    ...DEFAULT_VENUE_CONFIG,
    fees: {
      takerFeeBps: env.MOCK_TAKER_FEE_BPS,
      makerFeeBps: env.MOCK_MAKER_FEE_BPS,
      builderShareBps: env.MOCK_BUILDER_SHARE_BPS,
      liquidationFeeBps: env.MOCK_LIQUIDATION_FEE_BPS,
      liquidationIfShareBps: DEFAULT_VENUE_CONFIG.fees.liquidationIfShareBps,
    },
    imrBps: env.MOCK_IMR_BPS,
    mmrBps: env.MOCK_MMR_BPS,
    ifRequirementUsd: env.MOCK_IF_REQUIREMENT_USD,
    ifLock: env.MOCK_IF_LOCK,
    settleIntervalSec: env.MOCK_SETTLE_INTERVAL_SECONDS ?? env.MARK_INTERVAL_SECONDS,
    fundingIntervalSec: env.MOCK_FUNDING_INTERVAL_SECONDS,
    fundingRateBps: env.MOCK_FUNDING_RATE_BPS,
    externalSpreadBps: env.MOCK_EXTERNAL_SPREAD_BPS,
    autoCreateSymbols: env.MOCK_AUTO_CREATE_SYMBOLS,
    marginCheck: env.MOCK_MARGIN_CHECK,
    quoteTick: env.MOCK_QUOTE_TICK,
    baseTick: env.MOCK_BASE_TICK,
    enforceTicks: env.MOCK_ENFORCE_TICKS,
    enforceWithdrawNonce: env.MOCK_ENFORCE_WITHDRAW_NONCE,
    ...(env.MOCK_ORDERLY_BUILDER_ACCOUNT_ID ? { builderAccountId: env.MOCK_ORDERLY_BUILDER_ACCOUNT_ID } : {}),
    flow,
  };
  const delegateSigners = (env.MOCK_ORDERLY_DELEGATE_SIGNERS ? env.MOCK_ORDERLY_DELEGATE_SIGNERS.split(",") : [devAccount("opsVenue").address])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { env, venue, delegateSigners };
}

export type MockConfig = ReturnType<typeof loadMockConfig>;
