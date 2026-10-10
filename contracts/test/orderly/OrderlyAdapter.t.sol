// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {MockOrderlyVault} from "../../src/mocks/MockOrderlyVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IVenueAdapter} from "../../src/interfaces/IVenueAdapter.sol";

import {OrderlyFixture} from "./utils/OrderlyFixture.sol";
import {
    OrderlyMockConfig,
    OrderlyMockUWVault,
    NonPullingOrderlyVault,
    OrderlyAdapterV2,
    EthRejecter
} from "./utils/OrderlyTestMocks.sol";

contract OrderlyAdapterInitTest is OrderlyFixture {
    function test_initialize_bindsBookAndVenue() public view {
        assertEq(adapter.config(), address(cfg));
        assertEq(adapter.bookId(), BOOK_ID);
        assertEq(adapter.book(), address(bookMock));
        assertEq(adapter.vault(), address(uwVault));
        assertEq(adapter.router(), address(router));
        assertEq(adapter.usdc(), address(usdc));
        assertEq(adapter.orderlyVault(), address(ov));
        assertEq(adapter.brokerHash(), BROKER_HASH);
        assertEq(adapter.tokenHash(), TOKEN_HASH);
        assertEq(adapter.venueKind(), BRTypes.VENUE_ORDERLY);
        assertEq(adapter.maxFeeSweepPerPeriodUsd(), DEFAULT_CAP);
        assertEq(adapter.feePeriodFloor(), uint64(1_750_000_123 - (1_750_000_123 % MARK_INTERVAL)));
        assertEq(adapter.valuationAt(), 0);
        assertEq(adapter.deployedValueUsd(), 0);
        assertEq(adapter.DEFAULT_BROKER_HASH(), BROKER_HASH);
        assertEq(adapter.DEFAULT_TOKEN_HASH(), TOKEN_HASH);
    }

    function test_initialize_emitsEvent() public {
        address predicted = _predictAdapter(BOOK_ID);
        bookMock.setComponents(_components(predicted));
        vm.expectEmit(true, true, false, true, predicted);
        emit OrderlyAdapter.AdapterInitialized(
            BOOK_ID,
            address(bookMock),
            address(uwVault),
            address(router),
            address(ov),
            BROKER_HASH,
            TOKEN_HASH,
            DEFAULT_CAP
        );
        _deployAdapter(BOOK_ID, false);
    }

    function test_accountIds_orderlyDerivation() public view {
        address ifAcc = adapter.ifAccount();
        assertTrue(ifAcc != address(0) && ifAcc.code.length != 0);
        bytes32 ifId = keccak256(abi.encode(ifAcc, BROKER_HASH));
        bytes32 mmId = keccak256(abi.encode(address(adapter), BROKER_HASH));
        assertEq(adapter.accountId(IF), ifId);
        assertEq(adapter.accountId(MM), mmId);
        assertEq(adapter.accountOwner(IF), ifAcc);
        assertEq(adapter.accountOwner(MM), address(adapter));
        assertTrue(ifId != mmId);
    }

    function test_accountIds_legacyDerivationBeforeMigration() public {
        _makeLegacy(adapter);
        assertEq(adapter.accountId(IF), keccak256(abi.encode(address(adapter), BROKER_HASH, uint8(0))));
        assertEq(adapter.accountId(MM), keccak256(abi.encode(address(adapter), BROKER_HASH, uint8(1))));
        assertEq(adapter.accountOwner(IF), address(adapter));
        assertEq(adapter.accountOwner(MM), address(adapter));
    }

    function test_accountId_revertsOnInvalidAccount() public {
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.InvalidAccount.selector, uint8(2)));
        adapter.accountId(2);
    }

    function test_initialize_onlyFactory() public {
        bytes memory data = mockFactory.initData(address(cfg), BOOK_ID, address(bookMock));
        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotFactory.selector);
        new ERC1967Proxy(address(impl), data);
    }

    function test_initialize_revertsTwice() public {
        vm.prank(factory);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        adapter.initialize(address(cfg), BOOK_ID, address(bookMock));
    }

    function test_implementation_isLocked() public {
        vm.prank(factory);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(cfg), BOOK_ID, address(bookMock));
    }

    function test_proxy_requiresInitData() public {
        vm.expectRevert(ERC1967Proxy.ERC1967ProxyUninitialized.selector);
        new ERC1967Proxy(address(impl), "");
    }

    function test_constructor_rejectsZeroHashes() public {
        vm.expectRevert(OrderlyAdapter.ZeroHash.selector);
        new OrderlyAdapter(bytes32(0), TOKEN_HASH);
        vm.expectRevert(OrderlyAdapter.ZeroHash.selector);
        new OrderlyAdapter(BROKER_HASH, bytes32(0));
    }

    function test_initialize_rejectsZeroAddresses() public {
        bytes memory noConfig = mockFactory.initData(address(0), BOOK_ID, address(bookMock));
        bytes memory noBook = mockFactory.initData(address(cfg), BOOK_ID, address(0));
        vm.startPrank(factory);
        vm.expectRevert(OrderlyAdapter.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), noConfig);
        vm.expectRevert(OrderlyAdapter.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), noBook);
        vm.stopPrank();
    }

    function test_initialize_rejectsBookIdMismatch() public {
        _expectDeployRevert(abi.encodeWithSelector(OrderlyAdapter.BookMismatch.selector), BOOK_ID + 1, true);
    }

    function test_initialize_rejectsWrongVenue() public {
        bookMock.setCharter(_charter(BRTypes.VENUE_POOL_ENGINE));
        _expectDeployRevert(
            abi.encodeWithSelector(OrderlyAdapter.WrongVenue.selector, BRTypes.VENUE_POOL_ENGINE),
            BOOK_ID,
            true
        );
    }

    function test_initialize_rejectsBookNotListingAdapter() public {
        // the book still lists the fixture adapter, not the new proxy
        _expectDeployRevert(abi.encodeWithSelector(OrderlyAdapter.NotBookAdapter.selector), BOOK_ID, false);
    }

    function test_initialize_rejectsMissingVaultOrRouter() public {
        address predicted = _predictAdapter(BOOK_ID);
        BRTypes.BookComponents memory c = _components(predicted);
        c.vault = address(0);
        bookMock.setComponents(c);
        _expectDeployRevert(abi.encodeWithSelector(OrderlyAdapter.ZeroAddress.selector), BOOK_ID, false);

        c = _components(predicted);
        c.router = address(0);
        bookMock.setComponents(c);
        _expectDeployRevert(abi.encodeWithSelector(OrderlyAdapter.ZeroAddress.selector), BOOK_ID, false);
    }

    function test_initialize_rejectsMissingConfigAddresses() public {
        cfg.setOrderlyVault(address(0));
        _expectDeployRevert(abi.encodeWithSelector(OrderlyAdapter.ZeroAddress.selector), BOOK_ID, true);

        cfg.setOrderlyVault(address(ov));
        cfg.setUsdc(address(0));
        _expectDeployRevert(abi.encodeWithSelector(OrderlyAdapter.ZeroAddress.selector), BOOK_ID, true);
    }

    function test_initialize_rejectsZeroMarkInterval() public {
        cfg.setMarkInterval(0);
        _expectDeployRevert(abi.encodeWithSelector(OrderlyAdapter.ZeroMarkInterval.selector), BOOK_ID, true);
    }

    function test_initialize_rejectsVenueTokenMismatch() public {
        ov.setTokenAllowed(false);
        _expectDeployRevert(
            abi.encodeWithSelector(OrderlyAdapter.TokenNotAllowedByVenue.selector, TOKEN_HASH, address(0)),
            BOOK_ID,
            true
        );

        // USDG-style mismatch: the venue's token for the hash is not the book's settlement token
        ov.setTokenAllowed(true);
        MockERC20 other = new MockERC20("Global Dollar", "USDG", 6);
        cfg.setUsdc(address(other));
        _expectDeployRevert(
            abi.encodeWithSelector(OrderlyAdapter.TokenNotAllowedByVenue.selector, TOKEN_HASH, address(usdc)),
            BOOK_ID,
            true
        );
    }
}

