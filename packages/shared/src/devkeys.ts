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
} as const;
export type DevRole = keyof typeof DEV_ROLE_INDEX;

const ENV_FOR_ROLE: Partial<Record<DevRole, string>> = {
  markSigner: "MARK_SIGNER_PRIVATE_KEY",
  risk: "RISK_PRIVATE_KEY",
  opsVenue: "OPS_VENUE_PRIVATE_KEY",
  jury: "JURY_PRIVATE_KEY",
  keeper: "KEEPER_PRIVATE_KEY",
  oracleSigner: "ORACLE_SIGNER_PRIVATE_KEY",
  deployer: "DEPLOYER_PRIVATE_KEY",
};

export function devAccount(role: DevRole, mnemonic = DEV_MNEMONIC): LocalAccount {
  return mnemonicToAccount(mnemonic, { addressIndex: DEV_ROLE_INDEX[role] });
}

export function roleAccount(role: DevRole, env: Record<string, string | undefined> = process.env): LocalAccount {
  const envName = ENV_FOR_ROLE[role];
  const pk = envName ? env[envName] : undefined;
  if (pk) return privateKeyToAccount(pk as Hex);
  const chainId = Number(env.CHAIN_ID ?? 31337);
  if (chainId !== 31337) throw new Error(`role ${role}: set ${envName ?? "a private key"} for chain ${chainId}`);
  return devAccount(role, env.DEV_MNEMONIC || DEV_MNEMONIC);
}
