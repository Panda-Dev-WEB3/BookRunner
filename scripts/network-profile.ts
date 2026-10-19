// Network profiles of scripts/dev.ts that are pure functions of the environment (testable without spawning).
// Mainnet (Robinhood Chain 4663) profile: daily marks, live Orderly, real oracle sources only, no simulator,
// no mock venue, no gas keeper, no launch script (books are chartered by the sponsor through MarketCharter,
// docs/RUNBOOK.md), and a preflight that refuses to start while anything required is missing.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADMIN_KEY_OPT_IN, DEV_MNEMONIC, type DevRole, MAINNET_CHAIN_ID, assertDistinctRoleKeys, assertNoMnemonicOnMainnet, devAccount, roleAccount } from "../packages/shared/src/devkeys";
import { KMS_ENV_FOR_ROLE, SERVICE_ROLES, roleSignerSource } from "../packages/shared/src/signer";
import { busNames } from "../packages/shared/src/queues";

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
  // primary-confirm: Chainlink alone signs (sourceCount 1), the DEX TWAP / Pyth only confirm (VERIFY C6)
  ORACLE_POLICY: "primary-confirm",
  ORACLE_MIN_SOURCES: "1",
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

/**
 * Oracle sources (mirrors services/oracle/src/production.ts so the stack refuses before the oracle crash-loops). The
 * mainnet design is primary-confirm: Chainlink is the only source that sets and signs a price (sourceCount 1), a
 * Uniswap v3 TWAP confirms it (divergence -> alert, never a different price), Pyth Pro / HTTP sources are optional
 * extra confirmers. So, for every ticker (ORACLE_TICKERS, default the five launch tickers): a Chainlink feed in the
 * chain price config the oracle loads on 4663 (ORACLE_CHAIN_CONFIG, else config/chains/4663.json under `root`) or
 * ORACLE_CHAINLINK_FEEDS (entries must state their basis, {"proxy","basis","token"}: a plain address is refused,
 * VERIFY C2), and a DEX confirm pool in that config's dexConfirm.pools with a liquidity floor of at least
 * MAINNET_DEX_MIN_FLOOR_USD (the floor itself is checked live by source-check and every tick). ORACLE_POLICY and
 * ORACLE_MIN_SOURCES are pinned (MAINNET_FIXED); an inherited value contradicting them is refused rather than silently
 * overridden. Optional confirmers keep their rules: Pyth needs its key and https; HTTP specs their own timestamp
 * (tsPath) and maxAgeMs <= MAINNET_HTTP_MAX_AGE_MS; the Finnhub preset is refused. The oracle itself also refuses to
 * start unless the on-chain AttestedOracle.minSources() is exactly 1.
 */
export const MAINNET_ORACLE_MIN_SOURCES = 1;
export const MAINNET_ORACLE_POLICY = "primary-confirm";
/** services/oracle production.ts MAINNET_DEX_MIN_FLOOR_USD (the configured 2% depth floor, minDepthUsd) */
export const MAINNET_DEX_MIN_FLOOR_USD = 10_000;
/** services/oracle production.ts MAINNET_DEX_TWAP_SEC / MAINNET_DEX_MAX_AGE_MS / MAINNET_CHAINLINK_MAX_GRACE_MS */
export const MAINNET_DEX_TWAP_SEC = { min: 300, max: 3_600 } as const;
export const MAINNET_DEX_MAX_AGE_MS = 120_000;
export const MAINNET_CHAINLINK_MAX_GRACE_MS = 3_600_000;
/** services/oracle config.ts ORACLE_TICKERS default */
const DEFAULT_ORACLE_TICKERS = "NVDA,TSLA,AAPL,MSFT,AMZN";
/** services/oracle production.ts MAINNET_HTTP_MAX_AGE_MS */
export const MAINNET_HTTP_MAX_AGE_MS = 30_000;

/** Same truthy set as the oracle's z.stringbool() flags (ORACLE_PYTH=yes runs Pyth there, so it counts here too). */
const TRUTHY = new Set(["true", "1", "yes", "on", "y", "enabled"]);
const isOn = (v: string | undefined) => TRUTHY.has((v ?? "").trim().toLowerCase());

