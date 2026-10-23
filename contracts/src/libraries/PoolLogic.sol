// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IInsurancePool} from "../interfaces/IInsurancePool.sol";
import {InsurancePool} from "../InsurancePool.sol";

/// @title PoolLogic — InsurancePool's book, allocation and governance logic, moved out of the pool for bytecode headroom
///        (EIP-170; pool audit 2026-10-23 fix round 2).
/// @notice EXTERNAL library: its external functions are linked into InsurancePool and reached by DELEGATECALL, so they run
///         in the pool proxy's context (`$` is the pool's ERC-7201 `InsurancePool.PoolStorage`, same `msg.sender`, behind
///         the pool's reentrancy lock). Events and errors are InsurancePool's / IInsurancePool's (same topics / selectors,
///         emitted by the proxy). Never call it directly: it would operate on the library's own (empty) storage.
library PoolLogic {
    uint256 internal constant BPS = 10_000;
    /// @dev == InsurancePool.MAX_PREMIUM_BPS / MAX_ACTIVE_BOOKS / PARAM_* (the pool exposes these).
    uint16 internal constant MAX_PREMIUM_BPS = 5000;
    uint256 internal constant MAX_ACTIVE_BOOKS = 64;
    bytes32 internal constant PARAM_PREMIUM_FLOOR_BPS = "premiumFloorBps";
    bytes32 internal constant PARAM_MARKET_CAP_BPS = "marketCapBps";
    bytes32 internal constant PARAM_BUFFER_BPS = "bufferBps";
    bytes32 internal constant PARAM_COOLDOWN = "cooldown";
    bytes32 internal constant PARAM_EPOCH_LENGTH = "epochLength";
    bytes32 internal constant PARAM_FIRST_LOSS_TARGET_BPS = "firstLossTargetBps";
    bytes32 internal constant PARAM_PROCESS_GRACE = "processGrace";
    bytes32 internal constant PARAM_MIN_OWN_CAPITAL_BPS = "minOwnCapitalBps";
    /// @notice Fix round 2 (NEW-3): the slice also covers this share of the largest single allocation. With the tranches
    ///         in front of at least half of every IF (minOwnCapitalBps 5000), a single book can cost the pool at most half
    ///         its allocation; 25% makes the slice absorb at least half of that worst single-book loss before any
    ///         depositor does (the old 10%-of-the-pool gate implied about 33% at the 30% market cap).
    uint256 internal constant CONCENTRATION_BPS = 2500;

    // =========================================================================================================
    // Books
    // =========================================================================================================

    /// @dev InsurancePool.markBook (the caller checked nothing: every check is here).
    function markBook(
        InsurancePool.PoolStorage storage $,
        uint256 bookId,
        uint256 value,
        uint64 periodEnd,
        bool final_,
        bool held,
        bool noDepositors
    ) external {
        IInsurancePool.BookPosition storage p = $.books[bookId];
        if (p.book == address(0) || msg.sender != p.book) revert InsurancePool.NotBook(bookId, msg.sender);
        if (value > p.allocation) revert InsurancePool.ExceedsAllocation(value, p.allocation);
        revalue($, bookId, value, noDepositors);
        // audit 2026-10-23 B-L4: a held mark (a held price) is not fresh for the epoch gate
        if (!held && periodEnd > p.lastMarkAt) p.lastMarkAt = periodEnd;
        if (final_ && p.active) _deactivate($, bookId, p);
        emit IInsurancePool.BookMarked(bookId, value, periodEnd, final_);
    }

    /// @dev Moves a book's claim to `value` (<= allocation). The slice is the pool's junior tranche (audit 2026-10-23
    ///      A-M1), accounted pool-wide so the order of marks across books never moves value between the depositors and
    ///      the treasury: a loss hits the slice first, then the depositors (`depositorLoss`); a recovery, whichever book
    ///      it comes from, restores `depositorLoss` first, then the slice. Invariant: depositorLoss == 0 || firstLoss
    ///      == 0. The per-book split (lossFirstLoss / lossDepositors) is reporting only.
    function revalue(InsurancePool.PoolStorage storage $, uint256 bookId, uint256 value, bool noDepositors) public {
        IInsurancePool.BookPosition storage p = $.books[bookId];
        uint256 c = p.claim;
        if (value < c) {
            uint256 amount = c - value;
            uint256 fl = Math.min(amount, $.firstLoss);
            $.firstLoss -= fl;
            $.depositorLoss += amount - fl;
            p.lossFirstLoss += fl;
            p.lossDepositors += amount - fl;
            $.lossesTotal += amount;
            $.claims -= amount;
            p.claim = value;
            emit IInsurancePool.LossReported(bookId, amount, fl, amount - fl, value);
        } else if (value > c) {
            uint256 amount = value - c;
            uint256 pd = Math.min(amount, p.lossDepositors);
            p.lossDepositors -= pd;
            p.lossFirstLoss -= amount - pd;
            // no depositor shares beyond dust: their part is the slice's (never a gift to the next depositor)
            uint256 dl = noDepositors ? 0 : $.depositorLoss;
            uint256 d = Math.min(amount, dl);
            $.depositorLoss = dl - d;
            $.firstLoss += amount - d;
            $.lossesTotal -= amount;
            $.claims += amount;
            p.claim = value;
            emit IInsurancePool.LossRecovered(bookId, amount, amount - d, d, value);
        }
    }

    function _deactivate(InsurancePool.PoolStorage storage $, uint256 bookId, IInsurancePool.BookPosition storage p)
        private
    {
        p.active = false;
        $.marketAllocated[p.market] -= p.allocation;
        uint256 idx = $.activeIndex[bookId];
        uint256 last = $.activeBooks.length;
        if (idx != last) {
            uint256 moved = $.activeBooks[last - 1];
            $.activeBooks[idx - 1] = moved;
            $.activeIndex[moved] = idx;
        }
        $.activeBooks.pop();
        delete $.activeIndex[bookId];
    }

    /// @dev Active books not marked (non-held) since `epochEnd`, and the sum of their claims.
    function staleBooks(InsurancePool.PoolStorage storage $, uint256 epochEnd)
        external
        view
        returns (uint256 n, uint256 claims)
    {
        uint256 len = $.activeBooks.length;
        for (uint256 i; i < len; ++i) {
            IInsurancePool.BookPosition storage p = $.books[$.activeBooks[i]];
            if (p.lastMarkAt < epochEnd) {
                ++n;
                claims += p.claim;
            }
        }
    }

    // =========================================================================================================
    // Allocations
    // =========================================================================================================

    /// @dev InsurancePool.allocate's checks, in order (reverts with the pool's errors). `queued` = the value of every
    ///      queued withdrawal at the current price.
    function checkAllocation(
        InsurancePool.PoolStorage storage $,
        uint256 bookId,
        uint256 amount,
        bytes32 market,
        uint256 queued
    ) external view {
        if ($.allocationsPaused) revert InsurancePool.AllocationsPaused();
        if (amount == 0) revert InsurancePool.ZeroAmount();
        if ($.books[bookId].book != address(0)) revert InsurancePool.AlreadyAllocated(bookId);
        if ($.activeBooks.length >= MAX_ACTIVE_BOOKS) revert InsurancePool.TooManyBooks();
        (uint256 room, uint256 largest) = _firstLossRoom($);
        if (amount > room) revert InsurancePool.FirstLossBelowTarget($.firstLoss, _firstLossNeeded($, amount, largest));
        uint256 cap = _marketRoom($, market);
        if (amount > cap) revert InsurancePool.OverMarketCap(amount, cap);
        uint256 available = _allocatable($, queued);
        if (amount > available) revert InsurancePool.InsufficientFreeLiquidity(amount, available);
    }

    /// @dev InsurancePool.maxAllocation: the largest amount checkAllocation accepts.
    function maxAllocation(InsurancePool.PoolStorage storage $, uint256 bookId, bytes32 market, uint256 queued)
        external
        view
        returns (uint256)
    {
        if (
            $.allocationsPaused || $.books[bookId].book != address(0)
                || $.activeBooks.length >= MAX_ACTIVE_BOOKS
        ) return 0;
        (uint256 room,) = _firstLossRoom($);
        return Math.min(Math.min(_marketRoom($, market), _allocatable($, queued)), room);
    }

    /// @dev InsurancePool.withdrawFirstLoss's checks: from free liquidity above the buffer and the queued exits, keeping
    ///      the slice's cover of the exposure and of the largest book.
    function checkFirstLossWithdrawal(InsurancePool.PoolStorage storage $, uint256 amount, uint256 queued)
        external
        view
    {
        uint256 fl = $.firstLoss;
        if (amount > fl) revert InsurancePool.InsufficientFreeLiquidity(amount, fl);
        uint256 free = $.cash - $.reserved;
        uint256 keep = _keep(_poolAssets($) - amount, queued, $.bufferBps);
        if (free < amount + keep) revert InsurancePool.InsufficientFreeLiquidity(amount, free > keep ? free - keep : 0);
        uint256 needed = _firstLossNeeded($, 0, _largestAllocation($));
        if (fl - amount < needed) revert InsurancePool.FirstLossBelowTarget(fl - amount, needed);
    }

    function _poolAssets(InsurancePool.PoolStorage storage $) private view returns (uint256) {
        return $.cash - $.reserved + $.claims;
    }

    /// @dev Room left under the per-market cap: marketCapBps of T minus the active books' allocations on `market`.
    function _marketRoom(InsurancePool.PoolStorage storage $, bytes32 market) private view returns (uint256) {
        uint256 cap = Math.mulDiv(_poolAssets($), $.marketCapBps, BPS);
        uint256 used = $.marketAllocated[market];
        return cap > used ? cap - used : 0;
    }

    /// @dev Free liquidity above the buffer and every queued withdrawal (A-L3). Audit fix round 2 (NEW-2): the buffer is
    ///      a share of the assets that stay, `bufferBps * (T - queued) + queued`, so depositing and queueing the exit at
    ///      once is neutral (a queued exit is never counted twice).
    function _allocatable(InsurancePool.PoolStorage storage $, uint256 queued) private view returns (uint256) {
        uint256 free = $.cash - $.reserved;
        uint256 keep = _keep(_poolAssets($), queued, $.bufferBps);
        return free > keep ? free - keep : 0;
    }

    function _keep(uint256 t, uint256 queued, uint256 bufferBps) private pure returns (uint256) {
        return Math.mulDiv(t > queued ? t - queued : 0, bufferBps, BPS) + queued;
    }

    /// @dev The largest allocation the slice covers: firstLoss >= target * (claims + amount) (A-M2: the exposure), and
    ///      (fix round 2, NEW-3) firstLoss >= CONCENTRATION_BPS * max(largest book, amount), so one concentrated book
    ///      cannot be funded on a thin slice. Returns the room and the largest active allocation.
    function _firstLossRoom(InsurancePool.PoolStorage storage $) private view returns (uint256 room, uint256 largest) {
        uint256 fl = $.firstLoss;
        largest = _largestAllocation($);
        room = type(uint256).max;
        uint256 bps = $.firstLossTargetBps;
        if (bps != 0) {
            uint256 covered = Math.mulDiv(fl, BPS, bps);
            room = covered > $.claims ? covered - $.claims : 0;
        }
        if (Math.mulDiv(largest, CONCENTRATION_BPS, BPS) > fl) return (0, largest);
        room = Math.min(room, Math.mulDiv(fl, BPS, CONCENTRATION_BPS));
    }

    /// @dev The slice a further allocation of `amount` needs (the error's figure).
    function _firstLossNeeded(InsurancePool.PoolStorage storage $, uint256 amount, uint256 largest)
        private
        view
        returns (uint256)
    {
        uint256 a = Math.mulDiv($.claims + amount, $.firstLossTargetBps, BPS);
        uint256 b = Math.mulDiv(Math.max(largest, amount), CONCENTRATION_BPS, BPS);
        return Math.max(a, b);
    }

    function _largestAllocation(InsurancePool.PoolStorage storage $) private view returns (uint256 largest) {
        uint256 len = $.activeBooks.length;
        for (uint256 i; i < len; ++i) {
            uint256 a = $.books[$.activeBooks[i]].allocation;
            if (a > largest) largest = a;
        }
    }

    // =========================================================================================================
    // Governance
    // =========================================================================================================

    /// @dev InsurancePool.setParam / initialize (bounds as documented there).
    function setParam(InsurancePool.PoolStorage storage $, bytes32 key, uint256 value) external {
        if (key == PARAM_PREMIUM_FLOOR_BPS) {
            if (value > MAX_PREMIUM_BPS) revert InsurancePool.ParamOutOfRange(key, value);
            $.premiumFloorBps = uint16(value);
        } else if (key == PARAM_MARKET_CAP_BPS) {
            if (value < 100 || value > BPS) revert InsurancePool.ParamOutOfRange(key, value);
            $.marketCapBps = uint16(value);
        } else if (key == PARAM_BUFFER_BPS) {
            if (value > 9000) revert InsurancePool.ParamOutOfRange(key, value);
            $.bufferBps = uint16(value);
        } else if (key == PARAM_FIRST_LOSS_TARGET_BPS) {
            if (value > 5000) revert InsurancePool.ParamOutOfRange(key, value);
            $.firstLossTargetBps = uint16(value);
        } else if (key == PARAM_COOLDOWN) {
            if (value > 30 days) revert InsurancePool.ParamOutOfRange(key, value);
            $.cooldown = uint32(value);
        } else if (key == PARAM_PROCESS_GRACE) {
            if (value < 1 hours || value > 7 days) revert InsurancePool.ParamOutOfRange(key, value);
            $.processGrace = uint32(value);
        } else if (key == PARAM_MIN_OWN_CAPITAL_BPS) {
            if (value > 2 * BPS) revert InsurancePool.ParamOutOfRange(key, value);
            $.minOwnCapitalBps = uint16(value);
        } else if (key == PARAM_EPOCH_LENGTH) {
            if (value < 1 days || value > 30 days) revert InsurancePool.ParamOutOfRange(key, value);
            $.pendingEpochLength = uint32(value);
        } else {
            revert InsurancePool.UnknownParam(key);
        }
        emit IInsurancePool.PoolParamSet(key, value);
    }
}
