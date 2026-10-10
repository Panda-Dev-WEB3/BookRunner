// Devnet role keys derived from the anvil test mnemonic. NEVER used on a non-local chain:
// roleAccount() throws unless CHAIN_ID is 31337 or the role's *_PRIVATE_KEY env var is set.
// Mainnet (4663): no mnemonic of any kind is accepted (assertNoMnemonicOnMainnet), the deployer / funder are
// never loaded by TypeScript, and each service role needs its OWN key: `<ROLE>_PRIVATE_KEY` or a remote
// signer (`<ROLE>_KMS_KEY_ID`, signer.ts roleSigner).
import { type Hex, type LocalAccount } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

export const DEV_MNEMONIC = "test test test test test test test test test test test junk";

/** anvil account index per role (docker-compose starts anvil with 24 accounts). */
export const DEV_ROLE_INDEX = {
  deployer: 0, // admin / timelock proposer+executor on devnet
  markSigner: 1,
  risk: 2,
  opsVenue: 3,
  jury: 4,
  keeper: 5,
  oracleSigner: 6,
  sponsor: 7, // studio treasury: sponsors the three launch books
  committee0: 8,
  committee1: 9,
  committee2: 10,
  agentOperator: 11, // stakes BKRN for bookrunner inventory tiers
  deskKeyNvda: 12, // session keys for the launch books' desks
  deskKeyTsla: 13,
  deskKeyIndex: 14,
  allocator0: 15, // demo subscribers
  allocator1: 16,
  allocator2: 17,
  trader0: 18, // trader-sim takers
  trader1: 19,
  trader2: 20,
  trader3: 21,
  treasury: 22, // protocol treasury: config.expenseRecipient + slashRecipient (Deploy.s.sol TREASURY_INDEX)
  funder: 23, // gas keeper (public test chains): tops up the hot role keys; holds test ETH only, no protocol role
} as const;
export type DevRole = keyof typeof DEV_ROLE_INDEX;

export const ENV_FOR_ROLE: Partial<Record<DevRole, string>> = {
  markSigner: "MARK_SIGNER_PRIVATE_KEY",
  risk: "RISK_PRIVATE_KEY",
  opsVenue: "OPS_VENUE_PRIVATE_KEY",
  jury: "JURY_PRIVATE_KEY",
  keeper: "KEEPER_PRIVATE_KEY",
  oracleSigner: "ORACLE_SIGNER_PRIVATE_KEY",
  deployer: "DEPLOYER_PRIVATE_KEY",
  funder: "BKRN_TESTNET_FUNDER_PK",
};

/**
 * Roles holding protocol-admin power (deployer = admin / timelock / guardian, contracts/script/Deploy.s.sol).
 * On a public chain they are never derived from the shared hot mnemonic that the signing services hold:
 * only an explicit *_PRIVATE_KEY, or the mnemonic with ADMIN_KEY_OPT_IN=1 set for that one process
 * (operator-run deploy / launch scripts; scripts/dev.ts never sets it for a service).
 */
export const ADMIN_ROLES: ReadonlySet<DevRole> = new Set<DevRole>(["deployer"]);
export const ADMIN_KEY_OPT_IN = "BKRN_ALLOW_ADMIN_KEY";

export function devAccount(role: DevRole, mnemonic = DEV_MNEMONIC): LocalAccount {
  return mnemonicToAccount(mnemonic, { addressIndex: DEV_ROLE_INDEX[role] });
}

/** Robinhood Chain testnet: role keys derive from a locally generated mnemonic (.env.testnet, never committed). */
export const TESTNET_CHAIN_ID = 46630;
/** Robinhood Chain mainnet: explicit per-role keys or remote signers only. */
export const MAINNET_CHAIN_ID = 4663;

/** Env names that carry a mnemonic (any spelling): refused outright on mainnet. */
export const MNEMONIC_ENV = /MNEMONIC/i;

/**
 * Roles never loaded by a TypeScript process on mainnet: the deployer signs once from forge
 * (DeployMainnet.s.sol, then holds nothing) and there is no gas funder (the operator tops up role keys).
 */
