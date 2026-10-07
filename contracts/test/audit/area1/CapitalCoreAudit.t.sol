// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {Tranche} from "../../../src/Tranche.sol";
import {Waterfall} from "../../../src/libraries/Waterfall.sol";
import {BookFixture} from "../../book/utils/BookFixture.sol";

/// @notice SECURITY AUDIT — AREA 1 (capital core: Book / Tranche / UnderwritingVault / Waterfall).
///         Every test here asserts the SECURE behaviour and therefore FAILS on the audited code.
contract CapitalCoreAuditTest is BookFixture {
    function setUp() public {
        _setUpBook();
    }

    // =========================================================================================
    // A1-01 — sponsor-skin hook can be starved of gas (try/catch with an empty catch)
    // =========================================================================================

    /// @dev Tranche._update reports every outflow of the sponsor's Junior shares to the book inside
    ///      `try ... {} catch {}`. The hook does a 0 -> 1 SSTORE (sponsorAbandoned) when the sponsor
    ///      ends below 10%, so it needs > 20k gas, while the caller only needs a few hundred gas after
    ///      the catch. Calling `transfer` with a tuned gas limit makes the hook run out of gas (63/64
    ///      rule) while the transfer itself succeeds: the sponsor moves its whole Junior skin to another
    ///      address without `sponsorAbandoned` ever being set (no slashing possible), and that address
    ///      then redeems normally (the hook only watches the sponsor address).
    ///      SECURE: no successful sponsor outflow may leave the sponsor below 10% unflagged.
    function test_audit_sponsorSkinHookGasStarvation() public {
        _goLive();
        address alt = makeAddr("sponsorAlt");
        uint256 skin = junior.balanceOf(sponsor); // 10k of 30k Junior
        assertEq(skin, 10_000e6);

        uint256 bypassGas;
        for (uint256 g = 20_000; g <= 120_000; g += 100) {
            uint256 snap = vm.snapshotState();
            vm.prank(sponsor);
            (bool ok,) = address(junior).call{gas: g}(abi.encodeCall(IERC20.transfer, (alt, skin)));
            bool flagged = book.sponsorAbandoned();
            bool moved = junior.balanceOf(alt) == skin;
            vm.revertToState(snap);
            if (ok && moved && !flagged) {
                bypassGas = g;
                break;
            }
        }
        if (bypassGas != 0) {
            // replay the bypass for the record: the whole skin moved, the book never noticed
            vm.prank(sponsor);
            (bool ok,) = address(junior).call{gas: bypassGas}(abi.encodeCall(IERC20.transfer, (alt, skin)));
            assertTrue(ok);
            emit log_named_uint("transfer gas that starves the hook", bypassGas);
            emit log_named_uint("sponsor Junior balance after", junior.balanceOf(sponsor));
            // the alt address exits without any hook
            vm.prank(alt);
            junior.requestRedeem(skin, alt, alt);
        }
        assertEq(bypassGas, 0, "sponsor moved its Junior skin out without sponsorAbandoned being set");
    }

    // =========================================================================================
    // A1-02 — top-up share inflation via vault donation (no minimum supply / price bound)
    // =========================================================================================

    /// @dev Junior supply can be redeemed down to 1 share unit. A donation to the vault is P&L at the
    ///      next mark and goes entirely to Junior (supply > 0), so the sole Junior holder can push the
    ///      Junior price to ~D per share unit right before the mark that settles a top-up round.
    ///      `_settleTopUp` then accepts the whole round but mints floor(A / D) shares (here 1), and each
    ///      wallet gets floor(commit * minted / committed) = 0 shares and 0 refund. The single minted
    ///      share is stuck in escrow; the attacker's share is now worth (D + A) / 2.
    ///      SECURE: a top-up committer always receives shares + refund worth ~its commitment.
    function test_audit_topUpDonationInflation() public {
        _goLive();
        // every Junior holder but the attacker (sponsor) exits; the attacker keeps 1 share unit
        vm.prank(carol);
        junior.requestRedeem(20_000e6, carol, carol);
        vm.prank(sponsor);
        junior.requestRedeem(10_000e6 - 1, sponsor, sponsor);
        vm.warp(block.timestamp + NOTICE);
        while (junior.pendingBucketCount() > 0) {
            _markWithPnl(0);
        }
        assertEq(junior.totalSupply(), 1, "Junior supply is one share unit");

        // the attacker opens a Junior top-up round; honest wallets commit 100k
        vm.prank(sponsor);
        book.openTopUp(600, 0, 100_000e6);
        (, uint64 endsAt,,) = book.topUp();
        _deposit(junior, dave, 50_000e6);
        _deposit(junior, eve, 50_000e6);

        // after the round closed and right before the settling mark: donate 60k to the vault
        vm.warp(endsAt);
        uint256 donation = 60_000e6;
        usdc.mint(sponsor, donation);
        vm.prank(sponsor);
        usdc.transfer(address(vault), donation);
        while (!junior.roundInfo(1).settled) {
            _markWithPnl(0);
        }

        uint256 price = book.sharePrice(BRTypes.JUNIOR);
        emit log_named_uint("Junior price (WAD per share unit)", price);
        emit log_named_uint("round accepted", junior.roundInfo(1).accepted);
        emit log_named_uint("round sharesMinted", junior.roundInfo(1).sharesMinted);
        (, uint256 jNav) = book.trancheNav();
        emit log_named_uint("attacker 1 share unit worth after settlement", jNav / junior.totalSupply());

        (uint256 shares, uint256 refund) = junior.claimableAllocation(dave);
        uint256 daveValue = shares * price / WAD + refund;
        emit log_named_uint("dave committed", 50_000e6);
        emit log_named_uint("dave value (shares + refund)", daveValue);
        assertGe(daveValue, 49_500e6, "top-up committer lost its commitment to share-price inflation");
    }

    // =========================================================================================
    // A1-03 — Senior top-up while Senior is impaired dilutes the old holders' restoration
    // =========================================================================================

    /// @dev Senior shares minted in a top-up at the impaired price share pro-rata in the later
    ///      restoration of `seniorImpairment`, which belongs to the shares that took the loss
    ///      (ARCHITECTURE §2.5 [ext]: "restoration ... only ever restore the remaining shares").
    ///      Recapitalising after a loss (Junior wiped, Senior impaired, backstop short) is exactly when a
    ///      sponsor opens a top-up; the Senior cap only needs Junior NAV > 0, which the Junior part of
    ///      the same round provides (Junior settles first).
    ///      SECURE: once the whole impairment is restored, the pre-loss Senior shares are back at par.
    function test_audit_seniorTopUpDilutesImpairmentRestoration() public {
        _goLive();
        // loss of 40k: Junior (30k) wiped, Senior impaired by 10k; the backstop is empty
        _markWithPnl(-40_000e6);
        assertEq(book.seniorImpairment(), 10_000e6);
        // a fee distribution gives Junior a non-zero price again
        _credit(0, 300e6);

        vm.prank(sponsor);
        book.openTopUp(600, 20_000e6, 50_000e6);
        _deposit(junior, dave, 50_000e6);
        _deposit(senior, eve, 20_000e6);
        vm.warp(block.timestamp + 600);
        while (!senior.roundInfo(1).settled) {
            _markWithPnl(0);
        }
        // FIX (A1-03): no Senior top-up while Senior is impaired -> the Senior part is refunded in full
        assertEq(senior.roundInfo(1).accepted, 0, "Senior top-up refused while Senior is impaired");
        assertEq(book.seniorImpairment(), 10_000e6);

        // the venue recovers exactly the impairment
        _markWithPnl(10_000e6);
        assertEq(book.seniorImpairment(), 0, "impairment fully restored");

        uint256 oldShares = 70_000e6; // alice 40k + bob 30k, bought at par
        uint256 oldValue = senior.convertToAssets(oldShares);
        (uint256 eveShares, uint256 eveRefund) = senior.claimableAllocation(eve);
        emit log_named_uint("old Senior value after full restoration", oldValue);
        emit log_named_uint("eve paid", 20_000e6);
        emit log_named_uint("eve value", senior.convertToAssets(eveShares) + eveRefund);
        assertGe(oldValue, oldShares - 1e6, "pre-loss Senior shares not restored to par");
        assertEq(eveRefund, 20_000e6, "the refused Senior commitment is refunded 1:1");
    }

    // =========================================================================================
    // A1-05 — unallocatable dust shares keep "supply > 0": fee flow stranded on nobody's shares
    // =========================================================================================

    /// @dev Window / top-up settlement mints `allocated` shares into escrow but every wallet gets
    ///      floor(commit * allocated / committed), so up to (#wallets - 1) share units are never
    ///      claimable by anyone. They still count in totalSupply. Once every real Senior holder has
    ///      redeemed (e.g. right after finalizeRetirement, or a Senior run while Live), the router split
    ///      (`seniorSupply == 0 ? junior = rest`) and Waterfall see Senior supply == 2, so the Senior
    ///      hurdle share (60% of net fees) is credited to a tranche whose only shares sit unclaimable in
    ///      the tranche escrow: lost to Junior for good (and it inflates the Senior price for the next
    ///      top-up, see A1-02).
    ///      SECURE: fee flow is never credited to shares no one can ever redeem.
    function test_audit_dustSharesStrandFeeFlow() public {
        // Senior oversubscribed by 3 units: pro-rata floors leave 2 share units unallocatable
        _deposit(senior, alice, 40_000e6 + 1);
        _deposit(senior, bob, 30_000e6 + 1);
        _deposit(senior, dave, 1);
        _deposit(junior, sponsor, 10_000e6);
        _deposit(junior, carol, 20_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        senior.claimAllocation(alice);
        senior.claimAllocation(bob);
        senior.claimAllocation(dave);
        junior.claimAllocation(sponsor);
        junior.claimAllocation(carol);
        uint256 dust = senior.balanceOf(address(senior));
        emit log_named_uint("unallocatable Senior share units in escrow", dust);
        // FIX (A1-05): once the whole round is claimed, the unallocatable rounding dust is burned
        assertEq(dust, 0, "unallocatable Senior share units left in escrow");
        assertEq(senior.totalSupply(), senior.balanceOf(alice) + senior.balanceOf(bob) + senior.balanceOf(dave));

        // every Senior holder exits
        address[3] memory holders = [alice, bob, dave];
        for (uint256 i = 0; i < 3; i++) {
            uint256 bal = senior.balanceOf(holders[i]);
            if (bal == 0) continue;
            vm.prank(holders[i]);
            senior.requestRedeem(bal, holders[i], holders[i]);
        }
        _markWithPnl(0);
        assertEq(senior.totalSupply(), 0, "no Senior share left once every holder exited");
        (uint256 sNavBefore,) = book.trancheNav();

        // a 10k fee distribution, split exactly as RevenueRouter does (current supplies)
        Waterfall.SplitResult memory sp = Waterfall.splitDistribution(
            Waterfall.SplitInput({
                gross: 10_000e6,
                expensesRequested: 0,
                expenseCapBps: 2000,
                carryBps: 1000,
                seniorHurdleBps: 6000,
                seniorSupply: senior.totalSupply(),
                juniorSupply: junior.totalSupply()
            })
        );
        _credit(sp.senior, sp.junior);
        (uint256 sNavAfter,) = book.trancheNav();
        emit log_named_uint("fee credited to Senior (held only by escrow dust)", sNavAfter - sNavBefore);
        emit log_named_uint("fee credited to Junior", sp.junior);
        assertLe(sNavAfter - sNavBefore, 1e6, "fee flow stranded on unclaimable Senior dust shares");
    }

    // =========================================================================================
    // A1-04 — ERC-7540 maxRedeem / maxWithdraw exceed what redeem / withdraw can process
    // =========================================================================================

    /// @dev maxRedeem / maxWithdraw sum every settled bucket of the controller, but redeem / withdraw
    ///      only walk MAX_CLAIM_BUCKETS (64) buckets per call and revert ExceedsClaimable otherwise.
    ///      Any shareholder can push dust requests into a victim controller's list (controller is
    ///      free in requestRedeem), so an integrator calling redeem(maxRedeem(c)) is bricked by a
    ///      third party. ERC-4626/7540: maxRedeem MUST NOT exceed what redeem accepts.
    function test_audit_maxRedeemNotRedeemable() public {
        _goLive();
        _recall(10_000e6); // claims are funded: the only revert reason left is the bucket walk
        // bob (any Senior holder) griefs alice: 1 share unit per interval with controller = alice
        for (uint256 i = 0; i < Tranche(address(senior)).MAX_CLAIM_BUCKETS() + 1; i++) {
            vm.prank(bob);
            senior.requestRedeem(1, alice, bob);
            _markWithPnl(0);
        }
        // alice's own request
        vm.prank(alice);
        senior.requestRedeem(1000e6, alice, alice);
        _markWithPnl(0);

        uint256 maxShares = senior.maxRedeem(alice);
        // FIX (A1-04): maxRedeem only counts the next MAX_CLAIM_BUCKETS buckets (64 griefing units here);
        // alice's own request is reachable by calling again
        assertGt(maxShares, 0);
        assertLt(maxShares, 1000e6);
        assertGt(senior.claimableAssets(alice), 1000e6, "claimableAssets still reports every settled bucket");
        vm.prank(alice);
        (bool ok, bytes memory ret) =
            address(senior).call(abi.encodeCall(Tranche.redeem, (maxShares, alice, alice)));
        if (!ok) {
            assertEq(bytes4(ret), Tranche.ExceedsClaimable.selector, "reverts for the bucket walk, not liquidity");
        }
        assertTrue(ok, "redeem(maxRedeem(controller)) reverts ExceedsClaimable");
        // the next call reaches the rest: the 65th griefing unit and alice's own request
        maxShares = senior.maxRedeem(alice);
        assertEq(maxShares, 1000e6 + 1);
        vm.prank(alice);
        senior.redeem(maxShares, alice, alice);
        assertEq(senior.maxRedeem(alice), 0);
    }
}
