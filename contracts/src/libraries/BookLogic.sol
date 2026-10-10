// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

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
import {Waterfall} from "./Waterfall.sol";
import {Book, IVaultBackstopRepay} from "../Book.sol";

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

    /// @notice Working summary of a mark application (memory only; emitted as MarkSettled).
    ///         Arrays are indexed by tranche kind.
    struct MarkSummary {
        uint256 markId;
        uint64 periodEnd;
        uint64 flowNonce; // book flowNonce the mark was applied at
        uint256 navUsd; // marked NAV = max(vault idle + deployed - unfunded claims, 0)
        uint256 deployedValueUsd;
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
        Waterfall.WindowResult memory r = Waterfall.allocateWindow(
            Waterfall.WindowInput({
                ifTargetUsd: $.charter.ifTargetUsd,
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

        (uint256 ifAmount, uint256 mmAmount,) = Waterfall.initialDeployment(
            r.seniorAllocated + r.juniorAllocated, $.charter.ifTargetUsd, $.charter.mmInventoryUsd
        );
        emit IBook.CapitalDeployed($.bookId, ifAmount, mmAmount);
        if (ifAmount > 0) IUnderwritingVault(vault).deployToVenue(BRTypes.ACCOUNT_IF, ifAmount);
        if (mmAmount > 0) IUnderwritingVault(vault).deployToVenue(BRTypes.ACCOUNT_MM, mmAmount);
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

        int256 pnl = _applyPnl($, cfg, sum);
        _maybeDrawdownKill($);
        _settleAtMark($, sum);

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

    /// @dev Pays unfunded claims from vault idle, Senior first, then the backstop repayment owed (A5-01).
    ///      The repayment never blocks the caller: a vault that cannot pay it (e.g. a vault clone older
    ///      than repayBackstop) leaves it owed and reserved.
    function fundClaims(Book.BookStorage storage $) public returns (uint256 funded) {
        uint256 us = $.unfunded[S];
        uint256 uj = $.unfunded[J];
        uint256 owed = $.backstopPayable;
        if (us == 0 && uj == 0 && owed == 0) return 0;
        IUnderwritingVault vault = IUnderwritingVault($.components.vault);
        uint256 idle = vault.idle();
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
    // Shared internal helpers (also inlined into Book where it uses them)
    // =========================================================================================

    function liabilities(Book.BookStorage storage $) internal view returns (uint256) {
        return $.unfunded[S] + $.unfunded[J] + $.backstopPayable;
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
        uint256 nav =
            Waterfall.markedNavNet(IUnderwritingVault(vault).idle(), liabilities($), sum.deployedValueUsd);
        address backstop = cfg.backstop();
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

    function _settleAtMark(Book.BookStorage storage $, MarkSummary memory sum) private {
        uint256 interval = $.markInterval;
        uint256 upTo = Waterfall.settlesUpTo(sum.periodEnd, interval);
        bool topUpDue = $.topUpOpen && upTo * interval >= $.topUpEndsAt;
        // prices from the post-P&L NAVs, before any settlement
        uint256 seniorSupply;
        for (uint8 k = 0; k < 2; k++) {
            uint256 supply = IERC20(tranche($, k)).totalSupply();
            if (k == S) seniorSupply = supply;
            uint256 p = Waterfall.sharePriceWad($.nav[k], supply);
            $.price[k] = p;
            sum.priceWad[k] = p;
        }
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

    function _reasonCode(uint8 reason) private pure returns (bytes32) {
        if (reason == Waterfall.REASON_NO_JUNIOR) return "NO_JUNIOR";
        if (reason == Waterfall.REASON_SPONSOR_SKIN) return "SPONSOR_SKIN";
        return "IF_UNFUNDED";
    }
}