export const MAINNET_FORBIDDEN_ROLES: ReadonlySet<DevRole> = new Set<DevRole>(["deployer", "funder"]);

/** Throws when `env` is for chain 4663 and carries any mnemonic (set and non-empty). */
export function assertNoMnemonicOnMainnet(env: Record<string, string | undefined> = process.env): void {
  if (Number(env.CHAIN_ID ?? 31337) !== MAINNET_CHAIN_ID) return;
  const found = Object.keys(env).filter((k) => MNEMONIC_ENV.test(k) && !!env[k]?.trim());
  if (found.length > 0) {
    throw new Error(`refusing to run on mainnet (4663) with a mnemonic in the environment (${found.join(", ")}): every role key is its own secret or a KMS key`);
  }
}

export function roleAccount(role: DevRole, env: Record<string, string | undefined> = process.env): LocalAccount {
  const chainId = Number(env.CHAIN_ID ?? 31337);
  if (chainId === MAINNET_CHAIN_ID) {
    assertNoMnemonicOnMainnet(env);
    if (MAINNET_FORBIDDEN_ROLES.has(role)) {
      throw new Error(`role ${role} is never loaded by a service on mainnet (deployer: forge DeployMainnet; no gas funder)`);
    }
  }
  const envName = ENV_FOR_ROLE[role];
  const pk = envName ? env[envName] : undefined;
  if (pk) return privateKeyToAccount(pk as Hex);
  if (chainId === 31337) return devAccount(role, env.DEV_MNEMONIC || DEV_MNEMONIC);
  if (chainId === TESTNET_CHAIN_ID && env.BKRN_TESTNET_MNEMONIC) {
    if (env.BKRN_TESTNET_MNEMONIC.trim() === DEV_MNEMONIC) throw new Error("refusing the public anvil mnemonic on a public testnet");
    if (ADMIN_ROLES.has(role) && env[ADMIN_KEY_OPT_IN] !== "1") {
      throw new Error(
        `role ${role} is a protocol-admin key: it is not derived from the shared service mnemonic on chain ${chainId}. ` +
          `Set ${envName} for this process, or ${ADMIN_KEY_OPT_IN}=1 in an operator-run deploy/launch script (never in a service).`,
      );
    }
    return devAccount(role, env.BKRN_TESTNET_MNEMONIC.trim());
  }
  throw new Error(`role ${role}: set ${envName ?? "a private key"} for chain ${chainId}` + (chainId === TESTNET_CHAIN_ID ? " (or BKRN_TESTNET_MNEMONIC)" : ""));
}

/** True when roleAccount() can derive keys for this env without explicit private keys (never on mainnet). */
export function hasDerivedKeys(env: Record<string, string | undefined> = process.env): boolean {
  const chainId = Number(env.CHAIN_ID ?? 31337);
  return chainId === 31337 || (chainId === TESTNET_CHAIN_ID && !!env.BKRN_TESTNET_MNEMONIC);
}

/**
 * Mainnet: one key per role. Throws if two roles were given the same private key (normalised), so a single
 * leaked secret never carries two protocol roles. KMS key ids are compared the same way.
 */
export function assertDistinctRoleKeys(roles: readonly DevRole[], env: Record<string, string | undefined>, kmsEnvForRole: Partial<Record<DevRole, string>> = {}): void {
  const seen = new Map<string, DevRole>();
  for (const role of roles) {
    for (const [kind, name] of [["pk", ENV_FOR_ROLE[role]], ["kms", kmsEnvForRole[role]]] as const) {
      const v = name ? env[name]?.trim().toLowerCase().replace(/^0x/, "") : undefined;
      if (!v) continue;
      const prev = seen.get(`${kind}:${v}`);
      if (prev) throw new Error(`roles ${prev} and ${role} share one key (${name}): every mainnet role needs its own key`);
      seen.set(`${kind}:${v}`, role);
    }
  }
}
