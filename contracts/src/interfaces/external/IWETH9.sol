// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IWETH9 — wrapped native ETH (Robinhood Chain WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, VERIFY S3).
interface IWETH9 {
    function deposit() external payable;

    /// @notice Burns `amount` WETH of the caller and sends it `amount` native ETH.
    function withdraw(uint256 amount) external;
}
