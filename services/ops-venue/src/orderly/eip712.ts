// Orderly EIP-712 messages (signing side). Mirror of services/mock-orderly/src/orderly712.ts.
// Confirmed (2026-10) against https://orderly.network/docs/build-on-omnichain/user-flows/wallet-authentication and
// github.com/OrderlyNetwork/contract-evm src/library/Signature.sol:
//   off-chain domain {name "Orderly", version "1", chainId = the user's chain, verifyingContract 0xCcCC…cccC}:
//     Registration, AddOrderlyKey, DelegateSigner, DelegateAddOrderlyKey
//   on-chain domain (verifyingContract = Orderly Ledger: mainnet 0x6F7a…D203, testnet 0x1826…ffbf):
//     Withdraw, DelegateWithdraw (= Withdraw with a leading `address delegateContract`), SettlePnl
//   `amount` is uint256 raw token units in the signature (1 USDC = 1000000) and a string in the REST body;
//   timestamps / nonces are numbers in the REST body (docs examples).
// VERIFY: the chainId Orderly expects for Robinhood Chain (4663 per GET /v1/public/chain_info).
import type { Address, Hex, LocalAccount } from "viem";

export const ORDERLY_OFFCHAIN_VERIFYING_CONTRACT = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" as const;
export const ORDERLY_LEDGER_MAINNET = "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203" as const;
export const ORDERLY_LEDGER_TESTNET = "0x1826B75e2ef249173FC735149AE4B8e9ea10abff" as const;

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

export interface WithdrawParams {
  brokerId: string;
  chainId: number;
  receiver: Address;
  token: string; // Orderly token symbol: "USDC"; "USDG" on Robinhood Chain
  amount: bigint; // raw token units (6 dp)
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
    withdrawNonce: Number(p.withdrawNonce),
    timestamp: Number(p.timestamp),
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
      timestamp: Number(p.timestamp),
      expiration: Number(p.expiration),
      ...(p.delegateContract ? { delegateContract: p.delegateContract } : {}),
    },
    signature,
  };
}

export interface DelegateSignerParams {
  delegateContract: Address;
  brokerId: string;
  chainId: number;
  timestamp: bigint; // ms
  registrationNonce: bigint; // GET /v1/registration_nonce (valid 2 minutes, single use)
  txHash: Hex; // the contract's Vault.delegateSigner transaction
}

/** Signs DelegateSigner (POST /v1/delegate_signer): the delegate EOA confirms the on-chain delegation. */
export async function signDelegateSigner(signer: LocalAccount, p: DelegateSignerParams): Promise<{ message: Record<string, string | number>; signature: Hex }> {
  if (!signer.signTypedData) throw new Error("signer cannot sign typed data");
  const signature = await signer.signTypedData({
    domain: orderlyDomain(p.chainId, ORDERLY_OFFCHAIN_VERIFYING_CONTRACT),
    types: delegateSignerTypes,
    primaryType: "DelegateSigner",
    message: { delegateContract: p.delegateContract, brokerId: p.brokerId, chainId: BigInt(p.chainId), timestamp: p.timestamp, registrationNonce: p.registrationNonce, txHash: p.txHash },
  });
  return {
    message: {
      delegateContract: p.delegateContract,
      brokerId: p.brokerId,
      chainId: p.chainId,
      timestamp: Number(p.timestamp),
      registrationNonce: Number(p.registrationNonce),
      txHash: p.txHash,
    },
    signature,
  };
}