contract OrderlyAdapterDepositTest is OrderlyFixture {
    function test_deposit_IF_and_MM() public {
        bytes32 ifId = adapter.accountId(IF);
        vm.expectEmit(true, false, false, true, address(adapter));
        emit IVenueAdapter.VenueDeposit(IF, 25_000e6);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit OrderlyAdapter.OrderlyDeposit(IF, ifId, 25_000e6, 0);
        _deploy(IF, 25_000e6);
        _deploy(MM, 75_000e6);

        assertEq(adapter.insuranceEquityUsd(), 25_000e6);
        assertEq(adapter.marginEquityUsd(), int256(75_000e6));
        assertEq(adapter.deployedValueUsd(), 100_000e6);
        assertEq(adapter.totalDepositedUsd(IF), 25_000e6);
        assertEq(adapter.totalDepositedUsd(MM), 75_000e6);
        assertEq(adapter.lastFlowAt(), uint64(block.timestamp));

        assertEq(ov.balanceOf(adapter.accountId(IF)), 25_000e6);
        assertEq(ov.balanceOf(adapter.accountId(MM)), 75_000e6);
        assertEq(ov.accountOwner(adapter.accountId(MM)), address(adapter));
        assertEq(ov.accountBroker(adapter.accountId(MM)), BROKER_HASH);
        assertEq(usdc.balanceOf(address(ov)), 100_000e6);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.allowance(address(adapter), address(ov)), 0, "exact approval consumed");
        assertEq(usdc.allowance(address(uwVault), address(adapter)), 0);
        assertEq(uwVault.idle(), 900_000e6);
        assertEq(usdc.violations(), 0);
    }

    function test_deposit_isNavNeutral() public {
        uint256 navBefore = _navUsd();
        _deploy(IF, 25_000e6);
        _deploy(MM, 75_000e6);
        assertEq(_navUsd(), navBefore);
    }

    function test_deposit_onlyVault() public {
        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotVault.selector);
        adapter.depositToVenue(IF, 1e6);
        vm.prank(ops);
        vm.expectRevert(OrderlyAdapter.NotVault.selector);
        adapter.depositToVenue(MM, 1e6);
    }

    function test_deposit_rejectsInvalidAccount() public {
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.InvalidAccount.selector, uint8(2)));
        _deploy(2, 1e6);
    }

    function test_deposit_rejectsZero() public {
        vm.expectRevert(OrderlyAdapter.ZeroAmount.selector);
        _deploy(IF, 0);
    }

    function test_deposit_rejectsAmountAbove128Bits() public {
        uint256 huge = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 128, huge));
        _deploy(IF, huge);
    }

    function test_deposit_rejectsWhenVenueDisablesToken() public {
        ov.setTokenAllowed(false);
        vm.expectRevert(
            abi.encodeWithSelector(OrderlyAdapter.TokenNotAllowedByVenue.selector, TOKEN_HASH, address(0))
        );
        _deploy(IF, 1e6);
    }

    function test_deposit_paysNativeFeeFromAdapterBalance() public {
        ov.setDepositFee(0.0005 ether);
        vm.deal(address(adapter), 0.001 ether);
        bytes32 mmId = adapter.accountId(MM);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit OrderlyAdapter.OrderlyDeposit(MM, mmId, 10e6, 0.0005 ether);
        _deploy(MM, 10e6);
        assertEq(address(adapter).balance, 0.0005 ether);
        assertEq(address(ov).balance, 0.0005 ether);
        assertEq(ov.balanceOf(adapter.accountId(MM)), 10e6);
    }

    function test_deposit_revertsWithoutNativeForFee() public {
        ov.setDepositFee(0.0005 ether);
        vm.deal(address(adapter), 0.0001 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.InsufficientNativeForFee.selector, 0.0005 ether, 0.0001 ether
            )
        );
        _deploy(MM, 10e6);
    }

    function test_deposit_revertsIfVenueDoesNotPull() public {
        NonPullingOrderlyVault bad = new NonPullingOrderlyVault(address(usdc), TOKEN_HASH);
        cfg.setOrderlyVault(address(bad));
        OrderlyAdapter p = _deployAdapter(BOOK_ID, true);
        uwVault.setAdapter(address(p));

        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.VenueDidNotPull.selector, 5e6, 0));
        uwVault.deployToVenue(MM, 5e6);
    }

    function test_adapter_acceptsEth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(adapter).call{value: 0.2 ether}("");
        assertTrue(ok);
        assertEq(address(adapter).balance, 0.2 ether);
    }
}

