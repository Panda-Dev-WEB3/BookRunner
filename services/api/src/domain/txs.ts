// Prepared transactions: on-chain mutations are never sent by the API. They are encoded here and
// returned to the user's wallet as {to, data, value: "0", chainId, description}.
import type { Charter } from "@bookrunner/shared/types";
import { strToBytes32 } from "@bookrunner/shared/bytes32";
import { bkrnStakingAbi, marketCharterAbi, mMMandateAbi, riskCommitteeAbi, trancheAbi } from "@bookrunner/shared/abi";
import { type Address, type Hex, encodeFunctionData, erc20Abi, getAddress } from "viem";
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
    encodeFunctionData({ abi: marketCharterAbi, functionName: "file", args: [c] }),
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

export function depositTx(chainId: number, tranche: Address, amountUsd: bigint, receiver: Address, label: string): PreparedTx {
  return tx(
    chainId,
    tranche,
    encodeFunctionData({ abi: trancheAbi, functionName: "deposit", args: [amountUsd, getAddress(receiver)] }),
    `Commit ${trimUsd(amountUsd)} USDC to ${label} (allocated pro-rata at window close; any excess is refundable)`,
  );
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
    `Claim the full ${label} commitment back (book cancelled at window close)`,
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
