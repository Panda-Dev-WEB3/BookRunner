// docs/LOW_GAS.md entry points the mark keeper uses beyond the generated ABIs (packages/shared/src/abi).
import { parseAbi, toFunctionSelector } from "viem";

/** MarkRegistry.commitAndApply selector (bytecode feature detection on registries that strip revert data). */
export const COMMIT_AND_APPLY_SELECTOR = toFunctionSelector("commitAndApply((uint256,uint64,uint256,uint256,uint64,bytes32,bytes32,bytes32),bytes,bytes,bytes)");

/**
 * AttestedOracle.update(priceData) declared `view` here ONLY so it can sit in an eth_call aggregate (deployless
 * Multicall3) ahead of the views that should see its effect; the encoding is identical.
 */
export const oracleUpdateAsViewAbi = parseAbi(["function update(bytes priceData) view"]);
export const ORACLE_UPDATE_SELECTOR = toFunctionSelector("update(bytes)");
