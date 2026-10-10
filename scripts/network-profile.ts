// Network profiles of scripts/dev.ts that are pure functions of the environment (testable without spawning).
// Mainnet (Robinhood Chain 4663) profile: daily marks, live Orderly, real oracle sources only, no simulator,
// no mock venue, no gas keeper, no launch script (books are chartered by the sponsor through MarketCharter,
// docs/RUNBOOK.md), and a preflight that refuses to start while anything required is missing.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAINNET_CHAIN_ID, assertDistinctRoleKeys, assertNoMnemonicOnMainnet } from "../packages/shared/src/devkeys";
import { KMS_ENV_FOR_ROLE, SERVICE_ROLES, roleSignerSource } from "../packages/shared/src/signer";

export type Env = Record<string, string | undefined>;

/** Processes that never run on mainnet (simulators, mocks, testnet-only helpers). */
export const MAINNET_EXCLUDED = new Set(["mock-orderly", "trader-sim", "gas-keeper", "launch", "web"]);

/** Non-secret settings the mainnet profile pins (they win over anything inherited). */
export const MAINNET_FIXED: Readonly<Record<string, string>> = {
  NETWORK: "mainnet",
  CHAIN_ID: String(MAINNET_CHAIN_ID),
  NODE_ENV: "production",
  DEPLOYMENT_FILE: "contracts/deployments/4663.json",
  // daily marks: must equal the on-chain markInterval (DeployMainnet.s.sol enforces 86400 on 4663) and
  // Orderly's daily builder-fee settlement (docs/VERIFY.md O11)
  MARK_INTERVAL_SECONDS: "86400",
  RECEIPTS_INTERVAL_SECONDS: "3600",
  SESSIONS_MODE: "charter",
  ORDERLY_MODE: "live",
  ORACLE_SYNTHETIC: "0",
  ORACLE_PUSH_MODE: "pull",
  OPS_REPORT_MODE: "signed",
  INDEXER_CONFIRMATIONS: "2",
  OPS_KEYS_DIR: ".data/mainnet/keys",
  OPS_SAGA_FILE: ".data/mainnet/ops-venue/sagas.json",
};

/**
 * Env the operator must provide (systemd EnvironmentFile, root-only; never a file in the app tree). Values are
 * never printed. Role signers are checked separately (one per service role: `<ROLE>_KMS_KEY_ID` or
 * `<ROLE>_PRIVATE_KEY`).
 */
export const MAINNET_REQUIRED_ENV = [
  "RHC_RPC_URL", // archive RPC (Dwellir, VERIFY R2/R3)
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "API_ADMIN_TOKEN",
  "WEB_ORIGIN",
  "ORDERLY_BASE_URL", // live Orderly REST
  "ORDERLY_BROKER_ID", // builder broker id (VERIFY O7) — must match the input's externals.orderlyBrokerId
  "ORDERLY_BUILDER_KEY_SECRET", // builder ed25519 key (never generated onto disk on mainnet)
  "ANTHROPIC_API_KEY", // charter jury
] as const;

export interface ProfileResult {
  /** Settings to apply on top of the inherited environment. */
  env: Record<string, string>;
  /** Every reason the stack must not start (empty = ok). */
  errors: string[];
}