function oracleSourcesProblems(env: Env, root: string): string[] {
  const problems: string[] = [];
  const parse = (v: string | undefined, d: unknown) => {
    try {
      return v ? JSON.parse(v) : d;
    } catch {
      return null;
    }
  };
  const feeds = parse(env.ORACLE_CHAINLINK_FEEDS, {});
  const http = parse(env.ORACLE_HTTP_SOURCES, []);
  if (feeds === null || typeof feeds !== "object" || Array.isArray(feeds)) problems.push("ORACLE_CHAINLINK_FEEDS is not a JSON object");
  if (http === null || !Array.isArray(http)) problems.push("ORACLE_HTTP_SOURCES is not a JSON array");
  const envFeeds = feeds && typeof feeds === "object" && !Array.isArray(feeds) ? (feeds as Record<string, unknown>) : {};
  const plain = Object.entries(envFeeds)
    .filter(([, v]) => typeof v === "string")
    .map(([k]) => k);
  if (plain.length > 0) problems.push(`ORACLE_CHAINLINK_FEEDS gives plain addresses for ${plain.join(", ")}: give {"proxy","basis","token"} (VERIFY C2)`);

  const cfgName = env.ORACLE_CHAIN_CONFIG?.trim() || "config/chains/4663.json";
  const cfgPath = isAbsolute(cfgName) ? cfgName : resolve(root, cfgName);
  let cfgFeeds: Record<string, { heartbeatSec?: unknown; maxAgeSec?: unknown } | undefined> = {};
  let cfgPools: Record<string, { pool?: unknown; minDepthUsd?: unknown; twapSec?: unknown }> = {};
  if (existsSync(cfgPath)) {
    try {
      const c = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        chainId?: number;
        chainlink?: { feeds?: Record<string, { heartbeatSec?: unknown; maxAgeSec?: unknown } | undefined> };
        dexConfirm?: { pools?: Record<string, { pool?: unknown; minDepthUsd?: unknown; twapSec?: unknown }> };
      };
      if (c.chainId !== MAINNET_CHAIN_ID) problems.push(`${cfgName} is for chain ${c.chainId}, not 4663`);
      else {
        cfgFeeds = c.chainlink?.feeds ?? {};
        cfgPools = c.dexConfirm?.pools ?? {};
      }
    } catch {
      problems.push(`${cfgName} is not valid JSON`);
    }
  } else if (env.ORACLE_CHAIN_CONFIG?.trim()) {
    problems.push(`ORACLE_CHAIN_CONFIG ${cfgName} not found`);
  }
  const tickers = (env.ORACLE_TICKERS?.trim() || DEFAULT_ORACLE_TICKERS)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (Object.keys(cfgFeeds).length + Object.keys(envFeeds).length === 0) {
    problems.push("no Chainlink feed: config/chains/4663.json (ORACLE_CHAIN_CONFIG) or ORACLE_CHAINLINK_FEEDS (Chainlink is the only signing source)");
  } else {
    const noFeed = tickers.filter((t) => !(t in cfgFeeds) && !(t in envFeeds));
    if (noFeed.length > 0) problems.push(`no Chainlink feed for ${noFeed.join(", ")} (${cfgName} or ORACLE_CHAINLINK_FEEDS)`);
  }
  if (env.ORACLE_DEX_CONFIRM !== undefined && env.ORACLE_DEX_CONFIRM.trim() !== "" && !isOn(env.ORACLE_DEX_CONFIRM)) {
    problems.push("ORACLE_DEX_CONFIRM is off: mainnet requires the Uniswap v3 TWAP confirm source (a DEX confirm pool per ticker)");
  }
  const noPool = tickers.filter((t) => typeof cfgPools[t]?.pool !== "string");
  if (noPool.length > 0) problems.push(`no DEX confirm pool for ${noPool.join(", ")} (${cfgName} dexConfirm.pools)`);
  const twapOverride = env.ORACLE_DEX_TWAP_SEC?.trim() ? Number(env.ORACLE_DEX_TWAP_SEC) : undefined;
  if (twapOverride !== undefined && !(twapOverride >= MAINNET_DEX_TWAP_SEC.min && twapOverride <= MAINNET_DEX_TWAP_SEC.max)) {
    problems.push(`ORACLE_DEX_TWAP_SEC=${env.ORACLE_DEX_TWAP_SEC} outside ${MAINNET_DEX_TWAP_SEC.min}-${MAINNET_DEX_TWAP_SEC.max} s on mainnet (a short window is cheap to push)`);
  }
  for (const t of tickers) {
    const pool = cfgPools[t];
    if (typeof pool?.pool !== "string") continue;
    const floor = pool.minDepthUsd;
    if (typeof floor !== "number" || floor < MAINNET_DEX_MIN_FLOOR_USD) {
      problems.push(`dexConfirm.pools.${t}.minDepthUsd must be >= ${MAINNET_DEX_MIN_FLOOR_USD} (got ${String(floor)})`);
    }
    const twap = twapOverride ?? (typeof pool.twapSec === "number" ? pool.twapSec : 600);
    if (twapOverride === undefined && !(twap >= MAINNET_DEX_TWAP_SEC.min && twap <= MAINNET_DEX_TWAP_SEC.max)) {
      problems.push(`dexConfirm.pools.${t}.twapSec=${twap} outside ${MAINNET_DEX_TWAP_SEC.min}-${MAINNET_DEX_TWAP_SEC.max} s on mainnet`);
    }
  }
  const dexAge = env.ORACLE_DEX_MAX_AGE_MS?.trim();
  if (dexAge && !(Number(dexAge) > 0 && Number(dexAge) <= MAINNET_DEX_MAX_AGE_MS)) {
    problems.push(`ORACLE_DEX_MAX_AGE_MS=${dexAge} must be in (0, ${MAINNET_DEX_MAX_AGE_MS}] on mainnet (an RPC stall must not confirm with an old block)`);
  }
  // Chainlink alone signs: its in-session max age stays within heartbeat + 1 h (a widened bound would sign an old
  // round as a fresh price; services/oracle production.ts chainlinkAgeProblems)
  const grace = env.ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS?.trim();
  const graceMs = grace ? Number(grace) : 600_000;
  if (grace && !(graceMs >= 0 && graceMs <= MAINNET_CHAINLINK_MAX_GRACE_MS)) {
    problems.push(`ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS=${grace} must be <= ${MAINNET_CHAINLINK_MAX_GRACE_MS} on mainnet (a wider grace signs an old Chainlink round as fresh)`);
  }
  const defaultBound = 86_400_000 + MAINNET_CHAINLINK_MAX_GRACE_MS;
  const defaultAge = env.ORACLE_CHAINLINK_MAX_AGE_MS?.trim();
  if (defaultAge && !(Number(defaultAge) > 0 && Number(defaultAge) <= defaultBound)) {
    problems.push(`ORACLE_CHAINLINK_MAX_AGE_MS=${defaultAge} must be <= ${defaultBound} on mainnet (24 h heartbeat + 1 h)`);
  }
  const mergedFeeds: Record<string, unknown> = { ...cfgFeeds, ...envFeeds };
  for (const [id, f] of Object.entries(mergedFeeds)) {
    if (!f || typeof f !== "object") continue;
    const { heartbeatSec, maxAgeSec } = f as { heartbeatSec?: unknown; maxAgeSec?: unknown };
    const hb = typeof heartbeatSec === "number" ? heartbeatSec : 86_400;
    if (typeof maxAgeSec === "number" && maxAgeSec * 1000 > hb * 1000 + MAINNET_CHAINLINK_MAX_GRACE_MS) {
      problems.push(`chainlink feed ${id}: maxAgeSec=${maxAgeSec} > heartbeat ${hb} s + 1 h on mainnet (an old round would be signed as fresh)`);
    }
  }
  const policy = env.ORACLE_POLICY?.trim();
  if (policy && policy !== MAINNET_ORACLE_POLICY) {
    problems.push(`ORACLE_POLICY=${policy} contradicts the mainnet profile (${MAINNET_ORACLE_POLICY}: Chainlink signs, the DEX TWAP / Pyth only confirm): remove it`);
  }
  const confirmBps = env.ORACLE_CONFIRM_BPS?.trim();
  if (confirmBps && !(Number(confirmBps) > 0 && Number(confirmBps) <= 500)) {
    problems.push(`ORACLE_CONFIRM_BPS=${confirmBps} must be in (0, 500] on mainnet (default 200)`);
  }
  const lagBps = env.ORACLE_PRIMARY_LAG_BPS?.trim();
  if (lagBps && !(Number(lagBps) > 0 && Number(lagBps) < (confirmBps ? Number(confirmBps) : 200))) {
    problems.push(`ORACLE_PRIMARY_LAG_BPS=${lagBps} must be positive and below ORACLE_CONFIRM_BPS (${confirmBps || 200}) on mainnet`);
  }
  const finnhub = isOn(env.ORACLE_HTTP_FINNHUB);
  const pythOn = isOn(env.ORACLE_PYTH);
  const pythKey = !!env.PYTH_API_KEY?.trim();
  if (pythOn && !pythKey) problems.push("ORACLE_PYTH=1 but PYTH_API_KEY is not set (Pyth Pro access token)");
  const pythUrl = env.ORACLE_PYTH_URL?.trim();
  if (pythUrl && !pythUrl.startsWith("https://")) problems.push("ORACLE_PYTH_URL must be https:// (the Pyth Pro access token travels in its Authorization header)");
  if (env.ORACLE_PYTH_FEEDS?.trim()) {
    const pf = parse(env.ORACLE_PYTH_FEEDS, {});
    if (pf === null || typeof pf !== "object" || Array.isArray(pf) || !Object.values(pf as object).every((v) => Number.isInteger(v) && (v as number) >= 0)) {
      problems.push('ORACLE_PYTH_FEEDS is not a JSON object of ticker -> Pyth Pro feed id (e.g. {"NVDA":1314})');
    }
  }
  // optional HTTP confirm sources: their own quote timestamp and in-session tight (a stale last trade stamped with
  // our receive time would "confirm" anything); Finnhub never on mainnet (regular session only, 120 s)
  for (const spec of Array.isArray(http) ? (http as Array<Record<string, unknown>>) : []) {
    const name = typeof spec?.name === "string" ? spec.name : "?";
    const age = typeof spec?.maxAgeMs === "number" ? spec.maxAgeMs : undefined;
    if (typeof spec?.tsPath !== "string" || spec.tsPath === "") {
      problems.push(`ORACLE_HTTP_SOURCES.${name} has no tsPath: on mainnet every quote must carry the vendor's own timestamp`);
    } else if (age === undefined || age > MAINNET_HTTP_MAX_AGE_MS) {
      problems.push(`ORACLE_HTTP_SOURCES.${name} needs maxAgeMs <= ${MAINNET_HTTP_MAX_AGE_MS} on mainnet`);
    }
  }
  if (finnhub) {
    problems.push(
      env.ORACLE_FINNHUB_API_KEY?.trim()
        ? "ORACLE_HTTP_FINNHUB is not a mainnet source (regular session only, 120 s quote age, licence unverified): use a 24/5 vendor in ORACLE_HTTP_SOURCES"
        : "ORACLE_HTTP_FINNHUB=1 but ORACLE_FINNHUB_API_KEY is not set (and Finnhub is not a mainnet source)",
    );
  }
  const min = env.ORACLE_MIN_SOURCES?.trim();
  if (min && min !== String(MAINNET_ORACLE_MIN_SOURCES)) {
    problems.push(
      `ORACLE_MIN_SOURCES=${min} contradicts the mainnet profile (${MAINNET_ORACLE_MIN_SOURCES}: primary-confirm signs every price with sourceCount 1): remove it`,
    );
  }
  return problems;
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
  errors.push(...oracleSourcesProblems(inherited, root));

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
  // builder IF mode is a fallback (IF custody with one operator key, docs/VERIFY.md O10): only with the owner's sign-off
  if (inherited.ORDERLY_IF_MODE === "builder" && inherited.ORDERLY_IF_MODE_BUILDER_ACK !== "1") {
    errors.push("ORDERLY_IF_MODE=builder is not for mainnet without the owner's explicit sign-off (it moves the insurance fund into one operator key): set ORDERLY_IF_MODE_BUILDER_ACK=1 only after that sign-off");
  }

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

