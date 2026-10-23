// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

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

    struct DistributionInput {
        uint256 senior; // Senior hurdle share credited by the router
        uint256 junior; // Junior residual credited by the router
        uint256 juniorSupply;
        uint256 seniorImpairment;
        uint256 backstopDebt;
    }

    struct DistributionResult {
        uint256 seniorCredit; // added to S
        uint256 juniorCredit; // added to J
        uint256 seniorRestored; // part of the residual that restored Senior impairment
        uint256 backstopRepaid; // part of the residual owed back to the backstop (leaves the tranches)
        uint256 seniorImpairment; // after
        uint256 backstopDebt; // after
    }

    /// @notice Book.creditDistribution (audit 2026-10 L-1): the residual of a fee distribution follows the
    ///         mark gain order. The residual is the Junior amount, or the whole distribution when Junior has
    ///         no supply (the router then credits everything to Senior). It restores Senior impairment first,
    ///         then repays backstop debt (that part leaves the tranches: seniorCredit + juniorCredit ==
    ///         senior + junior - backstopRepaid), and only the rest is credited to Junior (Senior when Junior
    ///         has no supply). Senior's hurdle share is Senior's own income and is credited unchanged.
    function applyDistribution(DistributionInput memory i) internal pure returns (DistributionResult memory r) {
        uint256 residual = i.juniorSupply == 0 ? i.senior + i.junior : i.junior;
        uint256 hurdle = i.senior + i.junior - residual;
        r.seniorRestored = Math.min(residual, i.seniorImpairment);
        uint256 rest = residual - r.seniorRestored;
        r.backstopRepaid = Math.min(rest, i.backstopDebt);
        rest -= r.backstopRepaid;
        r.seniorCredit = hurdle + r.seniorRestored;
        if (i.juniorSupply == 0) r.seniorCredit += rest;
        else r.juniorCredit = rest;
        r.seniorImpairment = i.seniorImpairment - r.seniorRestored;
        r.backstopDebt = i.backstopDebt - r.backstopRepaid;
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

    // -----------------------------------------------------------------------------------------
    // 5. Insurance pool (appended 2026-10, docs/ARCHITECTURE.md §2.10): a pool-funded book
    // -----------------------------------------------------------------------------------------

    /// @notice IF target the window raises from the tranches: 0 when the InsurancePool funds the IF (`ifFromPool`),
    ///         so the sponsor raises only the MM inventory (allocateWindow's max raise and IF_UNFUNDED check, and
    ///         initialDeployment, then see no IF).
    function windowIfTarget(uint256 ifTargetUsd, bool ifFromPool) internal pure returns (uint256) {
        return ifFromPool ? 0 : ifTargetUsd;
    }

    /// @notice Premium rate a pool-funded book pays: the charter's rate, never below the pool's floor, at most BPS.
    function effectivePremiumBps(uint256 charterPremiumBps, uint256 floorBps) internal pure returns (uint256) {
        uint256 bps = charterPremiumBps > floorBps ? charterPremiumBps : floorBps;
        return bps > BPS ? BPS : bps;
    }

    /// @notice The pool's premium comes off the gross fee flow first; `rest` is then split by splitDistribution
    ///         (expenses -> carry -> Senior -> Junior). premium + rest == gross.
    function premiumSplit(uint256 gross, uint256 premiumBps) internal pure returns (uint256 premium, uint256 rest) {
        premium = (gross * premiumBps) / BPS;
        rest = gross - premium;
    }

    /// @notice Minimum own capital of a pool-funded book (audit 2026-10-23 B-M2): the tranche capital raised must be at
    ///         least `minOwnCapitalBps` of the IF the pool lends (InsurancePool.minOwnCapitalBps, 5000 = 50% by default).
    ///         Book.closeWindow checks the raise, MarketCharter the charter's MM inventory (the planned raise) at filing.
    function poolCapitalOk(uint256 trancheCapital, uint256 ifTargetUsd, uint256 minOwnCapitalBps)
        internal
        pure
        returns (bool)
    {
        return trancheCapital * BPS >= ifTargetUsd * minOwnCapitalBps;
    }

    // ---- the explicit insurance ledger of a pool-funded book (audit 2026-10-23: B-H1, B-M1, B-L2, B-L3) ----

    /// @notice Waterfall state of a pool-funded book. Every field is persistent book state, moved only by explicit
    ///         events (a mark's IF draw or other loss, Backstop cover, a gain, a fee distribution, a pool repayment, a
    ///         redemption), never rebuilt from NAV:
    ///         - `seniorIfImpairment`: the part of `seniorImpairment` that is insurance debt (an IF draw Senior absorbed).
    ///           The Backstop never covers it, and a gain restores it only after the Backstop is repaid.
    ///         - `juniorIfLoss`: the IF draws Junior absorbed. Had the IF never been drawn, Junior would still hold this
    ///           capital in front of Senior, so a later loss of another kind that reaches Senior is an insurance-debt
    ///           loss up to it (owner ruling N-1: the Backstop never covers more than it would without the IF draws).
    ///         - `coverHeld`: Backstop cover Senior still holds (<= Senior NAV, <= backstopDebt). Never the book's own
    ///           capital: it never backs the pool's claim nor repays it; a loss other than an IF draw consumes it first.
    ///         - `poolValue`: the pool's claim, <= `poolDebt`; below it only while the tranches hold no own capital
    ///           (Junior 0, Senior == coverHeld): a provisional pool loss, restored first by any later gain (N2-2).
    ///         - `ifDraw`: the outstanding IF draw at the last mark, max(0, poolDebt - IF equity).
    struct PoolMarkState {
        uint256 seniorNav;
        uint256 juniorNav;
        uint256 seniorImpairment;
        uint256 seniorIfImpairment;
        uint256 juniorIfLoss;
        uint256 coverHeld;
        uint256 backstopDebt;
        uint256 perfIndex;
        uint256 highWater;
        uint256 poolValue;
        uint256 poolDebt;
        uint256 ifDraw;
    }

    struct PoolMarkInputs {
        uint256 netAssets; // max(vault idle + deployed - unfunded claims - backstop repayment owed, 0)
        uint256 insuranceEquityUsd; // the mark's signed IF equity, capped at its deployed value
        bool due; // the debt is due (IF recall started): repayments move the draw, so it is never read as a recovery
        uint256 juniorSupply;
        uint256 backstopAvailable;
    }

    struct PoolMarkResult {
        PoolMarkState s; // after the mark, cover included (the input struct, updated in place)
        uint256 nav; // tranche NAV before cover, the repayment owed to the Backstop included: netAssets - poolValue'
        int256 pnl; // nav - accounted
        int256 drawdownBps;
        uint256 juniorLoss;
        uint256 seniorLoss; // seniorIfLoss included
        uint256 seniorIfLoss;
        uint256 poolLoss;
        uint256 poolRestored;
        uint256 seniorRestored;
        uint256 juniorGain;
        uint256 backstopRepaid;
        uint256 backstopCovered;
    }

    /// @notice Book.applyMark P&L of a pool-funded book: the change of the book's net assets against what the tranches
    ///         and the pool's claim held, allocated on the explicit ledger. `s` is updated in place (r.s == s).
    ///         - The IF draw since the last mark (`ifDraw` growth; once due only within a net loss) is the insurance debt's loss: Junior
    ///           (-> juniorIfLoss), then Senior's own capital (-> seniorIfImpairment), then the pool's claim; never the
    ///           Backstop cover.
    ///         - Any other loss: Junior first (within a mark Junior absorbs it before the IF draw: the conservative
    ///           split), then on Senior up to `juniorIfLoss` it is insurance debt as above (counterfactual Junior), the
    ///           rest consumes `coverHeld` first and is coverable, then the pool's claim (only once nothing is left).
    ///         - While Live the change splits exactly into an IF recovery (applied first), the other P&L, then the IF draw.
    ///         - A gain: the pool's provisional shortfall first (N2-2); an IF recovery (Live) then restores the IF losses
    ///           (Senior's, then Junior's); the rest restores Senior's impairment
    ///           other than the IF part, then repays the Backstop (coverHeld <= backstopDebt), then restores Senior's IF
    ///           impairment, then goes to Junior (Senior when Junior has no supply).
    ///         - Cover: only Senior's impairment other than the IF part, only while Junior is empty.
    function applyPoolMarkPnl(PoolMarkState memory s, PoolMarkInputs memory i)
        internal
        pure
        returns (PoolMarkResult memory r)
    {
        uint256 accounted = s.seniorNav + s.juniorNav;
        uint256 draw = s.poolDebt > i.insuranceEquityUsd ? s.poolDebt - i.insuranceEquityUsd : 0;
        uint256 held = accounted + s.poolValue;
        if (!i.due) {
            // Live: nothing recalls or repays the IF, so the draw moves only by IF P&L and splits the change exactly: an
            // IF recovery first, then the other P&L, then the IF draw (Junior absorbs other losses first, and the IF
            // draw takes what an other gain brought, as it would have without the gain)
            uint256 up = draw > s.ifDraw ? draw - s.ifDraw : 0;
            uint256 down = s.ifDraw > draw ? s.ifDraw - draw : 0;
            if (down > 0) _poolGain(s, r, down, down, i.juniorSupply);
            uint256 plus = i.netAssets + up;
            uint256 minus = held + down;
            if (plus > minus) _poolGain(s, r, plus - minus, 0, i.juniorSupply);
            else if (plus < minus) _poolLossOther(s, r, minus - plus);
            _poolLossIf(s, r, up);
        } else if (i.netAssets < held) {
            // due: repayments and recalls move the draw too, so only a net loss is split (the draw first within it:
            // conservative) and no fall of the draw is read as an IF recovery
            uint256 loss = held - i.netAssets;
            uint256 ifLoss = draw > s.ifDraw ? Math.min(loss, draw - s.ifDraw) : 0;
            _poolLossOther(s, r, loss - ifLoss);
            _poolLossIf(s, r, ifLoss);
        } else if (i.netAssets > held) {
            _poolGain(s, r, i.netAssets - held, 0, i.juniorSupply);
        }
        r.nav = i.netAssets - s.poolValue;
        r.pnl = SafeCast.toInt256(r.nav) - SafeCast.toInt256(accounted);

        uint256 other = s.seniorImpairment - s.seniorIfImpairment;
        if (s.juniorNav == 0 && other > 0) {
            uint256 c = Math.min(other, i.backstopAvailable);
            r.backstopCovered = c;
            s.seniorNav += c;
            s.seniorImpairment -= c;
            s.backstopDebt += c;
            s.coverHeld += c;
        }

        uint256 pi = accounted > 0 ? Math.mulDiv(s.perfIndex, r.nav, accounted) : s.perfIndex;
        uint256 hw = pi > s.highWater ? pi : s.highWater;
        r.drawdownBps = hw > 0 ? -SafeCast.toInt256(Math.mulDiv(hw - pi, BPS, hw)) : int256(0);
        s.perfIndex = pi;
        s.highWater = hw;
        s.ifDraw = draw;
        r.s = s;
    }

    /// @dev A loss other than the IF draw: Junior, then (counterfactual Junior) an IF loss of Senior's, then the cover,
    ///      then Senior's own capital, then the pool's claim.
    function _poolLossOther(PoolMarkState memory s, PoolMarkResult memory r, uint256 x) private pure {
        uint256 j = Math.min(x, s.juniorNav);
        s.juniorNav -= j;
        r.juniorLoss += j;
        x -= j;
        uint256 sw = Math.min(x, s.juniorIfLoss);
        s.juniorIfLoss -= sw;
        _poolLossIfSenior(s, r, sw);
        x -= sw;
        uint256 sl = Math.min(x, s.seniorNav);
        s.coverHeld -= Math.min(sl, s.coverHeld);
        s.seniorNav -= sl;
        s.seniorImpairment += sl;
        r.seniorLoss += sl;
        uint256 p = Math.min(x - sl, s.poolValue);
        s.poolValue -= p;
        r.poolLoss += p;
    }

    /// @dev The IF draw: Junior (juniorIfLoss), then Senior's own capital, then the pool's claim.
    function _poolLossIf(PoolMarkState memory s, PoolMarkResult memory r, uint256 x) private pure {
        uint256 j = Math.min(x, s.juniorNav);
        s.juniorNav -= j;
        s.juniorIfLoss += j;
        r.juniorLoss += j;
        _poolLossIfSenior(s, r, x - j);
    }

    /// @dev An insurance-debt loss reaching Senior: its own capital (seniorIfImpairment), then the pool's claim, and
    ///      only if nothing else is left (net assets below the cover) the cover itself, still never coverable.
    function _poolLossIfSenior(PoolMarkState memory s, PoolMarkResult memory r, uint256 x) private pure {
        uint256 own = Math.min(x, s.seniorNav - s.coverHeld);
        uint256 p = Math.min(x - own, s.poolValue);
        s.poolValue -= p;
        r.poolLoss += p;
        uint256 c = Math.min(x - own - p, s.coverHeld);
        s.coverHeld -= c;
        uint256 sl = own + c;
        s.seniorNav -= sl;
        s.seniorImpairment += sl;
        s.seniorIfImpairment += sl;
        r.seniorLoss += sl;
        r.seniorIfLoss += sl;
    }

    function _poolGain(PoolMarkState memory s, PoolMarkResult memory r, uint256 g, uint256 ifGain, uint256 jSupply)
        private
        pure
    {
        uint256 p = Math.min(g, s.poolDebt - s.poolValue);
        s.poolValue += p;
        r.poolRestored += p;
        g -= p;
        // an IF recovery reverses the IF losses: Senior's, then Junior's
        uint256 gi = Math.min(g, ifGain);
        uint256 a = Math.min(gi, s.seniorIfImpairment);
        s.seniorIfImpairment -= a;
        uint256 b = jSupply == 0 ? 0 : Math.min(gi - a, s.juniorIfLoss);
        s.juniorIfLoss -= b;
        s.juniorNav += b;
        r.juniorGain += b;
        g -= a + b;
        // the rest: Senior's other impairment, the Backstop, Senior's IF impairment, Junior
        uint256 n = Math.min(g, s.seniorImpairment - a - s.seniorIfImpairment);
        g -= n;
        uint256 rp = Math.min(g, s.backstopDebt);
        s.backstopDebt -= rp;
        if (s.coverHeld > s.backstopDebt) s.coverHeld = s.backstopDebt;
        r.backstopRepaid += rp;
        g -= rp;
        uint256 f = Math.min(g, s.seniorIfImpairment);
        s.seniorIfImpairment -= f;
        g -= f;
        // what a gain other than an IF recovery gives the pool's shortfall and Senior's IF impairment would, had the IF
        // never been drawn, have gone to Junior: counterfactual Junior capital in front of Senior's later other losses
        // (so neither the pool's priority nor the restoration ever makes the Backstop cover more)
        if (ifGain == 0 && jSupply != 0) s.juniorIfLoss += p + f;
        uint256 restored = a + n + f;
        s.seniorImpairment -= restored;
        s.seniorNav += restored;
        r.seniorRestored += restored;
        if (jSupply == 0) {
            s.seniorNav += g;
        } else {
            s.juniorNav += g;
            r.juniorGain += g;
        }
    }

    struct PoolDistributionInput {
        uint256 senior; // Senior hurdle share credited by the router
        uint256 junior; // Junior residual credited by the router
        uint256 juniorSupply;
        uint256 seniorImpairment;
        uint256 seniorIfImpairment;
        uint256 backstopDebt;
        uint256 coverHeld;
        uint256 juniorIfLoss;
        uint256 poolShortfall; // poolDebt - poolValue (0 once the pool's position is closed)
    }

    struct PoolDistributionResult {
        uint256 seniorCredit;
        uint256 juniorCredit;
        uint256 poolRestored; // raises the pool's claim (stays in the vault, owed to the pool)
        uint256 seniorRestored;
        uint256 backstopRepaid; // owed to the Backstop (leaves the tranches)
        uint256 seniorImpairment;
        uint256 seniorIfImpairment;
        uint256 backstopDebt;
        uint256 coverHeld;
        uint256 juniorIfLoss;
    }

    /// @notice Book.creditDistribution of a pool-funded book (audit 2026-10-23 B-L2): fee flow is own capital, so while
    ///         the book is exhausted it restores the pool's claim first (N2-2; the residual first, then the hurdle
    ///         share; the residual's part, and what restores Senior's IF impairment, is booked to juniorIfLoss). The rest of the residual follows the mark gain order: Senior's impairment other than the IF part,
    ///         the Backstop, Senior's IF impairment, then Junior (Senior when Junior has no supply). seniorCredit +
    ///         juniorCredit + poolRestored + backstopRepaid == senior + junior.
    function applyPoolDistribution(PoolDistributionInput memory i)
        internal
        pure
        returns (PoolDistributionResult memory r)
    {
        uint256 residual = i.juniorSupply == 0 ? i.senior + i.junior : i.junior;
        uint256 hurdle = i.senior + i.junior - residual;
        uint256 pr = Math.min(residual, i.poolShortfall);
        uint256 ph = Math.min(hurdle, i.poolShortfall - pr);
        r.poolRestored = pr + ph;
        residual -= pr;
        hurdle -= ph;
        uint256 n = Math.min(residual, i.seniorImpairment - i.seniorIfImpairment);
        residual -= n;
        r.backstopRepaid = Math.min(residual, i.backstopDebt);
        residual -= r.backstopRepaid;
        uint256 f = Math.min(residual, i.seniorIfImpairment);
        residual -= f;
        // the residual given to the pool and to Senior's IF impairment would otherwise be Junior's (applyPoolMarkPnl)
        r.juniorIfLoss = i.juniorSupply == 0 ? i.juniorIfLoss : i.juniorIfLoss + pr + f;
        r.seniorRestored = n + f;
        r.seniorCredit = hurdle + n + f;
        if (i.juniorSupply == 0) r.seniorCredit += residual;
        else r.juniorCredit = residual;
        r.seniorImpairment = i.seniorImpairment - n - f;
        r.seniorIfImpairment = i.seniorIfImpairment - f;
        r.backstopDebt = i.backstopDebt - r.backstopRepaid;
        r.coverHeld = i.coverHeld < r.backstopDebt ? i.coverHeld : r.backstopDebt;
    }
}
