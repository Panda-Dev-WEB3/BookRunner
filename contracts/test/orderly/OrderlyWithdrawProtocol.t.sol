// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";

import {OrderlyFixture} from "./utils/OrderlyFixture.sol";

/// @dev Views added by the withdrawal-protocol fix, called through an interface so this file also
///      compiles against the pre-fix adapter (regression tests must fail there, not fail to build).
interface IOrderlyAdapterProtocolViews {
    function heldForPendingWithdrawalsUsd() external view returns (uint256);
    function lastSweptPeriod() external view returns (uint64);
    function depositNativeFee(uint8 account, uint256 amount) external view returns (uint256);
}

/// @notice Regression tests for the review findings on the Orderly withdrawal / report / fee protocol:
///         a venue payout that lands before `confirmWithdraw` is held (never unattributed), reports are
///         rejected while a withdrawal is Requested, unattributed sweeps do not bump `book.flowNonce`, and
///         `sweepFees` cannot backfill old period labels.
contract OrderlyWithdrawProtocolTest is OrderlyFixture {
    bytes4 internal constant WITHDRAWAL_PENDING = bytes4(keccak256("WithdrawalPending(uint256)"));
    bytes4 internal constant PERIOD_TOO_OLD = bytes4(keccak256("PeriodTooOld(uint64,uint64)"));
    bytes4 internal constant PERIOD_NOT_AFTER_LAST_SWEPT =
        bytes4(keccak256("PeriodNotAfterLastSwept(uint64,uint64)"));

    function setUp() public override {
        super.setUp();
        _deploy(IF, 25_000e6);
        _deploy(MM, 75_000e6);
        vm.warp(block.timestamp + 10);
        _report(25_000e6, 75_000e6, 0);
        _applyCurrentMark();
    }

    function _views() internal view returns (IOrderlyAdapterProtocolViews) {
        return IOrderlyAdapterProtocolViews(address(adapter));
    }

    function _donate(uint256 amount) internal {
        usdc.mint(alice, amount);
        vm.prank(alice);
        usdc.transfer(address(adapter), amount);
    }

    // ------------------------------------------------------------------ payout before confirmWithdraw

    /// finding withdraw-pay-before-confirm-phantom-intransit / unconfirmed-withdrawal-swept-phantom-intransit /
    /// orderly-preconfirm-sweep-phantom-intransit: the ops-venue saga pays before it confirms.
    function test_payoutBeforeConfirm_isHeld_thenSweptOnce_noPhantomInTransit() public {
        uint256 nav0 = _navUsd();
        uint256 n = _recall(MM, 20_000e6);
        _payOut(MM, 20_000e6); // Orderly pays before confirmWithdraw
        assertEq(_navUsd(), nav0, "landed payout counted once (venue-side) while Requested");

        vm.prank(alice); // anyone
        assertEq(adapter.sweepToVault(), 0, "requested-but-unconfirmed payout is held, not unattributed");
        assertEq(usdc.balanceOf(address(adapter)), 20_000e6);
        assertEq(adapter.sweepableToVault(), 0);
        assertEq(_navUsd(), nav0);

        _confirm(n);
        assertEq(adapter.inTransitUsd(), 20_000e6);
        assertEq(_navUsd(), nav0, "confirmation after landing is NAV-neutral");

        assertEq(adapter.sweepToVault(), 20_000e6);
        assertEq(adapter.inTransitUsd(), 0, "no phantom in-transit");
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(_navUsd(), nav0);

        // a later ordinary cycle still clears exactly
        uint256 m = _recall(MM, 5000e6);
        _confirm(m);
        _payOut(MM, 5000e6);
        assertEq(adapter.sweepToVault(), 5000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(_navUsd(), nav0);
        assertEq(usdc.violations(), 0);
    }

    /// The second-saga path: another saga's sweep (or anyone) must not take an unconfirmed payout.
    function test_payoutBeforeConfirm_otherSagaSweepTakesOnlyItsPrincipal() public {
        uint256 nav0 = _navUsd();
        uint256 a = _recall(MM, 20_000e6);
        uint256 b = _recall(IF, 5000e6);
        _confirm(b);
        _payOut(IF, 5000e6);
        _payOut(MM, 20_000e6); // saga A paid, its confirm still pending
        assertEq(adapter.sweepToVault(), 5000e6, "only confirmed principal moves");
        assertEq(usdc.balanceOf(address(adapter)), 20_000e6);
        assertEq(_navUsd(), nav0);

        _confirm(a);
        assertEq(adapter.sweepToVault(), 20_000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(_navUsd(), nav0);
    }

    /// The pre-confirm sweep used to bypass the mark-window gate (principal == 0); now it moves nothing and
    /// the principal, once confirmed, waits for the mark like any other.
    function test_payoutBeforeConfirm_gateStillApplies() public {
        uint256 nav0 = _navUsd();
        uint256 n = _recall(MM, 30_000e6);
        _warpToNextPeriod(5);
        assertFalse(adapter.sweepOpen());
        _payOut(MM, 30_000e6);
        vm.prank(alice);
        assertEq(adapter.sweepToVault(), 0, "held payout cannot slip past the closed gate");

        _confirm(n);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.SweepBlockedUntilMark.selector,
                _currentPeriodStart(),
                _currentPeriodStart() - MARK_INTERVAL
            )
        );
        adapter.sweepToVault();

        _applyCurrentMark();
        assertEq(adapter.sweepToVault(), 30_000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(_navUsd(), nav0);
    }

    /// Fee forwarding (permissionless) must not route a held payout through the fee waterfall.
    function test_payoutBeforeConfirm_feeForwardCannotTakeIt() public {
        uint64 p = _firstFeePeriod();
        vm.warp(uint256(p) + 1);
        _applyCurrentMark();
        vm.prank(ops);
        assertEq(adapter.sweepFees(p, 2000e6), 0, "earmark only");

        uint256 nav0 = _navUsd();
        uint256 n = _recall(MM, 20_000e6);
        _payOut(MM, 20_000e6);
        assertEq(adapter.forwardableFees(), 0);
        vm.prank(alice);
        assertEq(adapter.forwardPendingFees(), 0, "principal is never fee flow");
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(adapter.pendingFeesUsd(), 2000e6);

        _confirm(n);
        assertEq(adapter.forwardPendingFees(), 0);
        assertEq(adapter.sweepToVault(), 20_000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(_navUsd(), nav0);

        // the real fee payment then forwards normally
        _donate(2000e6);
        assertEq(adapter.forwardPendingFees(), 2000e6);
        assertEq(router.pendingGross(), 2000e6);
    }

    /// With a venue fee the held amount is the net payout; confirmation books the fee once.
    function test_payoutBeforeConfirm_withVenueFee() public {
        uint256 nav0 = _navUsd();
        uint256 n = _recall(MM, 10_000e6);
        bytes32 mmId = adapter.accountId(MM);
        vm.prank(orderlyOperator);
        ov.operatorWithdrawWithFee(mmId, address(adapter), 10_000e6, 1e6);
        assertEq(adapter.sweepToVault(), 0);
        vm.prank(ops);
        adapter.confirmWithdrawWithFee(n, 1e6);
        assertEq(_navUsd(), nav0 - 1e6, "venue fee is the only cost");
        assertEq(adapter.sweepToVault(), 9999e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(_navUsd(), nav0 - 1e6);
    }

    function test_heldView_tracksPendingPayouts() public {
        uint256 n = _recall(MM, 20_000e6);
        _payOut(MM, 12_000e6);
        _donate(3e6);
        // attribution is fungible: everything up to the pending amount is held
        assertEq(_views().heldForPendingWithdrawalsUsd(), 12_003e6);
        assertEq(adapter.sweepableToVault(), 0);
        _payOut(MM, 8000e6);
        assertEq(_views().heldForPendingWithdrawalsUsd(), 20_000e6);
        assertEq(adapter.sweepableToVault(), 3e6, "only the excess beyond the pending amount is free");
        _confirm(n);
        assertEq(_views().heldForPendingWithdrawalsUsd(), 0);
        assertEq(adapter.sweepableToVault(), 20_003e6);
    }

    // ------------------------------------------------------------------ reports vs in-flight withdrawals

    /// finding orderly-report-double-debits-inflight-withdrawals / pending-withdrawal-nav-understated: the
    /// venue debits on request; a report between the venue debit and the on-chain confirmation used to be
    /// accepted and confirm then debited the same amount again.
    function test_report_rejectedWhileWithdrawalRequested_noDoubleDebit() public {
        uint256 nav0 = _navUsd();
        uint256 n = _recall(MM, 30_000e6);
        vm.warp(block.timestamp + 5);
        // venue MM equity after the venue-side request: 45k
        vm.prank(ops);
        vm.expectRevert(abi.encodeWithSelector(WITHDRAWAL_PENDING, 30_000e6));
        adapter.report(25_000e6, 45_000e6, 0, uint64(block.timestamp));
        assertEq(_navUsd(), nav0);

        _confirm(n);
        assertEq(_navUsd(), nav0);
        vm.warp(block.timestamp + 1);
        _report(25_000e6, 45_000e6, 0); // raw venue equity, net of the executed withdrawal
        assertEq(adapter.deployedValueUsd(), 100_000e6, "25k IF + 45k MM + 30k in transit");
        assertEq(_navUsd(), nav0, "no phantom loss");
    }

    function test_report_rejectedWhileAnyAccountPending_acceptedAfterCancel() public {
        uint256 a = _recall(IF, 5000e6);
        uint256 b = _recall(MM, 7000e6);
        vm.warp(block.timestamp + 2);
        uint64 snapshotWhilePending = uint64(block.timestamp);
        _confirm(b);
        vm.prank(ops);
        vm.expectRevert(abi.encodeWithSelector(WITHDRAWAL_PENDING, 5000e6));
        adapter.report(25_000e6, 68_000e6, 0, snapshotWhilePending);

        vm.warp(block.timestamp + 3);
        vm.prank(ops);
        adapter.cancelWithdraw(a);
        // a snapshot taken while the cancelled request was outstanding can no longer be posted
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.ReportPredatesFlow.selector, snapshotWhilePending, uint64(block.timestamp)
            )
        );
        adapter.report(25_000e6, 68_000e6, 0, snapshotWhilePending);
        vm.warp(block.timestamp + 1); // strictly after the cancellation
        _report(25_000e6, 68_000e6, 0);
        assertEq(adapter.deployedValueUsd(), 100_000e6);
    }

    // ------------------------------------------------------------------ flowNonce griefing

    /// findings flownonce-grief-voids-marks / flownonce-grief-burns-marks / permissionless-flownonce-bump-mark-dos.
    function test_dustDonationSweep_doesNotBumpFlowNonce() public {
        uint64 nonce0 = bookMock.flowNonce();
        _donate(1);
        vm.prank(alice);
        assertEq(adapter.sweepToVault(), 1);
        assertEq(bookMock.flowNonce(), nonce0, "a dust sweep must not invalidate a committed mark");

        // also with the mark-window gate closed (right after a period end, while a mark is pending)
        _warpToNextPeriod(1);
        _donate(1);
        vm.prank(alice);
        assertEq(adapter.sweepToVault(), 1);
        assertEq(bookMock.flowNonce(), nonce0);
        _applyCurrentMark();

        // a principal sweep still notifies (defence in depth)
        uint256 n = _recall(MM, 1000e6);
        uint64 nonce1 = bookMock.flowNonce();
        _confirm(n);
        _payOut(MM, 1000e6);
        assertEq(adapter.sweepToVault(), 1000e6);
        assertEq(bookMock.flowNonce(), nonce1 + 1);
    }

    function test_heldPayoutSweepAttempt_doesNotBumpFlowNonce() public {
        _recall(MM, 1000e6);
        _payOut(MM, 1000e6);
        uint64 nonce0 = bookMock.flowNonce();
        vm.prank(alice);
        adapter.sweepToVault();
        assertEq(bookMock.flowNonce(), nonce0);
    }

    // ------------------------------------------------------------------ deposit fee preview (ops hook)

    function test_depositNativeFee_previewsVenueFee() public {
        assertEq(_views().depositNativeFee(MM, 10e6), 0);
        ov.setDepositFee(0.0005 ether);
        assertEq(_views().depositNativeFee(IF, 10e6), 0.0005 ether);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.InvalidAccount.selector, uint8(2)));
        _views().depositNativeFee(2, 10e6);
        // pre-funding the previewed fee makes the deploy go through
        vm.deal(address(adapter), _views().depositNativeFee(MM, 10e6));
        _deploy(MM, 10e6);
        assertEq(address(adapter).balance, 0);
    }

    // ------------------------------------------------------------------ fee sweep backfill

    /// finding fee-sweep-backfill-defeats-period-cap.
    function test_sweepFees_cannotBackfillOldPeriods() public {
        uint64 p1 = _firstFeePeriod();
        vm.warp(uint256(p1) + 50 * uint256(MARK_INTERVAL) + 1);
        _applyCurrentMark();
        uint64 cur = _currentPeriodStart();
        uint64 oldest = cur - 2 * MARK_INTERVAL;

        vm.startPrank(ops);
        vm.expectRevert(abi.encodeWithSelector(PERIOD_TOO_OLD, p1, oldest));
        adapter.sweepFees(p1, DEFAULT_CAP);
        vm.expectRevert(abi.encodeWithSelector(PERIOD_TOO_OLD, oldest - MARK_INTERVAL, oldest));
        adapter.sweepFees(oldest - MARK_INTERVAL, DEFAULT_CAP);

        adapter.sweepFees(oldest, DEFAULT_CAP);
        adapter.sweepFees(cur, DEFAULT_CAP);
        // monotonic: a skipped label in between cannot be filled in afterwards
        vm.expectRevert(abi.encodeWithSelector(PERIOD_NOT_AFTER_LAST_SWEPT, cur - MARK_INTERVAL, cur));
        adapter.sweepFees(cur - MARK_INTERVAL, DEFAULT_CAP);
        vm.stopPrank();

        assertEq(adapter.pendingFeesUsd(), 2 * DEFAULT_CAP);
        assertEq(_views().lastSweptPeriod(), cur);

        // the next period opens exactly one more cap
        vm.warp(uint256(cur) + MARK_INTERVAL + 1);
        vm.prank(ops);
        adapter.sweepFees(cur + MARK_INTERVAL, DEFAULT_CAP);
        assertEq(adapter.pendingFeesUsd(), 3 * DEFAULT_CAP);
    }

    /// Whatever labels a (compromised) OPS_VENUE key tries in one block, at most (1 + lookback) caps can
    /// be earmarked, however long the book went without sweeps.
    function testFuzz_sweepFees_burstBoundedByLookback(uint64[12] calldata picks, uint16 idlePeriods) public {
        uint64 p1 = _firstFeePeriod();
        vm.warp(uint256(p1) + uint256(bound(idlePeriods, 0, 2000)) * MARK_INTERVAL + 1);
        uint64 cur = _currentPeriodStart();
        for (uint256 i; i < picks.length; i++) {
            uint64 back = uint64(bound(picks[i], 0, 3000));
            if (back * MARK_INTERVAL > cur) continue;
            vm.prank(ops);
            try adapter.sweepFees(cur - back * MARK_INTERVAL, DEFAULT_CAP) {} catch {}
        }
        assertLe(adapter.pendingFeesUsd(), (1 + 2) * DEFAULT_CAP);
    }
}

