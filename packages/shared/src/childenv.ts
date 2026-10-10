// Per-process environment for the orchestrator (scripts/dev.ts): every child gets the non-secret
// configuration, but a secret (mnemonic, private key, API key, password, seed, admin token) only reaches
// the processes on its allow-list. The internet-facing API, the indexer, receipts and the web dev server
// get no signing material at all; the shared role mnemonic goes to the processes that sign, and the
// protocol-admin opt-in (devkeys ADMIN_KEY_OPT_IN) to the one-shot launch script only.
// Mainnet (CHAIN_ID 4663): childEnv refuses to build any child environment while a mnemonic is present, and
// a role's remote signer (`<ROLE>_KMS_KEY_ID`, signer.ts) reaches only the process signing for that role.
import { ADMIN_KEY_OPT_IN, assertNoMnemonicOnMainnet } from "./devkeys";

/** Env names treated as secrets: stripped unless the process's allow-list names them. */
export const SECRET_ENV = /MNEMONIC|PRIVATE_KEY|_PK$|API_KEY|SECRET|PASSWORD|(^|_)TOKEN$|^ORACLE_SEED$|KMS_KEY_ID$/;

const MNEMONIC = ["BKRN_TESTNET_MNEMONIC", "DEV_MNEMONIC"] as const;
/** AWS credentials for a KMS signer (prefer the host's instance role: then none of these is set). */
const AWS_SIGNING = ["AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;

/**
 * Secrets each process may receive (exact names; a trailing `*` is a prefix). Agents are `agent:<book>`
 * and share the `agent` entry. A process missing here gets no secrets.
 */
export const SECRET_ALLOW: Readonly<Record<string, readonly string[]>> = {
  "mock-orderly": [],
  oracle: [...MNEMONIC, "ORACLE_SIGNER_PRIVATE_KEY", "ORACLE_SIGNER_KMS_KEY_ID", ...AWS_SIGNING, "ORACLE_SEED", "ORACLE_FINNHUB_API_KEY"],
  indexer: [],
  charter: [...MNEMONIC, "JURY_PRIVATE_KEY", "JURY_KMS_KEY_ID", ...AWS_SIGNING, "ANTHROPIC_API_KEY"],
  "ops-venue": [...MNEMONIC, "OPS_VENUE_PRIVATE_KEY", "OPS_VENUE_KMS_KEY_ID", ...AWS_SIGNING, "ORDERLY_BUILDER_KEY_SECRET", "ORDERLY_TRADE_KEY_SECRET*"],
  risk: [...MNEMONIC, "RISK_PRIVATE_KEY", "RISK_KMS_KEY_ID", ...AWS_SIGNING, "RISK_ORDERLY_SECRET"],
  receipts: [],
  waterfall: [...MNEMONIC, "KEEPER_PRIVATE_KEY", "KEEPER_KMS_KEY_ID", ...AWS_SIGNING],
  mark: [...MNEMONIC, "MARK_SIGNER_PRIVATE_KEY", "MARK_SIGNER_KMS_KEY_ID", ...AWS_SIGNING],
  api: ["API_ADMIN_TOKEN"],
  "gas-keeper": [...MNEMONIC, "BKRN_TESTNET_FUNDER_PK"],
  web: [],
  launch: [...MNEMONIC, "DEPLOYER_PRIVATE_KEY", ADMIN_KEY_OPT_IN],
  agent: [...MNEMONIC, "DESK_KEY_PRIVATE_KEY"],
  "trader-sim": [...MNEMONIC],
};

/** Infrastructure URLs (they carry the DB / Redis passwords): every process but the web dev server. */
const INFRA_ENV = ["DATABASE_URL", "REDIS_URL"] as const;
const NO_INFRA = new Set(["web"]);

const allowKey = (proc: string) => (proc.startsWith("agent:") ? "agent" : proc);

export function secretAllowed(proc: string, name: string): boolean {
  const list = SECRET_ALLOW[allowKey(proc)] ?? [];
  return list.some((a) => (a.endsWith("*") ? name.startsWith(a.slice(0, -1)) : a === name));
}

/**
 * The environment one child process receives: `base` without the secrets it is not allowed, without
 * the admin opt-in unless allowed (it is not a secret by name, but grants the admin key), plus `extra`.
 */
export function childEnv(proc: string, base: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  assertNoMnemonicOnMainnet({ ...base, ...extra });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if ((SECRET_ENV.test(k) || k === ADMIN_KEY_OPT_IN) && !secretAllowed(proc, k)) continue;
    if (NO_INFRA.has(allowKey(proc)) && (INFRA_ENV as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}
