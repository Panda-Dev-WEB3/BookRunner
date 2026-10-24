// Prepared transactions: on-chain mutations are never sent by the API. They are encoded here and
// returned to the user's wallet as {to, data, value: "0", chainId, description}.
import type { Charter } from "@bookrunner/shared/types";
import { strToBytes32 } from "@bookrunner/shared/bytes32";
import { charterArg } from "@bookrunner/shared/insurancePool";
import { attestedOracleAbi, bkrnStakingAbi, insurancePoolAbi, marketCharterAbi, mMMandateAbi, poolEngineAbi, riskCommitteeAbi, trancheAbi } from "@bookrunner/shared/abi";
import { type Address, type Hex, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, getAddress } from "viem";
import { bkrnStr, usdStr } from "../format";

export interface PreparedTx {
  to: Address;
  data: Hex;
  value: "0";
  chainId: number;
  description: string;
  /** Set when a multi-step flow needs a different wallet for this step (e.g. the operator's consentKey). */
  signer?: Address;
}

const tx = (chainId: number, to: Address, data: Hex, description: string): PreparedTx => ({
  to: getAddress(to),
  data,
  value: "0",
  chainId,
  description,
});

const trimUsd = (raw: bigint) => usdStr(raw).replace(/\.?0+$/, "");

export function approveUsdcTx(chainId: number, usdc: Address, spender: Address, amountUsd: bigint, purpose: string): PreparedTx {
  return tx(
    chainId,
    usdc,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), amountUsd] }),
    `Approve ${trimUsd(amountUsd)} USDC for ${purpose}`,
  );
}

export function approveBkrnTx(chainId: number, bkrn: Address, spender: Address, amount: bigint, purpose: string): PreparedTx {
  return tx(
    chainId,
    bkrn,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), amount] }),
    `Approve ${bkrnStr(amount)} BKRN for ${purpose}`,
  );
}

export function stakeTx(chainId: number, staking: Address, amount: bigint): PreparedTx {
  return tx(
    chainId,
    staking,
    encodeFunctionData({ abi: bkrnStakingAbi, functionName: "stake", args: [amount] }),
    `Stake ${bkrnStr(amount)} BKRN (bonding for the sponsor bond lock)`,
  );
}

export function fileCharterTx(chainId: number, marketCharter: Address, c: Charter, label: string): PreparedTx {
  return tx(
    chainId,
    marketCharter,
    encodeFunctionData({ abi: marketCharterAbi, functionName: "file", args: [charterArg(c)] }),
    `File charter ${label} (pays the flat charter fee and locks the sponsor bond)`,
  );
}

export function committeeVoteTx(chainId: number, committee: Address, charterId: number, approve: boolean): PreparedTx {
  return tx(
    chainId,
    committee,
    encodeFunctionData({ abi: riskCommitteeAbi, functionName: "vote", args: [BigInt(charterId), approve] }),
    `Committee vote to ${approve ? "approve" : "reject"} charter #${charterId}`,
  );
}

/**
 * When a commitment settles: at window close in a subscription window (round 0), or for a top-up
 * round at the first mark whose period ends at or after the round end (Tranche.settleAtMark).
 */
export type DepositSettlement = { kind: "window" } | { kind: "topup"; settlesAt: number | null };

const isoMinute = (sec: number) => `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function depositTx(chainId: number, tranche: Address, amountUsd: bigint, receiver: Address, label: string, settles: DepositSettlement = { kind: "window" }): PreparedTx {
  const when =
    settles.kind === "window"
      ? "allocated pro-rata at window close; any excess is refundable"
      : `accepted at the first mark at or after the round end${settles.settlesAt ? ` (${isoMinute(settles.settlesAt)})` : ""}, at that mark's share price; any excess is refundable then`;
  return tx(chainId, tranche, encodeFunctionData({ abi: trancheAbi, functionName: "deposit", args: [amountUsd, getAddress(receiver)] }), `Commit ${trimUsd(amountUsd)} USDC to ${label} (${when})`);
}

