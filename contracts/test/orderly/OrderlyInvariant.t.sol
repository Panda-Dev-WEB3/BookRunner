// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {MockOrderlyVault} from "../../src/mocks/MockOrderlyVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";

import {OrderlyFixture} from "./utils/OrderlyFixture.sol";
import {
    OrderlyMockConfig,
    OrderlyMockBook,
    OrderlyMockUWVault,
    OrderlyMockRouter,
    TrackingUSDC,
    OrderlyAdapterV2
} from "./utils/OrderlyTestMocks.sol";

/// @notice Drives every external function of the adapter (and the simulated venue) with random callers
///         and random arguments. Privileged actors (vault, ops-venue, timelock, factory) are in the caller
///         pool so authorised paths are exercised too.
contract OrderlyHandler is Test {
    OrderlyAdapter internal adapter;
    MockOrderlyVault internal ov;
    TrackingUSDC internal usdc;
    OrderlyMockUWVault internal uwVault;
    OrderlyMockRouter internal router;
    OrderlyMockBook internal book;
    OrderlyMockConfig internal cfg;
    address internal ops;
    address internal timelock;
    address internal orderlyOperator;
    OrderlyAdapterV2 internal v2;
    MockERC20 internal junk;

    address[] internal actors;
    address[] public strangers;

    // ghosts
    uint256 public ghostFeesAuthorized;
    uint256 public ghostFeesCancelled;
    uint256 public ghostMaxCapSeen;
    uint256 public calls;
    mapping(string => uint256) public ok;

    constructor(
        OrderlyAdapter adapter_,
        MockOrderlyVault ov_,
        TrackingUSDC usdc_,
        OrderlyMockUWVault uwVault_,
        OrderlyMockRouter router_,
        OrderlyMockBook book_,
        OrderlyMockConfig cfg_,
        address ops_,
        address timelock_,
        address orderlyOperator_,
        address factory_
    ) {
        adapter = adapter_;
        ov = ov_;
        usdc = usdc_;
        uwVault = uwVault_;
        router = router_;
        book = book_;
        cfg = cfg_;
        ops = ops_;
        timelock = timelock_;
        orderlyOperator = orderlyOperator_;
        v2 = new OrderlyAdapterV2(adapter_.brokerHash(), adapter_.tokenHash());
        junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(address(adapter_), 1e24);

        strangers.push(makeAddr("eve"));
        strangers.push(makeAddr("mallory"));
        strangers.push(makeAddr("trudy"));
        for (uint256 i; i < strangers.length; i++) {
            actors.push(strangers[i]);
        }
        actors.push(address(uwVault_));
        actors.push(ops_);
        actors.push(timelock_);
        actors.push(factory_);
        actors.push(orderlyOperator_);
        ghostMaxCapSeen = adapter_.maxFeeSweepPerPeriodUsd();
    }

    function strangerCount() external view returns (uint256) {
        return strangers.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev Half of the calls use the function's privileged role, the rest a random pool member.
    function _pick(uint256 seed, address privileged) internal view returns (address) {
        return seed % 2 == 0 ? privileged : actors[(seed >> 1) % actors.length];
    }

    function _account(uint256 seed) internal pure returns (uint8) {
        return uint8(seed % 3); // 2 is invalid on purpose
    }

    // ------------------------------------------------------------------ adapter surface

    function deposit(uint256 actorSeed, uint256 accountSeed, uint256 amount) external {
        calls++;
        address a = _pick(actorSeed, address(uwVault));
        uint8 account = _account(accountSeed);
        amount = bound(amount, 0, 60_000e6);
        if (a == address(uwVault)) {
            try uwVault.deployToVenue(account, amount) {
                ok["uwVault.deployToVenue"]++;
            } catch {}
        } else {
            vm.prank(a);
            try adapter.depositToVenue(account, amount) {
                ok["adapter.depositToVenue"]++;
            } catch {}
        }
    }

    function requestWithdraw(uint256 actorSeed, uint256 accountSeed, uint256 amount) external {
        calls++;
        address a = _pick(actorSeed, address(uwVault));
        uint8 account = _account(accountSeed);
        amount = bound(amount, 0, 60_000e6);
        if (a == address(uwVault)) {
            try uwVault.recall(account, amount) {
                ok["uwVault.recall"]++;
            } catch {}
        } else {
            vm.prank(a);
            try adapter.requestWithdraw(account, amount) {
                ok["adapter.requestWithdraw"]++;
            } catch {}
        }
    }

    function confirm(uint256 actorSeed, uint256 nonceSeed, uint256 fee, bool withFee) external {
        calls++;
        uint256 n = adapter.withdrawNonce();
        uint256 nonce = n == 0 ? 0 : (nonceSeed % (n + 1));
        vm.prank(_pick(actorSeed, ops));
        if (withFee) {
            try adapter.confirmWithdrawWithFee(nonce, bound(fee, 0, 5e6)) {
                ok["adapter.confirmWithdrawWithFee"]++;
            } catch {}
        } else {
            try adapter.confirmWithdraw(nonce) {
                ok["adapter.confirmWithdraw"]++;
            } catch {}
        }
    }

    function cancel(uint256 actorSeed, uint256 nonceSeed) external {
        calls++;
        uint256 nonce = nonceSeed % (adapter.withdrawNonce() + 1);
        vm.prank(_pick(actorSeed, ops));
        try adapter.cancelWithdraw(nonce) {
            ok["adapter.cancelWithdraw"]++;
        } catch {}
    }

    function fail(uint256 actorSeed, uint256 nonceSeed) external {
        calls++;
        uint256 nonce = nonceSeed % (adapter.withdrawNonce() + 1);
        vm.prank(_pick(actorSeed, ops));
        try adapter.failWithdraw(nonce) {
            ok["adapter.failWithdraw"]++;
        } catch {}
    }

    function sweepToVault(uint256 actorSeed) external {
        calls++;
        vm.prank(_actor(actorSeed));
        try adapter.sweepToVault() returns (uint256 amt) {
            if (amt > 0) ok["sweepToVault"]++;
        } catch {}
    }

    function report(uint256 actorSeed, uint256 ins, int256 margin, int256 exposure, uint256 back) external {
        calls++;
        ins = bound(ins, 0, 500_000e6);
        margin = bound(margin, -100_000e6, 500_000e6);
        exposure = bound(exposure, -500_000e6, 500_000e6);
        uint64 asOf = uint64(block.timestamp - bound(back, 0, 30));
        vm.prank(_pick(actorSeed, ops));
        try adapter.report(ins, margin, exposure, asOf) {
            ok["adapter.report"]++;
        } catch {}
    }

    function sweepFees(uint256 actorSeed, uint256 periodSeed, uint256 amount) external {
        calls++;
        uint64 interval = cfg.markInterval();
        uint64 period = adapter.feePeriodFloor() + uint64(bound(periodSeed, 0, 40)) * interval;
        amount = bound(amount, 0, 3 * adapter.maxFeeSweepPerPeriodUsd() + 1);
        vm.prank(_pick(actorSeed, ops));
        try adapter.sweepFees(period, amount) {
            ghostFeesAuthorized += amount;
            ok["sweepFees"]++;
        } catch {}
    }

    function forwardPendingFees(uint256 actorSeed) external {
        calls++;
        vm.prank(_actor(actorSeed));
        try adapter.forwardPendingFees() returns (uint256 amt) {
            if (amt > 0) ok["forwardPendingFees"]++;
        } catch {}
    }

    function cancelPendingFees(uint256 actorSeed, uint256 amount) external {
        calls++;
        amount = bound(amount, 0, adapter.pendingFeesUsd() + 1);
        vm.prank(_pick(actorSeed, ops));
        try adapter.cancelPendingFees(amount) {
            ghostFeesCancelled += amount;
        } catch {}
    }

    function setDelegateSigner(uint256 actorSeed, uint256 signerSeed) external {
        calls++;
        address signer = signerSeed % 4 == 0 ? address(router) : _actor(signerSeed);
        vm.prank(_pick(actorSeed, timelock));
        try adapter.setDelegateSigner(signer) {
            ok["adapter.setDelegateSigner"]++;
        } catch {}
    }

    function setMaxFee(uint256 actorSeed, uint256 cap) external {
        calls++;
        cap = bound(cap, 0, 10_000e6);
        vm.prank(_pick(actorSeed, timelock));
        try adapter.setMaxFeeSweepPerPeriodUsd(cap) {
            if (cap > ghostMaxCapSeen) ghostMaxCapSeen = cap;
        } catch {}
    }

    function rescueToken(uint256 actorSeed, uint256 toSeed, bool useUsdc, uint256 amount) external {
        calls++;
        address token = useUsdc ? address(usdc) : address(junk);
        amount = bound(amount, 0, 1e24);
        vm.prank(_pick(actorSeed, timelock));
        try adapter.rescueToken(token, _actor(toSeed), amount) {
            ok["adapter.rescueToken"]++;
        } catch {}
    }

    function rescueNative(uint256 actorSeed, uint256 toSeed, uint256 amount) external {
        calls++;
        vm.deal(address(adapter), 1 ether);
        vm.prank(_pick(actorSeed, timelock));
        try adapter.rescueNative(payable(_actor(toSeed)), bound(amount, 0, 1 ether)) {
            ok["adapter.rescueNative"]++;
        } catch {}
    }

    function upgrade(uint256 actorSeed) external {
        calls++;
        vm.prank(_pick(actorSeed, timelock));
        try adapter.upgradeToAndCall(address(v2), "") {
            ok["adapter.upgradeToAndCall"]++;
        } catch {}
    }

    function reinitialize(uint256 actorSeed) external {
        calls++;
        uint256 id = adapter.bookId();
        vm.prank(_actor(actorSeed));
        try adapter.initialize(address(cfg), id, address(book)) {
            ok["adapter.initialize"]++;
        } catch {}
    }

    // ------------------------------------------------------------------ venue / environment simulation

    /// @dev Orderly pays a withdrawal from one of the book's accounts to the adapter.
    function venuePays(uint256 accountSeed, uint256 amount) external {
        calls++;
        uint8 account = uint8(accountSeed % 2);
        bytes32 id = adapter.accountId(account);
        uint256 bal = ov.balanceOf(id);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(orderlyOperator);
        ov.operatorWithdraw(id, address(adapter), amount);
    }

    /// @dev Builder fee settlement / PnL credited to a book account on the venue.
    function venueCredits(uint256 accountSeed, uint256 amount) external {
        calls++;
        amount = bound(amount, 1, 5000e6);
        bytes32 id = adapter.accountId(uint8(accountSeed % 2));
        if (ov.accountOwner(id) == address(0)) return; // account not opened on the venue yet
        usdc.mint(address(ov), amount);
        vm.prank(orderlyOperator);
        ov.creditFees(id, amount);
    }

    /// @dev Someone sends USDC straight to the adapter.
    function donate(uint256 actorSeed, uint256 amount) external {
        calls++;
        address a = strangers[actorSeed % strangers.length];
        amount = bound(amount, 1, 1000e6);
        usdc.mint(a, amount);
        vm.prank(a);
        usdc.transfer(address(adapter), amount);
    }

    function warp(uint256 secs) external {
        calls++;
        vm.warp(block.timestamp + bound(secs, 0, 700));
    }

    function applyMark() external {
        calls++;
        uint64 interval = cfg.markInterval();
        book.setLastMarkPeriodEnd(uint64(block.timestamp - (block.timestamp % interval)));
    }

    function setBookState(uint256 seed) external {
        calls++;
        uint256 s = seed % 3;
        book.setState(
            s == 0
                ? BRTypes.BookState.Live
                : (s == 1 ? BRTypes.BookState.Retiring : BRTypes.BookState.Retired)
        );
    }
}

/// forge-config: default.invariant.depth = 256
/// forge-config: default.invariant.runs = 96
contract OrderlyInvariantTest is OrderlyFixture {
    OrderlyHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new OrderlyHandler(
            adapter, ov, usdc, uwVault, router, bookMock, cfg, ops, timelock, orderlyOperator, factory
        );
        targetContract(address(handler));
    }

    /// @notice The red-team property: USDC that reaches the adapter/vault/venue/router never leaves that
    ///         set, and the adapter itself only ever pays the vault, the router or the venue (deposits).
    function invariant_usdcOnlyToVaultOrRouter() public view {
        assertEq(usdc.violations(), 0, "USDC left the allowed set");
        for (uint256 i; i < handler.strangerCount(); i++) {
            address s = handler.strangers(i);
            assertEq(usdc.receivedFromAdapter(s), 0);
            assertEq(usdc.balanceOf(s), 0);
        }
        assertEq(usdc.receivedFromAdapter(timelock), 0);
        assertEq(usdc.receivedFromAdapter(ops), 0);
        assertEq(usdc.receivedFromAdapter(factory), 0);
    }

    /// @notice Every USDC unit in existence is held by the vault, the adapter, the venue or the router.
    function invariant_noLeakage() public view {
        uint256 held = usdc.balanceOf(address(uwVault)) + usdc.balanceOf(address(adapter))
            + usdc.balanceOf(address(ov)) + usdc.balanceOf(address(router));
        assertEq(usdc.totalSupply(), held);
    }

    /// @notice Adapter bookkeeping matches actual token movements.
    function invariant_flowAccountingMatchesTransfers() public view {
        assertEq(usdc.receivedFromAdapter(address(uwVault)), adapter.totalReturnedUsd());
        assertEq(usdc.receivedFromAdapter(address(router)), adapter.totalFeesForwardedUsd());
        assertEq(
            usdc.balanceOf(address(router)), adapter.totalFeesForwardedUsd(), "router fed only by the adapter"
        );
        assertEq(router.pendingGross(), adapter.totalFeesForwardedUsd(), "every forward notified");
        assertEq(
            usdc.receivedFromAdapter(address(ov)),
            adapter.totalDepositedUsd(0) + adapter.totalDepositedUsd(1),
            "venue receives exactly the deposits"
        );
    }

    /// @notice Fee flow never exceeds what OPS_VENUE authorised (each authorisation <= cap, once per period).
    function invariant_feeFlowBounded() public view {
        assertEq(
            adapter.totalFeesForwardedUsd() + adapter.pendingFeesUsd() + handler.ghostFeesCancelled(),
            handler.ghostFeesAuthorized()
        );
    }

    /// @notice Direct calls from anyone but the vault to the vault-only entry points never succeed, and the
    ///         initializer can never run again.
    function invariant_gatedEntryPointsNeverSucceedForOthers() public view {
        assertEq(handler.ok("adapter.depositToVenue"), 0);
        assertEq(handler.ok("adapter.requestWithdraw"), 0);
        assertEq(handler.ok("adapter.initialize"), 0);
    }

    /// @notice Coverage log: shows the handler reaches the success paths, not only reverts.
    function afterInvariant() external view {
        console2.log("calls", handler.calls());
        console2.log("deposits ok", handler.ok("uwVault.deployToVenue"));
        console2.log("recalls ok", handler.ok("uwVault.recall"));
        console2.log(
            "confirms ok",
            handler.ok("adapter.confirmWithdraw") + handler.ok("adapter.confirmWithdrawWithFee")
        );
        console2.log("cancels ok", handler.ok("adapter.cancelWithdraw"));
        console2.log("fails ok", handler.ok("adapter.failWithdraw"));
        console2.log("sweepToVault >0", handler.ok("sweepToVault"));
        console2.log("reports ok", handler.ok("adapter.report"));
        console2.log("sweepFees ok", handler.ok("sweepFees"));
        console2.log("forwardPendingFees >0", handler.ok("forwardPendingFees"));
        console2.log("rescueToken ok", handler.ok("adapter.rescueToken"));
        console2.log("upgrades ok", handler.ok("adapter.upgradeToAndCall"));
        console2.log("returned to vault", adapter.totalReturnedUsd());
        console2.log("fees forwarded", adapter.totalFeesForwardedUsd());
    }
}

