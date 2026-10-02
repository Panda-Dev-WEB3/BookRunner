// Test funds on non-mainnet chains: native gas balance checks, and a mint transaction for the mock
// USDC the devnet / testnet deployments use (MockERC20.mint is open there; real USDC reverts, so the
// UI only offers it after an eth_call simulation succeeds). Pure helpers, unit-tested.
import { type Address, type Hex, encodeFunctionData, getAddress } from "viem";

export const MOCK_MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** ERC-4626 asset() of a tranche: the USDC it settles in. */
export const TRANCHE_ASSET_ABI = [{ type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;

/** 10,000 USDC (6 decimals). */
export const TEST_USDC_AMOUNT = 10_000_000_000n;

export interface MintTx {
  to: Address;
  data: Hex;
  value: "0";
  chainId: number;
  description: string;
}

export function mockMintData(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: MOCK_MINT_ABI, functionName: "mint", args: [getAddress(to), amount] });
}

export function mockMintTx(usdc: Address, to: Address, amount: bigint, chainId: number, label = "USDC"): MintTx {
  const whole = amount / 1_000_000n;
  return {
    to: getAddress(usdc),
    data: mockMintData(to, amount),
    value: "0",
    chainId,
    description: `Mint ${whole.toLocaleString("en-US")} test ${label} to ${to.slice(0, 6)}…${to.slice(-4)} (mock token, test networks only)`,
  };
}

/** wei -> "0.0123 ETH" (4 significant decimals, trailing zeros trimmed). */
export function fmtEth(wei: bigint | null | undefined, symbol = "ETH"): string {
  if (wei == null) return "—";
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  const body = `${whole.toLocaleString("en-US")}${fracStr ? `.${fracStr}` : ""}`;
  const shown = body === "0" && abs > 0n ? "<0.0001" : body;
  return `${neg ? "-" : ""}${shown} ${symbol}`;
}

/** anvil_setBalance amount for the devnet top-up (10 ETH) as a 0x quantity. */
export const DEVNET_TOPUP_WEI = 10n * 10n ** 18n;
export const toQuantity = (v: bigint): Hex => `0x${v.toString(16)}` as Hex;
