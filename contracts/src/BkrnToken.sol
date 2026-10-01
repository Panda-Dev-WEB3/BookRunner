// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title BkrnToken — $BKRN, the Bookrunner access and bonding token.
/// @notice Fixed supply of 1,000,000,000 BKRN (18 decimals) minted once in the constructor, split
///         80 / 10 / 5 / 5 between the `community`, `studio`, `liquidity` and `contributors` recipients.
///         No mint function exists after construction. Supports EIP-2612 permits.
contract BkrnToken is ERC20, ERC20Permit {
    /// @notice Total (and maximum) supply.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant COMMUNITY_BPS = 8000;
    uint256 public constant STUDIO_BPS = 1000;
    uint256 public constant LIQUIDITY_BPS = 500;
    uint256 public constant CONTRIBUTORS_BPS = 500;

    error ZeroAddress();

    /// @notice Emitted once at construction with the four allocation recipients and amounts.
    event InitialAllocation(
        address indexed community,
        address indexed studio,
        address liquidity,
        address contributors,
        uint256 communityAmount,
        uint256 studioAmount,
        uint256 liquidityAmount,
        uint256 contributorsAmount
    );

    /// @param community receives 80% of supply
    /// @param studio receives 10% of supply
    /// @param liquidity receives 5% of supply
    /// @param contributors receives 5% of supply
    constructor(address community, address studio, address liquidity, address contributors)
        ERC20("Bookrunner", "BKRN")
        ERC20Permit("Bookrunner")
    {
        if (
            community == address(0) || studio == address(0) || liquidity == address(0)
                || contributors == address(0)
        ) {
            revert ZeroAddress();
        }
        uint256 studioAmount = (TOTAL_SUPPLY * STUDIO_BPS) / 10_000;
        uint256 liquidityAmount = (TOTAL_SUPPLY * LIQUIDITY_BPS) / 10_000;
        uint256 contributorsAmount = (TOTAL_SUPPLY * CONTRIBUTORS_BPS) / 10_000;
        uint256 communityAmount = TOTAL_SUPPLY - studioAmount - liquidityAmount - contributorsAmount;

        _mint(community, communityAmount);
        _mint(studio, studioAmount);
        _mint(liquidity, liquidityAmount);
        _mint(contributors, contributorsAmount);

        emit InitialAllocation(
            community,
            studio,
            liquidity,
            contributors,
            communityAmount,
            studioAmount,
            liquidityAmount,
            contributorsAmount
        );
    }
}