/**
 * Role-key ADDRESSES services/alerts watches for gas (ALERT_ROLE_ADDRESSES = "role=0x..,role=0x.."): never keys.
 * Local keys (explicit *_PRIVATE_KEY, or the devnet / testnet mnemonic) are derived here; roles signed by KMS are
 * returned in `kmsRoles` (their address needs a KMS GetPublicKey: scripts/dev.ts resolves them); per-book desk
 * keys (DESK_KEY_PRIVATE_KEY_<bookId>) are watched as `deskKeyBook<bookId>`. The protocol-admin key is never
 * derived for this, and roles without a key on this network (e.g. the gas funder on mainnet) are skipped.
 */
export function watchedRoleAddresses(env: Env, roles: readonly DevRole[]): { pairs: string[]; kmsRoles: DevRole[] } {
  const noAdmin: Env = { ...env };
  delete noAdmin[ADMIN_KEY_OPT_IN];
  const pairs: string[] = [];
  const kmsRoles: DevRole[] = [];
  for (const role of roles) {
    try {
      const source = roleSignerSource(role, noAdmin);
      if (source === "kms") kmsRoles.push(role);
      else if (source !== "missing") pairs.push(`${role}=${roleAccount(role, noAdmin).address}`);
    } catch {
      // no usable key for this role here
    }
  }
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^DESK_KEY_PRIVATE_KEY_(\d+)$/);
    if (!m || !v) continue;
    try {
      pairs.push(`deskKeyBook${m[1]}=${privateKeyToAccount(v as Hex).address}`);
    } catch {
      // malformed key: the agent reports it
    }
  }
  return { pairs, kmsRoles };
}

