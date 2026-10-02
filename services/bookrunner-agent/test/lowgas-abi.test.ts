// Low-gas entry points in the generated ABIs (pinned to the LOW_GAS.md signatures) + deployed-code
// feature detection (EIP-1167 clones resolved to the implementation).
import { describe, expect, test } from "bun:test";
import { attestedOracleAbi, bookrunnerConfigAbi, bookrunnerDeskAbi, poolEngineAbi } from "@bookrunner/shared/abi";
import { type Abi, type Address, type Hex, decodeFunctionData, encodeFunctionData, toFunctionSelector } from "viem";
import { formatAbiItem } from "viem/utils";
import { DESK_PULL_ABI } from "../src/chain/desk-client";
import {
  EXECUTE_WITH_PRICES_SIG,
  LIQUIDATE_WITH_PRICES_SIG,
  ORACLE_ERRORS,
  ORACLE_UPDATE_SIG,
  TRADE_WITH_PRICES_SIG,
  cloneImplementation,
  codeHasSelector,
  mergeAbi,
  supportsFunction,
} from "../src/chain/lowgas-abi";
import { ENGINE_PULL_ABI } from "../src/sim/engine-trader";

const IMPL = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const cloneCode = (impl: Address): Hex => `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`;
/** A fake dispatcher: PUSH4 <selector> for each implemented function (what solc emits). */
const dispatcher = (...sigs: string[]): Hex => `0x6080604052${sigs.map((s) => `63${toFunctionSelector(s).slice(2)}1461`).join("")}00`;

/** Canonical signatures of every function `name` in `abi` (overloads included). */
const sigsOf = (abi: readonly unknown[], name: string) =>
  (abi as Abi)
    .filter((x) => x.type === "function" && x.name === name)
    .map((x) => formatAbiItem(x as never).replace(/^function /, ""))
    .sort();

const count = (abi: readonly unknown[], type: string, name: string) =>
  (abi as Abi).filter((x) => x.type === type && "name" in x && x.name === name).length;

describe("generated ABIs carry the LOW_GAS.md entry points", () => {
  test("desk execute + executeWithPrices, engine trade / liquidate overloads, oracle update, config maxTradePriceAge", () => {
    expect(sigsOf(bookrunnerDeskAbi, "executeWithPrices")).toEqual([EXECUTE_WITH_PRICES_SIG]);
    expect(sigsOf(bookrunnerDeskAbi, "execute")).toEqual(["execute((uint8,bytes,bytes32[]))"]);
    expect(sigsOf(poolEngineAbi, "trade")).toEqual(["trade(uint256,int256,uint256)", TRADE_WITH_PRICES_SIG].sort());
    expect(sigsOf(poolEngineAbi, "liquidate")).toEqual(["liquidate(uint256,address)", LIQUIDATE_WITH_PRICES_SIG].sort());
    expect(sigsOf(attestedOracleAbi, "update")).toEqual([ORACLE_UPDATE_SIG]);
    expect(sigsOf(bookrunnerConfigAbi, "maxTradePriceAge")).toEqual(["maxTradePriceAge()"]);
    expect(toFunctionSelector(TRADE_WITH_PRICES_SIG)).toBe("0x72ff4739");
  });

  test("mergeAbi adds an item once and never duplicates what the base already has", () => {
    const once = mergeAbi(bookrunnerDeskAbi as unknown as Abi, ORACLE_ERRORS as unknown as Abi);
    const twice = mergeAbi(once as Abi, ORACLE_ERRORS as unknown as Abi, bookrunnerDeskAbi as unknown as Abi);
    expect(twice.length).toBe(once.length);
    expect(count(DESK_PULL_ABI, "function", "executeWithPrices")).toBe(1);
    expect(count(DESK_PULL_ABI, "function", "execute")).toBe(1);
    // AttestedOracle errors decode through the desk / engine ABIs (in-tx update reverts); StalePrice
    // (same signature in PoolEngine and AttestedOracle) appears once
    expect(count(DESK_PULL_ABI, "error", "BadSigner")).toBe(1);
    expect(count(DESK_PULL_ABI, "error", "FuturePrice")).toBe(1);
    expect(count(DESK_PULL_ABI, "error", "StalePrice")).toBe(1);
    expect(count(ENGINE_PULL_ABI, "error", "BadSigner")).toBe(1);
    expect(count(ENGINE_PULL_ABI, "error", "StalePrice")).toBe(1);
  });

  test("overloaded trade / liquidate resolve by arity (legacy and priceData); executeWithPrices encodes", () => {
    const legacy = encodeFunctionData({ abi: ENGINE_PULL_ABI, functionName: "trade", args: [1n, 10n, 5n] });
    const pull = encodeFunctionData({ abi: ENGINE_PULL_ABI, functionName: "trade", args: [1n, 10n, 5n, "0xabcd"] });
    expect(legacy.slice(0, 10)).toBe(toFunctionSelector("trade(uint256,int256,uint256)"));
    expect(pull.slice(0, 10)).toBe(toFunctionSelector(TRADE_WITH_PRICES_SIG));
    expect(decodeFunctionData({ abi: ENGINE_PULL_ABI, data: pull }).args).toEqual([1n, 10n, 5n, "0xabcd"]);
    const liq = encodeFunctionData({ abi: ENGINE_PULL_ABI, functionName: "liquidate", args: [1n, IMPL, "0x01"] });
    expect(liq.slice(0, 10)).toBe(toFunctionSelector(LIQUIDATE_WITH_PRICES_SIG));
    const liqLegacy = encodeFunctionData({ abi: ENGINE_PULL_ABI, functionName: "liquidate", args: [1n, IMPL] });
    expect(liqLegacy.slice(0, 10)).toBe(toFunctionSelector("liquidate(uint256,address)"));
    const desk = encodeFunctionData({ abi: DESK_PULL_ABI, functionName: "executeWithPrices", args: [{ kind: 5, data: "0x", proof: [] }, "0x01"] });
    expect(desk.slice(0, 10)).toBe(toFunctionSelector(EXECUTE_WITH_PRICES_SIG));
  });
});

