// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IVenueAdapter} from "../../../src/interfaces/IVenueAdapter.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";

/// @notice Venue adapter mock with separate IF and MM accounts (synchronous, like the engine): the IF equity and the
///         MM value move independently (gains mint, losses burn the USDC held), deployedValueUsd = IF + MM + IF in transit.
///         [2026-10 pool follow-up m-6] `setIfAsync(true)`: IF deposits and recalls stay in flight (`ifInTransit`,
///         counted in deployedValueUsd like OrderlyAdapter's in-transit) until `landIf()`.
contract MockPoolAdapter is IVenueAdapter {
    MockERC20 public immutable usdcToken;
    address public vault;
    address public book;
    uint256 public ifEquity;
    uint256 public mmValue;
    bool public revertInsurance;
    bool public ifAsync;
    /// @notice IF in flight: a deposit not yet at the venue or a recall not yet in the vault (`ifInTransitIsRecall`).
    uint256 public ifInTransit;
    bool public ifInTransitIsRecall;

    constructor(MockERC20 usdc_) {
        usdcToken = usdc_;
    }

    function initialize(address, uint256, address book_) external {
        book = book_;
    }

    function setVault(address v) external {
        vault = v;
    }

    function setRevertInsurance(bool r) external {
        revertInsurance = r;
    }

    function venueKind() external pure returns (uint8) {
        return BRTypes.VENUE_POOL_ENGINE;
    }

    function setIfAsync(bool a) external {
        ifAsync = a;
    }

    /// @notice Test hook: the IF in flight arrives (a deposit at the venue, a recall in the vault).
    function landIf() external {
        uint256 amount = ifInTransit;
        ifInTransit = 0;
        if (ifInTransitIsRecall) IERC20(address(usdcToken)).transfer(vault, amount);
        else ifEquity += amount;
    }

    function depositToVenue(uint8 account, uint256 amount) external {
        require(msg.sender == vault, "MockPoolAdapter: not vault");
        IERC20(address(usdcToken)).transferFrom(vault, address(this), amount);
        if (account == BRTypes.ACCOUNT_IF && ifAsync) (ifInTransit, ifInTransitIsRecall) = (ifInTransit + amount, false);
        else if (account == BRTypes.ACCOUNT_IF) ifEquity += amount;
        else mmValue += amount;
        emit VenueDeposit(account, amount);
    }

    function requestWithdraw(uint8 account, uint256 amount) external {
        require(msg.sender == vault, "MockPoolAdapter: not vault");
        if (account == BRTypes.ACCOUNT_IF) {
            if (amount > ifEquity) amount = ifEquity;
            ifEquity -= amount;
            if (ifAsync) {
                (ifInTransit, ifInTransitIsRecall) = (ifInTransit + amount, true);
                emit WithdrawRequested(account, amount, 0);
                return;
            }
        } else {
            if (amount > mmValue) amount = mmValue;
            mmValue -= amount;
        }
        IERC20(address(usdcToken)).transfer(vault, amount);
        emit WithdrawRequested(account, amount, 0);
    }

    /// @notice Test hook: the IF equity becomes `v` (traders' bad debt burns, a refill mints).
    function setIfEquity(uint256 v) external {
        _move(ifEquity, v);
        ifEquity = v;
    }

    /// @notice Test hook: the MM value becomes `v` (P&L).
    function setMmValue(uint256 v) external {
        _move(mmValue, v);
        mmValue = v;
    }

    function _move(uint256 from, uint256 to) private {
        if (to > from) usdcToken.mint(address(this), to - from);
        else if (to < from) usdcToken.burn(address(this), from - to);
    }

    function sweepToVault() external pure returns (uint256) {
        return 0;
    }

    function sweepFees(uint64, uint256) external pure returns (uint256) {
        return 0;
    }

    function insuranceEquityUsd() external view returns (uint256) {
        require(!revertInsurance, "MockPoolAdapter: insurance");
        return ifEquity;
    }

    function marginEquityUsd() external view returns (int256) {
        return int256(mmValue);
    }

    function netExposureUsd() external pure returns (int256) {
        return 0;
    }

    function inTransitUsd() external view returns (uint256) {
        return ifInTransit;
    }

    /// @notice As OrderlyAdapter.insuranceInTransitUsd: the IF part of inTransitUsd.
    function insuranceInTransitUsd() external view returns (uint256) {
        return ifInTransit;
    }

    function deployedValueUsd() external view returns (uint256) {
        return ifEquity + mmValue + ifInTransit;
    }

    function valuationAt() external view returns (uint64) {
        return uint64(block.timestamp);
    }
}

/// @notice BkrnFeeRouter stand-in: accepts carry.
contract MockCarrySink {
    uint256 public carry;

    function notifyCarry(uint256, uint256 amount) external {
        carry += amount;
    }
}
