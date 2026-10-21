// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BRTypes} from "../interfaces/BRTypes.sol";
import {IBook} from "../interfaces/IBook.sol";
import {IBookrunnerConfig} from "../interfaces/IBookrunnerConfig.sol";
import {ITranche} from "../interfaces/ITranche.sol";
import {IUnderwritingVault} from "../interfaces/IUnderwritingVault.sol";
import {IMarkRegistry} from "../interfaces/IMarkRegistry.sol";
import {IMMMandate} from "../interfaces/IMMMandate.sol";
import {IMarketCharter} from "../interfaces/IMarketCharter.sol";
import {IBackstop} from "../interfaces/IBkrnFeeRouter.sol";
import {IAttestedOracle} from "../interfaces/IAttestedOracle.sol";
import {IStockTokenRegistry} from "../interfaces/IStockTokenRegistry.sol";
import {IInsurancePool, IBookrunnerConfigPool} from "../interfaces/IInsurancePool.sol";
import {Waterfall} from "./Waterfall.sol";
import {Book, IVaultBackstopRepay} from "../Book.sol";

/// @dev UnderwritingVault's InsurancePool repayment (book only), not part of the frozen IUnderwritingVault.
interface IVaultPoolRepay {
    function repayInsurancePool(uint256 amount) external;
}

