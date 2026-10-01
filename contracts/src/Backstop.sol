// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IBackstop} from "./interfaces/IBkrnFeeRouter.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";

/// @title Backstop — syndicate backstop funded by 50% of protocol carry.
/// @notice Covers Senior shortfalls of a book after its Junior tranche is exhausted, up to the pool:
///         a registered book receives `min(shortfall, balance, maxCoverBps * balance / 1e4)` USDC in its
///         UnderwritingVault. "Backstop up to the pool" — never more than it holds.
/// @dev `balance()` is the full USDC balance (acknowledged deposits plus any direct donations), all of
///      which is available for cover. `accountedBalance` tracks acknowledged deposits net of cover and is
///      used to verify `notifyDeposit` claims (push-then-notify).
contract Backstop is IBackstop, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 private constant DEFAULT_ADMIN_ROLE = 0x00;
    uint256 private constant BPS = 10_000;

    /// @notice Protocol registry.
    IBookrunnerConfig public immutable config;
    /// @notice USDC (config.usdc() at deployment).
    IERC20 public immutable usdc;

    /// @notice Per-cover cap as a share of the current balance (bps, default 10000 = no cap).
    uint16 public maxCoverBps;
    /// @notice Acknowledged deposits net of cover (always <= balance()).
    uint256 public accountedBalance;
    /// @notice Lifetime acknowledged deposits.
    uint256 public totalDeposited;
    /// @notice Lifetime cover paid.
    uint256 public totalCovered;

    error ZeroAddress();
    error ZeroAmount();
    error NotBook(uint256 bookId, address caller);
    error NotAdmin(address caller);
    error NotConfigured(bytes32 what);
    error DepositNotReceived(uint256 amount, uint256 unaccounted);
    error InvalidBps(uint256 bps);

    /// @notice Per-cover cap changed.
    event MaxCoverBpsSet(uint16 bps);

    /// @param config_ BookrunnerConfig; `usdc()` must already be set.
    constructor(address config_) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        address usdc_ = IBookrunnerConfig(config_).usdc();
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        maxCoverBps = uint16(BPS);
        emit MaxCoverBpsSet(uint16(BPS));
    }

    /// @inheritdoc IBackstop
    function balance() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice The most a single `cover` call can currently pay: `balance * maxCoverBps / 1e4`.
    function coverable() public view returns (uint256) {
        return (balance() * maxCoverBps) / BPS;
    }

    /// @inheritdoc IBackstop
    /// @dev Callable by anyone (fee router or donors) but only for USDC that has actually arrived and has
    ///      not been acknowledged yet.
    function notifyDeposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balance();
        uint256 accounted = accountedBalance;
        uint256 unaccounted = bal > accounted ? bal - accounted : 0;
        if (unaccounted < amount) revert DepositNotReceived(amount, unaccounted);
        accountedBalance = accounted + amount;
        totalDeposited += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @inheritdoc IBackstop
    /// @dev Only `config.factory().bookOf(bookId)`. Pays `min(shortfall, coverable())` to the calling
    ///      book's vault (`IBook(msg.sender).components().vault`).
    function cover(uint256 bookId, uint256 shortfall) external nonReentrant returns (uint256 covered) {
        address factory = config.factory();
        if (factory == address(0) || IBookFactory(factory).bookOf(bookId) != msg.sender) {
            revert NotBook(bookId, msg.sender);
        }
        uint256 cap = coverable();
        covered = shortfall < cap ? shortfall : cap;
        if (covered > 0) {
            address vault = IBook(msg.sender).components().vault;
            if (vault == address(0)) revert NotConfigured("vault");
            uint256 accounted = accountedBalance;
            accountedBalance = accounted > covered ? accounted - covered : 0;
            totalCovered += covered;
            emit Covered(bookId, shortfall, covered);
            usdc.safeTransfer(vault, covered);
        } else {
            emit Covered(bookId, shortfall, 0);
        }
    }

    /// @notice Sets the per-cover cap (1..10000 bps). Config admin (timelock) only.
    function setMaxCoverBps(uint16 bps) external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        if (bps == 0 || bps > BPS) revert InvalidBps(bps);
        maxCoverBps = bps;
        emit MaxCoverBpsSet(bps);
    }
}
