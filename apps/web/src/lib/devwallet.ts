// Devnet "dev wallet" metadata: the protocol roles a dev wallet can sign for, with labels. Offered
// only on a devnet build whose API reports chain 31337; never on a live chain. The signer itself
// (the anvil mnemonic and the key derivation) lives in ./devsigner and is loaded only by a devnet
// build (wallet/devSigner.ts), so it never ships in a testnet or mainnet bundle.
import type { DevRole } from "@bookrunner/shared/devkeys";

import { DEVNET_CHAIN_ID } from "./chainConfig";

export { DEVNET_CHAIN_ID };

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

const LISTED = new Set<string>(DEV_WALLETS.map((w) => w.role));

/** A role the dev-wallet picker offers (the only roles a stored selection may name). */
export const isDevRole = (s: string | null | undefined): s is DevRole => !!s && LISTED.has(s);

export const devEntry = (role: DevRole): DevWalletEntry | undefined => DEV_WALLETS.find((w) => w.role === role);

/**
 * Dev wallets are offered only on a devnet build (the signer is compiled in) for chain 31337, and
 * only while the API is on 31337 too (unknown counts as yes until /health answers).
 */
export function devWalletsAvailable(i: { devBuild: boolean; appChainId: number; apiChainId: number | null }): boolean {
  return i.devBuild && i.appChainId === DEVNET_CHAIN_ID && (i.apiChainId === null || i.apiChainId === DEVNET_CHAIN_ID);
}

/**
 * The wallet mode that applies now. A stored "dev" choice only counts while dev wallets are
 * available: the devnet and testnet dev servers share 127.0.0.1:5180 (and its storage), so a "dev"
 * choice made on devnet must not hide a browser wallet that wagmi reconnected on testnet.
 */
export function effectiveMode<M extends "dev" | "injected" | null>(mode: M, devAvailable: boolean): M | null {
  return mode === "dev" && !devAvailable ? null : mode;
}