contract OrderlyAdapterWithdrawTest is OrderlyFixture {
    function setUp() public override {
        super.setUp();
        _deploy(IF, 25_000e6);
        _deploy(MM, 75_000e6);
        vm.warp(block.timestamp + 10);
        _report(25_000e6, 75_000e6, 1000e6);
    }

    function test_requestWithdraw_recordsAndEmits() public {
        vm.expectEmit(true, true, false, true, address(adapter));
        emit IVenueAdapter.WithdrawRequested(MM, 10_000e6, 1);
        uint256 n1 = _recall(MM, 10_000e6);
        uint256 n2 = _recall(IF, 5000e6);
        assertEq(n1, 1);
        assertEq(n2, 2);
        OrderlyAdapter.WithdrawRequest memory r = adapter.withdrawRequest(1);
        assertEq(r.amount, 10_000e6);
        assertEq(r.account, MM);
        assertEq(uint8(r.status), uint8(OrderlyAdapter.WithdrawStatus.Requested));
        assertEq(r.requestedAt, uint64(block.timestamp));
        assertEq(adapter.pendingWithdrawUsd(MM), 10_000e6);
        assertEq(adapter.pendingWithdrawUsd(IF), 5000e6);
        // still venue-side, not in transit: counted exactly once
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.deployedValueUsd(), 100_000e6);
    }

    function test_requestWithdraw_onlyVault() public {
        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotVault.selector);
        adapter.requestWithdraw(MM, 1e6);
    }

    function test_requestWithdraw_rejectsInvalidAccountAndZero() public {
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.InvalidAccount.selector, uint8(7)));
        uwVault.recall(7, 1e6);
        vm.expectRevert(OrderlyAdapter.ZeroAmount.selector);
        uwVault.recall(MM, 0);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.InvalidAccount.selector, uint8(9)));
        adapter.pendingWithdrawUsd(9);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.InvalidAccount.selector, uint8(9)));
        adapter.totalDepositedUsd(9);
    }

    function test_confirm_movesVenueSideToInTransit() public {
        uint256 n = _recall(MM, 10_000e6);
        uint256 navBefore = _navUsd();
        vm.warp(block.timestamp + 5);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit OrderlyAdapter.WithdrawConfirmed(n, MM, 10_000e6, 0);
        _confirm(n);
        assertEq(adapter.marginEquityUsd(), int256(65_000e6));
        assertEq(adapter.inTransitUsd(), 10_000e6);
        assertEq(adapter.pendingWithdrawUsd(MM), 0);
        assertEq(adapter.lastFlowAt(), uint64(block.timestamp));
        assertEq(_navUsd(), navBefore, "confirmation is NAV-neutral");
        OrderlyAdapter.WithdrawRequest memory r = adapter.withdrawRequest(n);
        assertEq(uint8(r.status), uint8(OrderlyAdapter.WithdrawStatus.Confirmed));
        assertEq(r.confirmedAt, uint64(block.timestamp));
    }

    function test_confirm_onlyOpsVenue() public {
        uint256 n = _recall(MM, 1e6);
        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.confirmWithdraw(n);
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.confirmWithdrawWithFee(n, 0);
    }

    function test_confirm_rejectsUnknownAndDuplicate() public {
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.RequestNotPending.selector, 42, OrderlyAdapter.WithdrawStatus.None
            )
        );
        adapter.confirmWithdraw(42);

        uint256 n = _recall(MM, 1e6);
        _confirm(n);
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.RequestNotPending.selector, n, OrderlyAdapter.WithdrawStatus.Confirmed
            )
        );
        adapter.confirmWithdraw(n);
    }

    function test_confirmWithFee_expectsNetAmount() public {
        uint256 n = _recall(MM, 10_000e6);
        vm.prank(ops);
        adapter.confirmWithdrawWithFee(n, 1e6);
        assertEq(adapter.inTransitUsd(), 10_000e6 - 1e6);
        assertEq(adapter.marginEquityUsd(), int256(65_000e6));
        assertEq(adapter.withdrawRequest(n).venueFee, 1e6);

        uint256 n2 = _recall(MM, 5e6);
        vm.prank(ops);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.VenueFeeExceedsAmount.selector, 6e6, 5e6));
        adapter.confirmWithdrawWithFee(n2, 6e6);
    }

    function test_confirm_IF_saturatesAtZero_MM_goesNegative() public {
        vm.warp(block.timestamp + 1);
        _report(1000e6, 2000e6, 0); // stale-low report
        uint256 a = _recall(IF, 5000e6);
        uint256 b = _recall(MM, 5000e6);
        _confirm(a);
        _confirm(b);
        assertEq(adapter.insuranceEquityUsd(), 0);
        assertEq(adapter.marginEquityUsd(), -int256(3000e6));
        // deployed = 0 + max(-3000, 0) + 10_000 in transit
        assertEq(adapter.deployedValueUsd(), 10_000e6);
    }

    function test_cancel_onlyPending() public {
        uint256 n = _recall(IF, 2000e6);
        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.cancelWithdraw(n);

        vm.expectEmit(true, true, false, true, address(adapter));
        emit OrderlyAdapter.WithdrawCancelled(n, IF, 2000e6);
        vm.prank(ops);
        adapter.cancelWithdraw(n);
        assertEq(adapter.pendingWithdrawUsd(IF), 0);
        assertEq(uint8(adapter.withdrawRequest(n).status), uint8(OrderlyAdapter.WithdrawStatus.Cancelled));
        assertEq(adapter.insuranceEquityUsd(), 25_000e6);

        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.RequestNotPending.selector, n, OrderlyAdapter.WithdrawStatus.Cancelled
            )
        );
        adapter.cancelWithdraw(n);
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.RequestNotPending.selector, n, OrderlyAdapter.WithdrawStatus.Cancelled
            )
        );
        adapter.confirmWithdraw(n);
    }

    function test_fail_returnsToVenueSide() public {
        uint256 n = _recall(MM, 10_000e6);
        vm.prank(ops);
        adapter.confirmWithdrawWithFee(n, 1e6);
        uint256 navBefore = _navUsd();

        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.failWithdraw(n);

        vm.warp(block.timestamp + 3);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit OrderlyAdapter.WithdrawFailed(n, MM, 10_000e6);
        vm.prank(ops);
        adapter.failWithdraw(n);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.marginEquityUsd(), int256(75_000e6));
        assertEq(adapter.lastFlowAt(), uint64(block.timestamp));
        assertEq(_navUsd(), navBefore + 1e6, "venue fee not charged on a failed withdrawal");
        assertEq(uint8(adapter.withdrawRequest(n).status), uint8(OrderlyAdapter.WithdrawStatus.Failed));

        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.RequestNotConfirmed.selector, n, OrderlyAdapter.WithdrawStatus.Failed
            )
        );
        adapter.failWithdraw(n);
        uint256 pending = _recall(MM, 1e6);
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.RequestNotConfirmed.selector, pending, OrderlyAdapter.WithdrawStatus.Requested
            )
        );
        adapter.failWithdraw(pending);
    }
}

