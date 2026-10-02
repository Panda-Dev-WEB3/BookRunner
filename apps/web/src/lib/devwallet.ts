// Devnet "dev wallet": signs with the anvil test accounts behind the protocol roles
// (@bookrunner/shared/devkeys). Offered only when the API reports chain 31337; never on a live chain.
import { DEV_MNEMONIC, DEV_ROLE_INDEX, type DevRole, devAccount } from "@bookrunner/shared/devkeys";
import type { Address, LocalAccount } from "viem";

export { DEVNET_CHAIN_ID } from "./chainConfig";

export type DevGroup = "Sponsor" | "Allocators" | "Committee" | "Desk" | "Protocol";

export interface DevWalletEntry {
  role: DevRole;
  label: string;
  group: DevGroup;
  hint: string;
}

export const DEV_WALLETS: DevWalletEntry[] = [
  { role: "sponsor", label: "Studio sponsor", group: "Sponsor", hint: "Sponsors the launch books; files charters, registers desk keys" },
  { role: "allocator0", label: "Allocator A", group: "Allocators", hint: "Demo subscriber" },
  { role: "allocator1", label: "Allocator B", group: "Allocators", hint: "Demo subscriber" },
  { role: "allocator2", label: "Allocator C", group: "Allocators", hint: "Demo subscriber" },
  { role: "committee0", label: "Committee seat 1", group: "Committee", hint: "Bonded risk-committee member" },
  { role: "committee1", label: "Committee seat 2", group: "Committee", hint: "Bonded risk-committee member" },
  { role: "committee2", label: "Committee seat 3", group: "Committee", hint: "Bonded risk-committee member" },
  { role: "agentOperator", label: "Agent operator", group: "Desk", hint: "Stakes BKRN for desk inventory tiers" },
  { role: "deskKeyNvda", label: "Desk key (NVDA)", group: "Desk", hint: "Session key of the NVDA desk" },
  { role: "deskKeyTsla", label: "Desk key (TSLA)", group: "Desk", hint: "Session key of the TSLA desk" },
  { role: "deskKeyIndex", label: "Desk key (RHX5)", group: "Desk", hint: "Session key of the index desk" },
  { role: "deployer", label: "Deployer / guardian", group: "Protocol", hint: "Devnet admin and guardian" },
  { role: "risk", label: "Risk service", group: "Protocol", hint: "RISK role: may revoke desk keys" },
];

export const DEV_GROUPS: DevGroup[] = ["Sponsor", "Allocators", "Committee", "Desk", "Protocol"];

const cache = new Map<DevRole, LocalAccount>();

/** Derives (once per role) the anvil account for a role. BIP-39 seed derivation is not instant. */
export function devAccountFor(role: DevRole): LocalAccount {
  let a = cache.get(role);
  if (!a) {
    a = devAccount(role, DEV_MNEMONIC);
    cache.set(role, a);
  }
  return a;
}

export const devAddress = (role: DevRole): Address => devAccountFor(role).address;

export const isDevRole = (s: string | null | undefined): s is DevRole => !!s && Object.prototype.hasOwnProperty.call(DEV_ROLE_INDEX, s);

/** The dev role behind an address among the already-derived roles (no derivation triggered). */
export function devRoleOf(address: string | null | undefined): DevRole | null {
  if (!address) return null;
  const a = address.toLowerCase();
  for (const [role, acct] of cache) if (acct.address.toLowerCase() === a) return role;
  return null;
}

/** Derives every listed role, yielding between roles so the UI stays responsive. */
export async function deriveAll(onEach?: (role: DevRole, address: Address) => void): Promise<void> {
  for (const w of DEV_WALLETS) {
    if (!cache.has(w.role)) await new Promise((r) => setTimeout(r, 0));
    onEach?.(w.role, devAddress(w.role));
  }
}

export const devEntry = (role: DevRole): DevWalletEntry | undefined => DEV_WALLETS.find((w) => w.role === role);
