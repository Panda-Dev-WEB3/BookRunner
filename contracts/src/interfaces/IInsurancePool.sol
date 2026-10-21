// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IInsurancePool — the protocol-wide pool that funds the insurance fund (IF) of `ifFromPool` books.
/// @notice ERC-4626-style vault over the settlement token with epoch-based entry and exit. Depositors' assets fund the
///         IF of every pool-funded book and earn the premium those books pay out of their gross fee flow. A book owes
///         its allocation as a SENIOR DEBT: whatever draws the IF (traders' bad debt, the MM's losses) is the book's
///         loss first (Junior -> Senior -> backstop); the pool loses only what an exhausted book cannot repay, as the
///         book reports at its marks (`markBook`) and at retirement (first the treasury's first-loss slice, then the
///         depositors' share price). Deposits and withdrawals are queued to weekly epochs and priced when the epoch
///         is processed, which waits until every active book has applied a mark after the epoch end (or a bounded
///         grace period has passed, so exits are never blocked). See docs/ARCHITECTURE.md §2.10.
interface IInsurancePool {
    /// @notice A book's position. Identity: allocation - claim == lossFirstLoss + lossDepositors.
    struct BookPosition {
        address book; // recorded at allocate (the factory's book for the id)
        address vault; // the book's UnderwritingVault (receives the allocation, repays the debt)
        address router; // the book's RevenueRouter (pays the premium)
        bytes32 market; // the book's underlying (per-market cap)
        uint256 allocation; // debt principal outstanding (reduced by repayments)
        uint256 claim; // the pool's valuation of it: what the book can repay at its last mark (<= allocation)
        uint256 lossFirstLoss; // part of allocation - claim absorbed by the first-loss slice
        uint256 lossDepositors; // part absorbed by the depositors' share price
        uint64 lastMarkAt; // periodEnd of the book's last mark reported here (allocation time at first)
        bool active; // counted in the epoch freshness gate until the book's final mark
    }

    // ---- book hooks ----

    /// @notice Only the book of `bookId` (BookFactory.bookOf), once per book, at its closeWindow: sends `amount` to the
    ///         book's vault. Within the per-market cap (sum over the books on `market`) and the free liquidity above the
    ///         buffer, with the first-loss slice at its target; refused while allocations are paused or withdrawals are
    ///         due.
    function allocate(uint256 bookId, uint256 amount, bytes32 market) external;
    /// @notice Only the recorded book, at each applied mark (and its final one at retirement): `value` (<= allocation)
    ///         is what the book can repay (min(debt, vault idle + marked deployed value)). A fall below the pool's
    ///         claim is a pool loss (slice first), a rise a recovery. `final` ends the book's freshness obligation.
    function markBook(uint256 bookId, uint256 value, uint64 periodEnd, bool final_) external;
    /// @notice Only the recorded vault: repays `amount` (<= allocation) of the book's debt, pulled from the vault.
    function repay(uint256 bookId, uint256 amount) external;
    /// @notice Only the recorded router: the book's premium, pulled from the router.
    function notifyPremium(uint256 bookId, uint256 amount) external;

    // ---- depositors ----

    /// @notice Queues `assets` (pulled now) for the open epoch; shares are minted when the epoch is processed, at that
    ///         price. Not while deposits are paused.
    function requestDeposit(uint256 assets) external returns (uint256 depositId);
    /// @notice The owner, before the deposit's epoch ends: refunds it.
    function cancelDeposit(uint256 depositId) external;
    /// @notice Anyone, once the deposit's epoch is processed: transfers the owner's shares (starting their cooldown).
    function claimDeposit(uint256 depositId) external returns (uint256 shares);
    /// @notice Escrows `shares` of the caller and queues them for the first epoch ending after now and after the
    ///         caller's cooldown. Never refused (no pause, kill or market state blocks it).
    function requestWithdraw(uint256 shares) external returns (uint256 requestId);
    /// @notice Anyone: pays the request's owner what its epoch has filled for it so far.
    function claim(uint256 requestId) external returns (uint256 assets);
    /// @notice Anyone, once the oldest unprocessed epoch has ended and every active book marked after its end (or the
    ///         grace period passed): mints its deposits and fills withdrawals (oldest first) at the share price.
    function processEpoch() external returns (uint64 epoch);

    // ---- views ----

    function premiumFloorBps() external view returns (uint16);
    function bookPosition(uint256 bookId) external view returns (BookPosition memory);
    /// @notice Largest allocation `bookId` on `market` could draw now.
    function maxAllocation(uint256 bookId, bytes32 market) external view returns (uint256);
    /// @notice Pool value: free liquidity + book claims (first-loss slice included).
    function poolAssets() external view returns (uint256);
    function freeLiquidity() external view returns (uint256);
    function firstLossAssets() external view returns (uint256);
    function claimsTotal() external view returns (uint256);
    function utilisationBps() external view returns (uint256);

    event Allocated(uint256 indexed bookId, address indexed book, address vault, bytes32 indexed market, uint256 amount);
    event BookMarked(uint256 indexed bookId, uint256 value, uint64 periodEnd, bool final_);
    event LossReported(
        uint256 indexed bookId, uint256 amount, uint256 firstLossAbsorbed, uint256 depositorsAbsorbed, uint256 claim
    );
    event LossRecovered(
        uint256 indexed bookId, uint256 amount, uint256 firstLossRestored, uint256 depositorsRestored, uint256 claim
    );
    event Repaid(uint256 indexed bookId, uint256 amount, uint256 allocation);
    event PremiumReceived(uint256 indexed bookId, uint256 amount, uint256 firstLossShare);
    event DepositRequested(uint256 indexed depositId, address indexed owner, uint256 assets, uint64 indexed epoch);
    event DepositCancelled(uint256 indexed depositId, address indexed owner, uint256 assets);
    event DepositClaimed(uint256 indexed depositId, address indexed owner, uint256 shares);
    event WithdrawRequested(
        uint256 indexed requestId, address indexed owner, uint256 shares, uint64 indexed epoch, uint64 epochEndsAt
    );
    event EpochProcessed(uint64 indexed epoch, uint256 depositAssets, uint256 depositShares, bool stale);
    /// @notice The epoch was processed after the grace period with `staleBooks` books not marked since its end.
    event EpochProcessedStale(uint64 indexed epoch, uint256 staleBooks);
    event EpochFilled(uint64 indexed epoch, uint256 shares, uint256 assets, bool complete);
    event Claimed(uint256 indexed requestId, address indexed owner, uint256 assets);
    event FirstLossDeposited(address indexed from, uint256 amount);
    event FirstLossWithdrawn(address indexed to, uint256 amount);
    event PoolParamSet(bytes32 indexed key, uint256 value);
    event EpochLengthApplied(uint256 epochLength, uint64 nextEpochEndsAt);
    event PausedSet(bool deposits, bool allocations, address indexed by);
}

/// @notice BookrunnerConfig getter of the pool address (not in the frozen IBookrunnerConfig).
interface IBookrunnerConfigPool {
    function insurancePool() external view returns (address);
}

/// @notice Book surface of a pool-funded IF (Book extension, not in the frozen IBook).
interface IBookInsurance {
    /// @notice The pool that funded this book's IF at closeWindow (address(0): the tranches funded it).
    function insurancePool() external view returns (address);
    /// @notice Only the book's vault, before an IF recall (not while Live): the debt becomes due (cash-reserved and
    ///         repaid from vault idle by fundClaims before tranche claims).
    function onInsuranceRecall() external;
}
