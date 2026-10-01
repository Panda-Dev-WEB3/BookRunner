// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IOrderlyVault — Orderly Network chain Vault (omnichain deposits).
/// @notice VERIFY: struct layout, function names, and the RHC (4663) deployment address against
///         Orderly's published contracts (github.com/OrderlyNetwork/contract-evm) before mainnet.
///         accountId = keccak256(abi.encode(address user, bytes32 brokerHash)) (VERIFY).
///         brokerHash = keccak256(bytes(brokerId)); tokenHash = keccak256(bytes("USDC")) (VERIFY).
///         Withdrawals are requested off-chain via the Orderly API with an EIP-712 signature from the
///         account's (delegate) signer and are paid to the account address on the chosen chain.
interface IOrderlyVault {
    struct VaultDepositFE {
        bytes32 accountId;
        bytes32 brokerHash;
        bytes32 tokenHash;
        uint128 tokenAmount;
    }

    struct VaultDelegate {
        bytes32 brokerHash;
        address delegateSigner;
    }

    function deposit(VaultDepositFE calldata data) external payable;
    function depositTo(address receiver, VaultDepositFE calldata data) external payable;
    function getDepositFee(address receiver, VaultDepositFE calldata data) external view returns (uint256);
    function delegateSigner(VaultDelegate calldata data) external;
    function getAllowedToken(bytes32 tokenHash) external view returns (address);
}