/// @title BookLogic — Book's state-transition logic, moved out of Book for bytecode headroom (EIP-170).
/// @notice EXTERNAL library: its external/public functions are linked into Book and reached by
///         DELEGATECALL, so they run in the book proxy's context — same storage (`$` is the book's
///         ERC-7201 `Book.BookStorage` pointer), same `msg.sender`, same `address(this)`, same transient
///         reentrancy lock (every entry point is behind Book's `nonReentrant`). Events and errors are
///         Book's / IBook's own declarations (identical topics / selectors, emitted by the proxy).
///         Behaviour is byte-for-byte the code that used to live in Book; only its location changed.
/// @dev Internal functions here (`liabilities`, `tranche`, ...) are also callable from Book and are
///      inlined at the call site (JUMP, no delegatecall). Never call these entry points directly on the
///      library address: they would operate on the library's own (empty) storage, and a library's
///      state-changing external functions can only be reached through DELEGATECALL anyway.
library BookLogic {
    uint256 internal constant BPS = 10_000;
    uint8 internal constant S = BRTypes.SENIOR;
    uint8 internal constant J = BRTypes.JUNIOR;
    /// @dev settleAtMark index used once Retired: settles every remaining normal bucket.
    uint256 internal constant RETIRED_SETTLE_INDEX = (1 << 128) - 1;
    /// @dev == Book.KILL_DRAWDOWN
    bytes32 internal constant KILL_DRAWDOWN = "DRAWDOWN";
    /// @notice Longest a run of held marks defers settlement (audit M-1; decision in docs/AUDIT-2026-10.md).
    ///         30 days: above every scheduled closed session (a weekend + holiday is ~4 days) and above the
    ///         longest SEC single-name trading suspension (10 business days, ~14 calendar days), so a held
    ///         price never settles a bucket during either. Past it, held marks settle at the held valuation
    ///         for liveness of exits (a long hold defers them, it never blocks them), unless a governance settle
    ///         price for the book's underlying is pending or in force (_governanceSettlePrice; Task 7).
    uint256 internal constant MAX_HELD_DEFERRAL = 30 days;
    /// @notice Hard bound on a hold run while a governance settle price is pending or in force (Task 7): past it held
    ///         marks settle at the held valuation whatever governance does, so the settle path can never block exits.
    uint256 internal constant MAX_SETTLE_PRICE_DEFERRAL = 60 days;
    /// @notice Subscription timeout before {cancelStuckWindow} (Book.CLOSE_WINDOW_TIMEOUT reads it).
    uint256 internal constant CLOSE_WINDOW_TIMEOUT = 7 days;

    /// @notice Working summary of a mark application (memory only; emitted as MarkSettled).
    ///         Arrays are indexed by tranche kind.
    struct MarkSummary {
        uint256 markId;
        uint64 periodEnd;
        uint64 flowNonce; // book flowNonce the mark was applied at
        uint256 navUsd; // marked NAV = max(vault idle + deployed - unfunded claims, 0)
        uint256 deployedValueUsd;
        uint256 insuranceEquityUsd; // the mark's IF equity (pool-funded books: Backstop cover cap)
        uint256 backstopCovered; // USDC actually received from the backstop
        uint256[2] navPostPnl; // tranche NAV after P&L + backstop, before redemptions / top-ups
        uint256[2] priceWad; // settlement prices
        uint256[2] owed; // redemption assets settled at this mark
        uint256[2] topUp; // top-up assets accepted at this mark
    }

    // =========================================================================================
    // Entry points (DELEGATECALL from Book; see Book for the per-function NatSpec)
    // =========================================================================================

    /// @dev Book.closeWindow.
    function closeWindow(Book.BookStorage storage $) external {
        if ($.state != BRTypes.BookState.Subscription) revert Book.BadState($.state);
        if (block.timestamp < $.subscriptionEnds) revert Book.WindowStillOpen($.subscriptionEnds);

        ITranche senior = ITranche($.components.senior);
        ITranche junior = ITranche($.components.junior);
        uint256 sCommitted = senior.totalCommitted();
        uint256 jCommitted = junior.totalCommitted();
        // [2026-10 insurance pool] a pool-funded IF is not raised from the tranches (0 here, funded below)
        uint256 ifTarget = Waterfall.windowIfTarget($.charter.ifTargetUsd, $.charter.ifFromPool);
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(
            Waterfall.WindowInput({
                ifTargetUsd: ifTarget,
                mmInventoryUsd: $.charter.mmInventoryUsd,
                seniorCapBps: $.charter.seniorCapBps,
                seniorCommitted: sCommitted,
                juniorCommitted: jCommitted,
                sponsorJuniorCommitted: junior.committedOf($.charter.sponsor)
            })
        );

        if (!r.ok) {
            $.state = BRTypes.BookState.Cancelled;
            emit IBook.BookCancelled($.bookId, _reasonCode(r.reason));
            senior.markCancelled();
            junior.markCancelled();
            return;
        }

        $.nav = [r.seniorAllocated, r.juniorAllocated];
        $.state = BRTypes.BookState.Live;
        emit IBook.WindowClosed($.bookId, r.seniorAllocated, r.juniorAllocated, sCommitted, jCommitted);

        address vault = $.components.vault;
        senior.settleWindow(r.seniorAllocated, vault);
        junior.settleWindow(r.juniorAllocated, vault);

        (uint256 ifAmount, uint256 mmAmount,) =
            Waterfall.initialDeployment(r.seniorAllocated + r.juniorAllocated, ifTarget, $.charter.mmInventoryUsd);
        // [2026-10 insurance pool] the pool sends the IF to the vault; it is deployed to the IF account below
        if ($.charter.ifFromPool) ifAmount = _drawInsurance($);
        emit IBook.CapitalDeployed($.bookId, ifAmount, mmAmount);
        if (ifAmount > 0) IUnderwritingVault(vault).deployToVenue(BRTypes.ACCOUNT_IF, ifAmount);
        if (mmAmount > 0) IUnderwritingVault(vault).deployToVenue(BRTypes.ACCOUNT_MM, mmAmount);
    }

    /// @dev Book.cancelStuckWindow (Task 7 lead "unconfirmed deposits"): a window closeWindow could not close for
    ///      CLOSE_WINDOW_TIMEOUT (its venue deposit keeps reverting) is cancelled; commitments refundable 1:1.
    function cancelStuckWindow(Book.BookStorage storage $) external {
        if ($.state != BRTypes.BookState.Subscription) revert Book.BadState($.state);
        uint256 at = uint256($.subscriptionEnds) + CLOSE_WINDOW_TIMEOUT;
        if (block.timestamp < at) revert Book.WindowNotStuck(uint64(at));
        $.state = BRTypes.BookState.Cancelled;
        emit IBook.BookCancelled($.bookId, "CLOSE_TIMEOUT");
        ITranche($.components.senior).markCancelled();
        ITranche($.components.junior).markCancelled();
    }

    /// @dev Book.applyMark.
    function applyMark(Book.BookStorage storage $, uint256 markId) external {
        BRTypes.BookState st = $.state;
        if (st != BRTypes.BookState.Live && st != BRTypes.BookState.Retiring) revert Book.BadState(st);
        IBookrunnerConfig cfg = IBookrunnerConfig($.config);
        IMarkRegistry registry = IMarkRegistry(cfg.markRegistry());
        BRTypes.Mark memory m = registry.getMark(markId);
        if (m.committedAt == 0 || m.signer == address(0)) revert Book.UnknownMark(markId);
        if (m.input.bookId != $.bookId) revert Book.MarkForOtherBook(markId, m.input.bookId);
        if (m.applied) revert Book.MarkAlreadyApplied(markId);
        // only the book's latest committed mark: an older unapplied one is superseded (A7-02)
        if (m.input.periodEnd <= $.lastMark.periodEnd || registry.latestMarkId($.bookId) != markId) {
            revert Book.MarkOutOfOrder(m.input.periodEnd, $.lastMark.periodEnd);
        }
        if (m.input.flowNonce != $.flowNonce) revert Book.FlowNonceMismatch($.flowNonce, m.input.flowNonce);

        MarkSummary memory sum;
        sum.markId = markId;
        sum.periodEnd = m.input.periodEnd;
        sum.flowNonce = $.flowNonce;
        sum.deployedValueUsd = m.input.deployedValueUsd;
        sum.insuranceEquityUsd = m.input.insuranceEquityUsd;

        int256 pnl = _applyPnl($, cfg, sum);
        _maybeDrawdownKill($);
        if (_settles($, m.input.held, markId, sum.periodEnd)) _settleAtMark($, sum);
        else _setPrices($, sum);

        $.lastMark = Book.LastMark({
            markId: markId,
            periodEnd: sum.periodEnd,
            flowNonce: sum.flowNonce,
            navUsd: sum.navUsd,
            deployedValueUsd: sum.deployedValueUsd,
            backstopCovered: sum.backstopCovered
        });
        if (st == BRTypes.BookState.Retiring) $.markAppliedWhileRetiring = true;
        fundClaims($);
        // [2026-10 insurance pool] what the book can repay, from this mark's snapshot, to the pool
        _markInsurance($, sum.periodEnd, false);
        registry.markApplied(markId);
        emit Book.MarkSettled($.bookId, markId, sum.backstopCovered, sum.navPostPnl, sum.owed, sum.topUp);
        emit IBook.MarkApplied(
            $.bookId, markId, sum.navUsd, pnl, $.nav[S], $.nav[J], sum.priceWad[S], sum.priceWad[J]
        );
    }

    /// @dev Book.finalizeRetirement.
    function finalizeRetirement(Book.BookStorage storage $) external {
        if ($.state != BRTypes.BookState.Retiring) revert Book.BadState($.state);
        Book.LastMark storage lm = $.lastMark;
        if (!$.markAppliedWhileRetiring || lm.deployedValueUsd != 0 || lm.flowNonce != $.flowNonce) {
            revert Book.RetirementNotReady();
        }
        $.state = BRTypes.BookState.Retired;
        setRetiredPrice($, S, false);
        setRetiredPrice($, J, false);
        emit IBook.Retired($.bookId, $.nav[S] + $.nav[J]);
        _closeInsurance($); // [2026-10 insurance pool] the pool's due claim first, then the backlog
        _settleRetiredBacklog($);
        IMarketCharter(IBookrunnerConfig($.config).charter()).onRetired($.bookId);
    }

    /// @dev Book.settleRetiredBacklog.
    function settleRetiredBacklog(Book.BookStorage storage $) external {
        if ($.state != BRTypes.BookState.Retired) revert Book.BadState($.state);
        _settleRetiredBacklog($);
    }

    /// @dev Book.onRetiredRedeem (msg.sender is the calling tranche: DELEGATECALL keeps it).
    function onRetiredRedeem(Book.BookStorage storage $, uint256 assetsOwed, uint256 sharesBurned) external {
        uint8 k;
        if (msg.sender == $.components.senior) k = S;
        else if (msg.sender == $.components.junior) k = J;
        else revert Book.NotTranche();
        if ($.state != BRTypes.BookState.Retired) revert Book.BadState($.state);
        if (k == S) _scaleImpairment($, sharesBurned, IERC20(msg.sender).totalSupply() + sharesBurned);
        $.nav[k] -= assetsOwed;
        $.unfunded[k] += assetsOwed;
        emit Book.RetiredRedemption($.bookId, k, assetsOwed);
        fundClaims($);
    }

    /// @dev Book.creditDistribution (msg.sender is the router: DELEGATECALL keeps it). Audit 2026-10 L-1: the
    ///      residual follows the mark gain order (Waterfall.applyDistribution). A repayment earned here is netted
    ///      from NAV (backstopPayable) and paid by the next fundClaims, exactly like one earned at a mark; the
    ///      router's distribution does not wait for it.
    function creditDistribution(Book.BookStorage storage $, uint256 seniorAmount, uint256 juniorAmount)
        external
    {
        if (msg.sender != $.components.router) revert Book.NotRouter();
        BRTypes.BookState st = $.state;
        if (st == BRTypes.BookState.Subscription || st == BRTypes.BookState.Cancelled) revert Book.BadState(st);
        Waterfall.DistributionResult memory r = Waterfall.applyDistribution(
            Waterfall.DistributionInput({
                senior: seniorAmount,
                junior: juniorAmount,
                juniorSupply: IERC20($.components.junior).totalSupply(),
                seniorImpairment: $.seniorImpairment,
                backstopDebt: $.backstopDebt
            })
        );
        $.nav[S] += r.seniorCredit;
        $.nav[J] += r.juniorCredit;
        emit IBook.DistributionCredited($.bookId, r.seniorCredit, r.juniorCredit);
        if (r.seniorRestored > 0 || r.backstopRepaid > 0) {
            $.seniorImpairment = r.seniorImpairment;
            $.backstopDebt = r.backstopDebt;
            $.backstopPayable += r.backstopRepaid;
            emit Book.DistributionRepaid($.bookId, r.seniorRestored, r.backstopRepaid);
        }
        if (st == BRTypes.BookState.Retired) {
            // late fee flow raises the immediate-settlement price for the remaining holders
            if (r.seniorCredit > 0) setRetiredPrice($, S, true);
            if (r.juniorCredit > 0) setRetiredPrice($, J, true);
        }
    }

    /// @dev Pays unfunded claims from vault idle, Senior first, then the backstop repayment owed (A5-01).
    ///      The repayment never blocks the caller: a vault that cannot pay it (e.g. a vault clone older
    ///      than repayBackstop) leaves it owed and reserved. [2026-10 insurance pool] A due pool claim is repaid
    ///      first (the pool is senior to the tranches for the IF it funded, which was never tranche value); a
    ///      failed repayment leaves it owed and its cash reserved, never blocking the caller.
    function fundClaims(Book.BookStorage storage $) public returns (uint256 funded) {
        uint256 us = $.unfunded[S];
        uint256 uj = $.unfunded[J];
        uint256 owed = $.backstopPayable;
        uint256 pc = $.poolDue ? $.poolDebt : 0;
        if (us == 0 && uj == 0 && owed == 0 && pc == 0) return 0;
        IUnderwritingVault vault = IUnderwritingVault($.components.vault);
        uint256 idle = vault.idle();
        if (pc > 0) idle -= _repayInsurance($, address(vault), Math.min(idle, pc));
        uint256 ps = Math.min(idle, us);
        uint256 pj = Math.min(idle - ps, uj);
        funded = ps + pj;
        if (funded > 0) {
            $.unfunded = [us - ps, uj - pj];
            emit IBook.ClaimsFunded($.bookId, funded, (us - ps) + (uj - pj));
            if (ps > 0) vault.payTo($.components.senior, ps);
            if (pj > 0) vault.payTo($.components.junior, pj);
        }
        uint256 pb = Math.min(idle - funded, owed);
        if (pb > 0) {
            try IVaultBackstopRepay(address(vault)).repayBackstop(pb) {
                $.backstopPayable = owed - pb;
            } catch {}
        }
    }

    /// @dev Retired: re-prices tranche `k` from its NAV and supply (`bumpEpoch` on late fee flow).
    function setRetiredPrice(Book.BookStorage storage $, uint8 k, bool bumpEpoch) public {
        uint256 p = Waterfall.sharePriceWad($.nav[k], IERC20(tranche($, k)).totalSupply());
        if (bumpEpoch) $.retiredEpoch[k]++;
        $.price[k] = p;
        emit Book.RetiredPriceSet($.bookId, k, p, $.retiredEpoch[k]);
    }

    // =========================================================================================
    // Insurance pool (2026-10, charter.ifFromPool; docs/ARCHITECTURE.md §2.10)
    // =========================================================================================

    /// @dev Book.onInsuranceRecall (msg.sender is the vault: DELEGATECALL keeps it). The vault only recalls a
    ///      pool-funded IF once the book is no longer Live; the debt becomes due (reserved, repaid first).
    function onInsuranceRecall(Book.BookStorage storage $) external {
        if (msg.sender != $.components.vault) revert Book.NotVault();
        if ($.insurancePool == address(0) || $.poolDue) return;
        if ($.state == BRTypes.BookState.Live) revert Book.BadState($.state);
        $.poolDue = true;
        emit Book.InsuranceDue($.bookId, $.poolDebt);
    }

    /// @dev Book.settleInsurance: Retired pool-funded book, retries the repayment and the retirement mark.
    function settleInsurance(Book.BookStorage storage $) external {
        if ($.state != BRTypes.BookState.Retired) revert Book.BadState($.state);
        if ($.insurancePool == address(0)) return;
        fundClaims($);
        if (!$.poolClosed) _closeInsurance($);
    }

    // =========================================================================================
    // Shared internal helpers (also inlined into Book where it uses them)
    // =========================================================================================

    /// @dev Cash owed out of the vault (reserved from deployment): unfunded claims, the backstop repayment and, once
    ///      due, the pool's debt.
    function liabilities(Book.BookStorage storage $) internal view returns (uint256) {
        return $.unfunded[S] + $.unfunded[J] + $.backstopPayable + ($.poolDue ? $.poolDebt : 0);
    }

    /// @dev Liabilities netted from NAV: liabilities() plus the pool's debt before it is due (backed by the venue IF,
    ///      which the mark's deployedValueUsd counts at the same snapshot), so a pool-funded IF is never Senior / Junior
    ///      value and an IF draw is a book loss (Junior -> Senior -> backstop) before it can be the pool's.
    function navLiabilities(Book.BookStorage storage $) internal view returns (uint256) {
        return $.unfunded[S] + $.unfunded[J] + $.backstopPayable + $.poolDebt;
    }

    function tranche(Book.BookStorage storage $, uint8 k) internal view returns (address) {
        return k == S ? $.components.senior : $.components.junior;
    }

    // =========================================================================================
    // Private
    // =========================================================================================

    function _applyPnl(Book.BookStorage storage $, IBookrunnerConfig cfg, MarkSummary memory sum)
        private
        returns (int256 pnl)
    {
        address vault = $.components.vault;
        address backstop = cfg.backstop();
        (Waterfall.MarkState memory ms, Waterfall.MarkInputs memory mi, uint256 coverCap) =
            _markInputs($, sum, vault, backstop);
        Waterfall.MarkResult memory r = Waterfall.applyMarkPnl(ms, mi);
        uint256 nav = mi.nav;

        uint256 covered;
        if (r.backstopCovered > 0) {
            uint256 shortfall = r.seniorImpairment + r.backstopCovered; // impairment before cover
            covered = _pullBackstop($.bookId, cfg, backstop, vault, Math.min(shortfall, coverCap));
            // replace the modelled cover with the USDC actually received
            r.seniorNav = r.seniorNav - r.backstopCovered + covered;
            r.seniorImpairment = shortfall - covered;
            r.backstopDebt = r.backstopDebt - r.backstopCovered + covered;
        }

        $.nav = [r.seniorNav, r.juniorNav];
        $.seniorImpairment = r.seniorImpairment;
        // cover is owed back from later gains; a repayment earned now leaves NAV until the vault pays it
        $.backstopDebt = r.backstopDebt;
        $.backstopPayable += r.backstopRepaid;
        $.perfIndex = r.perfIndex;
        $.highWater = r.highWater;
        $.drawdownBps = r.drawdownBps;

        sum.navUsd = nav;
        sum.backstopCovered = covered;
        sum.navPostPnl = [r.seniorNav, r.juniorNav];
        pnl = r.pnl;

        if (r.juniorLoss > 0 || r.seniorLoss > 0 || covered > 0) {
            emit IBook.LossAbsorbed($.bookId, r.juniorLoss, r.seniorLoss, covered);
        }
        if (pnl > 0) {
            // senior side = impairment restored (+ the residual when Junior has no supply)
            emit IBook.GainAllocated($.bookId, uint256(pnl) - r.juniorGain - r.backstopRepaid, r.juniorGain);
        }
    }

    /// @dev Audit M-1: whether this mark settles redemption buckets and a due top-up round. A non-held mark
    ///      always does (and ends a hold run). A held mark (valued at a held oracle price, e.g. a closed
    ///      session) applies P&L only, so nobody can exit or enter at a value the reopen is about to
    ///      reprice: the buckets / round wait for the first non-held mark, which settles every bucket due
    ///      by then at its post-P&L prices (at most Tranche.MAX_SETTLE_BUCKETS per tranche per mark; any
    ///      further due bucket settles at the next mark, still a post-hold price). Bounded: once the run of
    ///      held marks is MAX_HELD_DEFERRAL old, held marks settle again at the held valuation (liveness of
    ///      exits), unless a governance settle price for the book's underlying (or an index component) is pending
    ///      or in force: in force, the mark service values the book at it and signs NON-held marks, which settle
    ///      whatever this hook says; a held mark reaching the chain then (an old or failing mark service, a mark
    ///      signed before the price came into force) must not settle at the held valuation, which would let early
    ///      exiters dodge the governance price. Bounded: past MAX_SETTLE_PRICE_DEFERRAL (60 days) of hold, held
    ///      marks settle whatever governance does (repeated proposals, a stuck mark service cannot block exits).
    function _settles(Book.BookStorage storage $, bool held, uint256 markId, uint64 periodEnd)
        private
        returns (bool)
    {
        if (!held) {
            if ($.heldSince != 0) $.heldSince = 0;
            return true;
        }
        uint64 since = $.heldSince;
        if (since == 0) $.heldSince = since = periodEnd;
        uint256 elapsed = periodEnd - since;
        bool settles = elapsed >= MAX_HELD_DEFERRAL
            && (elapsed >= MAX_SETTLE_PRICE_DEFERRAL || !_governanceSettlePrice($));
        emit Book.MarkHeld($.bookId, markId, since, settles);
        return settles;
    }

    /// @dev Audit M-1 x Task 7: whether a governance settle price is pending or in force in config.oracle() for the
    ///      book's underlying (the oracle price id of `charter.underlying`, the price its marks are held on) or, for an
    ///      index book, for any of the index's components (at most StockTokenRegistry.MAX_INDEX_COMPONENTS). Never
    ///      reverts: no registry / oracle, an oracle without the settle path, or a failing read means false (the
    ///      30-day fallback applies). Read only for a held mark past MAX_HELD_DEFERRAL.
    function _governanceSettlePrice(Book.BookStorage storage $) private view returns (bool) {
        IBookrunnerConfig cfg = IBookrunnerConfig($.config);
        address reg = cfg.stockRegistry();
        address oracle = cfg.oracle();
        if (reg.code.length == 0 || oracle.code.length == 0) return false;
        bytes32 u = $.charter.underlying;
        if (_settlePriceSet(reg, oracle, u)) return true;
        if (uint256(u) >> 160 == 0) return false; // a token, not an index id
        try IStockTokenRegistry(reg).getIndex(u) returns (bytes32, IStockTokenRegistry.IndexComponent[] memory cs) {
            for (uint256 i; i < cs.length; ++i) {
                if (_settlePriceSet(reg, oracle, bytes32(uint256(uint160(cs[i].token))))) return true;
            }
        } catch {}
        return false;
    }

    /// @dev A settle price pending or in force for the oracle price id of `underlying` (false on any failed read).
    function _settlePriceSet(address reg, address oracle, bytes32 underlying) private view returns (bool set) {
        try IStockTokenRegistry(reg).priceIdOf(underlying) returns (bytes32 pid) {
            try IAttestedOracle(oracle).settlePrice(pid) returns (uint256, uint64, uint64, bool pending, bool effective) {
                set = pending || effective;
            } catch {}
        } catch {}
    }

    /// @dev Share prices from the post-P&L NAVs, before any settlement; returns the Senior supply.
    function _setPrices(Book.BookStorage storage $, MarkSummary memory sum)
        private
        returns (uint256 seniorSupply)
    {
        for (uint8 k = 0; k < 2; k++) {
            uint256 supply = IERC20(tranche($, k)).totalSupply();
            if (k == S) seniorSupply = supply;
            uint256 p = Waterfall.sharePriceWad($.nav[k], supply);
            $.price[k] = p;
            sum.priceWad[k] = p;
        }
    }

    function _settleAtMark(Book.BookStorage storage $, MarkSummary memory sum) private {
        uint256 interval = $.markInterval;
        uint256 upTo = Waterfall.settlesUpTo(sum.periodEnd, interval);
        bool topUpDue = $.topUpOpen && upTo * interval >= $.topUpEndsAt;
        uint256 seniorSupply = _setPrices($, sum);
        // Junior first so the Senior top-up cap sees the final Junior NAV
        _settleTranche($, sum, J, upTo, topUpDue ? $.topUpCapacity[J] : 0);
        // no Senior top-up while impaired: new shares would share the restoration owed to the old ones
        uint256 seniorCap = topUpDue && $.seniorImpairment == 0
            ? _seniorTopUpRoom($.nav[S], $.nav[J], $.charter.seniorCapBps, $.topUpCapacity[S])
            : 0;
        _scaleImpairment($, _settleTranche($, sum, S, upTo, seniorCap), seniorSupply);

        if (topUpDue) {
            $.topUpOpen = false;
            emit Book.TopUpSettled($.bookId, sum.topUp[S], sum.topUp[J]);
        }
    }

    /// @return burned redemption shares burned (settled) at this mark.
    function _settleTranche(
        Book.BookStorage storage $,
        MarkSummary memory sum,
        uint8 k,
        uint256 upTo,
        uint256 cap
    ) private returns (uint256 burned) {
        uint256 owed;
        uint256 acc;
        (burned, owed, acc,) =
            ITranche(tranche($, k)).settleAtMark(upTo, sum.priceWad[k], cap, $.components.vault);
        $.nav[k] = $.nav[k] - owed + acc;
        $.unfunded[k] += owed;
        sum.owed[k] = owed;
        sum.topUp[k] = acc;
    }

    /// @dev Senior top-up room: Senior may not exceed seniorCapBps of book capital after the round,
    ///      i.e. S' <= J' * c / (1 - c). Uses S before this mark's Senior redemptions (conservative).
    function _seniorTopUpRoom(uint256 sNav, uint256 jNav, uint256 capBps, uint256 capacity)
        private
        pure
        returns (uint256)
    {
        if (capBps >= BPS) return capacity;
        uint256 limit = (jNav * capBps) / (BPS - capBps);
        uint256 room = limit > sNav ? limit - sNav : 0;
        return Math.min(room, capacity);
    }

    function _settleRetiredBacklog(Book.BookStorage storage $) private {
        uint256[2] memory owed;
        for (uint8 k = 0; k < 2; k++) {
            address t = tranche($, k);
            uint256 supply = IERC20(t).totalSupply();
            uint256 burned;
            (burned, owed[k],,) =
                ITranche(t).settleAtMark(RETIRED_SETTLE_INDEX, $.price[k], 0, $.components.vault);
            if (k == S) _scaleImpairment($, burned, supply);
            $.nav[k] -= owed[k];
            $.unfunded[k] += owed[k];
        }
        if (owed[S] > 0 || owed[J] > 0) emit Book.RetiredBacklogSettled($.bookId, owed[S], owed[J]);
        fundClaims($);
    }

    /// @dev Senior shares burned at a settlement (marks, Retired backlog / immediate redemptions) take their
    ///      pro-rata part of the impairment with them: imp' = floor(imp * (supply - burned) / supply), i.e.
    ///      0 once no Senior share is left. Restoration and backstop cover (the backstop is shared across
    ///      books) then only ever restore the remaining shares' loss.
    function _scaleImpairment(Book.BookStorage storage $, uint256 burned, uint256 supplyBefore) private {
        uint256 imp = $.seniorImpairment;
        if (burned == 0 || imp == 0) return;
        $.seniorImpairment = Math.mulDiv(imp, supplyBefore - burned, supplyBefore);
    }

    function _maybeDrawdownKill(Book.BookStorage storage $) private {
        int256 killAt = $.charter.mandate.killAtDrawdownBps;
        // the committee may re-mandate: prefer the live terms
        try IMMMandate($.components.mandate).getMandate() returns (BRTypes.Mandate memory md) {
            killAt = md.killAtDrawdownBps;
        } catch {}
        if (Waterfall.drawdownKill($.drawdownBps, killAt)) _killMandate($, KILL_DRAWDOWN);
    }

    /// @dev Never blocks the caller (marks / retirement must stay live): failures surface as events.
    function _killMandate(Book.BookStorage storage $, bytes32 reason) private {
        IMMMandate mandate = IMMMandate($.components.mandate);
        try mandate.killed() returns (bool k) {
            if (k) return;
        } catch {}
        try mandate.kill(reason) {}
        catch {
            emit Book.MandateKillFailed($.bookId, reason);
        }
    }

    function _backstopBalance(address backstop) private view returns (uint256 bal) {
        if (backstop == address(0)) return 0;
        try IBackstop(backstop).balance() returns (uint256 b) {
            bal = b;
        } catch {}
    }

    /// @dev Returns the USDC actually received by the vault (<= shortfall). Never reverts.
    function _pullBackstop(
        uint256 id,
        IBookrunnerConfig cfg,
        address backstop,
        address vault,
        uint256 shortfall
    ) private returns (uint256 covered) {
        IERC20 usdc = IERC20(cfg.usdc());
        uint256 before = usdc.balanceOf(vault);
        try IBackstop(backstop).cover(id, shortfall) returns (uint256 reported) {
            uint256 afterBal = usdc.balanceOf(vault);
            uint256 received = afterBal > before ? afterBal - before : 0;
            covered = Math.min(Math.min(received, reported), shortfall);
        } catch {
            emit Book.BackstopCoverFailed(id, shortfall);
        }
    }

    /// @dev closeWindow of a pool-funded book: the pool sends `charter.ifTargetUsd` to the vault (reverts, and so
    ///      does closeWindow, when the pool cannot fund it now: retried, or cancelled by cancelStuckWindow after
    ///      CLOSE_WINDOW_TIMEOUT). Returns the IF amount to deploy.
    function _drawInsurance(Book.BookStorage storage $) private returns (uint256 amount) {
        address pool = IBookrunnerConfigPool($.config).insurancePool();
        if (pool == address(0)) revert Book.InsurancePoolUnset();
        amount = $.charter.ifTargetUsd;
        if (amount == 0) revert Book.InsuranceTargetZero();
        $.insurancePool = pool;
        $.poolDebt = amount;
        $.poolValue = amount;
        emit Book.InsuranceFunded($.bookId, pool, amount);
        IInsurancePool(pool).allocate($.bookId, amount, $.charter.underlying);
    }

    /// @dev Repays `amount` of the due debt from vault idle; returns the cash reserved for it (== amount, whether or
    ///      not the vault managed to pay).
    function _repayInsurance(Book.BookStorage storage $, address vault, uint256 amount) private returns (uint256) {
        if (amount == 0) return 0;
        try IVaultPoolRepay(vault).repayInsurancePool(amount) {
            uint256 left = $.poolDebt - amount;
            $.poolDebt = left;
            uint256 v = $.poolValue;
            $.poolValue = v > amount ? v - amount : 0;
            emit Book.InsuranceRepaid($.bookId, amount, left);
        } catch {
            emit Book.InsuranceRepayFailed($.bookId, amount);
        }
        return amount;
    }

    /// @dev The waterfall inputs of a mark. [2026-10 insurance pool, owner ruling N-1] For a pool-funded book an
    ///      exhausted book's debt is written down first (the pool's loss), the NAV nets the debt, and the Backstop is
    ///      offered at most what covers the losses other than the insurance debt (`coverCap`; no cap otherwise).
    function _markInputs(Book.BookStorage storage $, MarkSummary memory sum, address vault, address backstop)
        private
        returns (Waterfall.MarkState memory ms, Waterfall.MarkInputs memory mi, uint256 coverCap)
    {
        uint256 idle = IUnderwritingVault(vault).idle();
        bool poolBook = $.insurancePool != address(0) && !$.poolClosed;
        if (poolBook) _writeDownInsurance($, idle, sum.deployedValueUsd);
        ms = Waterfall.MarkState({
            seniorNav: $.nav[S],
            juniorNav: $.nav[J],
            seniorImpairment: $.seniorImpairment,
            perfIndex: $.perfIndex,
            highWater: $.highWater,
            backstopDebt: $.backstopDebt
        });
        mi = Waterfall.MarkInputs({
            nav: Waterfall.markedNavNet(idle, navLiabilities($), sum.deployedValueUsd),
            juniorSupply: IERC20($.components.junior).totalSupply(),
            backstopAvailable: _backstopBalance(backstop)
        });
        coverCap = type(uint256).max;
        if (poolBook) {
            coverCap = _insuranceCoverCap($, ms, mi, sum, idle);
            if (coverCap < mi.backstopAvailable) mi.backstopAvailable = coverCap;
        }
    }

    /// @dev Owner ruling N-1: the book's own capital (idle + deployed, less the Backstop money in it: cover still held
    ///      by Senior, a repayment owed to the Backstop) is what the insurance debt can draw on; a debt above it is
    ///      written down to it (Waterfall.poolDebtAtMark), the shortfall being the pool's loss (reported with the next
    ///      markBook). So Backstop cash is never netted against the debt.
    function _writeDownInsurance(Book.BookStorage storage $, uint256 idle, uint256 deployed) private {
        uint256 backstopMoney = Math.min($.backstopDebt, $.nav[S]) + $.backstopPayable;
        (uint256 debt, uint256 writeOff) = Waterfall.poolDebtAtMark($.poolDebt, idle, deployed, backstopMoney);
        if (writeOff > 0) {
            $.poolDebt = debt;
            emit Book.InsuranceWrittenOff($.bookId, writeOff);
        }
    }

    /// @dev Owner ruling N-1: the Backstop covers Senior impairment only for losses other than the insurance debt. The
    ///      cap is what applyMarkPnl would cover at the NAV with the mark's IF draw added back (Waterfall.poolCoverNav,
    ///      from the signed MarkInput.insuranceEquityUsd); no IF draw: no cap.
    function _insuranceCoverCap(
        Book.BookStorage storage $,
        Waterfall.MarkState memory ms,
        Waterfall.MarkInputs memory mi,
        MarkSummary memory sum,
        uint256 idle
    ) private view returns (uint256) {
        uint256 navH = Waterfall.poolCoverNav(
            idle, navLiabilities($), sum.deployedValueUsd, $.poolDebt, sum.insuranceEquityUsd
        );
        if (navH <= mi.nav) return type(uint256).max; // no IF draw (navH >= nav always)
        return Waterfall.applyMarkPnl(
            ms, Waterfall.MarkInputs({nav: navH, juniorSupply: mi.juniorSupply, backstopAvailable: mi.backstopAvailable})
        ).backstopCovered;
    }

    /// @dev After each applied mark (and the retirement mark): the debt, i.e. what the book can still repay, to the pool,
    ///      which values its claim at it (it falls only when the book was exhausted) and counts the mark for its epoch
    ///      gate. Never reverts.
    function _markInsurance(Book.BookStorage storage $, uint64 periodEnd, bool final_) private {
        address pool = $.insurancePool;
        if (pool == address(0) || $.poolClosed) return;
        uint256 value = $.poolDebt;
        try IInsurancePool(pool).markBook($.bookId, value, periodEnd, final_) {
            $.poolValue = value;
            emit Book.InsuranceMarked($.bookId, value, value, periodEnd, final_);
            if (final_) $.poolClosed = true;
        } catch {
            emit Book.InsuranceMarkFailed($.bookId, value, final_);
        }
    }

    /// @dev finalizeRetirement of a pool-funded book: everything is back in the vault (deployedValueUsd == 0). The debt
    ///      is due and written down to the book's own capital (Backstop money excluded), repaid from idle first, and
    ///      the retirement mark reports what is left (0 unless the repayment failed). Never reverts.
    function _closeInsurance(Book.BookStorage storage $) private {
        if ($.insurancePool == address(0) || $.poolClosed) return;
        if (!$.poolDue) {
            $.poolDue = true;
            emit Book.InsuranceDue($.bookId, $.poolDebt);
        }
        _writeDownInsurance($, IUnderwritingVault($.components.vault).idle(), 0);
        fundClaims($);
        _markInsurance($, $.lastMark.periodEnd, true);
    }

    function _reasonCode(uint8 reason) private pure returns (bytes32) {
        if (reason == Waterfall.REASON_NO_JUNIOR) return "NO_JUNIOR";
        if (reason == Waterfall.REASON_SPONSOR_SKIN) return "SPONSOR_SKIN";
        return "IF_UNFUNDED";
    }
}
