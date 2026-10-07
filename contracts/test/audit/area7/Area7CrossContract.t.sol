// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../../src/interfaces/IBookrunnerDesk.sol";
import {BookrunnerConfig} from "../../../src/BookrunnerConfig.sol";
import {BookFactory} from "../../../src/BookFactory.sol";
import {MarkRegistry} from "../../../src/MarkRegistry.sol";
import {Backstop} from "../../../src/Backstop.sol";
import {Book} from "../../../src/Book.sol";
import {Tranche} from "../../../src/Tranche.sol";
import {UnderwritingVault} from "../../../src/UnderwritingVault.sol";
import {MMMandate} from "../../../src/MMMandate.sol";
import {RevenueRouter} from "../../../src/RevenueRouter.sol";
import {BookrunnerDesk} from "../../../src/BookrunnerDesk.sol";
import {OrderlyAdapter} from "../../../src/OrderlyAdapter.sol";
import {MockOrderlyVault} from "../../../src/mocks/MockOrderlyVault.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";

/// @dev Minimal BKRN staking stand-in: lockers may lock any amount (the tier bond of a desk key).
contract A7Staking {
    mapping(address => bool) public isLocker;
    mapping(address => mapping(bytes32 => uint256)) public lockOf;

    function setLocker(address l, bool ok) external {
        isLocker[l] = ok;
    }

    function lock(address account, bytes32 lockId, uint256 amount) external {
        require(isLocker[msg.sender], "locker");
        lockOf[account][lockId] += amount;
    }

    function unlock(address account, bytes32 lockId) external returns (uint256 released) {
        released = lockOf[account][lockId];
        lockOf[account][lockId] = 0;
    }
}

