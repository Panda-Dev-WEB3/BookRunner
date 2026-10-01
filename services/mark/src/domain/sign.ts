// EIP-712 mark signing (shared eip712.ts markTypedData; domain "Bookrunner MarkRegistry" v1).
import { type MarkInput, markTypedData } from "@bookrunner/shared";
import { type Address, type Hex, type LocalAccount, hashTypedData, recoverTypedDataAddress } from "viem";

export async function signMark(account: LocalAccount, chainId: number, registry: Address, input: MarkInput): Promise<Hex> {
  return account.signTypedData(markTypedData(chainId, registry, input));
}

export function markDigest(chainId: number, registry: Address, input: MarkInput): Hex {
  return hashTypedData(markTypedData(chainId, registry, input));
}

export function recoverMarkSigner(chainId: number, registry: Address, input: MarkInput, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...markTypedData(chainId, registry, input), signature });
}
