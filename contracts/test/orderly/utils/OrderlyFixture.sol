// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {OrderlyAdapter} from "../../../src/OrderlyAdapter.sol";
import {MockOrderlyVault} from "../../../src/mocks/MockOrderlyVault.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";

import {
    OrderlyMockConfig,
    OrderlyMockBook,
    OrderlyMockUWVault,
    OrderlyMockRouter,
    OrderlyMockFactory,
    TrackingUSDC
} from "./OrderlyTestMocks.sol";

/// @notice Shared deployment for the A-orderly test suites: one Live Orderly book with a proxied adapter.
abstract contract OrderlyFixture is Test {
    bytes32 internal constant BROKER_HASH = keccak256("bookrunner");
    bytes32 internal constant TOKEN_HASH = keccak256("USDC");
    uint256 internal constant BOOK_ID = 7;
    uint32 internal constant MARK_INTERVAL = 300;
    uint128 internal constant IF_TARGET = 25_000e6;
    uint128 internal constant MM_INVENTORY = 75_000e6;
    /// @dev 2% of (IF_TARGET + MM_INVENTORY)
    uint256 internal constant DEFAULT_CAP = 2000e6;
    uint8 internal constant IF = 0;
    uint8 internal constant MM = 1;

    address internal timelock = makeAddr("timelock");
    OrderlyMockFactory internal mockFactory = new OrderlyMockFactory();
    address internal factory = address(mockFactory);
    address internal ops = makeAddr("opsVenue");
    address internal orderlyOperator = makeAddr("orderlyOperator");
    address internal alice = makeAddr("alice");
    address internal delegateEoa = makeAddr("delegateEoa");

    TrackingUSDC internal usdc;
    OrderlyMockConfig internal cfg;
    MockOrderlyVault internal ov;
    OrderlyMockBook internal bookMock;
    OrderlyMockUWVault internal uwVault;
    OrderlyMockRouter internal router;
    OrderlyAdapter internal impl;
    OrderlyAdapter internal adapter;

    function setUp() public virtual {
        vm.warp(1_750_000_123);
        usdc = new TrackingUSDC();
        ov = new MockOrderlyVault(address(this), address(usdc), TOKEN_HASH, BROKER_HASH);
        ov.setOperator(orderlyOperator, true);
        cfg = new OrderlyMockConfig(address(usdc), address(ov), timelock, factory, MARK_INTERVAL);
        cfg.grantRole(cfg.OPS_VENUE_ROLE(), ops);

        bookMock = new OrderlyMockBook(BOOK_ID);
        bookMock.setCharter(_charter(BRTypes.VENUE_ORDERLY));
        uwVault = new OrderlyMockUWVault(address(usdc), address(bookMock));
        router = new OrderlyMockRouter(address(usdc));
        impl = new OrderlyAdapter(BROKER_HASH, TOKEN_HASH);

        adapter = _deployAdapter(BOOK_ID, true);
        uwVault.setAdapter(address(adapter));

        usdc.watch(address(adapter), address(uwVault), address(router), address(ov));
        bookMock.setState(BRTypes.BookState.Live);
        _applyCurrentMark();
        usdc.mint(address(uwVault), 1_000_000e6);
    }

    // ---------------------------------------------------------------------------------------------
    // builders
    // ---------------------------------------------------------------------------------------------

    uint256 private _saltNonce;

    /// @dev Next CREATE2 address the mock factory will deploy an adapter proxy at for `bookId_`.
    function _predictAdapter(uint256 bookId_) internal view returns (address) {
        return mockFactory.predictAdapter(
            address(impl), address(cfg), bookId_, address(bookMock), bytes32(_saltNonce + 1)
        );
    }

    /// @dev Deploys + initializes an adapter proxy via the mock factory (optionally listing it in the book first).
    function _deployAdapter(uint256 bookId_, bool listInBook) internal returns (OrderlyAdapter p) {
        address predicted = _predictAdapter(bookId_);
        if (listInBook) bookMock.setComponents(_components(predicted));
        _saltNonce++;
        p = OrderlyAdapter(
            payable(mockFactory.deployAdapter(
                    address(impl), address(cfg), bookId_, address(bookMock), bytes32(_saltNonce)
                ))
        );
        assertEq(address(p), predicted, "CREATE2 prediction");
    }

    /// @dev Expects the factory deployment (and thus `initialize`) to revert with `err`.
    function _expectDeployRevert(bytes memory err, uint256 bookId_, bool listInBook) internal {
        address predicted = _predictAdapter(bookId_);
        if (listInBook) bookMock.setComponents(_components(predicted));
        vm.expectRevert(err);
        mockFactory.deployAdapter(
            address(impl), address(cfg), bookId_, address(bookMock), bytes32(_saltNonce + 1)
        );
    }

    function _charter(uint8 venue) internal returns (BRTypes.Charter memory c) {
        c.underlying = bytes32(uint256(uint160(makeAddr("NVDA"))));
        c.venue = venue;
        c.oracle = BRTypes.ORACLE_ATTESTED;
        c.ifTargetUsd = IF_TARGET;
        c.mmInventoryUsd = MM_INVENTORY;
        c.mandate = BRTypes.Mandate({
            maxInventoryUsd: 50_000e6,
            maxSkewBps: 25,
            minQuoteWidthBps: 8,
            maxHedgeLeverage: 100,
            hedgeRatioMinBps: 5000,
            hedgeRatioMaxBps: 12_000,
            noNewRiskOffHours: true,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: bytes32(uint256(1))
        });
        c.seniorHurdleBps = 6000;
        c.seniorCapBps = 7000;
        c.subscriptionWindow = 600;
        c.juniorNoticeSeconds = 900;
        c.sponsor = makeAddr("sponsor");
        c.symbol = bytes32("PERP_NVDA_USDC");
    }

    function _components(address adapter_) internal returns (BRTypes.BookComponents memory) {
        return BRTypes.BookComponents({
            book: address(bookMock),
            senior: makeAddr("senior"),
            junior: makeAddr("junior"),
            vault: address(uwVault),
            mandate: makeAddr("mandate"),
            router: address(router),
            desk: makeAddr("desk"),
            adapter: adapter_
        });
    }

    // ---------------------------------------------------------------------------------------------
    // actions
    // ---------------------------------------------------------------------------------------------

    function _deploy(uint8 account, uint256 amount) internal {
        uwVault.deployToVenue(account, amount);
    }

    function _recall(uint8 account, uint256 amount) internal returns (uint256 nonce) {
        uwVault.recall(account, amount);
        nonce = adapter.withdrawNonce();
    }

    function _confirm(uint256 nonce) internal {
        vm.prank(ops);
        adapter.confirmWithdraw(nonce);
    }

    /// @dev Simulates Orderly paying a withdrawal of `amount` from `account` to the adapter.
    function _payOut(uint8 account, uint256 amount) internal {
        bytes32 id = adapter.accountId(account);
        vm.prank(orderlyOperator);
        ov.operatorWithdraw(id, address(adapter), amount);
    }

    /// @dev Simulates a builder fee settlement credited to `account` on Orderly (USDC minted to the venue).
    function _creditVenueFees(uint8 account, uint256 amount) internal {
        usdc.mint(address(ov), amount);
        bytes32 id = adapter.accountId(account);
        vm.prank(orderlyOperator);
        ov.creditFees(id, amount);
    }

    function _report(uint256 ins, int256 margin, int256 exposure) internal {
        vm.prank(ops);
        adapter.report(ins, margin, exposure, uint64(block.timestamp));
    }

    function _currentPeriodStart() internal view returns (uint64) {
        return uint64(block.timestamp - (block.timestamp % MARK_INTERVAL));
    }

    /// @dev Marks the current period's mark as applied (opens the sweep gate).
    function _applyCurrentMark() internal {
        bookMock.setLastMarkPeriodEnd(_currentPeriodStart());
    }

    /// @dev Moves to the next period boundary + `offset` seconds (gate closed until _applyCurrentMark()).
    function _warpToNextPeriod(uint256 offset) internal {
        vm.warp(uint256(_currentPeriodStart()) + MARK_INTERVAL + offset);
    }

    /// @dev First fee period label the adapter accepts.
    function _firstFeePeriod() internal view returns (uint64) {
        return adapter.feePeriodFloor() + MARK_INTERVAL;
    }

    /// @dev Book NAV contribution measured on-chain: vault idle + adapter deployed value.
    function _navUsd() internal view returns (uint256) {
        return uwVault.idle() + adapter.deployedValueUsd();
    }
}