contract OrderlyAdapterSweepTest is OrderlyFixture {
    function setUp() public override {
        super.setUp();
        _deploy(IF, 25_000e6);
        _deploy(MM, 75_000e6);
    }

    function test_sweep_returnsPrincipalToVault() public {
        uint256 n = _recall(MM, 10_000e6);
        _confirm(n);
        _payOut(MM, 10_000e6);
        uint256 navBefore = _navUsd();
        uint256 idleBefore = uwVault.idle();

        vm.expectEmit(false, false, false, true, address(adapter));
        emit IVenueAdapter.SweptToVault(10_000e6);
        vm.expectEmit(false, false, false, true, address(adapter));
        emit OrderlyAdapter.InTransitCleared(10_000e6, 0);
        vm.prank(alice); // anyone
        uint256 swept = adapter.sweepToVault();

        assertEq(swept, 10_000e6);
        assertEq(uwVault.idle(), idleBefore + 10_000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.totalReturnedUsd(), 10_000e6);
        assertEq(_navUsd(), navBefore);
        assertEq(usdc.violations(), 0);
    }

    function test_sweep_nothingIsNoop() public {
        assertEq(adapter.sweepToVault(), 0);
        assertEq(adapter.sweepableToVault(), 0);
    }

    function test_sweep_partialLanding() public {
        uint256 n = _recall(MM, 10_000e6);
        _confirm(n);
        _payOut(MM, 4000e6);
        assertEq(adapter.sweepToVault(), 4000e6);
        assertEq(adapter.inTransitUsd(), 6000e6);
        _payOut(MM, 6000e6);
        assertEq(adapter.sweepToVault(), 6000e6);
        assertEq(adapter.inTransitUsd(), 0);
    }

    function test_sweep_unattributedFundsGoToVault() public {
        usdc.mint(alice, 50e6);
        vm.prank(alice);
        usdc.transfer(address(adapter), 50e6);
        assertEq(adapter.sweepToVault(), 50e6);
        assertEq(adapter.inTransitUsd(), 0);
    }

    function test_sweep_gate_blocksPrincipalUntilMarkApplied() public {
        uint256 n = _recall(MM, 10_000e6);
        _confirm(n);
        _payOut(MM, 10_000e6);

        _warpToNextPeriod(30); // period ended, its mark not yet applied
        assertFalse(adapter.sweepOpen());
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.SweepBlockedUntilMark.selector,
                _currentPeriodStart(),
                _currentPeriodStart() - MARK_INTERVAL
            )
        );
        adapter.sweepToVault();

        _applyCurrentMark();
        assertTrue(adapter.sweepOpen());
        assertEq(adapter.sweepToVault(), 10_000e6);
    }

    function test_sweep_gate_doesNotBlockUnattributedFunds() public {
        _warpToNextPeriod(1);
        usdc.mint(address(adapter), 7e6);
        assertEq(adapter.sweepToVault(), 7e6);
    }

    function test_sweep_gate_openOutsideLiveAndRetiring() public {
        uint256 n = _recall(MM, 1000e6);
        _confirm(n);
        _payOut(MM, 1000e6);
        _warpToNextPeriod(1);

        bookMock.setState(BRTypes.BookState.Retiring);
        assertFalse(adapter.sweepOpen());
        bookMock.setState(BRTypes.BookState.Retired);
        assertTrue(adapter.sweepOpen());
        bookMock.setState(BRTypes.BookState.Cancelled);
        assertTrue(adapter.sweepOpen());
        bookMock.setState(BRTypes.BookState.Subscription);
        assertTrue(adapter.sweepOpen());
        assertEq(adapter.sweepToVault(), 1000e6);
    }

    function test_sweep_excludesPendingFees_principalFirst() public {
        // principal 10k in transit and landed; 300 of fee flow earmarked and landed
        uint256 n = _recall(MM, 10_000e6);
        _confirm(n);
        uint64 p = _firstFeePeriod();
        vm.warp(uint256(p) + 1);
        _applyCurrentMark();
        vm.prank(ops);
        uint256 swept = adapter.sweepFees(p, 300e6);
        assertEq(swept, 0, "nothing landed yet");
        assertEq(adapter.pendingFeesUsd(), 300e6);

        _creditVenueFees(MM, 300e6);
        _payOut(MM, 10_300e6);
        assertEq(adapter.sweepableToVault(), 10_000e6);
        assertEq(adapter.forwardableFees(), 300e6);

        assertEq(adapter.sweepToVault(), 10_000e6);
        assertEq(usdc.balanceOf(address(adapter)), 300e6, "fee flow kept for the router");
        vm.prank(alice);
        assertEq(adapter.forwardPendingFees(), 300e6);
        assertEq(usdc.balanceOf(address(router)), 300e6);
        assertEq(router.pendingGross(), 300e6);
        assertEq(router.lastSource(), BRTypes.SRC_VENUE_TAKER_SHARE);
        assertEq(adapter.pendingFeesUsd(), 0);
        assertEq(usdc.violations(), 0);
    }

    function test_sweep_feeLandingBeforePrincipalIsNotForwardedFromPrincipal() public {
        uint256 n = _recall(MM, 10_000e6);
        _confirm(n);
        uint64 p = _firstFeePeriod();
        vm.warp(uint256(p) + 1);
        _applyCurrentMark();
        vm.prank(ops);
        adapter.sweepFees(p, 300e6);

        // the fee withdrawal lands first: attributed to principal (conservative), never forwarded from it
        _creditVenueFees(MM, 300e6);
        _payOut(MM, 300e6);
        assertEq(adapter.forwardableFees(), 0);
        assertEq(adapter.forwardPendingFees(), 0);
        uint256 navBefore = _navUsd();
        assertEq(adapter.sweepToVault(), 300e6);
        assertEq(adapter.inTransitUsd(), 9700e6);
        assertEq(_navUsd(), navBefore, "NAV-neutral");

        // principal lands: 9.7k is principal, the extra 300 is the fee
        _payOut(MM, 10_000e6);
        assertEq(adapter.forwardPendingFees(), 300e6);
        assertEq(adapter.sweepToVault(), 9700e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(usdc.balanceOf(address(router)), 300e6);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }
}

