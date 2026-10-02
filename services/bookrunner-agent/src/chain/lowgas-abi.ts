// Low-gas entry points (docs/LOW_GAS.md §1) the agent and trader-sim call. The generated ABIs in
// @bookrunner/shared/abi carry them (BookrunnerDesk.executeWithPrices, the PoolEngine trade / liquidate
// priceData overloads, BookrunnerConfig.maxTradePriceAge); this module holds their canonical signatures
// (pinned against the generated ABIs in test/lowgas-abi.test.ts) and supportsFunction(), which detects
// whether a DEPLOYED contract has the entry point: an older deployment keeps the legacy path
// (desk.execute / 3-arg trade / 2-arg liquidate) without a redeploy of the services.

import { attestedOracleAbi } from "@bookrunner/shared/abi";
import { type Abi, type Address, type Hex, type PublicClient, toFunctionSelector } from "viem";
import { formatAbiItem } from "viem/utils";

/** BookrunnerDesk.executeWithPrices(Action, priceData): oracle.update(priceData) first (when non-empty), then execute(action). */
export const EXECUTE_WITH_PRICES_SIG = "executeWithPrices((uint8,bytes,bytes32[]),bytes)";
/** PoolEngine.trade(marketId, sizeDelta, acceptablePriceWad, priceData) */
export const TRADE_WITH_PRICES_SIG = "trade(uint256,int256,uint256,bytes)";
/** PoolEngine.liquidate(marketId, trader, priceData) */
export const LIQUIDATE_WITH_PRICES_SIG = "liquidate(uint256,address,bytes)";
/** AttestedOracle.update(priceData) */
export const ORACLE_UPDATE_SIG = "update(bytes)";

/** BookrunnerConfig.maxTradePriceAge default (seconds; read from the chain, this is the fallback). */
export const DEFAULT_MAX_TRADE_PRICE_AGE_SEC = 15;

type OracleError = Extract<(typeof attestedOracleAbi)[number], { type: "error" }>;
/** AttestedOracle custom errors that bubble up through executeWithPrices / trade(..., priceData). */
export const ORACLE_ERRORS = attestedOracleAbi.filter((x): x is OracleError => (x as { type: string }).type === "error");

const signatureOf = (item: Abi[number]): string => {
  try {
    return `${item.type}:${formatAbiItem(item as never)}`;
  } catch {
    return JSON.stringify(item);
  }
};

/** base + every extra item whose canonical signature base does not already have (order kept). */
export function mergeAbi<const B extends Abi, const E extends Abi>(base: B, ...extra: E[]): readonly (B[number] | E[number])[] {
  const seen = new Set(base.map(signatureOf));
  const out: (B[number] | E[number])[] = [...base];
  for (const abi of extra) {
    for (const item of abi) {
      const sig = signatureOf(item);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------- deployed-code detection

const EIP1167_PREFIX = "363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

/** EIP-1167 minimal proxy (OZ Clones) runtime code -> implementation address, else null. */
export function cloneImplementation(code: Hex | undefined): Address | null {
  if (!code) return null;
  const c = code.toLowerCase().replace(/^0x/, "");
  if (c.length !== EIP1167_PREFIX.length + 40 + EIP1167_SUFFIX.length) return null;
  if (!c.startsWith(EIP1167_PREFIX) || !c.endsWith(EIP1167_SUFFIX)) return null;
  return `0x${c.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40)}` as Address;
}

/**
 * Whether runtime code dispatches `selector`: solc pushes every external selector as a constant
 * (PUSH4 sel, or a shorter PUSH when it has leading zero bytes) in the dispatcher.
 */
export function codeHasSelector(code: Hex | undefined, selector: Hex): boolean {
  if (!code || code === "0x") return false;
  const c = code.toLowerCase().replace(/^0x/, "");
  let s = selector.toLowerCase().replace(/^0x/, "");
  while (s.startsWith("00") && s.length > 2) s = s.slice(2);
  const push = (0x5f + s.length / 2).toString(16); // PUSH1 = 0x60
  return c.includes(push + s);
}

/** Does the contract at `address` (resolving an EIP-1167 clone to its implementation) implement `signature`? */
export async function supportsFunction(pub: Pick<PublicClient, "getCode">, address: Address, signature: string): Promise<boolean> {
  let code = await pub.getCode({ address });
  const impl = cloneImplementation(code);
  if (impl) code = await pub.getCode({ address: impl });
  return codeHasSelector(code, toFunctionSelector(signature));
}
