// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test/devnet Robinhood-style Stock Token: ERC-20 (18 decimals) + ERC-8056 `uiMultiplier()` (WAD)
///         with Robinhood's scheduled-update views (`newUIMultiplier`, `effectiveAt`) and the advisory
///         `oraclePaused()` flag. Open mint and open admin — never deploy to mainnet.
contract MockStockToken is ERC20 {
    uint256 internal _current;
    uint256 internal _next;
    uint256 internal _effectiveAt;
    bool public oraclePaused;

    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);

    constructor(string memory name_, string memory symbol_, uint256 multiplierWad) ERC20(name_, symbol_) {
        _current = multiplierWad;
        _next = multiplierWad;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Active multiplier: the staged value once `effectiveAt` has passed.
    function uiMultiplier() public view returns (uint256) {
        return block.timestamp >= _effectiveAt ? _next : _current;
    }

    function newUIMultiplier() external view returns (uint256) {
        return _next;
    }

    function effectiveAt() external view returns (uint256) {
        return _effectiveAt;
    }

    /// @notice Immediate update (Robinhood: small dividend reinvestments).
    function updateMultiplier(uint256 m) external {
        updateMultiplier(m, block.timestamp);
    }

    /// @notice Scheduled update (Robinhood: splits, behind an oracle pause).
    function updateMultiplier(uint256 m, uint256 at) public {
        uint256 old = uiMultiplier();
        _current = old;
        _next = m;
        _effectiveAt = at;
        emit UIMultiplierUpdated(old, m, at);
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }
}
