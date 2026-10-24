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
import {BookPoolLogic} from "./BookPoolLogic.sol";
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
        Waterfall.WindowInput memory w = Waterfall.WindowInput({
            ifTargetUsd: Waterfall.windowIfTarget($.charter.ifTargetUsd, $.charter.ifFromPool),
            mmInventoryUsd: $.charter.mmInventoryUsd,
            seniorCapBps: $.charter.seniorCapBps,
            seniorCommitted: sCommitted,
            juniorCommitted: jCommitted,
            sponsorJuniorCommitted: junior.committedOf($.charter.sponsor)
        });
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(w);
        // [pool audit 2026-10-23 A-M2, B-M2; fix round 2 V-3] the pool funds the IF only for a raise of at least its
        // minimum own capital and only within what it can allocate. A shortage of the pool (POOL_UNFUNDED) makes the
        // window wait (revert, retried) until CLOSE_WINDOW_TIMEOUT, so no caller picks the outcome at an instant; then,
        // as for UNDERCAPITALISED at once, the book is cancelled (refunds 1:1), or, only if the charter opted in
        // (ifPoolFallback), the IF is raised from the tranches (the window re-run the old way)
        address pool = address(0);
        bytes32 poolReason = bytes32(0);
        if (r.ok && $.charter.ifFromPool) {
            (pool, poolReason) = BookPoolLogic.poolFunding($, r.seniorAllocated + r.juniorAllocated);
            if (pool == address(0)) {
                uint256 until = uint256($.subscriptionEnds) + CLOSE_WINDOW_TIMEOUT;
                if (poolReason == "POOL_UNFUNDED" && block.timestamp < until) {
                    revert Book.InsurancePoolCannotFund(uint64(until));
                }
                if ($.charter.ifPoolFallback) {
                    w.ifTargetUsd = $.charter.ifTargetUsd;
                    r = Waterfall.allocateWindow(w);
                } else {
                    r.ok = false;
                }
            }
        }

        if (!r.ok) {
            $.state = BRTypes.BookState.Cancelled;
            emit IBook.BookCancelled($.bookId, poolReason != bytes32(0) ? poolReason : _reasonCode(r.reason));
            senior.markCancelled();
            junior.markCancelled();
            return;
        }

        $.nav = [r.seniorAllocated, r.juniorAllocated];
        $.state = BRTypes.BookState.Live;
        if (poolReason != bytes32(0)) emit Book.InsuranceFallback($.bookId, poolReason);
        emit IBook.WindowClosed($.bookId, r.seniorAllocated, r.juniorAllocated, sCommitted, jCommitted);

        address vault = $.components.vault;
        senior.settleWindow(r.seniorAllocated, vault);
        junior.settleWindow(r.juniorAllocated, vault);

        (uint256 ifAmount, uint256 mmAmount,) = Waterfall.initialDeployment(
            r.seniorAllocated + r.juniorAllocated, w.ifTargetUsd, $.charter.mmInventoryUsd
        );
        // [2026-10 insurance pool] the pool sends the IF to the vault; it is deployed to the IF account below
        if (pool != address(0)) ifAmount = BookPoolLogic.drawInsurance($, pool);
        emit IBook.CapitalDeployed($.bookId, ifAmount, mmAmount);
        if (ifAmount > 0) IUnderwritingVault(vault).deployToVenue(BRTypes.ACCOUNT_IF, ifAmount);
        if (mmAmount > 0) IUnderwritingVault(vault).deployToVenue(BRTypes.ACCOUNT_MM, mmAmount);
    }

    /// @dev Book.cancelStuckWindow (Task 7 lead "unconfirmed deposits"): a window closeWindow could not close for
    ///      CLOSE_WINDOW_TIMEOUT (its venue deposit keeps reverting) is cancelled; commitments refundable 1:1. Fix round 2
    ///      (V-3): a pool-funded charter that can close now (the pool funds it, or its opted-in fallback) is closed by
    ///      closeWindow only, until twice the timeout (a venue deposit that keeps reverting still ends in a cancel).
    function cancelStuckWindow(Book.BookStorage storage $) external {
        if ($.state != BRTypes.BookState.Subscription) revert Book.BadState($.state);
        uint256 at = uint256($.subscriptionEnds) + CLOSE_WINDOW_TIMEOUT;
        if (block.timestamp < at) revert Book.WindowNotStuck(uint64(at));
        if (
            $.charter.ifFromPool && block.timestamp < at + CLOSE_WINDOW_TIMEOUT
                && BookPoolLogic.windowCanClose($)
        ) revert Book.WindowNotStuck(uint64(at + CLOSE_WINDOW_TIMEOUT));
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

        // [pool audit 2026-10-23] a due debt is repaid from the book's own idle cash before valuing, so IF cash a recall
        // brought back into the vault is never read as an IF draw (the snapshot's IF equity no longer holds it)
        if ($.poolDue) BookPoolLogic.repayPoolDue($, IUnderwritingVault($.components.vault).idle());
        int256 pnl;
        if ($.insurancePool != address(0) && !$.poolClosed) (pnl, sum) = BookPoolLogic.applyPoolPnl($, cfg, sum);
        else pnl = _applyPnl($, cfg, sum);
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
        // [2026-10 insurance pool] the pool's claim on the book's own capital, to the pool (a held mark is not fresh
        // for its epoch gate, pool audit 2026-10-23 B-L4)
        BookPoolLogic.markInsurance($, sum.periodEnd, false, m.input.held);
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
        // audit-B-verify2 hygiene: Senior's deferred IF share moves to the pool's claim before the Retired prices are set
        // (never counted again in them, as B-L1)
        if ($.insurancePool != address(0) && !$.poolClosed) BookPoolLogic.settleDeferred($);
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
        uint256 supplyBefore = IERC20(msg.sender).totalSupply() + sharesBurned;
        if (k == S) _scaleImpairment($, sharesBurned, supplyBefore);
        else _scaleJuniorIfLoss($, sharesBurned, supplyBefore);
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
        uint256 jSupply = IERC20($.components.junior).totalSupply();
        uint256 sc;
        uint256 jc;
        uint256 restored;
        uint256 repaid;
        if ($.insurancePool != address(0)) {
            (sc, jc, restored, repaid) = BookPoolLogic.creditPool($, seniorAmount, juniorAmount, jSupply);
        } else {
            Waterfall.DistributionResult memory r = Waterfall.applyDistribution(
                Waterfall.DistributionInput({
                    senior: seniorAmount,
                    junior: juniorAmount,
                    juniorSupply: jSupply,
                    seniorImpairment: $.seniorImpairment,
                    backstopDebt: $.backstopDebt
                })
            );
            $.seniorImpairment = r.seniorImpairment;
            $.backstopDebt = r.backstopDebt;
            (sc, jc, restored, repaid) = (r.seniorCredit, r.juniorCredit, r.seniorRestored, r.backstopRepaid);
            $.nav[S] += sc;
            $.nav[J] += jc;
        }
        emit IBook.DistributionCredited($.bookId, sc, jc);
        if (restored > 0 || repaid > 0) {
            $.backstopPayable += repaid;
            emit Book.DistributionRepaid($.bookId, restored, repaid);
        }
        if (st == BRTypes.BookState.Retired) {
            // late fee flow raises the immediate-settlement price for the remaining holders
            if (sc > 0) setRetiredPrice($, S, true);
            if (jc > 0) setRetiredPrice($, J, true);
        }
    }

    /// @dev Pays unfunded claims from vault idle, Senior first, then the backstop repayment owed (A5-01).
    ///      The repayment never blocks the caller: a vault that cannot pay it (e.g. a vault clone older
    ///      than repayBackstop) leaves it owed and reserved. [2026-10 insurance pool] A due pool claim is repaid
    ///      first, but only from the book's own idle cash (pool audit 2026-10-23 B-M1 / B-I6, whatever made the debt
    ///      due): never the cash owed to settled redemptions (they are final and rank ahead of the pool's provisional
    ///      claim), a repayment owed to the Backstop, or the Backstop cover Senior holds; a failed repayment leaves it
    ///      owed and its cash reserved, never blocking the caller.
    function fundClaims(Book.BookStorage storage $) public returns (uint256 funded) {
        uint256 us = $.unfunded[S];
        uint256 uj = $.unfunded[J];
        uint256 owed = $.backstopPayable;
        uint256 pc = $.poolDue ? $.poolValue : 0;
        if (us == 0 && uj == 0 && owed == 0 && pc == 0) return 0;
        IUnderwritingVault vault = IUnderwritingVault($.components.vault);
        uint256 idle = vault.idle();
        if (pc > 0) idle -= BookPoolLogic.repayPoolDue($, idle);
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
        emit Book.InsuranceDue($.bookId, $.poolValue);
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
        return $.unfunded[S] + $.unfunded[J] + $.backstopPayable + ($.poolDue ? $.poolValue : 0);
    }

    /// @dev Liabilities netted from NAV: liabilities() plus the pool's claim before it is due (the debt capped by the
    ///      book's own capital, at the mark's snapshot), so a pool-funded IF is never Senior / Junior value and an IF draw
    ///      is a book loss (Junior -> Senior, never the Backstop) before it can be the pool's.
    function navLiabilities(Book.BookStorage storage $) internal view returns (uint256) {
        return $.unfunded[S] + $.unfunded[J] + $.backstopPayable + $.poolValue;
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
        uint256 nav = Waterfall.markedNavNet(IUnderwritingVault(vault).idle(), navLiabilities($), sum.deployedValueUsd);
        Waterfall.MarkResult memory r = Waterfall.applyMarkPnl(
            Waterfall.MarkState({
                seniorNav: $.nav[S],
                juniorNav: $.nav[J],
                seniorImpairment: $.seniorImpairment,
                perfIndex: $.perfIndex,
                highWater: $.highWater,
                backstopDebt: $.backstopDebt
            }),
            Waterfall.MarkInputs({
                nav: nav,
                juniorSupply: IERC20($.components.junior).totalSupply(),
                backstopAvailable: _backstopBalance(backstop)
            })
        );

        uint256 covered;
        if (r.backstopCovered > 0) {
            uint256 shortfall = r.seniorImpairment + r.backstopCovered; // impairment before cover
            covered = _pullBackstop($.bookId, cfg, backstop, vault, shortfall);
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

    /// @dev Share prices from the post-P&L NAVs, before any settlement; returns the supplies.
    function _setPrices(Book.BookStorage storage $, MarkSummary memory sum)
        private
        returns (uint256[2] memory supplies)
    {
        for (uint8 k = 0; k < 2; k++) {
            uint256 supply = IERC20(tranche($, k)).totalSupply();
            supplies[k] = supply;
            uint256 p = Waterfall.sharePriceWad($.nav[k], supply);
            $.price[k] = p;
            sum.priceWad[k] = p;
        }
    }

    function _settleAtMark(Book.BookStorage storage $, MarkSummary memory sum) private {
        uint256 interval = $.markInterval;
        uint256 upTo = Waterfall.settlesUpTo(sum.periodEnd, interval);
        bool topUpDue = $.topUpOpen && upTo * interval >= $.topUpEndsAt;
        uint256[2] memory supplies = _setPrices($, sum);
        // Junior first so the Senior top-up cap sees the final Junior NAV
        _scaleJuniorIfLoss($, _settleTranche($, sum, J, upTo, topUpDue ? $.topUpCapacity[J] : 0), supplies[J]);
        // no Senior top-up while impaired: new shares would share the restoration owed to the old ones
        uint256 seniorCap = topUpDue && $.seniorImpairment == 0 && $.seniorIfDeferred == 0
            ? _seniorTopUpRoom($.nav[S], $.nav[J], $.charter.seniorCapBps, $.topUpCapacity[S])
            : 0;
        _scaleImpairment($, _settleTranche($, sum, S, upTo, seniorCap), supplies[S]);

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
            else _scaleJuniorIfLoss($, burned, supply);
            $.nav[k] -= owed[k];
            $.unfunded[k] += owed[k];
        }
        if (owed[S] > 0 || owed[J] > 0) emit Book.RetiredBacklogSettled($.bookId, owed[S], owed[J]);
        fundClaims($);
    }

    /// @dev Senior shares burned at a settlement (marks, Retired backlog / immediate redemptions) take their
    ///      pro-rata part of the impairment with them: imp' = floor(imp * (supply - burned) / supply), i.e.
    ///      0 once no Senior share is left. Restoration and backstop cover (the backstop is shared across
    ///      books) then only ever restore the remaining shares' loss. [pool audit 2026-10-23 B-L3] Its IF part and the
    ///      Backstop cover Senior holds scale the same way: redeemers take their part of the cover with them (backstopDebt,
    ///      owed from later gains, is unchanged; a Senior top-up never counts as cover).
    function _scaleImpairment(Book.BookStorage storage $, uint256 burned, uint256 supplyBefore) private {
        if (burned == 0) return;
        uint256 left = supplyBefore - burned;
        uint256 imp = $.seniorImpairment;
        if (imp != 0) {
            $.seniorImpairment = Math.mulDiv(imp, left, supplyBefore);
            uint256 impIf = $.seniorIfImpairment;
            if (impIf != 0) $.seniorIfImpairment = Math.mulDiv(impIf, left, supplyBefore);
        }
        uint256 c = $.coverHeld;
        if (c != 0) $.coverHeld = Math.mulDiv(c, left, supplyBefore);
        uint256 d = $.seniorIfDeferred;
        if (d != 0) $.seniorIfDeferred = Math.mulDiv(d, left, supplyBefore);
    }

    /// @dev Junior shares burned at a settlement take their pro-rata part of Junior's IF losses (the counterfactual Junior
    ///      capital in front of Senior's other losses) with them.
    function _scaleJuniorIfLoss(Book.BookStorage storage $, uint256 burned, uint256 supplyBefore) private {
        uint256 l = $.juniorIfLoss;
        if (burned == 0 || l == 0) return;
        $.juniorIfLoss = Math.mulDiv(l, supplyBefore - burned, supplyBefore);
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

    /// @dev finalizeRetirement of a pool-funded book: everything is back in the vault (deployedValueUsd == 0). The claim
    ///      is the ledger's (the last mark's, plus fee flow credited since: never a revaluation on live idle that the
    ///      Retired prices would count again, pool audit 2026-10-23 B-L1), due, repaid from the book's own idle first; the
    ///      rest of the debt is written off for good (the pool's loss) and the retirement mark reports what is left (0
    ///      unless the repayment failed). Never reverts.
    function _closeInsurance(Book.BookStorage storage $) private {
        if ($.insurancePool == address(0) || $.poolClosed) return;
        if (!$.poolDue) {
            $.poolDue = true;
            emit Book.InsuranceDue($.bookId, $.poolDebt);
        }
        fundClaims($);
        uint256 debt = $.poolDebt;
        uint256 claim = $.poolValue;
        if (debt > claim) {
            $.poolDebt = claim;
            emit Book.InsuranceWrittenOff($.bookId, debt - claim);
        }
        BookPoolLogic.markInsurance($, $.lastMark.periodEnd, true, false);
    }

    function _reasonCode(uint8 reason) private pure returns (bytes32) {
        if (reason == Waterfall.REASON_NO_JUNIOR) return "NO_JUNIOR";
        if (reason == Waterfall.REASON_SPONSOR_SKIN) return "SPONSOR_SKIN";
        return "IF_UNFUNDED";
    }
}