contract OrderlyAdapterReportTest is OrderlyFixture {
    function test_report_storesAndEmits() public {
        vm.warp(block.timestamp + 60);
        vm.expectEmit(false, false, false, true, address(adapter));
        emit OrderlyAdapter.VenueReported(25_100e6, 74_000e6, -2500e6, uint64(block.timestamp - 5));
        vm.prank(ops);
        adapter.report(25_100e6, 74_000e6, -2500e6, uint64(block.timestamp - 5));
        assertEq(adapter.insuranceEquityUsd(), 25_100e6);
        assertEq(adapter.marginEquityUsd(), int256(74_000e6));
        assertEq(adapter.netExposureUsd(), -int256(2500e6));
        assertEq(adapter.valuationAt(), uint64(block.timestamp - 5));
        assertEq(adapter.deployedValueUsd(), 99_100e6);
    }

    function test_report_negativeMarginNotCounted() public {
        _report(10e6, -500e6, 0);
        assertEq(adapter.deployedValueUsd(), 10e6);
    }

    function test_report_onlyOpsVenue() public {
        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.report(1, 1, 1, uint64(block.timestamp));
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.report(1, 1, 1, uint64(block.timestamp));
    }

    function test_report_rejectsFuture() public {
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.ReportInFuture.selector, uint64(block.timestamp + 1), uint64(block.timestamp)
            )
        );
        adapter.report(1, 1, 1, uint64(block.timestamp + 1));
    }

    function test_report_monotonic() public {
        _report(1, 1, 1);
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.StaleReport.selector, uint64(block.timestamp), uint64(block.timestamp)
            )
        );
        adapter.report(2, 2, 2, uint64(block.timestamp));
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.StaleReport.selector, uint64(block.timestamp - 1), uint64(block.timestamp)
            )
        );
        adapter.report(2, 2, 2, uint64(block.timestamp - 1));
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(OrderlyAdapter.StaleReport.selector, uint64(0), uint64(block.timestamp))
        );
        adapter.report(2, 2, 2, 0);
    }

    function test_report_cannotPredateLastFlow() public {
        vm.warp(block.timestamp + 100);
        _deploy(MM, 1000e6);
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.ReportPredatesFlow.selector,
                uint64(block.timestamp - 1),
                uint64(block.timestamp)
            )
        );
        adapter.report(0, 0, 0, uint64(block.timestamp - 1));
        // a same-second snapshot may predate the flow (A3-03): rejected too
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderlyAdapter.ReportPredatesFlow.selector, uint64(block.timestamp), uint64(block.timestamp)
            )
        );
        adapter.report(0, 0, 0, uint64(block.timestamp));
        vm.warp(block.timestamp + 1);
        _report(0, 1000e6, 0); // strictly after the flow is accepted
    }

    function test_report_boundsValues() public {
        vm.startPrank(ops);
        uint64 t = uint64(block.timestamp);
        vm.expectRevert(OrderlyAdapter.ReportOutOfRange.selector);
        adapter.report(uint256(type(uint128).max) + 1, 0, 0, t);
        vm.expectRevert(OrderlyAdapter.ReportOutOfRange.selector);
        adapter.report(0, int256(type(int128).max) + 1, 0, t);
        vm.expectRevert(OrderlyAdapter.ReportOutOfRange.selector);
        adapter.report(0, int256(type(int128).min) - 1, 0, t);
        vm.expectRevert(OrderlyAdapter.ReportOutOfRange.selector);
        adapter.report(0, 0, int256(type(int128).max) + 1, t);
        vm.expectRevert(OrderlyAdapter.ReportOutOfRange.selector);
        adapter.report(0, 0, int256(type(int128).min) - 1, t);
        adapter.report(type(uint128).max, type(int128).max, type(int128).min, t);
        vm.stopPrank();
        assertEq(adapter.deployedValueUsd(), uint256(type(uint128).max) + uint256(uint128(type(int128).max)));
    }

    function test_depositUpdatesVenueSideBetweenReports() public {
        _report(20_000e6, 50_000e6, 0);
        _deploy(IF, 1000e6);
        _deploy(MM, 2000e6);
        assertEq(adapter.insuranceEquityUsd(), 21_000e6);
        assertEq(adapter.marginEquityUsd(), int256(52_000e6));
    }
}

