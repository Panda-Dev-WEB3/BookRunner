// Devnet dev-wallet signer: derives the anvil test accounts behind the protocol roles
// (@bookrunner/shared/devkeys, the public anvil mnemonic). Loaded ONLY through
// wallet/devSigner.ts's compile-time gate, so testnet and mainnet bundles never contain it
// (vite.config.ts fails such a build if the mnemonic shows up).
import { DEV_MNEMONIC, type DevRole, devAccount } from "@bookrunner/shared/devkeys";
import type { Address, LocalAccount } from "viem";
import { DEV_WALLETS } from "./devwallet";

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
