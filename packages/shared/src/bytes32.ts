import { type Address, type Hex, getAddress, hexToString, isAddress, keccak256, padHex, stringToHex, toBytes } from "viem";

/** ASCII string (<= 32 bytes) -> right-padded bytes32, as Solidity `bytes32("PERP_NVDA_USDC")`. */
export function strToBytes32(s: string): Hex {
  if (toBytes(s).length > 32) throw new Error(`string too long for bytes32: ${s}`);
  return stringToHex(s, { size: 32 });
}

/** right-padded bytes32 -> ASCII string with trailing NULs trimmed. */
export function bytes32ToStr(b: Hex): string {
  return hexToString(b, { size: 32 }).replace(/\0+$/, "");
}

/** Charter.underlying for a Stock Token: address left-padded to bytes32. */
export function tokenUnderlying(token: Address): Hex {
  return padHex(getAddress(token), { size: 32, dir: "left" }).toLowerCase() as Hex;
}

/**
 * Charter.underlying for an index: keccak256("BKRN.INDEX." + name). Upper 12 bytes are non-zero with
 * overwhelming probability; registry.registerIndex rejects ids whose upper 12 bytes are zero.
 */
export function indexUnderlying(name: string): Hex {
  return keccak256(stringToHex(`BKRN.INDEX.${name}`));
}

/** True if bytes32 encodes an address (upper 12 bytes zero). */
export function isTokenUnderlying(u: Hex): boolean {
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(u);
}

export function underlyingToToken(u: Hex): Address {
  if (!isTokenUnderlying(u)) throw new Error(`not a token underlying: ${u}`);
  const a = `0x${u.slice(26)}`;
  if (!isAddress(a)) throw new Error(`bad address in underlying: ${u}`);
  return getAddress(a);
}

/** Oracle price id for an equity / index, e.g. priceId("NVDA") = bytes32("NVDA"). */
export const priceId = (ticker: string): Hex => strToBytes32(ticker);

/** Venue ids used in hedge allow-lists (Mandate.hedgeAllowRoot leaves). */
export const HEDGE_VENUES = {
  UNIV3: strToBytes32("UNIV3"),
  UNIV4: strToBytes32("UNIV4"),
  ORDERLY: strToBytes32("ORDERLY"),
  ENGINE: strToBytes32("ENGINE"),
} as const;