// ============================================================================ testnet: live Orderly rehearsal
// scripts/dev.ts --network testnet-live (VERIFY O22, RUNBOOK "Testnet rehearsal on real Orderly"): the Orderly books
// trade on Orderly's REAL testnet (vault 0x2A5b…E24d, testnet USDG) while Stock Tokens and prices stay mock / synthetic.
// A truly SEPARATE stack that runs ALONGSIDE the public testnet stack on the same host (systemd bookrunner@testnet-live
// next to bookrunner.service): its own role mnemonic (BKRN_TESTNET_LIVE_MNEMONIC: every role key, the deployer and the
// gas funder differ from the public stack's, so no key ever signs in two places), its own deployment record, database,
// Redis INSTANCE (redis-live, 127.0.0.1:63791) and bus namespace (testnet-live: channels, keys, queues), state directory
// and loopback ports. Env: .env.testnet-live (mode 600, optional) over the process env (the
// unit's /etc/bookrunner/testnet-live.env); the public stack's .env.testnet is only READ, to refuse a shared key. No
// mock-orderly (nothing to serve), no trader-sim (it mints mock USDC), no web dev server. Builder admin key (G6):
// ops-venue uses ORDERLY_BUILDER_KEY_SECRET, the key the admin wallet registered; its automated fee sweep is off.

