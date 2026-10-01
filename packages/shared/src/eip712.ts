import type { Address, Hex } from "viem";
import type { MarkInput } from "./types";

// EIP-712 definitions shared with MarkRegistry.sol and AttestedOracle.sol (keep in lockstep).

export const markDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "Bookrunner MarkRegistry", version: "1", chainId, verifyingContract }) as const;

export const markTypes = {
  Mark: [
    { name: "bookId", type: "uint256" },
    { name: "periodEnd", type: "uint64" },
    { name: "navUsd", type: "uint256" },
    { name: "deployedValueUsd", type: "uint256" },
    { name: "flowNonce", type: "uint64" },
    { name: "inventoryRoot", type: "bytes32" },
    { name: "pnlJsonHash", type: "bytes32" },
    { name: "receiptsRoot", type: "bytes32" },
  ],
} as const;

export const markTypedData = (chainId: number, registry: Address, m: MarkInput) =>
  ({ domain: markDomain(chainId, registry), types: markTypes, primaryType: "Mark", message: m }) as const;

export const oracleDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "Bookrunner AttestedOracle", version: "1", chainId, verifyingContract }) as const;

export const priceTypes = {
  Price: [
    { name: "underlying", type: "bytes32" },
    { name: "priceWad", type: "uint256" },
    { name: "publishedAt", type: "uint64" },
    { name: "held", type: "bool" },
    { name: "sourceCount", type: "uint32" },
    { name: "sourcesHash", type: "bytes32" },
  ],
} as const;

export interface PriceUpdate {
  underlying: Hex;
  priceWad: bigint;
  publishedAt: bigint;
  held: boolean;
  sourceCount: number;
  sourcesHash: Hex;
}

export const priceTypedData = (chainId: number, oracle: Address, p: PriceUpdate) =>
  ({ domain: oracleDomain(chainId, oracle), types: priceTypes, primaryType: "Price", message: p }) as const;