/// @notice Stateless variant: a single fuzz run executes a random sequence over the whole surface.
contract OrderlyRandomSequenceFuzzTest is OrderlyFixture {
    OrderlyHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new OrderlyHandler(
            adapter, ov, usdc, uwVault, router, bookMock, cfg, ops, timelock, orderlyOperator, factory
        );
    }

    /// @notice Guards the handler itself: with privileged actor seeds every success path is reachable.
    ///         An even actor seed selects the function's privileged role (vault / ops-venue / timelock).
    function test_handlerReachesSuccessPaths() public {
        handler.deposit(0, 1, 50_000e6);
        handler.deposit(0, 0, 25_000e6);
        assertEq(handler.ok("uwVault.deployToVenue"), 2, "deposit");
        handler.requestWithdraw(0, 1, 10_000e6);
        handler.requestWithdraw(0, 1, 5000e6);
        assertEq(handler.ok("uwVault.recall"), 2, "recall");
        handler.confirm(0, 1, 0, false);
        handler.confirm(0, 2, 1e6, true);
        assertEq(
            handler.ok("adapter.confirmWithdraw") + handler.ok("adapter.confirmWithdrawWithFee"), 2, "confirm"
        );
        handler.venuePays(1, 14_999e6);
        handler.sweepToVault(0);
        assertEq(handler.ok("sweepToVault"), 1, "sweep");
        handler.warp(MARK_INTERVAL);
        handler.report(0, 25_000e6, 35_000e6, 0, 0);
        assertEq(handler.ok("adapter.report"), 1, "report");
        handler.venueCredits(1, 500e6);
        handler.venuePays(1, 500e6);
        handler.sweepFees(0, 1, 300e6);
        assertEq(handler.ok("sweepFees"), 1, "sweepFees");
        assertEq(adapter.totalFeesForwardedUsd(), 300e6);
        handler.upgrade(0);
        assertEq(handler.ok("adapter.upgradeToAndCall"), 1, "upgrade");
        handler.rescueToken(0, 0, false, 1e18);
        assertEq(handler.ok("adapter.rescueToken"), 1, "rescue junk");
        handler.rescueToken(0, 0, true, 1);
        assertEq(handler.ok("adapter.rescueToken"), 1, "never USDC");
        assertEq(usdc.violations(), 0);
    }

    function testFuzz_randomCallersNeverMoveUsdcOutside(uint256[40] calldata seeds) public {
        for (uint256 i; i < seeds.length; i++) {
            uint256 s = seeds[i];
            uint256 op = s % 22;
            uint256 x = uint256(keccak256(abi.encode(s, 1)));
            uint256 y = uint256(keccak256(abi.encode(s, 2)));
            if (op == 0) handler.deposit(x, y, s >> 8);
            else if (op == 1) handler.requestWithdraw(x, y, s >> 8);
            else if (op == 2) handler.confirm(x, y, s >> 8, s & 1 == 1);
            else if (op == 3) handler.cancel(x, y);
            else if (op == 4) handler.fail(x, y);
            else if (op == 5) handler.sweepToVault(x);
            else if (op == 6) handler.report(x, y, int256(s >> 16), -int256(s >> 20), s >> 4);
            else if (op == 7) handler.sweepFees(x, y, s >> 8);
            else if (op == 8) handler.forwardPendingFees(x);
            else if (op == 9) handler.cancelPendingFees(x, y);
            else if (op == 10) handler.setDelegateSigner(x, y);
            else if (op == 11) handler.setMaxFee(x, y);
            else if (op == 12) handler.rescueToken(x, y, s & 1 == 1, s >> 8);
            else if (op == 13) handler.rescueNative(x, y, s >> 8);
            else if (op == 14) handler.upgrade(x);
            else if (op == 15) handler.reinitialize(x);
            else if (op == 16) handler.venuePays(x, y);
            else if (op == 17) handler.venueCredits(x, y);
            else if (op == 18) handler.donate(x, y);
            else if (op == 19) handler.warp(y);
            else if (op == 20) handler.applyMark();
            else handler.setBookState(y);
        }
        assertEq(usdc.violations(), 0);
        uint256 held = usdc.balanceOf(address(uwVault)) + usdc.balanceOf(address(adapter))
            + usdc.balanceOf(address(ov)) + usdc.balanceOf(address(router));
        assertEq(usdc.totalSupply(), held);
        assertEq(usdc.receivedFromAdapter(address(router)), adapter.totalFeesForwardedUsd());
        assertEq(usdc.receivedFromAdapter(address(uwVault)), adapter.totalReturnedUsd());
    }
}
