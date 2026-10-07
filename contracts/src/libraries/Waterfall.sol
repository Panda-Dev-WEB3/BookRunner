// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title Waterfall — pure book math. NORMATIVE mirror of `packages/shared/src/waterfall.ts`.
/// @notice Every function here must produce bit-identical results to its TypeScript counterpart on the
///         valid input domain (parity vectors: `contracts/test/vectors/waterfall.json`, consumed by
///         `test/book/WaterfallParity.t.sol`). Units: USD 6dp, WAD prices, bps (1e4 = 100%).
///         Rounding: always floor (TS bigint division on non-negative operands); payouts never exceed
///         what is owed and dust stays in the book. Products that could exceed 256 bits on extreme but
///         reachable states (performance index, share prices) use `Math.mulDiv`, which yields the exact
///         floor of the full-precision product — i.e. the same value as bigint arithmetic.
library Waterfall {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    /// @dev Sponsor must hold >= 10% of Junior at close of window (enforced by sponsor priority + cap).
    uint256 internal constant SPONSOR_MIN_JUNIOR_BPS = 1000;

    /// @dev allocateWindow reason codes (match scripts/gen-vectors.ts).
    uint8 internal constant REASON_OK = 0;
    uint8 internal constant REASON_NO_JUNIOR = 1;
    uint8 internal constant REASON_SPONSOR_SKIN = 2;
    uint8 internal constant REASON_IF_UNFUNDED = 3;

    // -----------------------------------------------------------------------------------------
    // 1. Window close
    // -----------------------------------------------------------------------------------------

    struct WindowInput {
        uint256 ifTargetUsd;
        uint256 mmInventoryUsd;
        uint256 seniorCapBps;
        uint256 seniorCommitted;
        uint256 juniorCommitted;
        uint256 sponsorJuniorCommitted;
    }

    struct WindowResult {
        bool ok;
        uint8 reason; // REASON_*
        uint256 seniorAllocated;
        uint256 juniorAllocated;
        uint256 sponsorJuniorAllocated; // the sponsor's part of juniorAllocated (allocated first)
    }

    /// @notice Window allocation with the senior cap and sponsor priority in Junior.
    /// @dev Sponsor priority: the sponsor's Junior commitment is allocated first and the Junior eligible
    ///      for allocation is capped at 10x it (everyone else: at most 9x the sponsor, pro-rata, the
    ///      excess refunded), so the sponsor always holds >= 10% of allocated Junior and outside
    ///      over-commitment can never cancel the book. Without a sponsor commitment nothing is capped and
    ///      the window fails SPONSOR_SKIN. `seniorCapBps > BPS` is outside the charter-validated domain
    ///      (MarketCharter rejects it as BAD_BPS); it is clamped to BPS so the function can never
    ///      underflow on such input.
    function allocateWindow(WindowInput memory i) internal pure returns (WindowResult memory r) {
        uint256 maxRaise = i.ifTargetUsd + i.mmInventoryUsd;
        uint256 c = i.seniorCapBps > BPS ? BPS : i.seniorCapBps;
        uint256 s = i.seniorCommitted;
        uint256 p = i.sponsorJuniorCommitted;
        uint256 j = p == 0 ? i.juniorCommitted : Math.min(i.juniorCommitted, (p * BPS) / SPONSOR_MIN_JUNIOR_BPS);

        uint256 sa0 = Math.min(s, (maxRaise * c) / BPS);
        uint256 ja = Math.min(j, maxRaise - sa0);
        // Senior may not exceed c of final book capital: sa <= ja * c / (1 - c)
        uint256 saCapByJunior = c >= BPS ? sa0 : (ja * c) / (BPS - c);
        uint256 sa = Math.min(sa0, saCapByJunior);
        ja = Math.min(j, maxRaise - sa);
        uint256 sp = Math.min(p, ja);

        uint8 reason = REASON_OK;
        if (ja == 0) {
            reason = REASON_NO_JUNIOR;
        } else if (sp * BPS < ja * SPONSOR_MIN_JUNIOR_BPS) {
            // only reachable without a sponsor commitment (priority + cap keep sp >= 10% of ja otherwise)
            reason = REASON_SPONSOR_SKIN;
        } else if (sa + ja < i.ifTargetUsd) {
            reason = REASON_IF_UNFUNDED;
        }

        if (reason != REASON_OK) {
            return WindowResult({
                ok: false, reason: reason, seniorAllocated: 0, juniorAllocated: 0, sponsorJuniorAllocated: 0
            });
        }
        return WindowResult({
            ok: true, reason: REASON_OK, seniorAllocated: sa, juniorAllocated: ja, sponsorJuniorAllocated: sp
        });
    }

    /// @notice Per-wallet settlement of a Junior window commitment with sponsor priority: the sponsor
    ///         receives min(sponsorCommitted, totalAllocated) shares first; every other wallet shares the
    ///         rest pro-rata on the non-sponsor commitments (walletAllocation). 1 share = 1 USDC unit.
    /// @dev Requires totalAllocated <= totalCommitted, sponsorCommitted <= totalCommitted and, for the
    ///      sponsor, commit == sponsorCommitted (reverts on underflow otherwise). Sums never exceed the
    ///      allocation / refund totals, since totalAllocated - sp <= totalCommitted - sponsorCommitted.
    function juniorWindowAllocation(
        uint256 commit,
        bool isSponsor,
        uint256 totalCommitted,
        uint256 sponsorCommitted,
        uint256 totalAllocated
    ) internal pure returns (uint256 shares, uint256 refund) {
        uint256 sp = Math.min(sponsorCommitted, totalAllocated);
        if (isSponsor) return (sp, commit - sp);
        return walletAllocation(commit, totalCommitted - sponsorCommitted, totalAllocated - sp);
    }

    /// @notice Per-wallet settlement of a window commitment (1 share = 1 USDC unit at close).
    /// @dev Requires totalAllocated <= totalCommitted (reverts on underflow otherwise).
    function walletAllocation(uint256 commit, uint256 totalCommitted, uint256 totalAllocated)
        internal
        pure
        returns (uint256 shares, uint256 refund)
    {
        if (totalCommitted == 0) return (0, 0);
        shares = Math.mulDiv(commit, totalAllocated, totalCommitted);
        refund = Math.mulDiv(commit, totalCommitted - totalAllocated, totalCommitted);
    }

    /// @notice Generalisation of walletAllocation for top-up rounds settled at a mark price, where the
    ///         shares minted for the round differ from the assets accepted. For a window round
    ///         (sharesMinted == accepted) this equals walletAllocation exactly.
    function roundAllocation(uint256 commit, uint256 totalCommitted, uint256 accepted, uint256 sharesMinted)
        internal
        pure
        returns (uint256 shares, uint256 refund)
    {
        if (totalCommitted == 0) return (0, 0);
        shares = Math.mulDiv(commit, sharesMinted, totalCommitted);
        refund = Math.mulDiv(commit, totalCommitted - accepted, totalCommitted);
    }

    /// @notice Initial deployment at close: IF first, then MM inventory; remainder stays idle in the vault.
    function initialDeployment(uint256 total, uint256 ifTargetUsd, uint256 mmInventoryUsd)
        internal
        pure
        returns (uint256 ifAmount, uint256 mmAmount, uint256 idle)
    {
        ifAmount = Math.min(ifTargetUsd, total);
        mmAmount = Math.min(mmInventoryUsd, total - ifAmount);
        idle = total - ifAmount - mmAmount;
    }

    // -----------------------------------------------------------------------------------------
    // 2. Fee-flow distribution
    // -----------------------------------------------------------------------------------------

    struct SplitInput {
        uint256 gross;
        uint256 expensesRequested;
        uint256 expenseCapBps;
        uint256 carryBps;
        uint256 seniorHurdleBps;
        uint256 seniorSupply;
        uint256 juniorSupply;
    }

    struct SplitResult {
        uint256 gross;
        uint256 expenses;
        uint256 carry;
        uint256 senior;
        uint256 junior;
    }

    /// @notice expenses (capped) -> carry (carryBps of net) -> Senior share (hurdle of the rest) -> Junior.
    function splitDistribution(SplitInput memory i) internal pure returns (SplitResult memory o) {
        uint256 expenses = Math.min(i.expensesRequested, (i.gross * i.expenseCapBps) / BPS);
        uint256 net = i.gross - expenses;
        uint256 carry = (net * i.carryBps) / BPS;
        uint256 rest = net - carry;
        uint256 senior;
        uint256 junior;
        if (i.seniorSupply == 0) {
            junior = rest;
        } else if (i.juniorSupply == 0) {
            senior = rest;
        } else {
            senior = (rest * i.seniorHurdleBps) / BPS;
            junior = rest - senior;
        }
        o = SplitResult({gross: i.gross, expenses: expenses, carry: carry, senior: senior, junior: junior});
    }

    // -----------------------------------------------------------------------------------------
    // 3. Mark application
    // -----------------------------------------------------------------------------------------

    struct MarkState {
        uint256 seniorNav;
        uint256 juniorNav;
        uint256 seniorImpairment;
        uint256 perfIndex; // WAD
        uint256 highWater; // WAD
        uint256 backstopDebt; // backstop cover not yet repaid from later gains
    }

    struct MarkInputs {
        uint256 nav;
        uint256 juniorSupply;
        uint256 backstopAvailable;
    }

    struct MarkResult {
        uint256 seniorNav;
        uint256 juniorNav;
        uint256 seniorImpairment;
        uint256 perfIndex;
        uint256 highWater;
        int256 pnl; // nav - accounted
        uint256 juniorLoss;
        uint256 seniorLoss;
        uint256 backstopCovered;
        uint256 seniorRestored;
        uint256 juniorGain;
        int256 drawdownBps; // <= 0
        uint256 backstopRepaid; // gain owed back to the backstop (leaves the tranches)
        uint256 backstopDebt; // debt after this mark: debt - repaid + covered
    }

    /// @notice Loss: Junior first, then Senior (impairment += senior loss); if Junior == 0 and Senior is
    ///         impaired, the backstop covers min(impairment, available) and the cover becomes backstop
    ///         debt. Gain: restores impairment first, then repays backstop debt (that part leaves the
    ///         tranches: S' + J' == nav + covered - repaid), then Junior residual (Senior if Junior
    ///         supply == 0). Performance index moves by nav / accounted (pre-backstop); drawdown measured
    ///         from its high-water mark.
    function applyMarkPnl(MarkState memory s, MarkInputs memory m)
        internal
        pure
        returns (MarkResult memory r)
    {
        uint256 sNav = s.seniorNav;
        uint256 jNav = s.juniorNav;
        uint256 imp = s.seniorImpairment;
        uint256 accounted = sNav + jNav;
        r.pnl = SafeCast.toInt256(m.nav) - SafeCast.toInt256(accounted);

        if (m.nav < accounted) {
            uint256 loss = accounted - m.nav; // <= S + J because nav >= 0
            r.juniorLoss = Math.min(loss, jNav);
            jNav -= r.juniorLoss;
            r.seniorLoss = loss - r.juniorLoss;
            sNav -= r.seniorLoss;
            imp += r.seniorLoss;
        } else if (m.nav > accounted) {
            uint256 gain = m.nav - accounted;
            r.seniorRestored = Math.min(gain, imp);
            sNav += r.seniorRestored;
            imp -= r.seniorRestored;
            uint256 rest = gain - r.seniorRestored;
            r.backstopRepaid = Math.min(rest, s.backstopDebt);
            rest -= r.backstopRepaid;
            if (m.juniorSupply == 0) {
                sNav += rest;
            } else {
                jNav += rest;
                r.juniorGain = rest;
            }
        }

        if (jNav == 0 && imp > 0) {
            r.backstopCovered = Math.min(imp, m.backstopAvailable);
            sNav += r.backstopCovered;
            imp -= r.backstopCovered;
        }

        uint256 pi = accounted > 0 ? Math.mulDiv(s.perfIndex, m.nav, accounted) : s.perfIndex;
        uint256 hw = pi > s.highWater ? pi : s.highWater;
        // TS: ((pi - hw) * BPS) / hw with bigint truncation toward zero; pi <= hw so the numerator is <= 0.
        int256 dd = hw > 0 ? -SafeCast.toInt256(Math.mulDiv(hw - pi, BPS, hw)) : int256(0);

        r.seniorNav = sNav;
        r.juniorNav = jNav;
        r.seniorImpairment = imp;
        r.perfIndex = pi;
        r.highWater = hw;
        r.drawdownBps = dd;
        r.backstopDebt = s.backstopDebt - r.backstopRepaid + r.backstopCovered;
    }

    /// @notice Kill check at mark. killAtDrawdownBps must be negative (charter validation); >= 0 disables.
    function drawdownKill(int256 drawdownBps_, int256 killAtDrawdownBps) internal pure returns (bool) {
        return killAtDrawdownBps < 0 && drawdownBps_ <= killAtDrawdownBps;
    }

    // -----------------------------------------------------------------------------------------
    // 4. Share prices and redemption buckets
    // -----------------------------------------------------------------------------------------

    function sharePriceWad(uint256 trancheNav, uint256 supply) internal pure returns (uint256) {
        return supply == 0 ? WAD : Math.mulDiv(trancheNav, WAD, supply);
    }

    function sharesToAssets(uint256 shares, uint256 priceWad) internal pure returns (uint256) {
        return Math.mulDiv(shares, priceWad, WAD);
    }

    /// @notice Senior: eligible at request time. Junior: request time + notice. Notice != gate.
    function redeemEligibleAt(uint8 kind, uint256 requestedAt, uint256 juniorNoticeSeconds)
        internal
        pure
        returns (uint256)
    {
        return kind == 0 ? requestedAt : requestedAt + juniorNoticeSeconds;
    }

    /// @notice Bucket (requestId) = ceil(eligibleAt / markInterval).
    function bucketIndex(uint256 eligibleAt, uint256 markInterval) internal pure returns (uint256) {
        return (eligibleAt + markInterval - 1) / markInterval;
    }

    /// @notice A mark with periodEnd T settles buckets <= T / interval.
    function settlesUpTo(uint256 periodEnd, uint256 markInterval) internal pure returns (uint256) {
        return periodEnd / markInterval;
    }

    /// @notice Book NAV per the TS reference: max(idle - unfunded, 0) + deployed.
    /// @dev Exact mirror of waterfall.ts `markedNav`. NOTE: when vaultIdle < unfundedClaims this ignores
    ///      the part of the claim liability not covered by idle cash (overstating NAV). Book uses
    ///      `markedNavNet`, which nets the full liability; both agree whenever vaultIdle >= unfundedClaims.
    function markedNav(uint256 vaultIdle, uint256 unfundedClaims, uint256 deployedValueUsd)
        internal
        pure
        returns (uint256)
    {
        uint256 cash = vaultIdle > unfundedClaims ? vaultIdle - unfundedClaims : 0;
        return cash + deployedValueUsd;
    }

    /// @notice Book NAV as assets minus the settled-but-unfunded claim liability, floored at 0:
    ///         max(idle + deployed - unfunded, 0). Equal to `markedNav` when vaultIdle >= unfundedClaims.
    function markedNavNet(uint256 vaultIdle, uint256 unfundedClaims, uint256 deployedValueUsd)
        internal
        pure
        returns (uint256)
    {
        uint256 assets = vaultIdle + deployedValueUsd;
        return assets > unfundedClaims ? assets - unfundedClaims : 0;
    }
}