/** Orderly RH testnet externals (VERIFY O2 / O3; re-read on-chain by scripts/orderly-readiness.ts). */
export const TESTNET_ORDERLY = {
  vault: "0x2A5b650A894409372DDeE241EDAC92d4152bE24d",
  usdg: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  brokerId: "bookrunner",
  /** the broker admin wallet 0x9c1B…e8b9's Orderly account (builder admin account, G6) */
  adminAccountId: "0xaa04410b18eb0856e02832221f24b2cd37fde7c6f6f8eec83fe95a2f62702e5c",
} as const;

/** The live stack's role mnemonic (env name); dev.ts hands it to the signing children as BKRN_TESTNET_MNEMONIC. */
export const LIVE_MNEMONIC_ENV = "BKRN_TESTNET_LIVE_MNEMONIC";
/** Network names of the two testnet variants (dev.ts --network, supervisor status, systemd instance). */
export const TESTNET_VARIANTS = ["testnet", "testnet-live"] as const;
export type TestnetVariant = (typeof TESTNET_VARIANTS)[number];

/** Defaults of the live variant; a key set in .env.testnet-live overrides it (except TESTNET_LIVE_PINNED). */
export const TESTNET_LIVE_DEFAULTS: Readonly<Record<string, string>> = {
  ORDERLY_BASE_URL: "https://testnet-api.orderly.org",
  ORDERLY_BROKER_ID: TESTNET_ORDERLY.brokerId, // venue symbols PERP_<T>_USDC_bookrunner (packages/shared venueSymbol)
  ORDERLY_TOKEN: "USDG",
  ORDERLY_LEDGER_ADDRESS: "0x1826B75e2ef249173FC735149AE4B8e9ea10abff", // testnet Ledger: Withdraw EIP-712 domain
  ORDERLY_BUILDER_ACCOUNT_ID: TESTNET_ORDERLY.adminAccountId,
  ORDERLY_LISTING_MODE: "manual", // the admin lists the markets in Orderly One (G4)
  ORDERLY_IF_MODE: "contract", // per-book OrderlyIFAccount (G5); builder = fallback with ORDERLY_IF_BUILDER_ACCOUNTS
};

/**
 * The documented overrides of the live profile when it runs from the unit's env (no .env.testnet-live: the server's
 * root-owned /etc/bookrunner/testnet-live.env): only these keys of the process env count as explicit, never every key
 * (a stray app-tree .env auto-loaded by bun must not override the profile).
 */