/// @title Area 7 (static analysis + cross-contract) audit PoCs.
/// @notice One Orderly book on the REAL stack: BookrunnerConfig, BookFactory (BookProxy + EIP-1167 clones),
///         Book, Tranche x2, UnderwritingVault, MMMandate, RevenueRouter, BookrunnerDesk, OrderlyAdapter,
///         MarkRegistry, Backstop; MockOrderlyVault as the venue and a minimal staking stand-in.
///         Every test asserts the SECURE behaviour and fails on the current code.
contract Area7CrossContractTest is Test {
    uint256 internal constant BOOK_ID = 1;
    uint32 internal constant INTERVAL = 86_400;
    bytes32 internal constant BROKER_HASH = keccak256("bookrunner");
    bytes32 internal constant TOKEN_HASH = keccak256("USDC");
    uint128 internal constant IF_TARGET = 25_000e6;
    uint128 internal constant MM_INVENTORY = 75_000e6;
    uint256 internal constant MARK_PK = 0xA11CE;
    uint256 internal constant KEY_PK = 0xBEEF;

    address internal timelock = makeAddr("timelock");
    address internal charterAddr = makeAddr("marketCharter");
    address internal sponsor = makeAddr("sponsor");
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");
    address internal relayer = makeAddr("relayer");
    address internal key;

    MockERC20 internal usdc;
    BookrunnerConfig internal config;
    BookFactory internal factory;
    MarkRegistry internal registry;
    MockOrderlyVault internal ov;

    Book internal book;
    Tranche internal senior;
    Tranche internal junior;
    UnderwritingVault internal vault;
    MMMandate internal mandate;
    BookrunnerDesk internal desk;
    OrderlyAdapter internal adapter;

    uint64 internal p1;

    function setUp() public {
        vm.warp(1_760_000_123);
        key = vm.addr(KEY_PK);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        config = new BookrunnerConfig(timelock);
        factory = new BookFactory(address(config));
        registry = new MarkRegistry(address(config));
        ov = new MockOrderlyVault(address(this), address(usdc), TOKEN_HASH, BROKER_HASH);
        A7Staking staking = new A7Staking();

        vm.startPrank(timelock);
        config.setAddress("usdc", address(usdc));
        config.setAddress("orderlyVault", address(ov));
        config.setAddress("factory", address(factory));
        config.setAddress("markRegistry", address(registry));
        config.setAddress("charter", charterAddr);
        config.setAddress("staking", address(staking));
        config.setAddress("backstop", address(new Backstop(address(config))));
        config.setParam("markInterval", INTERVAL);
        config.grantRole(config.MARK_SIGNER_ROLE(), vm.addr(MARK_PK));

        bytes32[] memory kinds = new bytes32[](7);
        address[] memory impls = new address[](7);
        (kinds[0], impls[0]) = (factory.BOOK(), address(new Book()));
        (kinds[1], impls[1]) = (factory.TRANCHE(), address(new Tranche()));
        (kinds[2], impls[2]) = (factory.VAULT(), address(new UnderwritingVault()));
        (kinds[3], impls[3]) = (factory.MANDATE(), address(new MMMandate()));
        (kinds[4], impls[4]) = (factory.ROUTER(), address(new RevenueRouter()));
        (kinds[5], impls[5]) = (factory.DESK(), address(new BookrunnerDesk()));
        (kinds[6], impls[6]) = (factory.ORDERLY_ADAPTER(), address(new OrderlyAdapter(BROKER_HASH, TOKEN_HASH)));
        factory.setImplementations(kinds, impls);
        vm.stopPrank();

        vm.prank(charterAddr);
        BRTypes.BookComponents memory c = factory.create(BOOK_ID, _charter());
        book = Book(c.book);
        senior = Tranche(c.senior);
        junior = Tranche(c.junior);
        vault = UnderwritingVault(c.vault);
        mandate = MMMandate(c.mandate);
        desk = BookrunnerDesk(payable(c.desk));
        adapter = OrderlyAdapter(payable(c.adapter));

        // window -> Live: S 70k / J 30k, IF 25k + MM 75k deployed to the venue
        _deposit(senior, alice, 70_000e6);
        _deposit(junior, sponsor, 10_000e6);
        _deposit(junior, carol, 20_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        senior.claimAllocation(alice);
        junior.claimAllocation(sponsor);
        junior.claimAllocation(carol);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
        assertEq(adapter.deployedValueUsd(), 100_000e6);

        // the sponsor registers one bonded agent desk key
        vm.prank(sponsor);
        mandate.registerKey(key, sponsor, uint64(block.timestamp + 365 days), 50_000e6);
        assertTrue(mandate.isActiveKey(key));

        p1 = uint64((block.timestamp / INTERVAL + 1) * INTERVAL);
    }

    // =============================================================================================
    // A7-01: an active desk key (or any desk activity) invalidates every pending mark at will
    // =============================================================================================

    /// @notice SECURE: once a mark period has ended and the mark service has signed the mark against the
    ///         book's flowNonce, a desk key must not be able to make that mark unappliable. Today any active
    ///         key can do `ReturnToVault(1)` (no mandate check, moves 1 unit of the book's own USDC) and the
    ///         vault bumps book.flowNonce, so `commitAndApply` reverts FlowNonceMismatch. Repeated every
    ///         block this blocks marks forever: no redemption bucket settles, no top-up round settles, the
    ///         on-chain drawdown kill never runs, finalizeRetirement is unreachable. Unlike
    ///         OrderlyAdapter.sweepToVault (gated by _checkSweepOpen), desk-initiated flows have no
    ///         "period ended, mark pending" gate.
    function test_audit_deskKeyCannotInvalidatePendingMark() public {
        // the desk holds a little USDC (hedge budget / dust); here 1 unit lands on it
        usdc.mint(address(desk), 1);

        // period ends, the mark service values the book at the current nonce and signs
        vm.warp(uint256(p1) + 120);
        BRTypes.MarkInput memory m = _mark(p1, 100_000e6 + 1, book.flowNonce());
        bytes memory sig = _sign(m);

        // the agent key moves 1 unit desk -> vault (would be rejected by a mark-window gate)
        vm.prank(key);
        try desk.execute(
            IBookrunnerDesk.Action({
                kind: IBookrunnerDesk.ActionKind.ReturnToVault, data: abi.encode(uint256(1)), proof: new bytes32[](0)
            })
        ) {} catch {}

        // the signed mark must still apply
        vm.prank(relayer);
        uint256 markId = registry.commitAndApply(m, sig, "", "");
        assertEq(book.lastMarkId(), markId, "pending mark was invalidated by a desk key flow");
    }

    /// @notice Control (passes today): the same signed mark applies when no desk flow intervenes, so the
    ///         failure above is caused by the key's ReturnToVault alone.
    function test_control_markAppliesWithoutDeskFlow() public {
        usdc.mint(address(desk), 1);
        vm.warp(uint256(p1) + 120);
        BRTypes.MarkInput memory m = _mark(p1, 100_000e6 + 1, book.flowNonce());
        vm.prank(relayer);
        uint256 markId = registry.commitAndApply(m, _sign(m), "", "");
        assertEq(book.lastMarkId(), markId);
    }

    // =============================================================================================
    // Regression (testnet v3 launch): desk and adapter must agree on "mark pending" in the first period
    // =============================================================================================

    /// @notice Before the first mark the desk lets a key recall MM inventory (reference = subscriptionEnds);
    ///         the adapter must then also let that withdrawal be swept back to the vault. With the old adapter
    ///         rule (lastMarkPeriodEnd >= periodStart, i.e. 0 before the first mark) the sweep reverted
    ///         SweepBlockedUntilMark while the mark service refused every venue report because the withdrawal
    ///         was pending: a deadlock (TSLA, first period after launch, 2026-10-07).
    function test_regression_firstPeriodRecallCanBeSwept() public {
        address ops = makeAddr("ops");
        vm.startPrank(timelock);
        config.grantRole(config.OPS_VENUE_ROLE(), ops);
        vm.stopPrank();
        ov.setOperator(address(this), true);

        // first (partial) period: no mark yet, the desk gate is open
        assertEq(book.lastMarkPeriodEnd(), 0);
        assertTrue(desk.capitalFlowOpen(), "desk gate open before the first mark");

        // the key recalls 1,000 USDC of MM inventory
        vm.prank(key);
        desk.execute(
            IBookrunnerDesk.Action({
                kind: IBookrunnerDesk.ActionKind.InventoryToVault,
                data: abi.encode(BRTypes.ACCOUNT_MM, uint256(1_000e6)),
                proof: new bytes32[](0)
            })
        );
        uint256 n = adapter.withdrawNonce();

        // ops-venue confirms, the venue pays the adapter, the sweep must go through (no pending mark deadlock)
        vm.prank(ops);
        adapter.confirmWithdraw(n);
        ov.operatorWithdraw(adapter.accountId(BRTypes.ACCOUNT_MM), address(adapter), 1_000e6);
        uint256 swept = adapter.sweepToVault();
        assertEq(swept, 1_000e6, "recall started in the first period is swept back");
        assertEq(adapter.pendingWithdrawUsd(BRTypes.ACCOUNT_MM), 0, "no withdrawal left pending");
    }

    /// @notice After the first period ends with no mark, BOTH gates are closed (consistent): the key cannot
    ///         start a recall the adapter could not sweep.
    function test_regression_gatesAgreeOncePeriodEnded() public {
        vm.warp(uint256(p1) + 120);
        assertFalse(desk.capitalFlowOpen(), "desk gate closed while the p1 mark is pending");
        vm.prank(key);
        vm.expectRevert();
        desk.execute(
            IBookrunnerDesk.Action({
                kind: IBookrunnerDesk.ActionKind.InventoryToVault,
                data: abi.encode(BRTypes.ACCOUNT_MM, uint256(1_000e6)),
                proof: new bytes32[](0)
            })
        );
    }

    // =============================================================================================
    // A7-02: an older committed mark can still be applied after a newer one was committed
    // =============================================================================================

    /// @notice SECURE: once a newer mark (later periodEnd, same flowNonce) has been committed for the book, the
    ///         older unapplied one must not be applicable any more. Today `Book.applyMark` only checks
    ///         `periodEnd > lastMark.periodEnd` and the nonce, so anyone may apply M1 first and M2 after,
    ///         choosing at which of the two valuations the buckets <= p1 / interval settle (redeemers pick
    ///         the higher price, the cost is borne by the remaining holders), and M1 is applied with
    ///         today's vault idle long after its maxMarkAge.
    function test_audit_supersededOlderMarkNotApplicable() public {
        // a Senior redemption due at p1
        vm.prank(alice);
        senior.requestRedeem(10_000e6, alice, alice);

        // M1 (p1) committed but never applied (e.g. mark service crashed between commit and apply)
        vm.warp(uint256(p1) + 120);
        BRTypes.MarkInput memory m1 = _mark(p1, 95_000e6, book.flowNonce());
        uint256 id1 = registry.commit(m1, _sign(m1));

        // next period: M2 (p2) committed against the same nonce (no capital flow happened)
        uint64 p2 = p1 + INTERVAL;
        vm.warp(uint256(p2) + 120);
        BRTypes.MarkInput memory m2 = _mark(p2, 105_000e6, book.flowNonce());
        uint256 id2 = registry.commit(m2, _sign(m2));
        assertEq(registry.latestMarkId(BOOK_ID), id2);

        // nobody may apply the superseded M1 any more (only the latest committed mark)
        vm.expectRevert();
        book.applyMark(id1);
    }

    // ---------------------------------------------------------------------------------------------

    function _charter() internal view returns (BRTypes.Charter memory c) {
        c.underlying = bytes32(uint256(uint160(address(0xA0A0))));
        c.venue = BRTypes.VENUE_ORDERLY;
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
            noNewRiskOffHours: false,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: bytes32(uint256(1))
        });
        c.seniorHurdleBps = 6000;
        c.seniorCapBps = 7000;
        c.subscriptionWindow = 600;
        c.juniorNoticeSeconds = 900;
        c.sponsor = sponsor;
        c.perWalletCapUsd = 250_000e6;
        c.symbol = bytes32("PERP_NVDA_USDC");
    }

    function _deposit(Tranche t, address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(t), amount);
        t.deposit(amount, who);
        vm.stopPrank();
    }

    function _mark(uint64 periodEnd, uint256 deployed, uint64 nonce)
        internal
        view
        returns (BRTypes.MarkInput memory)
    {
        return BRTypes.MarkInput({
            bookId: BOOK_ID,
            periodEnd: periodEnd,
            navUsd: vault.idle() + deployed,
            deployedValueUsd: deployed,
            flowNonce: nonce,
            inventoryRoot: keccak256("inventory"),
            pnlJsonHash: keccak256("pnl.json"),
            receiptsRoot: keccak256("receipts")
        });
    }

    function _sign(BRTypes.MarkInput memory m) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MARK_PK, registry.hashMark(m));
        return abi.encodePacked(r, s, v);
    }
}
