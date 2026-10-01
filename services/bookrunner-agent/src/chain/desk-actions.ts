// IBookrunnerDesk.Action encoders (ARCHITECTURE.md §2.7 "Action data encodings"). Pure.

import { HEDGE_VENUES } from "@bookrunner/shared";
import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters } from "viem";

/** IBookrunnerDesk.ActionKind (enum order is normative). */
export const DESK_ACTION = {
  Hedge: 0,
  InventoryToVenue: 1,
  InventoryToVault: 2,
  FundDesk: 3,
  ReturnToVault: 4,
  SetQuote: 5,
  Flatten: 6,
} as const;
export type DeskActionKind = (typeof DESK_ACTION)[keyof typeof DESK_ACTION];
export const DESK_ACTION_NAME: Record<DeskActionKind, keyof typeof DESK_ACTION> = Object.fromEntries(
  Object.entries(DESK_ACTION).map(([k, v]) => [v, k]),
) as Record<DeskActionKind, keyof typeof DESK_ACTION>;

export interface DeskAction {
  kind: DeskActionKind;
  data: Hex;
  proof: Hex[];
}

const UINT16_MAX = 0xffff;
const INT16_MAX = 0x7fff;
const UINT128_MAX = (1n << 128n) - 1n;

const SET_QUOTE_PARAMS = [
  { type: "uint16", name: "spreadBps" },
  { type: "int16", name: "skewBps" },
  { type: "uint128", name: "maxNetExposureUsd" },
] as const;

export function encodeSetQuote(spreadBps: number, skewBps: number, maxNetExposureUsd: bigint): DeskAction {
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps > UINT16_MAX) throw new Error(`SetQuote: spreadBps out of uint16 range: ${spreadBps}`);
  if (!Number.isInteger(skewBps) || skewBps < -INT16_MAX - 1 || skewBps > INT16_MAX) throw new Error(`SetQuote: skewBps out of int16 range: ${skewBps}`);
  if (maxNetExposureUsd < 0n || maxNetExposureUsd > UINT128_MAX) throw new Error(`SetQuote: maxNetExposureUsd out of uint128 range`);
  return {
    kind: DESK_ACTION.SetQuote,
    data: encodeAbiParameters(SET_QUOTE_PARAMS, [spreadBps, skewBps, maxNetExposureUsd]),
    proof: [],
  };
}

export function decodeSetQuote(data: Hex): { spreadBps: number; skewBps: number; maxNetExposureUsd: bigint } {
  const [spreadBps, skewBps, maxNetExposureUsd] = decodeAbiParameters(SET_QUOTE_PARAMS, data);
  return { spreadBps, skewBps, maxNetExposureUsd };
}

export function encodeHedge(p: {
  token: Address;
  buy: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
  poolFee: number;
  venue?: Hex;
  proof: Hex[];
}): DeskAction {
  return {
    kind: DESK_ACTION.Hedge,
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint24" }, { type: "bytes32" }],
      [p.token, p.buy, p.amountIn, p.minAmountOut, p.poolFee, p.venue ?? HEDGE_VENUES.UNIV3],
    ),
    proof: p.proof,
  };
}

export function encodeFlatten(p: { token: Address; amountIn: bigint; minAmountOut: bigint; poolFee: number; venue?: Hex }): DeskAction {
  return {
    kind: DESK_ACTION.Flatten,
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint24" }, { type: "bytes32" }],
      [p.token, p.amountIn, p.minAmountOut, p.poolFee, p.venue ?? HEDGE_VENUES.UNIV3],
    ),
    proof: [],
  };
}

export function encodeFundDesk(amount: bigint): DeskAction {
  return { kind: DESK_ACTION.FundDesk, data: encodeAbiParameters([{ type: "uint256" }], [amount]), proof: [] };
}

export function encodeReturnToVault(amount: bigint): DeskAction {
  return { kind: DESK_ACTION.ReturnToVault, data: encodeAbiParameters([{ type: "uint256" }], [amount]), proof: [] };
}