export const TESTNET_LIVE_UNIT_OVERRIDES: ReadonlySet<string> = new Set([...Object.keys(TESTNET_LIVE_DEFAULTS), "OPS_FEE_SWEEP_AUTO", "MARK_INTERVAL_SECONDS"]);

/** Explicit keys of the live profile from a process env (the unit's env file): the documented overrides present. */
export function liveUnitExplicitKeys(processEnv: Env): Set<string> {
  return new Set([...TESTNET_LIVE_UNIT_OVERRIDES].filter((k) => processEnv[k] !== undefined && processEnv[k] !== ""));
}

/** Loopback ports of the live stack (the public testnet stack keeps 4400 / 4410 / 4420 / 4430). */
export const TESTNET_LIVE_PORTS = { api: 4500, oracle: 4510, charter: 4530 } as const;

/** Pinned by the live variant whatever its env says (separate record / state / ports; G6 fee sweep). */
export const TESTNET_LIVE_PINNED: Readonly<Record<string, string>> = {
  ORDERLY_MODE: "live",
  OPS_FEE_SWEEP_AUTO: "false",
  DEPLOYMENT_FILE: "contracts/deployments/46630.live.json",
  OPS_KEYS_DIR: ".data/testnet-live/keys",
  OPS_SAGA_FILE: ".data/testnet-live/ops-venue/sagas.json",
  API_PORT: String(TESTNET_LIVE_PORTS.api),
  ORACLE_PORT: String(TESTNET_LIVE_PORTS.oracle),
  CHARTER_PORT: String(TESTNET_LIVE_PORTS.charter),
  // alerts probes these (never the public stack's API / oracle)
  ALERT_API_URL: `http://127.0.0.1:${TESTNET_LIVE_PORTS.api}`,
  ALERT_ORACLE_URL: `http://127.0.0.1:${TESTNET_LIVE_PORTS.oracle}`,
  // alerts mail says which stack; the daily backup (both stacks in one set) is recorded in the public stack's Redis db
  ALERT_LABEL: "BookRunner testnet-live (Orderly rehearsal)",
  ALERT_BACKUP_EXPECTED: "0",
};

/** Processes the live variant never starts. */
export const TESTNET_LIVE_EXCLUDED = new Set(["mock-orderly", "trader-sim", "web"]);

/**
 * Redis of each testnet variant: the public stack on the infra Redis (127.0.0.1:63790, db 1, REDIS_PASSWORD), the live
 * stack on its OWN Redis instance (deploy/server/docker-compose.yml redis-live, 127.0.0.1:63791, db 0,
 * REDIS_LIVE_PASSWORD). Pub/sub channels are global to a Redis server, so a db index alone would not isolate them.
 */
export const TESTNET_REDIS: Record<TestnetVariant, { port: number; db: number; passwordEnv: string }> = {
  testnet: { port: 63790, db: 1, passwordEnv: "REDIS_PASSWORD" },
  "testnet-live": { port: 63791, db: 0, passwordEnv: "REDIS_LIVE_PASSWORD" },
};

/** Bus namespace of each testnet variant (packages/shared queues.ts busNamespace: channels, keys, queues). */
export const TESTNET_BUS_NS: Record<TestnetVariant, string> = { testnet: "testnet", "testnet-live": "testnet-live" };

/** The REDIS_URL a testnet variant uses (from its password env; none = no auth, the local default). */
export function variantRedisUrl(env: Env, v: TestnetVariant): string {
  const r = TESTNET_REDIS[v];
  const pw = env[r.passwordEnv];
  return `redis://${pw ? `:${encodeURIComponent(pw)}@` : ""}127.0.0.1:${r.port}/${r.db}`;
}