const isLocal = (url: string) => /(^|\/\/|@)(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(url);

/** Oracle sources that are real: at least one Chainlink feed or one HTTP source. */
function oracleSourcesProblem(env: Env): string | null {
  const parse = (v: string | undefined, d: unknown) => {
    try {
      return v ? JSON.parse(v) : d;
    } catch {
      return null;
    }
  };
  const feeds = parse(env.ORACLE_CHAINLINK_FEEDS, {});
  const http = parse(env.ORACLE_HTTP_SOURCES, []);
  if (feeds === null) return "ORACLE_CHAINLINK_FEEDS is not valid JSON";
  if (http === null) return "ORACLE_HTTP_SOURCES is not valid JSON";
  const nFeeds = typeof feeds === "object" && !Array.isArray(feeds) ? Object.keys(feeds).length : 0;
  const nHttp = Array.isArray(http) ? http.length : 0;
  return nFeeds + nHttp > 0 ? null : "no real oracle source: set ORACLE_CHAINLINK_FEEDS (from deployments/4663.json chainlinkFeeds) and/or ORACLE_HTTP_SOURCES";
}

/**
 * The mainnet profile and its preflight. `root` resolves the deployment file. Never throws: every problem is
 * collected so the operator sees them all at once.
 */
export function mainnetProfile(inherited: Env, root: string, only: readonly string[] = []): ProfileResult {
  const errors: string[] = [];
  try {
    assertNoMnemonicOnMainnet({ ...inherited, CHAIN_ID: String(MAINNET_CHAIN_ID) });
  } catch (err) {
    errors.push((err as Error).message);
  }
  for (const name of MAINNET_REQUIRED_ENV) if (!inherited[name]?.trim()) errors.push(`${name} is not set`);

  const rpc = inherited.RHC_RPC_URL ?? "";
  if (rpc && isLocal(rpc)) errors.push("RHC_RPC_URL points at a local node");
  const origins = (inherited.WEB_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.some((o) => !o.startsWith("https://"))) errors.push("WEB_ORIGIN must list https:// origins only");
  if (inherited.ORDERLY_BASE_URL && (isLocal(inherited.ORDERLY_BASE_URL) || !inherited.ORDERLY_BASE_URL.startsWith("https://"))) {
    errors.push("ORDERLY_BASE_URL must be the live Orderly API (https, not the mock)");
  }
  const oracle = oracleSourcesProblem(inherited);
  if (oracle) errors.push(oracle);

  const merged: Env = { ...inherited, ...MAINNET_FIXED };
  for (const role of SERVICE_ROLES) {
    try {
      if (roleSignerSource(role, merged) === "missing") {
        errors.push(`no signer for role ${role}: set ${KMS_ENV_FOR_ROLE[role]} (KMS) or its *_PRIVATE_KEY`);
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  try {
    assertDistinctRoleKeys(SERVICE_ROLES, merged, KMS_ENV_FOR_ROLE);
  } catch (err) {
    errors.push((err as Error).message);
  }
  if (inherited.DEPLOYER_PRIVATE_KEY || inherited.BKRN_TESTNET_FUNDER_PK) {
    errors.push("DEPLOYER_PRIVATE_KEY / BKRN_TESTNET_FUNDER_PK must not be in the mainnet service environment");
  }
  if (inherited.BKRN_ALLOW_ADMIN_KEY) errors.push("BKRN_ALLOW_ADMIN_KEY must not be set on mainnet");

  const depFile = resolve(root, MAINNET_FIXED.DEPLOYMENT_FILE!);
  if (!existsSync(depFile)) {
    errors.push(`${MAINNET_FIXED.DEPLOYMENT_FILE} not found: run scripts/deploy-mainnet.sh (DeployMainnet + VerifyHandover) first`);
  } else {
    try {
      const dep = JSON.parse(readFileSync(depFile, "utf8")) as { chainId?: number; network?: string; governance?: { timelockController?: string } };
      if (dep.chainId !== MAINNET_CHAIN_ID) errors.push(`${MAINNET_FIXED.DEPLOYMENT_FILE} is for chain ${dep.chainId}, not 4663`);
      if (dep.network !== "mainnet") errors.push(`${MAINNET_FIXED.DEPLOYMENT_FILE} was not written by DeployMainnet (network=${dep.network})`);
      if (!dep.governance?.timelockController) errors.push(`${MAINNET_FIXED.DEPLOYMENT_FILE} has no governance.timelockController`);
    } catch {
      errors.push(`${MAINNET_FIXED.DEPLOYMENT_FILE} is not valid JSON`);
    }
  }
  for (const p of only) if (MAINNET_EXCLUDED.has(p)) errors.push(`${p} never runs on mainnet`);

  const pg = encodeURIComponent(inherited.POSTGRES_PASSWORD ?? "");
  const redis = encodeURIComponent(inherited.REDIS_PASSWORD ?? "");
  const env: Record<string, string> = {
    ...MAINNET_FIXED,
    RPC_URL: rpc,
    DATABASE_URL: `postgres://bookrunner:${pg}@127.0.0.1:54400/bookrunner_mainnet`,
    REDIS_URL: `redis://:${redis}@127.0.0.1:63790/0`,
  };
  return { env, errors };
}

/** Per-book desk session key for agent:<book>: DESK_KEY_PRIVATE_KEY_<bookId> (only that agent receives it). */
export function deskKeyEnvFor(env: Env, bookId: number): Record<string, string> {
  const v = env[`DESK_KEY_PRIVATE_KEY_${bookId}`];
  return v ? { DESK_KEY_PRIVATE_KEY: v } : {};
}
