// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IInsurancePool — the protocol-wide pool that funds the insurance fund (IF) of `ifFromPool` books.
/// @notice ERC-4626 vault over the settlement token. Depositors' assets back every pool-funded book's IF and earn the
///         premium those books pay out of their gross fee flow; traders' bad debt drawn from an IF below its allocation
///         is the pool's loss (first the treasury's first-loss slice, then the depositors' share price). Exits are a
///         weekly queue: `requestWithdraw` is never refused, `claim` pays once the request's epoch is filled.
///         Book-side hooks are authenticated against the BookFactory (`allocate`) and then against the book, vault and
///         router recorded at allocation. See docs/ARCHITECTURE.md §2.10.
interface IInsurancePool {
    /// @notice A book's position in the pool. Identity: allocation - claim == lossFirstLoss + lossDepositors.
    struct BookPosition {
        address book; // recorded at allocate (the factory's book for the id)
        address vault; // the book's UnderwritingVault (receives the allocation, repays the claim)
        address router; // the book's RevenueRouter (pays the premium)
        uint256 allocation; // principal outstanding (reduced by repayments)
        uint256 claim; // what the book owes the pool now: allocation marked down by reported losses
        uint256 lossFirstLoss; // part of this book's outstanding losses absorbed by the first-loss slice
        uint256 lossDepositors; // part absorbed by the depositors' share price
    }

    // ---- book hooks ----

    /// @notice Only the book of `bookId` (BookFactory.bookOf), once per book, at its closeWindow: sends `amount` to the
    ///         book's vault. Within the per-market cap and the free liquidity above the buffer; refused while
    ///         allocations are paused or a due withdrawal epoch is still unfilled.
    function allocate(uint256 bookId, uint256 amount) external;
    /// @notice Only the recorded book: its IF equity fell `amount` below its claim (traders' bad debt). The claim
    ///         and the pool's assets fall by `amount`, first-loss slice first.
    function reportLoss(uint256 bookId, uint256 amount) external;
    /// @notice Only the recorded book: its IF equity recovered (up to the allocation). Restores the depositors'
    ///         part of this book's losses first, then the first-loss slice's.
    function reportRecovery(uint256 bookId, uint256 amount) external;
    /// @notice Only the recorded vault: repays `amount` (<= claim) of the book's claim, pulled from the vault.
    function repay(uint256 bookId, uint256 amount) external;
    /// @notice Only the recorded router: the book's premium, pulled from the router.
    function notifyPremium(uint256 bookId, uint256 amount) external;

    // ---- depositor exits ----

    /// @notice Escrows `shares` of the caller and queues them for the first epoch ending at or after both now and the
    ///         caller's cooldown end. Never refused (no pause, kill or market state blocks it).
    function requestWithdraw(uint256 shares) external returns (uint256 requestId);
    /// @notice Anyone: pays the request's owner what its epoch has filled for it so far.
    function claim(uint256 requestId) external returns (uint256 assets);
    /// @notice Anyone: fills due epochs (oldest first) from free liquidity, at most `maxEpochs` of them.
    function processQueue(uint256 maxEpochs) external;

    // ---- views ----

    function premiumFloorBps() external view returns (uint16);
    function bookPosition(uint256 bookId) external view returns (BookPosition memory);
    /// @notice Largest allocation `bookId` could draw now (per-market cap, free liquidity above the buffer).
    function maxAllocation(uint256 bookId) external view returns (uint256);
    /// @notice Pool value: free liquidity + book claims (first-loss slice included).
    function poolAssets() external view returns (uint256);
    function freeLiquidity() external view returns (uint256);
    function firstLossAssets() external view returns (uint256);
    function claimsTotal() external view returns (uint256);
    function utilisationBps() external view returns (uint256);

    event Allocated(uint256 indexed bookId, address indexed book, address vault, uint256 amount, uint256 poolAssets);
    event LossReported(
        uint256 indexed bookId, uint256 amount, uint256 firstLossAbsorbed, uint256 depositorsAbsorbed, uint256 claim
    );
    event LossRecovered(
        uint256 indexed bookId, uint256 amount, uint256 firstLossRestored, uint256 depositorsRestored, uint256 claim
    );
    event Repaid(uint256 indexed bookId, uint256 amount, uint256 claim);
    event PremiumReceived(uint256 indexed bookId, uint256 amount, uint256 firstLossShare);
    event WithdrawRequested(
        uint256 indexed requestId, address indexed owner, uint256 shares, uint64 indexed epoch, uint64 epochEndsAt
    );
    event EpochFilled(uint64 indexed epoch, uint256 shares, uint256 assets, bool complete);
    event EpochClosed(uint64 indexed epoch, uint64 nextEpochEndsAt);
    event Claimed(uint256 indexed requestId, address indexed owner, uint256 assets);
    event FirstLossDeposited(address indexed from, uint256 amount);
    event FirstLossWithdrawn(address indexed to, uint256 amount);
    event PoolParamSet(bytes32 indexed key, uint256 value);
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
    /// @notice Only the book's vault, before an IF recall: final loss sync, then the claim is due (cash-reserved and
    ///         repaid from vault idle by fundClaims).
    function onInsuranceRecall() external;
}