/** host:port of a redis URL (for the "same Redis" refusal); null when unparseable. */
export function redisHostPort(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname === "localhost" ? "127.0.0.1" : u.hostname}:${u.port || "6379"}`;
  } catch {
    return null;
  }
}

/** True when an env (the public testnet profile's) asks for live Orderly: refused there, use --network testnet-live. */
export function testnetOrderlyLive(env: Env): boolean {
  return env.ORDERLY_MODE === "live";
}

/** Explicit role keys that must never be shared between the two stacks. */
const EXPLICIT_KEY_ENV = /(_PRIVATE_KEY|^DESK_KEY_PRIVATE_KEY_\d+|^BKRN_TESTNET_FUNDER_PK)$/;

const deployerOf = (mnemonic: string): string => devAccount("deployer", mnemonic).address;

/**
 * Live-Orderly testnet variant. `inherited` = process env + .env.testnet-live; `explicit` = keys .env.testnet-live set
 * (they override the defaults); `publicEnv` = the public stack's .env.testnet as read (never applied), null when absent;
 * `root` resolves the deployment record. Never throws: every problem is collected. Never puts a mnemonic in a message.
 */
export function testnetLiveProfile(inherited: Env, explicit: ReadonlySet<string>, root: string, only: readonly string[] = [], publicEnv: Env | null = null): ProfileResult {
  const errors: string[] = [];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(TESTNET_LIVE_DEFAULTS)) env[k] = explicit.has(k) && inherited[k] ? (inherited[k] as string) : v;
  Object.assign(env, TESTNET_LIVE_PINNED);
  const pg = encodeURIComponent(inherited.POSTGRES_PASSWORD || "bookrunner");
  env.DATABASE_URL = `postgres://bookrunner:${pg}@127.0.0.1:54400/bookrunner_testnet_live`;
  // its own Redis instance (REDIS_LIVE_URL overrides, e.g. a local test Redis) and its own bus namespace
  env.REDIS_URL = inherited.REDIS_LIVE_URL?.trim() || variantRedisUrl(inherited, "testnet-live");
  env.BKRN_BUS_NS = TESTNET_BUS_NS["testnet-live"];
  const publicRedis = [redisHostPort(variantRedisUrl(inherited, "testnet")), redisHostPort(publicEnv?.REDIS_URL)].filter((x): x is string => !!x);
  const mineRedis = redisHostPort(env.REDIS_URL);
  if (!mineRedis) errors.push("the live stack's REDIS_URL is not a redis:// URL");
  else if (publicRedis.includes(mineRedis)) errors.push(`the live stack's Redis (${mineRedis}) is the public testnet stack's Redis: it needs its own instance (redis-live, 127.0.0.1:63791)`);
  if (inherited.REDIS_PASSWORD && !inherited.REDIS_LIVE_PASSWORD && !inherited.REDIS_LIVE_URL) {
    errors.push("REDIS_LIVE_PASSWORD is not set (the infra Redis has a password, the live Redis instance must have its own: .env.infra, install.sh)");
  }
  // services that call each other over HTTP follow the live ports (only when configured at all)
  if (inherited.CHARTER_URL) env.CHARTER_URL = `http://127.0.0.1:${TESTNET_LIVE_PORTS.charter}`;
  if (inherited.ORACLE_URL) env.ORACLE_URL = `http://127.0.0.1:${TESTNET_LIVE_PORTS.oracle}`;

  // ---- keys: a dedicated mnemonic, never the public stack's
  const live = inherited[LIVE_MNEMONIC_ENV]?.trim();
  const pub = (publicEnv?.BKRN_TESTNET_MNEMONIC ?? "").trim();
  if (!live) {
    errors.push(`${LIVE_MNEMONIC_ENV} is not set: the live stack needs its own role mnemonic (never the public testnet stack's BKRN_TESTNET_MNEMONIC)`);
  } else if (live === DEV_MNEMONIC) {
    errors.push(`${LIVE_MNEMONIC_ENV} is the public anvil mnemonic`);
  } else {
    try {
      const mine = deployerOf(live);
      if (pub && deployerOf(pub) === mine) errors.push(`${LIVE_MNEMONIC_ENV} derives the same deployer (${mine}) as the public testnet stack's BKRN_TESTNET_MNEMONIC: generate a new mnemonic`);
      env.BKRN_TESTNET_MNEMONIC = live; // the role mnemonic every signing child derives from (childenv allow-lists it)
    } catch {
      errors.push(`${LIVE_MNEMONIC_ENV} is not a valid BIP-39 mnemonic`);
    }
  }
  if (publicEnv) {
    for (const [k, v] of Object.entries(inherited)) {
      if (!EXPLICIT_KEY_ENV.test(k) || !v?.trim()) continue;
      if (Object.values(publicEnv).some((pv) => pv?.trim() === v.trim())) errors.push(`${k} is also a key of the public testnet stack (.env.testnet): every key of the live stack must be its own`);
    }
  }

  const base = env.ORDERLY_BASE_URL ?? "";
  if (isLocal(base) || !base.startsWith("https://")) errors.push(`ORDERLY_BASE_URL must be Orderly's testnet API (https, not the mock): ${base}`);
  if (!inherited.ORDERLY_BUILDER_KEY_SECRET?.trim()) {
    errors.push("ORDERLY_BUILDER_KEY_SECRET is not set: the base58 secret of the Orderly key the admin wallet registered for the builder admin account (RUNBOOK \"builder admin key\")");
  }
  if (!inherited.ORACLE_SEED?.trim()) errors.push("ORACLE_SEED is not set: the oracle refuses synthetic prices on a public chain without a secret seed");
  if (explicit.has("OPS_FEE_SWEEP_AUTO") && inherited.OPS_FEE_SWEEP_AUTO !== "false") {
    errors.push("OPS_FEE_SWEEP_AUTO must stay false on the live testnet profile: the builder fee withdrawal needs the admin wallet's signature (G6 / VERIFY O21)");
  }
  for (const p of only) if (TESTNET_LIVE_EXCLUDED.has(p)) errors.push(`${p} does not run on the live-Orderly testnet stack`);

  const file = TESTNET_LIVE_PINNED.DEPLOYMENT_FILE!;
  const depFile = resolve(root, file);
  if (!existsSync(depFile)) {
    errors.push(`${file} not found: deploy the rehearsal stack first (ORDERLY_VENUE=live bash scripts/deploy-testnet.sh)`);
  } else {
    try {
      const dep = JSON.parse(readFileSync(depFile, "utf8")) as { chainId?: number; contracts?: { usdc?: string; orderlyVault?: string }; orderly?: { venue?: string; vault?: string; brokerId?: string; settlementToken?: string } };
      const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
      if (dep.chainId !== 46630) errors.push(`${file} is for chain ${dep.chainId}, not 46630`);
      if (dep.orderly?.venue !== "live") errors.push(`${file} is not a live-venue deployment (orderly.venue = ${dep.orderly?.venue ?? "absent"}): its books sit on the mock vault`);
      if (!same(dep.contracts?.orderlyVault, TESTNET_ORDERLY.vault)) errors.push(`${file}: orderlyVault ${dep.contracts?.orderlyVault} is not Orderly's testnet vault ${TESTNET_ORDERLY.vault}`);
      if (!same(dep.contracts?.usdc, TESTNET_ORDERLY.usdg)) errors.push(`${file}: settlement token ${dep.contracts?.usdc} is not testnet USDG ${TESTNET_ORDERLY.usdg}`);
      if (dep.orderly?.brokerId && dep.orderly.brokerId !== env.ORDERLY_BROKER_ID) errors.push(`${file}: adapters hashed broker ${dep.orderly.brokerId}, ORDERLY_BROKER_ID is ${env.ORDERLY_BROKER_ID}`);
    } catch {
      errors.push(`${file} is not valid JSON`);
    }
  }
  return { env, errors };
}

