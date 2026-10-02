// Feature detection on deployed bytecode (backward compatibility with pre-low-gas deployments).
import type { Address, Hex, PublicClient } from "viem";

/** ERC-1967 implementation slot (UUPS proxies). */
export const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** PUSHn opcode + immediate of a 4-byte selector as the Solidity dispatcher emits it (leading zero bytes dropped). */
export function selectorPush(selector: Hex): string {
  let hex = selector.slice(2).toLowerCase().padStart(8, "0");
  while (hex.length > 2 && hex.startsWith("00")) hex = hex.slice(2);
  return `${(0x5f + hex.length / 2).toString(16)}${hex}`;
}

/** True when the contract at `address` (or its ERC-1967 implementation) dispatches `selector`. */
export async function codeHasSelector(pc: Pick<PublicClient, "getStorageAt" | "getCode">, address: Address, selector: Hex): Promise<boolean> {
  let target: Address = address;
  try {
    const slot = await pc.getStorageAt({ address, slot: ERC1967_IMPL_SLOT });
    if (slot && !/^0x0*$/.test(slot)) target = `0x${slot.slice(-40)}` as Address;
  } catch {
    /* not a proxy, or storage reads unsupported */
  }
  const code = ((await pc.getCode({ address: target })) ?? "0x").toLowerCase();
  return code.includes(selectorPush(selector));
}