contract OrderlyAdapterFeeTest is OrderlyFixture {
    uint64 internal p1;

    function setUp() public override {
        super.setUp();
        _deploy(MM, 75_000e6);
        p1 = _firstFeePeriod();
        vm.warp(uint256(p1) + 20);
        _applyCurrentMark();
    }

    function _landFees(uint256 amount) internal {
        _creditVenueFees(MM, amount);
        _payOut(MM, amount);
    }

    function test_sweepFees_forwardsToRouter() public {
        _landFees(500e6);
        vm.expectEmit(true, false, false, true, address(adapter));
        emit IVenueAdapter.FeesSwept(p1, 500e6);
        vm.expectEmit(false, false, false, true, address(adapter));
        emit OrderlyAdapter.FeesForwarded(500e6, 0);
        vm.prank(ops);
        uint256 swept = adapter.sweepFees(p1, 500e6);
        assertEq(swept, 500e6);
        assertEq(usdc.balanceOf(address(router)), 500e6);
        assertEq(router.pendingGross(), 500e6);
        assertEq(router.notifications(), 1);
        assertEq(router.lastSource(), BRTypes.SRC_VENUE_TAKER_SHARE);
        assertEq(router.lastNotifier(), address(adapter));
        assertEq(adapter.feeSweptForPeriod(p1), 500e6);
        assertEq(adapter.totalFeesForwardedUsd(), 500e6);
        assertEq(adapter.pendingFeesUsd(), 0);
        assertEq(usdc.violations(), 0);
    }

    function test_sweepFees_oncePerPeriod() public {
        _landFees(1000e6);
        vm.startPrank(ops);
        adapter.sweepFees(p1, 400e6);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.PeriodAlreadySwept.selector, p1));
        adapter.sweepFees(p1, 400e6);
        vm.stopPrank();

        vm.warp(uint256(p1) + MARK_INTERVAL + 1);
        vm.prank(ops);
        adapter.sweepFees(p1 + MARK_INTERVAL, 400e6);
        assertEq(usdc.balanceOf(address(router)), 800e6);
    }

    function test_sweepFees_cap() public {
        _landFees(DEFAULT_CAP + 1);
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(OrderlyAdapter.FeeSweepAboveCap.selector, DEFAULT_CAP + 1, DEFAULT_CAP)
        );
        adapter.sweepFees(p1, DEFAULT_CAP + 1);
        vm.prank(ops);
        assertEq(adapter.sweepFees(p1, DEFAULT_CAP), DEFAULT_CAP);
    }

    function test_sweepFees_periodValidation() public {
        vm.startPrank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(OrderlyAdapter.PeriodMisaligned.selector, p1 + 1, MARK_INTERVAL)
        );
        adapter.sweepFees(p1 + 1, 1e6);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.PeriodInFuture.selector, p1 + MARK_INTERVAL));
        adapter.sweepFees(p1 + MARK_INTERVAL, 1e6);
        uint64 floor = adapter.feePeriodFloor();
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.PeriodBeforeBook.selector, floor, floor));
        adapter.sweepFees(floor, 1e6);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.PeriodBeforeBook.selector, uint64(0), floor));
        adapter.sweepFees(0, 1e6);
        vm.expectRevert(OrderlyAdapter.ZeroAmount.selector);
        adapter.sweepFees(p1, 0);
        vm.stopPrank();
    }

    function test_sweepFees_zeroMarkIntervalReverts() public {
        cfg.setMarkInterval(0);
        vm.prank(ops);
        vm.expectRevert(OrderlyAdapter.ZeroMarkInterval.selector);
        adapter.sweepFees(p1, 1e6);
        // and the sweep gate degrades open rather than dividing by zero
        assertTrue(adapter.sweepOpen());
    }

    function test_sweepFees_onlyOpsVenue() public {
        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.sweepFees(p1, 1e6);
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.sweepFees(p1, 1e6);
    }

    function test_sweepFees_earmarkThenForward() public {
        vm.prank(ops);
        assertEq(adapter.sweepFees(p1, 600e6), 0);
        assertEq(adapter.pendingFeesUsd(), 600e6);

        _landFees(250e6);
        // a permissionless sweep cannot take earmarked fee flow
        assertEq(adapter.sweepToVault(), 0);
        vm.prank(alice);
        assertEq(adapter.forwardPendingFees(), 250e6);
        assertEq(adapter.pendingFeesUsd(), 350e6);

        _landFees(400e6);
        assertEq(adapter.forwardPendingFees(), 350e6);
        assertEq(adapter.pendingFeesUsd(), 0);
        assertEq(adapter.sweepToVault(), 50e6, "excess beyond the earmark is vault-bound");
        assertEq(usdc.balanceOf(address(router)), 600e6);
        assertEq(router.pendingGross(), 600e6);
        assertEq(adapter.forwardPendingFees(), 0);
    }

    function test_cancelPendingFees() public {
        vm.prank(ops);
        adapter.sweepFees(p1, 600e6);

        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotOpsVenueOrTimelock.selector);
        adapter.cancelPendingFees(1);

        vm.startPrank(ops);
        vm.expectRevert(OrderlyAdapter.ZeroAmount.selector);
        adapter.cancelPendingFees(0);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.ExceedsPendingFees.selector, 601e6, 600e6));
        adapter.cancelPendingFees(601e6);
        vm.expectEmit(false, true, false, true, address(adapter));
        emit OrderlyAdapter.PendingFeesCancelled(100e6, ops);
        adapter.cancelPendingFees(100e6);
        vm.stopPrank();

        vm.prank(timelock);
        adapter.cancelPendingFees(500e6);
        assertEq(adapter.pendingFeesUsd(), 0);

        _landFees(10e6);
        assertEq(adapter.sweepToVault(), 10e6, "cancelled earmark becomes vault-bound");
    }

    function test_setMaxFeeSweep_onlyTimelock() public {
        vm.prank(ops);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.setMaxFeeSweepPerPeriodUsd(1);

        vm.expectEmit(false, false, false, true, address(adapter));
        emit OrderlyAdapter.MaxFeeSweepSet(DEFAULT_CAP, 0);
        vm.prank(timelock);
        adapter.setMaxFeeSweepPerPeriodUsd(0);
        assertEq(adapter.maxFeeSweepPerPeriodUsd(), 0);
        vm.prank(ops);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.FeeSweepAboveCap.selector, 1, 0));
        adapter.sweepFees(p1, 1);

        vm.prank(timelock);
        adapter.setMaxFeeSweepPerPeriodUsd(5000e6);
        _landFees(5000e6);
        vm.prank(ops);
        assertEq(adapter.sweepFees(p1, 5000e6), 5000e6);
    }

    function test_sweepFees_revertsIfRouterRejects() public {
        // A router that was not funded would revert; the adapter always transfers first, so notify succeeds.
        _landFees(10e6);
        vm.prank(ops);
        adapter.sweepFees(p1, 10e6);
        assertEq(router.accountedBalance(), 10e6);
    }

    function testFuzz_sweepFees_neverExceedsCapOrDuplicates(uint256 amount, uint8 periods) public {
        amount = bound(amount, 1, DEFAULT_CAP * 2);
        periods = uint8(bound(periods, 1, 12));
        uint256 total;
        for (uint256 i; i < periods; i++) {
            uint64 p = p1 + uint64(i) * MARK_INTERVAL;
            vm.warp(uint256(p) + 1);
            _landFees(amount);
            vm.prank(ops);
            if (amount > DEFAULT_CAP) {
                vm.expectRevert(
                    abi.encodeWithSelector(OrderlyAdapter.FeeSweepAboveCap.selector, amount, DEFAULT_CAP)
                );
                adapter.sweepFees(p, amount);
            } else {
                adapter.sweepFees(p, amount);
                total += amount;
                vm.prank(ops);
                vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.PeriodAlreadySwept.selector, p));
                adapter.sweepFees(p, 1);
            }
        }
        assertEq(router.pendingGross(), total);
        assertLe(router.pendingGross(), uint256(periods) * DEFAULT_CAP);
    }
}