/** Deployer (role index 0) address a testnet variant signs with, for the supervisor status; null when not derivable. */
export function variantDeployer(env: Env): string | null {
  const m = env.BKRN_TESTNET_MNEMONIC?.trim();
  if (!m) return null;
  try {
    return deployerOf(m);
  } catch {
    return null;
  }
}

/** The OTHER testnet variant's Redis URL and supervisor status key (its own instance and bus namespace). */
export function otherVariant(env: Env, mine: TestnetVariant): { variant: TestnetVariant; redisUrl: string; statusKey: string } {
  const other: TestnetVariant = mine === "testnet" ? "testnet-live" : "testnet";
  return { variant: other, redisUrl: variantRedisUrl(env, other), statusKey: busNames(TESTNET_BUS_NS[other]).KEYS.supervisorStatus };
}

/**
 * Supervisor guard (belt and braces next to the separate mnemonics): refuse to start when the other variant's supervisor
 * status is fresh and reports the SAME deployer address (the same keys would sign in two stacks). Pure.
 */
export function supervisorConflict(other: { ts?: number; network?: string; deployer?: string | null } | null, myDeployer: string | null, now: number, ttlMs: number): string | null {
  if (!other || !myDeployer || !other.deployer || typeof other.ts !== "number") return null;
  if (now - other.ts > ttlMs) return null;
  if (other.deployer.toLowerCase() !== myDeployer.toLowerCase()) return null;
  return `the ${other.network ?? "other"} stack is running (supervisor status ${Math.round((now - other.ts) / 1000)} s old) with the same deployer ${myDeployer}: the same keys must never sign in two stacks`;
}
