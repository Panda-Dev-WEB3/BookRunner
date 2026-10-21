// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IInsurancePool} from "../../../src/interfaces/IInsurancePool.sol";
import {InsurancePool} from "../../../src/InsurancePool.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockBookConfig} from "../../book/utils/BookMocks.sol";
import {CoreMockFactory} from "../../core/utils/CoreMocks.sol";

/// @notice The InsurancePool behind its ERC1967 proxy on a mock config / factory. Books are plain addresses
///         registered in the factory (book, vault, router act through pranks).
abstract contract PoolFixture is Test {
    uint256 internal constant U = 1e6; // 1 USDC
    uint256 internal constant EPOCH = 7 days;
    bytes32 internal constant MKT = bytes32("NVDA");

    MockERC20 internal usdc;
    MockBookConfig internal cfg;
    CoreMockFactory internal factory;
    InsurancePool internal poolImpl;
    InsurancePool internal pool;

    address internal timelock = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function _deployPool() internal {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("Global Dollar", "USDG", 6);
        cfg = new MockBookConfig();
        factory = new CoreMockFactory();
        cfg.setUsdc(address(usdc));
        cfg.setTimelock(timelock);
        cfg.setFactory(address(factory));
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        cfg.grantRole(cfg.KEEPER_ROLE(), keeper);
        poolImpl = new InsurancePool();
        pool = InsurancePool(
            address(new ERC1967Proxy(address(poolImpl), abi.encodeCall(InsurancePool.initialize, (address(cfg)))))
        );
        cfg.setInsurancePool(address(pool));
    }

    /// @dev Registers book `id` in the factory with plain addresses for the book, its vault and router.
    function _registerBook(uint256 id) internal returns (address book, address vault, address router) {
        book = makeAddr(string.concat("book", vm.toString(id)));
        vault = makeAddr(string.concat("vault", vm.toString(id)));
        router = makeAddr(string.concat("router", vm.toString(id)));
        BRTypes.BookComponents memory c;
        c.book = book;
        c.vault = vault;
        c.router = router;
        c.senior = makeAddr(string.concat("senior", vm.toString(id)));
        c.junior = makeAddr(string.concat("junior", vm.toString(id)));
        c.adapter = makeAddr(string.concat("adapter", vm.toString(id)));
        factory.register(id, c);
    }

    // ---------------------------------------------------------------- epochs

    /// @dev Warps to the end of the oldest unprocessed epoch (if needed), has every active book mark at its current
    ///      claim (fresh), and processes it.
    function _process() internal returns (uint64 e) {
        (, uint64 ends,,,) = pool.queue();
        if (block.timestamp < ends) vm.warp(ends);
        _markAllFresh();
        e = pool.processEpoch();
    }

    function _procEpoch() internal view returns (uint64 e) {
        (e,,,,) = pool.queue();
    }

    function _markAllFresh() internal {
        uint256[] memory ids = pool.activeBooks();
        for (uint256 i; i < ids.length; ++i) {
            IInsurancePool.BookPosition memory p = pool.bookPosition(ids[i]);
            vm.prank(p.book);
            pool.markBook(ids[i], p.claim, uint64(block.timestamp), false);
        }
    }

    function _requestDeposit(address who, uint256 assets) internal returns (uint256 id) {
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(pool), assets);
        id = pool.requestDeposit(assets);
        vm.stopPrank();
    }

    /// @dev Queued deposit, processed at the next epoch end, claimed: returns the shares.
    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        uint256 id = _requestDeposit(who, assets);
        uint64 e = pool.depositInfo(id).epoch;
        for (uint256 i; i < 16 && !pool.epochInfo(e).processed; ++i) {
            _process();
        }
        shares = pool.claimDeposit(id);
    }

    function _seedFirstLoss(uint256 assets) internal {
        usdc.mint(treasury, assets);
        vm.startPrank(treasury);
        usdc.approve(address(pool), assets);
        pool.depositFirstLoss(assets);
        vm.stopPrank();
    }

    function _allocate(uint256 id, uint256 amount) internal {
        _allocate(id, amount, MKT);
    }

    function _allocate(uint256 id, uint256 amount, bytes32 market) internal {
        (address book,,) = _bookAddrs(id);
        vm.prank(book);
        pool.allocate(id, amount, market);
    }

    function _premium(uint256 id, uint256 amount) internal {
        (,, address router) = _bookAddrs(id);
        usdc.mint(router, amount);
        vm.startPrank(router);
        usdc.approve(address(pool), amount);
        pool.notifyPremium(id, amount);
        vm.stopPrank();
    }

    function _repay(uint256 id, uint256 amount) internal {
        (, address vault,) = _bookAddrs(id);
        vm.startPrank(vault);
        usdc.approve(address(pool), amount);
        pool.repay(id, amount);
        vm.stopPrank();
    }

    /// @dev The book reports `value` (what it can repay) at a mark now.
    function _markValue(uint256 id, uint256 value) internal {
        (address book,,) = _bookAddrs(id);
        vm.prank(book);
        pool.markBook(id, value, uint64(block.timestamp), false);
    }

    function _bookAddrs(uint256 id) internal view returns (address book, address vault, address router) {
        BRTypes.BookComponents memory c = factory.componentsOf(id);
        return (c.book, c.vault, c.router);
    }

    function _request(address who, uint256 shares) internal returns (uint256 id) {
        vm.prank(who);
        id = pool.requestWithdraw(shares);
    }

    /// @dev Processes epochs until the one `requestId` waits for is processed.
    function _processThrough(uint256 requestId) internal {
        uint64 target = pool.requestInfo(requestId).epoch;
        for (uint256 i; i < 16; ++i) {
            (uint64 e,,,,) = pool.queue();
            if (e > target) return;
            _process();
        }
    }

    /// @dev Pool accounting identity: assets == free + claims, depositors + slice == assets, cash backed.
    function _checkLedger() internal view {
        (uint256 cash, uint256 reserved, uint256 pendingDeposits,,) = pool.ledger();
        assertEq(pool.poolAssets(), cash - reserved + pool.claimsTotal(), "assets == free + claims");
        assertEq(pool.totalAssets() + pool.firstLossAssets(), pool.poolAssets(), "depositors + slice == assets");
        assertGe(usdc.balanceOf(address(pool)), cash + pendingDeposits, "cash and queued deposits backed");
        assertGe(cash, reserved, "reserved <= cash");
        (,,, uint256 pendingShares,) = pool.queue();
        assertEq(pool.balanceOf(address(pool)), pendingShares + pool.depositSharesUnclaimed(), "escrow == queue");
    }
}
