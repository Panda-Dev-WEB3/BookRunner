// Inventory tree (pure): StandardMerkleTree over INVENTORY_LEAF (location, asset, amount, valueUsd).
// Locations are bytes32 ASCII: VAULT, VENUE_IF, VENUE_MM, IN_TRANSIT, DESK_USDC, DESK_<TICKER>.
// Every fixed location is always present (zero rows included) so the leaf set is complete and stable.
import { type BuiltTree, inventoryTree, strToBytes32, tokenUnderlying } from "@bookrunner/shared";
import type { Hex } from "viem";
import type { MarkSnapshot } from "./types";

export const LOCATION = {
  VAULT: strToBytes32("VAULT"),
  VENUE_IF: strToBytes32("VENUE_IF"),
  VENUE_MM: strToBytes32("VENUE_MM"),
  IN_TRANSIT: strToBytes32("IN_TRANSIT"),
  DESK_USDC: strToBytes32("DESK_USDC"),
} as const;

export function deskLocation(ticker: string): Hex {
  const t = ticker
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, "")
    .slice(0, 27); // "DESK_" + 27 = 32 bytes
  return strToBytes32(`DESK_${t || "TOKEN"}`);
}

export interface InventoryItem {
  location: Hex;
  asset: Hex;
  amount: bigint; // int256 (VENUE_MM may be negative)
  valueUsd: bigint; // uint256
}

export function inventoryItems(s: Pick<MarkSnapshot, "usdc" | "vaultIdle" | "venue" | "desk">): InventoryItem[] {
  const usdc = tokenUnderlying(s.usdc);
  const pos = (x: bigint) => (x > 0n ? x : 0n);
  const items: InventoryItem[] = [
    { location: LOCATION.VAULT, asset: usdc, amount: s.vaultIdle, valueUsd: s.vaultIdle },
    { location: LOCATION.VENUE_IF, asset: usdc, amount: s.venue.insuranceUsd, valueUsd: s.venue.insuranceUsd },
    { location: LOCATION.VENUE_MM, asset: usdc, amount: s.venue.marginUsd, valueUsd: pos(s.venue.marginUsd) },
    { location: LOCATION.IN_TRANSIT, asset: usdc, amount: s.venue.inTransitUsd, valueUsd: s.venue.inTransitUsd },
    { location: LOCATION.DESK_USDC, asset: usdc, amount: s.desk.usdc, valueUsd: s.desk.usdc },
  ];
  for (const p of s.desk.positions) {
    if (p.qtyRaw === 0n) continue;
    items.push({ location: deskLocation(p.ticker), asset: tokenUnderlying(p.token), amount: p.qtyRaw, valueUsd: p.valueUsd });
  }
  return items;
}

export function buildInventory(s: Pick<MarkSnapshot, "usdc" | "vaultIdle" | "venue" | "desk">): { items: InventoryItem[]; tree: BuiltTree; root: Hex } {
  const items = inventoryItems(s);
  const tree = inventoryTree(items);
  return { items, tree, root: tree.root };
}
