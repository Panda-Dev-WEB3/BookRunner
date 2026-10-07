// Devnet role keys derived from the anvil test mnemonic. NEVER used on a non-local chain:
// roleAccount() throws unless CHAIN_ID is 31337 or the role's *_PRIVATE_KEY env var is set.
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
  funder: 22, // gas keeper (public test chains): tops up the hot role keys; holds test ETH only, no protocol role
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

export function roleAccount(role: DevRole, env: Record<string, string | undefined> = process.env): LocalAccount {
  const envName = ENV_FOR_ROLE[role];
  const pk = envName ? env[envName] : undefined;
  if (pk) return privateKeyToAccount(pk as Hex);
  const chainId = Number(env.CHAIN_ID ?? 31337);
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

/** True when roleAccount() can derive keys for this env without explicit private keys. */
export function hasDerivedKeys(env: Record<string, string | undefined> = process.env): boolean {
  const chainId = Number(env.CHAIN_ID ?? 31337);
  return chainId === 31337 || (chainId === TESTNET_CHAIN_ID && !!env.BKRN_TESTNET_MNEMONIC);
}