export function requestRedeemTx(chainId: number, tranche: Address, shares: bigint, wallet: Address, label: string): PreparedTx {
  const w = getAddress(wallet);
  return tx(
    chainId,
    tranche,
    encodeFunctionData({ abi: trancheAbi, functionName: "requestRedeem", args: [shares, w, w] }),
    `Request redemption of ${trimUsd(shares)} ${label} shares (settles at the first mark on or after the eligible time)`,
  );
}

export function claimAllocationTx(chainId: number, tranche: Address, wallet: Address, label: string): PreparedTx {
  return tx(
    chainId,
    tranche,
    encodeFunctionData({ abi: trancheAbi, functionName: "claimAllocation", args: [getAddress(wallet)] }),
    `Claim ${label} allocation (shares and any refund)`,
  );
}

export function claimRedemptionTx(chainId: number, tranche: Address, wallet: Address, label: string): PreparedTx {
  const w = getAddress(wallet);
  return tx(
    chainId,
    tranche,
    encodeFunctionData({ abi: trancheAbi, functionName: "claimRedemption", args: [w, w] }),
    `Claim settled ${label} redemptions (USDC)`,
  );
}

export function claimCancelledRefundTx(chainId: number, tranche: Address, wallet: Address, label: string): PreparedTx {
  return tx(
    chainId,
    tranche,
    encodeFunctionData({ abi: trancheAbi, functionName: "claimCancelledRefund", args: [getAddress(wallet)] }),
    `Claim the full ${label} commitment back (the round was cancelled)`,
  );
}

export function registerKeyTx(
  chainId: number,
  mandate: Address,
  key: Address,
  operator: Address,
  validUntil: bigint,
  inventoryTierUsd: bigint,
): PreparedTx {
  return tx(
    chainId,
    mandate,
    encodeFunctionData({
      abi: mMMandateAbi,
      functionName: "registerKey",
      args: [getAddress(key), getAddress(operator), validUntil, inventoryTierUsd],
    }),
    `Register desk key ${getAddress(key)} for operator ${getAddress(operator)} at a ${trimUsd(inventoryTierUsd)} USD inventory tier`,
  );
}

/** MMMandate.consentKey(key, true), signed by the OPERATOR: registerKey reverts OperatorConsentMissing without it. */
export function consentKeyTx(chainId: number, mandate: Address, key: Address, operator: Address): PreparedTx {
  return {
    ...tx(
      chainId,
      mandate,
      encodeFunctionData({ abi: mMMandateAbi, functionName: "consentKey", args: [getAddress(key), true] }),
      `Operator ${getAddress(operator)} consents to bond desk key ${getAddress(key)} (sign with the operator wallet, before the sponsor registers the key)`,
    ),
    signer: getAddress(operator),
  };
}

export function revokeKeyTx(chainId: number, mandate: Address, key: Address, reason: string): PreparedTx {
  return tx(
    chainId,
    mandate,
    encodeFunctionData({ abi: mMMandateAbi, functionName: "revokeKey", args: [getAddress(key), strToBytes32(reason)] }),
    `Revoke desk key ${getAddress(key)} (${reason}); effective in the same block`,
  );
}

// ------------------------------------------------------------------ insurance pool (2026-10, ARCHITECTURE §2.10)
const poolShares = (raw: bigint) => formatUnits(raw, 12).replace(/\.?0+$/, "") || "0";

export function poolRequestDepositTx(chainId: number, pool: Address, amountUsd: bigint, epoch: number, endsAtSec: number): PreparedTx {
  return tx(
    chainId,
    pool,
    encodeFunctionData({ abi: insurancePoolAbi, functionName: "requestDeposit", args: [amountUsd] }),
    `Queue ${trimUsd(amountUsd)} USDC into the insurance pool for epoch ${epoch} (priced when the epoch is processed, after ${isoMinute(endsAtSec)})`,
  );
}

export function poolCancelDepositTx(chainId: number, pool: Address, depositId: number, amountUsd: bigint): PreparedTx {
  return tx(
    chainId,
    pool,
    encodeFunctionData({ abi: insurancePoolAbi, functionName: "cancelDeposit", args: [BigInt(depositId)] }),
    `Cancel insurance pool deposit #${depositId} (refunds ${trimUsd(amountUsd)} USDC)`,
  );
}

