// docs/LOW_GAS.md entry points the mark keeper uses beyond the generated ABIs (packages/shared/src/abi).
import { markRegistryAbi } from "@bookrunner/shared/abi";
import { getAbiItem, parseAbi, toFunctionSelector } from "viem";

/**
 * MarkRegistry.commitAndApply selector (bytecode feature detection on registries that strip revert data). Derived from
 * the generated ABI, so a MarkInput change (2026-10: insuranceEquityUsd) moves it with the contract.
 */
export const COMMIT_AND_APPLY_SELECTOR = toFunctionSelector(getAbiItem({ abi: markRegistryAbi, name: "commitAndApply" }));

/**
 * AttestedOracle.update(priceData) declared `view` here ONLY so it can sit in an eth_call aggregate (deployless
 * Multicall3) ahead of the views that should see its effect; the encoding is identical.
 */
export const oracleUpdateAsViewAbi = parseAbi(["function update(bytes priceData) view"]);
export const ORACLE_UPDATE_SELECTOR = toFunctionSelector("update(bytes)");
