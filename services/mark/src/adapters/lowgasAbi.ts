// docs/LOW_GAS.md entry points the mark keeper calls. Kept as local fragments (binding signatures) so the
// service works whether or not the regenerated ABIs (scripts/gen-abi.ts) already include them.
import { parseAbi, toFunctionSelector } from "viem";

export const markRegistryLowGasAbi = parseAbi([
  "struct MarkInput { uint256 bookId; uint64 periodEnd; uint256 navUsd; uint256 deployedValueUsd; uint64 flowNonce; bytes32 inventoryRoot; bytes32 pnlJsonHash; bytes32 receiptsRoot; }",
  "function commitAndApply(MarkInput m, bytes sig, bytes priceData, bytes venueReport) returns (uint256 markId)",
]);

export const COMMIT_AND_APPLY_SELECTOR = toFunctionSelector("commitAndApply((uint256,uint64,uint256,uint256,uint64,bytes32,bytes32,bytes32),bytes,bytes,bytes)");

/**
 * AttestedOracle.update(priceData) declared `view` here ONLY so it can sit in an eth_call aggregate (deployless
 * Multicall3) ahead of the views that should see its effect; the encoding is identical.
 */
export const oracleUpdateAsViewAbi = parseAbi(["function update(bytes priceData) view"]);
export const ORACLE_UPDATE_SELECTOR = toFunctionSelector("update(bytes)");