describe("deployed-code detection", () => {
  test("cloneImplementation reads an OZ Clones (EIP-1167) runtime; anything else -> null", () => {
    expect(cloneImplementation(cloneCode(IMPL))).toBe(IMPL);
    expect(cloneImplementation(cloneCode(IMPL).toUpperCase().replace("0X", "0x") as Hex)).toBe(IMPL);
    expect(cloneImplementation(dispatcher("execute((uint8,bytes,bytes32[]))"))).toBeNull();
    expect(cloneImplementation("0x")).toBeNull();
    expect(cloneImplementation(undefined)).toBeNull();
  });

  test("codeHasSelector finds PUSH4 selectors (and the shorter PUSH for leading-zero selectors)", () => {
    const code = dispatcher("execute((uint8,bytes,bytes32[]))", EXECUTE_WITH_PRICES_SIG);
    expect(codeHasSelector(code, toFunctionSelector(EXECUTE_WITH_PRICES_SIG))).toBe(true);
    expect(codeHasSelector(dispatcher("execute((uint8,bytes,bytes32[]))"), toFunctionSelector(EXECUTE_WITH_PRICES_SIG))).toBe(false);
    expect(codeHasSelector("0x620abcde14", "0x000abcde")).toBe(true); // PUSH3 0abcde
    expect(codeHasSelector("0x630abcde14", "0x000abcde")).toBe(false);
    expect(codeHasSelector("0x", "0x12345678")).toBe(false);
  });

  test("supportsFunction resolves a clone to its implementation", async () => {
    const DESK = "0x00000000000000000000000000000000000d0e5c" as Address;
    const codes = new Map<string, Hex>([
      [DESK.toLowerCase(), cloneCode(IMPL)],
      [IMPL.toLowerCase(), dispatcher("execute((uint8,bytes,bytes32[]))", EXECUTE_WITH_PRICES_SIG)],
    ]);
    const pub = { getCode: async ({ address }: { address: Address }) => codes.get(address.toLowerCase()) };
    expect(await supportsFunction(pub as never, DESK, EXECUTE_WITH_PRICES_SIG)).toBe(true);
    expect(await supportsFunction(pub as never, DESK, TRADE_WITH_PRICES_SIG)).toBe(false);
    codes.set(IMPL.toLowerCase(), dispatcher("execute((uint8,bytes,bytes32[]))")); // legacy implementation
    expect(await supportsFunction(pub as never, DESK, EXECUTE_WITH_PRICES_SIG)).toBe(false);
    expect(await supportsFunction({ getCode: async () => undefined } as never, DESK, EXECUTE_WITH_PRICES_SIG)).toBe(false);
  });
});