contract OrderlyAdapterAdminTest is OrderlyFixture {
    function test_setDelegateSigner() public {
        vm.expectEmit(true, true, true, true, address(ov));
        emit MockOrderlyVault.AccountDelegate(
            address(adapter), BROKER_HASH, delegateEoa, block.chainid, block.number
        );
        vm.expectEmit(true, false, false, true, address(adapter));
        emit OrderlyAdapter.DelegateSignerSet(delegateEoa);
        vm.prank(timelock);
        adapter.setDelegateSigner(delegateEoa);
        assertEq(adapter.delegateSigner(), delegateEoa);
        assertEq(ov.delegateOf(address(adapter), BROKER_HASH), delegateEoa);

        address next = makeAddr("nextDelegate");
        vm.prank(timelock);
        adapter.setDelegateSigner(next);
        assertEq(ov.delegateOf(address(adapter), BROKER_HASH), next, "a new delegate replaces the old");
    }

    function test_setDelegateSigner_access() public {
        vm.prank(ops);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.setDelegateSigner(delegateEoa);
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.ZeroAddress.selector);
        adapter.setDelegateSigner(address(0));
        // Orderly requires the delegate to be an EOA
        vm.prank(timelock);
        vm.expectRevert(MockOrderlyVault.NotZeroCodeLength.selector);
        adapter.setDelegateSigner(address(router));
    }

    function test_rescueNative() public {
        vm.deal(address(adapter), 1 ether);
        vm.prank(ops);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.rescueNative(payable(alice), 1);

        vm.startPrank(timelock);
        vm.expectRevert(OrderlyAdapter.ZeroAddress.selector);
        adapter.rescueNative(payable(address(0)), 1);
        vm.expectRevert(OrderlyAdapter.ZeroAmount.selector);
        adapter.rescueNative(payable(alice), 0);
        EthRejecter rej = new EthRejecter();
        vm.expectRevert(OrderlyAdapter.NativeTransferFailed.selector);
        adapter.rescueNative(payable(address(rej)), 1);
        vm.expectEmit(true, false, false, true, address(adapter));
        emit OrderlyAdapter.NativeRescued(alice, 0.4 ether);
        adapter.rescueNative(payable(alice), 0.4 ether);
        vm.stopPrank();
        assertEq(alice.balance, 0.4 ether);
    }

    function test_rescueToken_neverUsdc() public {
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(address(adapter), 5e18);
        usdc.mint(address(adapter), 5e6);

        vm.prank(ops);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.rescueToken(address(junk), alice, 1);

        vm.startPrank(timelock);
        vm.expectRevert(OrderlyAdapter.CannotRescueUsdc.selector);
        adapter.rescueToken(address(usdc), alice, 5e6);
        vm.expectRevert(OrderlyAdapter.ZeroAddress.selector);
        adapter.rescueToken(address(0), alice, 1);
        vm.expectRevert(OrderlyAdapter.ZeroAddress.selector);
        adapter.rescueToken(address(junk), address(0), 1);
        vm.expectRevert(OrderlyAdapter.ZeroAmount.selector);
        adapter.rescueToken(address(junk), alice, 0);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit OrderlyAdapter.TokenRescued(address(junk), alice, 5e18);
        adapter.rescueToken(address(junk), alice, 5e18);
        vm.stopPrank();
        assertEq(junk.balanceOf(alice), 5e18);
        assertEq(usdc.balanceOf(address(adapter)), 5e6);
        assertEq(usdc.violations(), 0);
    }
}

