// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IOrderlyVault} from "./interfaces/external/IOrderlyVault.sol";

/// @title OrderlyIFAccount — owner of a book's Orderly insurance-fund (IF) account.
/// @notice Orderly derives `accountId = keccak256(abi.encode(owner, brokerHash))`: ONE account per (address,
///         broker). A book needs two accounts (IF and MM), so the MM account is the OrderlyAdapter's own and
///         the IF account is owned by this contract, deployed by the adapter (CREATE2, one per book).
///
///         It holds no logic beyond what the adapter needs:
///           - `delegateSigner` registers the book's delegate EOA for this contract account on the Orderly
///             Vault (Orderly requires the caller to be the contract that owns the account);
///           - `forward` moves this contract's whole balance of a token to the adapter (the ONLY destination).
///         Deposits into the IF account are made by the adapter with `Vault.depositTo(this, ...)`. Withdrawals
///         from a contract account are paid to the contract itself (delegate flow), land here and are pulled
///         by the adapter (`sweepToVault` / fee forwarding), where the adapter's accounting applies unchanged.
///         Only the adapter can call it; it has no owner, no upgrade path and refuses ETH.
contract OrderlyIFAccount {
    using SafeERC20 for IERC20;

    /// @notice The OrderlyAdapter proxy that deployed this contract (sole caller and sole destination).
    address public immutable adapter;

    event Forwarded(address indexed token, uint256 amount);
    event DelegateSignerRegistered(address indexed orderlyVault, bytes32 indexed brokerHash, address indexed signer);

    error NotAdapter();

    constructor() {
        adapter = msg.sender;
    }

    modifier onlyAdapter() {
        if (msg.sender != adapter) revert NotAdapter();
        _;
    }

    /// @notice Adapter only. Calls `IOrderlyVault.delegateSigner({brokerHash, signer})` as this contract account.
    function delegateSigner(address orderlyVault, bytes32 brokerHash, address signer) external onlyAdapter {
        IOrderlyVault(orderlyVault)
            .delegateSigner(IOrderlyVault.VaultDelegate({brokerHash: brokerHash, delegateSigner: signer}));
        emit DelegateSignerRegistered(orderlyVault, brokerHash, signer);
    }

    /// @notice Adapter only. Sends this contract's whole `token` balance to the adapter.
    /// @return amount Amount forwarded (0 when there is nothing to forward).
    function forward(address token) external onlyAdapter returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount != 0) {
            IERC20(token).safeTransfer(adapter, amount);
            emit Forwarded(token, amount);
        }
    }
}
