// EIP-712 price attestations (domain "Bookrunner AttestedOracle" v1, shared eip712.ts).
import { type PriceUpdate, priceTypedData } from "@bookrunner/shared";
import { type Address, type Hex, type LocalAccount, hashTypedData, recoverTypedDataAddress } from "viem";

export interface PriceSigner {
  readonly address: Address;
  sign(chainId: number, oracle: Address, u: PriceUpdate): Promise<Hex>;
}

export function accountSigner(account: LocalAccount): PriceSigner {
  return {
    address: account.address,
    sign: (chainId, oracle, u) => account.signTypedData(priceTypedData(chainId, oracle, u)),
  };
}

export function priceDigest(chainId: number, oracle: Address, u: PriceUpdate): Hex {
  return hashTypedData(priceTypedData(chainId, oracle, u));
}

export function recoverPriceSigner(chainId: number, oracle: Address, u: PriceUpdate, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...priceTypedData(chainId, oracle, u), signature });
}
