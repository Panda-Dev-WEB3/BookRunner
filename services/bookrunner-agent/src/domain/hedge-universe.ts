// Hedge allow-list universe (pure): which (asset, venue) pairs the book may hedge with, the
// StandardMerkleTree over them (shared merkle.ts hedgeAllowTree, same leaf encoding as
// Mandate.hedgeAllowRoot) and a proof per component. Default pairs come from the charter: the
// underlying Stock Token on UNIV3, or every index component token on UNIV3 (weighted basket).

import { type BuiltTree, HEDGE_VENUES, hedgeAllowTree, proofFor, strToBytes32, tokenUnderlying } from "@bookrunner/shared";
import type { Address, Hex } from "viem";

export interface UniverseComponent {
  token: Address;
  weightBps: number;
}

export interface AllowPair {
  asset: Hex;
  venue: Hex;
}

export interface HedgeUniverse {
  components: Array<UniverseComponent & { assetId: Hex; proof: Hex[]; allowed: boolean }>;
  pairs: AllowPair[];
  tree: BuiltTree;
  root: Hex;
  rootMatches: boolean;
  perpAllowed: boolean;
}

export function defaultAllowPairs(components: UniverseComponent[], venue: Hex = HEDGE_VENUES.UNIV3): AllowPair[] {
  return components.map((c) => ({ asset: tokenUnderlying(c.token), venue }));
}

/** Parse a HEDGE_ALLOW_PAIRS override: [{asset, venue}] with bytes32 hex, addresses, or ASCII names. */
export function parseAllowPairs(json: string): AllowPair[] {
  const raw = JSON.parse(json) as Array<{ asset: string; venue: string }>;
  if (!Array.isArray(raw)) throw new Error("HEDGE_ALLOW_PAIRS must be a JSON array");
  const toB32 = (s: string): Hex => {
    if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase() as Hex;
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) return tokenUnderlying(s as Address);
    return strToBytes32(s);
  };
  return raw.map((p) => ({ asset: toB32(p.asset), venue: toB32(p.venue) }));
}

export function buildHedgeUniverse(components: UniverseComponent[], mandateRoot: Hex, pairs: AllowPair[] = defaultAllowPairs(components)): HedgeUniverse {
  const tree = hedgeAllowTree(pairs);
  const spotVenue = HEDGE_VENUES.UNIV3.toLowerCase();
  const has = (asset: Hex) => pairs.some((p) => p.asset.toLowerCase() === asset.toLowerCase() && p.venue.toLowerCase() === spotVenue);
  const comps = components.map((c) => {
    const assetId = tokenUnderlying(c.token);
    const allowed = has(assetId);
    return { ...c, assetId, allowed, proof: allowed ? proofFor(tree, [assetId, HEDGE_VENUES.UNIV3]) : [] };
  });
  const perpVenues = [HEDGE_VENUES.ORDERLY, HEDGE_VENUES.ENGINE].map((v) => v.toLowerCase());
  return {
    components: comps,
    pairs,
    tree,
    root: tree.root,
    rootMatches: tree.root.toLowerCase() === mandateRoot.toLowerCase(),
    perpAllowed: pairs.some((p) => perpVenues.includes(p.venue.toLowerCase())),
  };
}