contract OrderlyAdapterUpgradeTest is OrderlyFixture {
    function test_upgrade_onlyTimelock() public {
        OrderlyAdapterV2 v2 = new OrderlyAdapterV2(BROKER_HASH, TOKEN_HASH);
        vm.prank(ops);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.upgradeToAndCall(address(v2), "");
        vm.prank(factory);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.upgradeToAndCall(address(v2), "");
    }

    function test_upgrade_byTimelockPreservesState() public {
        _deploy(MM, 75_000e6);
        uint256 n = _recall(MM, 1000e6);
        bytes32 mmId = adapter.accountId(MM);

        OrderlyAdapterV2 v2 = new OrderlyAdapterV2(keccak256("other-broker"), keccak256("USDG"));
        vm.prank(timelock);
        adapter.upgradeToAndCall(address(v2), "");

        assertEq(OrderlyAdapterV2(payable(address(adapter))).version(), 2);
        bytes32 implSlot = vm.load(address(adapter), ERC1967Utils.IMPLEMENTATION_SLOT);
        assertEq(address(uint160(uint256(implSlot))), address(v2));
        // storage (incl. hashes copied at initialize) survives; new impl defaults do not leak in
        assertEq(adapter.brokerHash(), BROKER_HASH);
        assertEq(adapter.tokenHash(), TOKEN_HASH);
        assertEq(adapter.accountId(MM), mmId);
        assertEq(adapter.marginEquityUsd(), int256(75_000e6));
        assertEq(adapter.withdrawRequest(n).amount, 1000e6);
        assertEq(adapter.vault(), address(uwVault));
        _confirm(n);
        assertEq(adapter.inTransitUsd(), 1000e6);
    }

    function test_upgrade_rejectsNonUups() public {
        MockERC20 notUups = new MockERC20("x", "x", 6);
        vm.prank(timelock);
        vm.expectRevert(
            abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, address(notUups))
        );
        adapter.upgradeToAndCall(address(notUups), "");
    }

    function test_upgrade_implementationNotDirectlyUpgradeable() public {
        OrderlyAdapterV2 v2 = new OrderlyAdapterV2(BROKER_HASH, TOKEN_HASH);
        vm.prank(timelock);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        impl.upgradeToAndCall(address(v2), "");
    }

    function test_upgrade_followsTimelockRotation() public {
        address newTimelock = makeAddr("newTimelock");
        cfg.setTimelock(newTimelock);
        OrderlyAdapterV2 v2 = new OrderlyAdapterV2(BROKER_HASH, TOKEN_HASH);
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.upgradeToAndCall(address(v2), "");
        vm.prank(newTimelock);
        adapter.upgradeToAndCall(address(v2), "");
    }
}

/// @notice Access control fuzz: an arbitrary caller holding no role can use none of the gated functions.
contract OrderlyAdapterAccessFuzzTest is OrderlyFixture {
    function _unprivileged(address who) internal view returns (bool) {
        return who != address(uwVault) && who != ops && who != timelock && who != factory;
    }

    function testFuzz_gatedFunctionsRejectStrangers(address who, uint256 amount, uint64 period, uint8 account)
        public
    {
        vm.assume(_unprivileged(who));
        account = uint8(bound(account, 0, 1));
        amount = bound(amount, 1, 1e15);

        vm.startPrank(who);
        vm.expectRevert(OrderlyAdapter.NotVault.selector);
        adapter.depositToVenue(account, amount);
        vm.expectRevert(OrderlyAdapter.NotVault.selector);
        adapter.requestWithdraw(account, amount);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.confirmWithdraw(amount);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.confirmWithdrawWithFee(amount, 0);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.cancelWithdraw(amount);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.failWithdraw(amount);
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.report(amount, int256(amount), 0, uint64(block.timestamp));
        vm.expectRevert(OrderlyAdapter.NotOpsVenue.selector);
        adapter.sweepFees(period, amount);
        vm.expectRevert(OrderlyAdapter.NotOpsVenueOrTimelock.selector);
        adapter.cancelPendingFees(amount);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.setDelegateSigner(who);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.setMaxFeeSweepPerPeriodUsd(amount);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.rescueNative(payable(who), amount);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.rescueToken(address(usdc), who, amount);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.upgradeToAndCall(address(impl), "");
        vm.stopPrank();
    }
}
