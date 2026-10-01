// Orderly EIP-712 messages (verification side, mock-orderly). Mirror of
// services/ops-venue/src/orderly/eip712.ts — keep in lockstep (cross-checked by ops-venue tests).
//
// Confirmed (docs 2026-10, user-flows/withdrawal-deposit + wallet-authentication + delegate-signer):
//   off-chain domain {name:"Orderly", version:"1", chainId, verifyingContract:0xCcCC…cccC}  (AddOrderlyKey, DelegateAddOrderlyKey)
//   on-chain  domain {name:"Orderly", version:"1", chainId, verifyingContract: Ledger}       (Withdraw)
//   Withdraw(brokerId string, chainId uint256, receiver address, token string, amount uint256, withdrawNonce uint64, timestamp uint64)
//   AddOrderlyKey(brokerId string, chainId uint256, orderlyKey string, scope string, timestamp uint64, expiration uint64)
//   DelegateAddOrderlyKey(delegateContract address, brokerId string, chainId uint256, orderlyKey string, scope string, timestamp uint64, expiration uint64)
// VERIFY: DelegateWithdraw field list (assumed = Withdraw with a leading delegateContract), and the
//         domain used for the delegate withdraw (assumed on-chain/Ledger like Withdraw).
import { type Address, encodeAbiParameters, type Hex, keccak256, recoverTypedDataAddress, stringToHex } from "viem";

export const ORDERLY_OFFCHAIN_VERIFYING_CONTRACT = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" as const;
/** Orderly Ledger (mainnet) — verifyingContract of the Withdraw domain. VERIFY per environment. */
export const ORDERLY_LEDGER_MAINNET = "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203" as const;

export const orderlyDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "Orderly", version: "1", chainId, verifyingContract }) as const;

export const withdrawTypes = {
  Withdraw: [
    { name: "brokerId", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "receiver", type: "address" },
    { name: "token", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "withdrawNonce", type: "uint64" },
    { name: "timestamp", type: "uint64" },
  ],
} as const;

export const delegateWithdrawTypes = {
  DelegateWithdraw: [
    { name: "delegateContract", type: "address" },
    { name: "brokerId", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "receiver", type: "address" },
    { name: "token", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "withdrawNonce", type: "uint64" },
    { name: "timestamp", type: "uint64" },
  ],
} as const;

export const addOrderlyKeyTypes = {
  AddOrderlyKey: [
    { name: "brokerId", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "orderlyKey", type: "string" },
    { name: "scope", type: "string" },
    { name: "timestamp", type: "uint64" },
    { name: "expiration", type: "uint64" },
  ],
} as const;

export const delegateAddOrderlyKeyTypes = {
  DelegateAddOrderlyKey: [
    { name: "delegateContract", type: "address" },
    { name: "brokerId", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "orderlyKey", type: "string" },
    { name: "scope", type: "string" },
    { name: "timestamp", type: "uint64" },
    { name: "expiration", type: "uint64" },
  ],
} as const;

export const delegateSignerTypes = {
  DelegateSigner: [
    { name: "delegateContract", type: "address" },
    { name: "brokerId", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "timestamp", type: "uint64" },
    { name: "registrationNonce", type: "uint256" },
    { name: "txHash", type: "bytes32" },
  ],
} as const;

export interface DelegateSignerMessageJson {
  delegateContract: string;
  brokerId: string;
  chainId: number | string;
  timestamp: string | number;
  registrationNonce: string | number;
  txHash: string;
}

export async function recoverDelegateSignerLink(msg: DelegateSignerMessageJson, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({
    domain: orderlyDomain(Number(msg.chainId), ORDERLY_OFFCHAIN_VERIFYING_CONTRACT),
    types: delegateSignerTypes,
    primaryType: "DelegateSigner",
    message: {
      delegateContract: msg.delegateContract as Address,
      brokerId: msg.brokerId,
      chainId: BigInt(msg.chainId),
      timestamp: BigInt(msg.timestamp),
      registrationNonce: BigInt(msg.registrationNonce),
      txHash: msg.txHash as Hex,
    },
    signature,
  });
}

/** Orderly account id (VERIFY): keccak256(abi.encode(address user, keccak256(bytes(brokerId)))). */
export function orderlyAccountId(user: Address, brokerId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [user, keccak256(stringToHex(brokerId))]));
}

export interface WithdrawMessageJson {
  brokerId: string;
  chainId: number | string;
  receiver: string;
  token: string;
  amount: string | number;
  withdrawNonce: string | number;
  timestamp: string | number;
  delegateContract?: string;
}

export interface AddKeyMessageJson {
  brokerId: string;
  chainId: number | string;
  orderlyKey: string;
  scope: string;
  timestamp: string | number;
  expiration: string | number;
  delegateContract?: string;
}

export async function recoverWithdrawSigner(
  msg: WithdrawMessageJson,
  signature: Hex,
  verifyingContract: Address,
  delegate: boolean,
): Promise<Address> {
  const chainId = Number(msg.chainId);
  const base = {
    brokerId: msg.brokerId,
    chainId: BigInt(msg.chainId),
    receiver: msg.receiver as Address,
    token: msg.token,
    amount: BigInt(msg.amount),
    withdrawNonce: BigInt(msg.withdrawNonce),
    timestamp: BigInt(msg.timestamp),
  };
  if (delegate) {
    return recoverTypedDataAddress({
      domain: orderlyDomain(chainId, verifyingContract),
      types: delegateWithdrawTypes,
      primaryType: "DelegateWithdraw",
      message: { delegateContract: (msg.delegateContract ?? "0x0000000000000000000000000000000000000000") as Address, ...base },
      signature,
    });
  }
  return recoverTypedDataAddress({
    domain: orderlyDomain(chainId, verifyingContract),
    types: withdrawTypes,
    primaryType: "Withdraw",
    message: base,
    signature,
  });
}

export async function recoverAddKeySigner(msg: AddKeyMessageJson, signature: Hex, delegate: boolean): Promise<Address> {
  const chainId = Number(msg.chainId);
  const base = {
    brokerId: msg.brokerId,
    chainId: BigInt(msg.chainId),
    orderlyKey: msg.orderlyKey,
    scope: msg.scope,
    timestamp: BigInt(msg.timestamp),
    expiration: BigInt(msg.expiration),
  };
  if (delegate) {
    return recoverTypedDataAddress({
      domain: orderlyDomain(chainId, ORDERLY_OFFCHAIN_VERIFYING_CONTRACT),
      types: delegateAddOrderlyKeyTypes,
      primaryType: "DelegateAddOrderlyKey",
      message: { delegateContract: (msg.delegateContract ?? "0x0000000000000000000000000000000000000000") as Address, ...base },
      signature,
    });
  }
  return recoverTypedDataAddress({
    domain: orderlyDomain(chainId, ORDERLY_OFFCHAIN_VERIFYING_CONTRACT),
    types: addOrderlyKeyTypes,
    primaryType: "AddOrderlyKey",
    message: base,
    signature,
  });
}