export function poolClaimDepositTx(chainId: number, pool: Address, depositId: number, shares: bigint): PreparedTx {
  return tx(
    chainId,
    pool,
    encodeFunctionData({ abi: insurancePoolAbi, functionName: "claimDeposit", args: [BigInt(depositId)] }),
    `Collect ${poolShares(shares)} insurance pool shares of deposit #${depositId} (starts the cooldown)`,
  );
}

export function poolRequestWithdrawTx(chainId: number, pool: Address, shares: bigint, epoch: number, endsAtSec: number): PreparedTx {
  return tx(
    chainId,
    pool,
    encodeFunctionData({ abi: insurancePoolAbi, functionName: "requestWithdraw", args: [shares] }),
    `Queue ${poolShares(shares)} insurance pool shares for withdrawal in epoch ${epoch} (priced when the epoch is processed, after ${isoMinute(endsAtSec)})`,
  );
}

export function poolClaimTx(chainId: number, pool: Address, requestId: number, assetsUsd: bigint): PreparedTx {
  return tx(
    chainId,
    pool,
    encodeFunctionData({ abi: insurancePoolAbi, functionName: "claim", args: [BigInt(requestId)] }),
    `Collect ${trimUsd(assetsUsd)} USDC of insurance pool withdrawal #${requestId}`,
  );
}

// ------------------------------------------------------------------ in-house engine (2026-10 trading page)
/** Exact decimal of a 1e18 amount (viem formatUnits: "100", "2.5", never truncated or rounded). */
export const unitsText = (raw: bigint): string => formatUnits(raw < 0n ? -raw : raw, 18);

/** The words of a trade step, from its CALLDATA (review I-1): side, exact size and exact price limit of the encoded call. */
export function tradeDescription(data: Hex, label: string, what: string): string {
  const { functionName, args } = decodeFunctionData({ abi: poolEngineAbi, data });
  if (functionName !== "trade" || !args || args.length !== 4) throw new Error("not a PoolEngine.trade(..., priceData) call");
  const [, sizeDelta, acceptablePriceWad] = args as readonly [bigint, bigint, bigint, Hex];
  const buy = sizeDelta > 0n;
  return `${buy ? "Buy" : "Sell"} ${unitsText(sizeDelta)} ${label} (${what}), filled at no ${buy ? "more" : "less"} than ${formatUnits(acceptablePriceWad, 18)} per unit, or not at all`;
}

export function engineDepositMarginTx(chainId: number, engine: Address, marketId: number, amountUsd: bigint, label: string): PreparedTx {
  return tx(
    chainId,
    engine,
    encodeFunctionData({ abi: poolEngineAbi, functionName: "depositMargin", args: [BigInt(marketId), amountUsd] }),
    `Deposit ${trimUsd(amountUsd)} USDC of margin into the ${label} market (isolated: it backs only your position there)`,
  );
}

export function engineWithdrawMarginTx(chainId: number, engine: Address, marketId: number, amountUsd: bigint, label: string): PreparedTx {
  return tx(
    chainId,
    engine,
    encodeFunctionData({ abi: poolEngineAbi, functionName: "withdrawMargin", args: [BigInt(marketId), amountUsd] }),
    `Withdraw ${trimUsd(amountUsd)} USDC of margin from the ${label} market to your wallet`,
  );
}

/** PoolEngine.trade(marketId, sizeDelta, acceptablePriceWad, priceData): the trade carries its signed price (pull oracle). */
export function engineTradeTx(chainId: number, engine: Address, marketId: number, sizeDelta: bigint, acceptablePriceWad: bigint, priceData: Hex, label: string, what: string): PreparedTx {
  const data = encodeFunctionData({ abi: poolEngineAbi, functionName: "trade", args: [BigInt(marketId), sizeDelta, acceptablePriceWad, priceData] });
  return tx(chainId, engine, data, tradeDescription(data, label, what));
}

/** AttestedOracle.update(priceData): relays a signed price (permissionless; the oracle verifies the signature). */
export function oracleUpdateTx(chainId: number, oracle: Address, priceData: Hex, label: string): PreparedTx {
  return tx(chainId, oracle, encodeFunctionData({ abi: attestedOracleAbi, functionName: "update", args: [priceData] }), `Bring the latest signed ${label} price on chain (needed by the next step)`);
}
