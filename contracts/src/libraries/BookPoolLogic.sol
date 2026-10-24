// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BRTypes} from "../interfaces/BRTypes.sol";
import {IBook} from "../interfaces/IBook.sol";
import {IBookrunnerConfig} from "../interfaces/IBookrunnerConfig.sol";
import {ITranche} from "../interfaces/ITranche.sol";
import {IUnderwritingVault} from "../interfaces/IUnderwritingVault.sol";
import {IBackstop} from "../interfaces/IBkrnFeeRouter.sol";
import {IInsurancePool, IBookrunnerConfigPool, IInsuranceReturns} from "../interfaces/IInsurancePool.sol";
import {Waterfall} from "./Waterfall.sol";
import {BookLogic, IVaultPoolRepay} from "./BookLogic.sol";
import {Book} from "../Book.sol";

/// @title BookPoolLogic — a pool-funded book's insurance-ledger logic (charter.ifFromPool), moved out of BookLogic for
///        bytecode headroom (EIP-170; pool audit 2026-10-23 fix round 2).
/// @notice EXTERNAL library linked into BookLogic and reached by DELEGATECALL from it, so it runs in the book proxy's
///         context exactly like BookLogic (same storage `$`, `msg.sender`, `address(this)` and reentrancy lock). Events and
///         errors are Book's / IBook's. Never call it directly. See Waterfall.applyPoolMarkPnl for the ledger rules.
library BookPoolLogic {
    uint8 internal constant S = BRTypes.SENIOR;
    uint8 internal constant J = BRTypes.JUNIOR;

    // =========================================================================================================
    // Window close
    // =========================================================================================================

    /// @dev closeWindow of a pool-funded book (pool audit 2026-10-23 A-M2, B-M2): whether the pool funds the IF. It does
    ///      only when the raise is at least the pool's minimum own capital (UNDERCAPITALISED otherwise) and the pool can
    ///      allocate the whole `charter.ifTargetUsd` now (POOL_UNFUNDED otherwise: no pool, paused, cap, liquidity, the
    ///      slice's cover). Decided on the pool's views, never on a caught revert (a caller could starve the call of gas).
    function poolFunding(Book.BookStorage storage $, uint256 raised)
        public
        view
        returns (address pool, bytes32 reason)
    {
        uint256 amount = $.charter.ifTargetUsd;
        if (amount == 0) revert Book.InsuranceTargetZero();
        pool = IBookrunnerConfigPool($.config).insurancePool();
        if (pool == address(0)) return (address(0), "POOL_UNFUNDED");
        IInsurancePool p = IInsurancePool(pool);
        if (!Waterfall.poolCapitalOk(raised, amount, p.minOwnCapitalBps())) return (address(0), "UNDERCAPITALISED");
        if (p.maxAllocation($.bookId, $.charter.underlying) < amount) return (address(0), "POOL_UNFUNDED");
    }

    /// @dev Book.cancelStuckWindow of a pool-funded charter (fix round 2, V-3): whether the window can close now (the pool
    ///      funds the IF, or the charter opted in to the tranche-funded fallback and the tranches raised it), in which
    ///      case only closeWindow decides until the longer timeout (no caller picks the cancel over a close).
    function windowCanClose(Book.BookStorage storage $) external view returns (bool) {
        ITranche junior = ITranche($.components.junior);
        Waterfall.WindowInput memory w = Waterfall.WindowInput({
            ifTargetUsd: 0,
            mmInventoryUsd: $.charter.mmInventoryUsd,
            seniorCapBps: $.charter.seniorCapBps,
            seniorCommitted: ITranche($.components.senior).totalCommitted(),
            juniorCommitted: junior.totalCommitted(),
            sponsorJuniorCommitted: junior.committedOf($.charter.sponsor)
        });
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(w);
        if (!r.ok) return false;
        (address pool,) = poolFunding($, r.seniorAllocated + r.juniorAllocated);
        if (pool != address(0)) return true;
        if (!$.charter.ifPoolFallback) return false;
        w.ifTargetUsd = $.charter.ifTargetUsd;
        return Waterfall.allocateWindow(w).ok;
    }

    /// @dev closeWindow of a pool-funded book: the pool sends `charter.ifTargetUsd` to the vault (its views said it can;
    ///      a revert anyway reverts closeWindow). Records the pool's minimum own capital of the close (Info 4,
    ///      Book.capitalShort). Returns the IF amount to deploy.
    function drawInsurance(Book.BookStorage storage $, address pool) external returns (uint256 amount) {
        amount = $.charter.ifTargetUsd;
        $.insurancePool = pool;
        $.poolDebt = amount;
        $.poolValue = amount;
        $.poolMinCapitalBps = IInsurancePool(pool).minOwnCapitalBps();
        emit Book.InsuranceFunded($.bookId, pool, amount);
        IInsurancePool(pool).allocate($.bookId, amount, $.charter.underlying);
    }

    // =========================================================================================================
    // Marks
    // =========================================================================================================

    /// @dev applyMark P&L of a pool-funded book on its explicit insurance ledger (Waterfall.applyPoolMarkPnl): the change
    ///      of the book's net assets (vault idle + deployed - unfunded claims - a repayment owed to the Backstop) against
    ///      what the tranches and the pool's claim held. Returns the P&L and the updated summary.
    function applyPoolPnl(Book.BookStorage storage $, IBookrunnerConfig cfg, BookLogic.MarkSummary memory sum)
        external
        returns (int256 pnl, BookLogic.MarkSummary memory)
    {
        address vault = $.components.vault;
        address backstop = cfg.backstop();
        Waterfall.PoolMarkResult memory r = Waterfall.applyPoolMarkPnl(_poolState($), _poolInputs($, sum, backstop));
        uint256 covered = 0;
        if (r.backstopCovered > 0) {
            covered = _pullBackstop($.bookId, cfg, backstop, vault, r.backstopCovered);
            // replace the modelled cover with the USDC actually received
            uint256 missing = r.backstopCovered - covered;
            r.s.seniorNav -= missing;
            r.s.seniorImpairment += missing;
            r.s.backstopDebt -= missing;
            r.s.coverHeld -= missing;
        }
        _storePoolState($, r.s);
        $.backstopPayable += r.backstopRepaid;
        $.drawdownBps = r.drawdownBps;

        sum.navUsd = r.nav;
        sum.backstopCovered = covered;
        sum.navPostPnl = [r.s.seniorNav, r.s.juniorNav];
        pnl = r.pnl;
        if (r.juniorLoss > 0 || r.seniorLoss > 0 || covered > 0) {
            emit IBook.LossAbsorbed($.bookId, r.juniorLoss, r.seniorLoss, covered);
        }
        if (pnl > 0) {
            // a mark can carry a gain and an IF draw (LossAbsorbed above): the Senior side is what is left of the net gain
            uint256 g = uint256(pnl);
            uint256 other = r.juniorGain + r.backstopRepaid;
            emit IBook.GainAllocated($.bookId, g > other ? g - other : 0, r.juniorGain);
        }
        if (r.s.poolValue < r.s.poolDebt) emit Book.InsuranceShortfall($.bookId, r.s.poolDebt - r.s.poolValue);
        return (pnl, sum);
    }

    function _poolInputs(Book.BookStorage storage $, BookLogic.MarkSummary memory sum, address backstop)
        private
        view
        returns (Waterfall.PoolMarkInputs memory)
    {
        uint256 assets = IUnderwritingVault($.components.vault).idle() + sum.deployedValueUsd;
        uint256 owed = $.unfunded[S] + $.unfunded[J] + $.backstopPayable;
        return Waterfall.PoolMarkInputs({
            netAssets: assets > owed ? assets - owed : 0,
            ifDraw: Waterfall.poolIfDraw(
                $.charter.ifTargetUsd,
                _ifReturned($.components.adapter),
                Math.min(sum.insuranceEquityUsd, sum.deployedValueUsd)
            ),
            juniorSupply: IERC20($.components.junior).totalSupply(),
            backstopAvailable: _backstopBalance(backstop)
        });
    }

    function _poolState(Book.BookStorage storage $) private view returns (Waterfall.PoolMarkState memory) {
        uint256 sNav = $.nav[S];
        return Waterfall.PoolMarkState({
            seniorNav: sNav,
            juniorNav: $.nav[J],
            seniorImpairment: $.seniorImpairment,
            seniorIfImpairment: $.seniorIfImpairment,
            juniorIfLoss: $.juniorIfLoss,
            coverHeld: Math.min($.coverHeld, sNav), // defensive: rounding of a Retired redemption never inverts it
            backstopDebt: $.backstopDebt,
            perfIndex: $.perfIndex,
            highWater: $.highWater,
            poolValue: $.poolValue,
            poolDebt: $.poolDebt,
            ifDraw: $.ifDrawAtMark,
            seniorIfDeferred: $.seniorIfDeferred
        });
    }

    function _storePoolState(Book.BookStorage storage $, Waterfall.PoolMarkState memory s) private {
        $.nav = [s.seniorNav, s.juniorNav];
        $.seniorImpairment = s.seniorImpairment;
        $.seniorIfImpairment = s.seniorIfImpairment;
        $.juniorIfLoss = s.juniorIfLoss;
        $.coverHeld = s.coverHeld;
        $.backstopDebt = s.backstopDebt;
        $.perfIndex = s.perfIndex;
        $.highWater = s.highWater;
        $.poolValue = s.poolValue;
        $.ifDrawAtMark = s.ifDraw;
        $.seniorIfDeferred = s.seniorIfDeferred;
    }

    /// @dev After each applied mark (and the retirement mark): the pool's claim (`poolValue`) to the pool, which values
    ///      its position at it and, unless the mark is `held` (B-L4), counts the mark for its epoch gate. Never reverts;
    ///      a failed report is retried by the next mark (absolute value).
    function markInsurance(Book.BookStorage storage $, uint64 periodEnd, bool final_, bool held) external {
        address pool = $.insurancePool;
        if (pool == address(0) || $.poolClosed) return;
        uint256 value = $.poolValue;
        try IInsurancePool(pool).markBook($.bookId, value, periodEnd, final_, held) {
            emit Book.InsuranceMarked($.bookId, $.poolDebt, value, periodEnd, final_);
            if (final_) $.poolClosed = true;
        } catch {
            emit Book.InsuranceMarkFailed($.bookId, value, final_);
        }
    }

    /// @dev finalizeRetirement (fix round 2, V-1): Senior's deferred IF share is charged from whatever own capital Senior
    ///      holds before the shortfall is written off for good, and the rest of it lapses with the write-off.
    function settleDeferred(Book.BookStorage storage $) external {
        uint256 short = $.poolDebt - $.poolValue;
        uint256 deferred = Math.min($.seniorIfDeferred, short);
        uint256 sNav = $.nav[S];
        uint256 d = Math.min(deferred, sNav - Math.min($.coverHeld, sNav));
        $.seniorIfDeferred = 0;
        if (d == 0) return;
        $.nav[S] = sNav - d;
        $.seniorImpairment += d;
        $.seniorIfImpairment += d;
        uint256 v = $.poolValue + d;
        $.poolValue = v;
        emit Book.InsuranceRestored($.bookId, d, v);
    }

    // =========================================================================================================
    // Fee flow and repayments
    // =========================================================================================================

    /// @dev creditDistribution of a pool-funded book (Waterfall.applyPoolDistribution): the residual follows the mark gain
    ///      order on the ledger, then Senior's deferred IF share is charged. Credits the tranche NAVs itself (Senior net of
    ///      the charge) and returns the credits, the Senior restoration and the Backstop repayment.
    function creditPool(Book.BookStorage storage $, uint256 seniorAmount, uint256 juniorAmount, uint256 jSupply)
        external
        returns (uint256, uint256, uint256, uint256)
    {
        Waterfall.PoolDistributionResult memory r = Waterfall.applyPoolDistribution(
            Waterfall.PoolDistributionInput({
                senior: seniorAmount,
                junior: juniorAmount,
                juniorSupply: jSupply,
                seniorNav: $.nav[S],
                seniorImpairment: $.seniorImpairment,
                seniorIfImpairment: $.seniorIfImpairment,
                seniorIfDeferred: $.seniorIfDeferred,
                juniorIfLoss: $.juniorIfLoss,
                backstopDebt: $.backstopDebt,
                coverHeld: $.coverHeld,
                poolShortfall: $.poolClosed ? 0 : $.poolDebt - $.poolValue
            })
        );
        $.seniorImpairment = r.seniorImpairment;
        $.seniorIfImpairment = r.seniorIfImpairment;
        $.seniorIfDeferred = r.seniorIfDeferred;
        $.backstopDebt = r.backstopDebt;
        $.coverHeld = r.coverHeld;
        $.juniorIfLoss = r.juniorIfLoss;
        uint256 restored = r.poolRestored + r.seniorIfCharged;
        if (restored > 0) {
            uint256 v = $.poolValue + restored;
            $.poolValue = v;
            emit Book.InsuranceRestored($.bookId, restored, v);
        }
        $.nav = [$.nav[S] + r.seniorCredit - r.seniorIfCharged, $.nav[J] + r.juniorCredit];
        return (r.seniorCredit, r.juniorCredit, r.seniorRestored, r.backstopRepaid);
    }

    /// @dev A due debt repaid from the book's own idle cash: idle minus the cash owed to settled redemptions, a repayment
    ///      owed to the Backstop and the Backstop cover Senior holds (B-M1; review N2-1), at most the pool's claim.
    ///      Returns the cash reserved for it (== the amount, whether or not the vault managed to pay).
    function repayPoolDue(Book.BookStorage storage $, uint256 idle) external returns (uint256 amount) {
        uint256 pc = $.poolValue;
        if (!$.poolDue || pc == 0) return 0;
        uint256 keep = $.unfunded[S] + $.unfunded[J] + $.backstopPayable + $.coverHeld;
        amount = Math.min(idle > keep ? idle - keep : 0, pc);
        if (amount == 0) return 0;
        try IVaultPoolRepay($.components.vault).repayInsurancePool(amount) {
            uint256 left = $.poolDebt - amount;
            $.poolDebt = left;
            $.poolValue = pc - amount;
            emit Book.InsuranceRepaid($.bookId, amount, left);
        } catch {
            emit Book.InsuranceRepayFailed($.bookId, amount);
        }
    }

    // =========================================================================================================
    // Backstop
    // =========================================================================================================

    /// @dev The adapter's cumulative IF cash returned to the vault (0 for an adapter without the getter: an IF recall then
    ///      reads as an IF draw, the conservative direction). Consistent with the mark: every return bumps the flowNonce.
    function _ifReturned(address adapter) private view returns (uint256 r) {
        try IInsuranceReturns(adapter).insuranceReturnedUsd() returns (uint256 v) {
            r = v;
        } catch {}
    }

    function _backstopBalance(address backstop) private view returns (uint256 bal) {
        if (backstop == address(0)) return 0;
        try IBackstop(backstop).balance() returns (uint256 b) {
            bal = b;
        } catch {}
    }

    /// @dev Returns the USDC actually received by the vault (<= amount). Never reverts.
    function _pullBackstop(uint256 id, IBookrunnerConfig cfg, address backstop, address vault, uint256 amount)
        private
        returns (uint256 covered)
    {
        IERC20 usdc = IERC20(cfg.usdc());
        uint256 before = usdc.balanceOf(vault);
        try IBackstop(backstop).cover(id, amount) returns (uint256 reported) {
            uint256 afterBal = usdc.balanceOf(vault);
            uint256 received = afterBal > before ? afterBal - before : 0;
            covered = Math.min(Math.min(received, reported), amount);
        } catch {
            emit Book.BackstopCoverFailed(id, amount);
        }
    }
}
