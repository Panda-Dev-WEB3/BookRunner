// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IOrderlyVault} from "../../src/interfaces/external/IOrderlyVault.sol";

/// @title OrderlyVaultAllowListMock — test stand-in for Orderly's chain Vault ALLOW LISTS (contract-evm `Vault.sol`):
///        `changeTokenAddressAndAllow(tokenHash, token)` / `setAllowedToken(tokenHash, allowed)` and
///        `getAllowedToken(tokenHash)` (the token address only while allowed, else 0x0: what the RH testnet vault answers
///        today for USDG and USDC), `setAllowedBroker(brokerHash, allowed)` / `getAllowedBroker(brokerHash)`. Deposits
///        follow the real rules the adapter relies on (token and broker allowed, the vault pulls the exact amount).
///        Not a MockOrderlyVault: no operator, no PnL minting (a live deployment must never need either).
contract OrderlyVaultAllowListMock is IOrderlyVault {
    using SafeERC20 for IERC20;

    error TokenNotAllowed();
    error BrokerNotAllowed();

    mapping(bytes32 => address) private _tokenAddress;
    mapping(bytes32 => bool) private _tokenAllowed;
    mapping(bytes32 => bool) private _brokerAllowed;
    uint256 public deposits;

    function changeTokenAddressAndAllow(bytes32 tokenHash, address token) external {
        _tokenAddress[tokenHash] = token;
        _tokenAllowed[tokenHash] = true;
    }

    function setAllowedToken(bytes32 tokenHash, bool allowed) external {
        _tokenAllowed[tokenHash] = allowed;
    }

    function setAllowedBroker(bytes32 brokerHash, bool allowed) external {
        _brokerAllowed[brokerHash] = allowed;
    }

    function getAllowedToken(bytes32 tokenHash) external view returns (address) {
        return _tokenAllowed[tokenHash] ? _tokenAddress[tokenHash] : address(0);
    }

    function getAllowedBroker(bytes32 brokerHash) external view returns (bool) {
        return _brokerAllowed[brokerHash];
    }

    function deposit(VaultDepositFE calldata data) external payable {
        _deposit(data);
    }

    function depositTo(address, VaultDepositFE calldata data) external payable {
        _deposit(data);
    }

    function getDepositFee(address, VaultDepositFE calldata) external pure returns (uint256) {
        return 0;
    }

    function delegateSigner(VaultDelegate calldata data) external view {
        if (!_brokerAllowed[data.brokerHash]) revert BrokerNotAllowed();
    }

    function _deposit(VaultDepositFE calldata data) private {
        if (!_tokenAllowed[data.tokenHash]) revert TokenNotAllowed();
        if (!_brokerAllowed[data.brokerHash]) revert BrokerNotAllowed();
        IERC20(_tokenAddress[data.tokenHash]).safeTransferFrom(msg.sender, address(this), data.tokenAmount);
        deposits += data.tokenAmount;
    }
}