/// @notice NAV conservation under ANY interleaving of venue payouts (full or partial, before or after
///         confirmation), confirmations (with or without venue fee), permissionless sweeps and fee
///         forwards, and mark-window gate changes. No reports and no donations: NAV may only fall by the
///         venue fees charged, and earmarked fee flow that never lands may never be paid from principal.
contract OrderlyWithdrawOrderingFuzzTest is OrderlyFixture {
    struct Req {
        uint256 nonce;
        uint8 account;
        uint256 amount;
        uint256 fee;
        uint256 paid;
        bool confirmed;
    }

    uint256 internal constant MAX_REQ = 4;

    function _pay(Req memory r, uint256 seed) internal {
        if (r.paid == r.amount) return;
        bytes32 id = adapter.accountId(r.account);
        if (r.fee > 0) {
            vm.prank(orderlyOperator);
            ov.operatorWithdrawWithFee(id, address(adapter), r.amount, r.fee);
            r.paid = r.amount;
        } else {
            uint256 amt = bound(seed, 1, r.amount - r.paid);
            _payOut(r.account, amt);
            r.paid += amt;
        }
    }

    function _confirmReq(Req memory r) internal {
        if (r.confirmed) return;
        vm.prank(ops);
        adapter.confirmWithdrawWithFee(r.nonce, r.fee);
        r.confirmed = true;
    }

    function testFuzz_anyPayoutConfirmOrderIsNavNeutral(uint256[24] calldata seeds) public {
        _deploy(IF, IF_TARGET);
        _deploy(MM, MM_INVENTORY);
        uint64 p = _firstFeePeriod();
        vm.warp(uint256(p) + 1);
        _applyCurrentMark();
        vm.prank(ops);
        adapter.sweepFees(p, 1000e6); // earmark that never lands

        uint256 nav0 = _navUsd();
        uint256 feesCharged;
        uint256[2] memory requested;
        Req[] memory reqs = new Req[](MAX_REQ);
        uint256 nReq;

        for (uint256 i; i < seeds.length; i++) {
            uint256 s = seeds[i];
            uint256 op = s % 6;
            uint256 x = uint256(keccak256(abi.encode(s, i)));
            if (op == 0 && nReq < MAX_REQ) {
                uint8 acct = uint8(x % 2);
                uint256 room = (acct == IF ? uint256(IF_TARGET) : uint256(MM_INVENTORY)) - requested[acct];
                if (room == 0) continue;
                uint256 amt = bound(x >> 8, 1, room);
                uint256 fee = (x >> 200) % 3 == 0 ? bound(x >> 120, 0, amt / 100) : 0;
                reqs[nReq] = Req(_recall(acct, amt), acct, amt, fee, 0, false);
                requested[acct] += amt;
                nReq++;
            } else if (op == 1 && nReq > 0) {
                Req memory r = reqs[x % nReq];
                if (!r.confirmed) feesCharged += r.fee;
                _confirmReq(r);
            } else if (op == 2 && nReq > 0) {
                _pay(reqs[x % nReq], x >> 8);
            } else if (op == 3) {
                vm.prank(alice);
                try adapter.sweepToVault() {} catch {}
            } else if (op == 4) {
                vm.prank(alice);
                adapter.forwardPendingFees();
            } else if (op == 5) {
                if (x % 2 == 0) _warpToNextPeriod(1);
                else _applyCurrentMark();
            }
            assertEq(_navUsd(), nav0 - feesCharged, "every recalled USDC counted exactly once");
            assertEq(usdc.balanceOf(address(router)), 0, "fee forwarding never takes principal");
        }

        // settle: confirm and pay everything still open, open the gate, sweep
        for (uint256 k; k < nReq; k++) {
            Req memory r = reqs[k];
            if (!r.confirmed) feesCharged += r.fee;
            _confirmReq(r);
            if (r.fee > 0) _pay(r, 0);
            else if (r.paid < r.amount) _payOut(r.account, r.amount - r.paid);
        }
        _applyCurrentMark();
        adapter.sweepToVault();
        assertEq(adapter.inTransitUsd(), 0, "no phantom in-transit");
        assertEq(usdc.balanceOf(address(adapter)), 0, "nothing stranded on the adapter");
        assertEq(_navUsd(), nav0 - feesCharged);
        assertEq(usdc.violations(), 0);
    }
}
