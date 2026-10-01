// Orderly EIP-712 messages (signing side). Mirror of services/mock-orderly/src/orderly712.ts.
// Confirmed (docs 2026-10): Withdraw + AddOrderlyKey + DelegateAddOrderlyKey types; off-chain domain
// verifyingContract 0xCcCC…cccC; Withdraw domain verifyingContract = Orderly Ledger
// (mainnet 0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203). Amount: uint256 in the signature, string in REST.
// VERIFY: DelegateWithdraw field list (assumed Withdraw + leading delegateContract), the chainId to use
//         for Robinhood Chain withdrawals, and that `amount` is in USDC raw units (6 dp).
import type { Address, Hex, LocalAccount } from "viem";

export const ORDERLY_OFFCHAIN_VERIFYING_CONTRACT = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" as const;
export const ORDERLY_LEDGER_MAINNET = "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203" as const;

export const orderlyDomain = (chainId: number, verifyingContract: Address) => ({ name: "Orderly", version: "1", chainId, verifyingContract }) as const;

const WITHDRAW_FIELDS = [
  { name: "brokerId", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "receiver", type: "address" },
  { name: "token", type: "string" },
  { name: "amount", type: "uint256" },
  { name: "withdrawNonce", type: "uint64" },
  { name: "timestamp", type: "uint64" },
] as const;

const ADD_KEY_FIELDS = [
  { name: "brokerId", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "orderlyKey", type: "string" },
  { name: "scope", type: "string" },
  { name: "timestamp", type: "uint64" },
  { name: "expiration", type: "uint64" },
] as const;

export const withdrawTypes = { Withdraw: WITHDRAW_FIELDS } as const;
export const delegateWithdrawTypes = { DelegateWithdraw: [{ name: "delegateContract", type: "address" }, ...WITHDRAW_FIELDS] } as const;
export const addOrderlyKeyTypes = { AddOrderlyKey: ADD_KEY_FIELDS } as const;
export const delegateAddOrderlyKeyTypes = { DelegateAddOrderlyKey: [{ name: "delegateContract", type: "address" }, ...ADD_KEY_FIELDS] } as const;

export interface WithdrawParams {
  brokerId: string;
  chainId: number;
  receiver: Address;
  token: string;
  amount: bigint; // USDC raw (6 dp) — VERIFY
  withdrawNonce: bigint;
  timestamp: bigint; // ms
  delegateContract?: Address;
}

/** Signs Withdraw (EOA account) or DelegateWithdraw (contract account via its delegate signer). */
export async function signWithdraw(signer: LocalAccount, p: WithdrawParams, verifyingContract: Address): Promise<{ message: Record<string, string | number>; signature: Hex }> {
  if (!signer.signTypedData) throw new Error("signer cannot sign typed data");
  const base = { brokerId: p.brokerId, chainId: BigInt(p.chainId), receiver: p.receiver, token: p.token, amount: p.amount, withdrawNonce: p.withdrawNonce, timestamp: p.timestamp };
  const signature = p.delegateContract
    ? await signer.signTypedData({ domain: orderlyDomain(p.chainId, verifyingContract), types: delegateWithdrawTypes, primaryType: "DelegateWithdraw", message: { delegateContract: p.delegateContract, ...base } })
    : await signer.signTypedData({ domain: orderlyDomain(p.chainId, verifyingContract), types: withdrawTypes, primaryType: "Withdraw", message: base });
  const message: Record<string, string | number> = {
    brokerId: p.brokerId,
    chainId: p.chainId,
    receiver: p.receiver,
    token: p.token,
    amount: p.amount.toString(),
    withdrawNonce: p.withdrawNonce.toString(),
    timestamp: p.timestamp.toString(),
    ...(p.delegateContract ? { delegateContract: p.delegateContract } : {}),
  };
  return { message, signature };
}

export interface AddKeyParams {
  brokerId: string;
  chainId: number;
  orderlyKey: string;
  scope: string; // comma list, e.g. "read,trading"
  timestamp: bigint; // ms
  expiration: bigint; // ms
  delegateContract?: Address;
}

export async function signAddKey(signer: LocalAccount, p: AddKeyParams): Promise<{ message: Record<string, string | number>; signature: Hex }> {
  if (!signer.signTypedData) throw new Error("signer cannot sign typed data");
  const domain = orderlyDomain(p.chainId, ORDERLY_OFFCHAIN_VERIFYING_CONTRACT);
  const base = { brokerId: p.brokerId, chainId: BigInt(p.chainId), orderlyKey: p.orderlyKey, scope: p.scope, timestamp: p.timestamp, expiration: p.expiration };
  const signature = p.delegateContract
    ? await signer.signTypedData({ domain, types: delegateAddOrderlyKeyTypes, primaryType: "DelegateAddOrderlyKey", message: { delegateContract: p.delegateContract, ...base } })
    : await signer.signTypedData({ domain, types: addOrderlyKeyTypes, primaryType: "AddOrderlyKey", message: base });
  return {
    message: {
      brokerId: p.brokerId,
      chainId: p.chainId,
      orderlyKey: p.orderlyKey,
      scope: p.scope,
      timestamp: p.timestamp.toString(),
      expiration: p.expiration.toString(),
      ...(p.delegateContract ? { delegateContract: p.delegateContract } : {}),
    },
    signature,
  };
}
