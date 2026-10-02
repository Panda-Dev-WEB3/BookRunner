// Low-gas entry points (docs/LOW_GAS.md §1) the agent and trader-sim call, as minimal local fragments:
// the generated ABIs in @bookrunner/shared/abi predate them. mergeAbi() drops a fragment once the
// regenerated ABI already carries the same signature, so both states compile and resolve identically.
// supportsFunction() detects whether a DEPLOYED contract has the entry point (an older deployment keeps
// the legacy path: desk.execute / 3-arg trade / 2-arg liquidate).

import { attestedOracleAbi } from "@bookrunner/shared/abi";
import { type Abi, type Address, type Hex, type PublicClient, parseAbi, toFunctionSelector } from "viem";
import { formatAbiItem } from "viem/utils";

/** BookrunnerDesk.executeWithPrices(Action, priceData): oracle.update(priceData) first (when non-empty), then execute(action). */
export const deskPullAbi = parseAbi([
  "struct Action { uint8 kind; bytes data; bytes32[] proof; }",
  "function executeWithPrices(Action action, bytes priceData) returns (bytes result)",
]);
export const EXECUTE_WITH_PRICES_SIG = "executeWithPrices((uint8,bytes,bytes32[]),bytes)";

/** PoolEngine overloads with a trailing priceData. */
export const enginePullAbi = parseAbi([
  "function trade(uint256 marketId, int256 sizeDelta, uint256 acceptablePriceWad, bytes priceData) returns (uint256 fillPriceWad, uint256 feeUsd)",
  "function liquidate(uint256 marketId, address trader, bytes priceData) returns (uint256 rewardUsd)",
  "function liquidate(uint256 marketId, address trader) returns (uint256 rewardUsd)",
  "function isLiquidatable(uint256 marketId, address trader) view returns (bool)",
]);
export const TRADE_WITH_PRICES_SIG = "trade(uint256,int256,uint256,bytes)";
export const LIQUIDATE_WITH_PRICES_SIG = "liquidate(uint256,address,bytes)";

/** BookrunnerConfig.maxTradePriceAge (seconds; the latency-arbitrage bound of pull-oracle trades). */
export const configPullAbi = parseAbi(["function maxTradePriceAge() view returns (uint256)"]);
export const DEFAULT_MAX_TRADE_PRICE_AGE_SEC = 15;

/** AttestedOracle custom errors that bubble up through executeWithPrices / trade(..., priceData). */
export const ORACLE_ERRORS = attestedOracleAbi.filter((x) => (x as { type: string }).type === "error");

const signatureOf = (item: Abi[number]): string => {
  try {
    return `${item.type}:${formatAbiItem(item as never)}`;
  } catch {
    return JSON.stringify(item);
  }
};

/** base + every extra item whose canonical signature base does not already have (order kept). */
export function mergeAbi(base: Abi, ...extra: Abi[]): Abi {
  const seen = new Set(base.map(signatureOf));
  const out: Abi[number][] = [...base];
  for (const abi of extra) {
    for (const item of abi) {
      const sig = signatureOf(item);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }
  }
  return out as Abi;
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
