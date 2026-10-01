// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {IStockTokenRegistry} from "../../src/interfaces/IStockTokenRegistry.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {StockTokenRegistry} from "../../src/StockTokenRegistry.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MandateMockConfig, MandateMockOracle, MandateWeirdDecimalsToken} from "./utils/MandateMocks.sol";

contract StockTokenRegistryTest is Test {
    MandateMockConfig internal cfg;
    MandateMockOracle internal oracle;
    StockTokenRegistry internal reg;
    MockERC20 internal t18;
    MockERC20 internal t6;
    MockERC20 internal t0;

    address internal timelock = makeAddr("timelock");
    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant NVDA = "NVDA";
    bytes32 internal constant TSLA = "TSLA";
    bytes32 internal constant AAPL = "AAPL";
    bytes32 internal constant RHX = "RHX5";
    bytes32 internal constant INDEX_ID = keccak256("BKRN.INDEX.RHX5");

    event TokenRegistered(address indexed token, bytes32 indexed priceId, uint256 multiplierWad);
    event MultiplierSet(address indexed token, uint256 multiplierWad);
    event FloatCapSet(address indexed token, uint256 floatCapRaw);
    event IndexRegistered(bytes32 indexed indexId, bytes32 priceId, uint256 components);
    event AdminSet(address indexed admin);
    event TokenActiveSet(address indexed token, bool active);

    function setUp() public {
        vm.warp(1_700_000_000);
        cfg = new MandateMockConfig();
        cfg.setTimelock(timelock);
        oracle = new MandateMockOracle(cfg);
        cfg.setOracle(address(oracle));
        reg = new StockTokenRegistry(address(cfg), admin);
        t18 = new MockERC20("NVDA", "NVDA", 18);
        t6 = new MockERC20("TSLA", "TSLA", 6);
        t0 = new MockERC20("AAPL", "AAPL", 0);
        oracle.set(NVDA, 190e18, uint64(block.timestamp), false);
        oracle.set(TSLA, 440e18, uint64(block.timestamp), false);
        oracle.set(AAPL, 255e18, uint64(block.timestamp), false);
    }

    function _registerAll() internal {
        vm.startPrank(timelock);
        reg.register(address(t18), NVDA, 1e18, 1000e18);
        reg.register(address(t6), TSLA, 1e18, 1000e6);
        reg.register(address(t0), AAPL, 1e18, 1000);
        vm.stopPrank();
    }

    function _components2() internal view returns (IStockTokenRegistry.IndexComponent[] memory c) {
        c = new IStockTokenRegistry.IndexComponent[](2);
        c[0] = IStockTokenRegistry.IndexComponent({token: address(t18), weightBps: 6000});
        c[1] = IStockTokenRegistry.IndexComponent({token: address(t6), weightBps: 4000});
    }

    // ------------------------------------------------------------------ construction / governance

    function test_constructor_zeroConfigReverts() public {
        vm.expectRevert(StockTokenRegistry.ZeroAddress.selector);
        new StockTokenRegistry(address(0), admin);
    }

    function test_register_byTimelockAndAdmin() public {
        vm.expectEmit(true, true, false, true, address(reg));
        emit TokenRegistered(address(t18), NVDA, 1e18);
        vm.expectEmit(true, false, false, true, address(reg));
        emit FloatCapSet(address(t18), 5e18);
        vm.prank(timelock);
        reg.register(address(t18), NVDA, 1e18, 5e18);

        vm.prank(admin);
        reg.register(address(t6), TSLA, 2e18, 7e6);

        IStockTokenRegistry.StockToken memory s = reg.getToken(address(t18));
        assertEq(s.token, address(t18));
        assertEq(s.priceId, NVDA);
        assertEq(s.multiplierWad, 1e18);
        assertEq(s.decimals, 18);
        assertTrue(s.active);
        assertEq(s.floatCapRaw, 5e18);
        assertEq(reg.getToken(address(t6)).decimals, 6);
        assertTrue(reg.isCanonical(address(t18)));
        assertTrue(reg.isCanonical(address(t6)));
        address[] memory list = reg.tokens();
        assertEq(list.length, 2);
        assertEq(list[1], address(t6));
    }

    function test_register_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.register(address(t18), NVDA, 1e18, 0);

        vm.startPrank(timelock);
        vm.expectRevert(StockTokenRegistry.ZeroAddress.selector);
        reg.register(address(0), NVDA, 1e18, 0);
        vm.expectRevert(StockTokenRegistry.BadPriceId.selector);
        reg.register(address(t18), bytes32(0), 1e18, 0);
        vm.expectRevert(StockTokenRegistry.BadMultiplier.selector);
        reg.register(address(t18), NVDA, 0, 0);
        MandateWeirdDecimalsToken weird = new MandateWeirdDecimalsToken();
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.BadDecimals.selector, uint8(31)));
        reg.register(address(weird), NVDA, 1e18, 0);
        reg.register(address(t18), NVDA, 1e18, 0);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.AlreadyRegistered.selector, address(t18)));
        reg.register(address(t18), NVDA, 1e18, 0);
        vm.stopPrank();
    }

    function test_setMultiplier_setFloatCap_setActive() public {
        _registerAll();
        vm.expectEmit(true, false, false, true, address(reg));
        emit MultiplierSet(address(t18), 15e17);
        vm.prank(timelock);
        reg.setMultiplier(address(t18), 15e17);
        assertEq(reg.getToken(address(t18)).multiplierWad, 15e17);

        vm.expectEmit(true, false, false, true, address(reg));
        emit FloatCapSet(address(t18), 42);
        vm.prank(admin);
        reg.setFloatCap(address(t18), 42);
        assertEq(reg.getToken(address(t18)).floatCapRaw, 42);

        vm.expectEmit(true, false, false, true, address(reg));
        emit TokenActiveSet(address(t18), false);
        vm.prank(timelock);
        reg.setActive(address(t18), false);
        assertFalse(reg.isCanonical(address(t18)));
        // inactive tokens are still valued (existing inventory can be marked / flattened)
        assertEq(reg.valueUsd(address(t18), 1e18), 285e6);
    }

    function test_setters_reverts() public {
        _registerAll();
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.setMultiplier(address(t18), 1e18);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.setFloatCap(address(t18), 1);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.setActive(address(t18), false);
        vm.stopPrank();

        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotRegistered.selector, stranger));
        reg.setMultiplier(stranger, 1e18);
        vm.expectRevert(StockTokenRegistry.BadMultiplier.selector);
        reg.setMultiplier(address(t18), 0);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotRegistered.selector, stranger));
        reg.setFloatCap(stranger, 1);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotRegistered.selector, stranger));
        reg.setActive(stranger, true);
        vm.stopPrank();
    }

    function test_admin_lifecycle() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.setAdmin(stranger);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, admin));
        reg.setAdmin(stranger);

        vm.expectEmit(true, false, false, false, address(reg));
        emit AdminSet(address(0));
        vm.prank(admin);
        reg.renounceAdmin();
        assertEq(reg.admin(), address(0));

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, admin));
        reg.register(address(t18), NVDA, 1e18, 0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.renounceAdmin();

        vm.prank(timelock);
        reg.setAdmin(stranger);
        assertEq(reg.admin(), stranger);
        vm.prank(stranger);
        reg.register(address(t18), NVDA, 1e18, 0);
    }

    function test_noAdmin_onlyTimelock() public {
        StockTokenRegistry r = new StockTokenRegistry(address(cfg), address(0));
        vm.prank(address(0x1234));
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, address(0x1234)));
        r.register(address(t18), NVDA, 1e18, 0);
        vm.prank(timelock);
        r.register(address(t18), NVDA, 1e18, 0);
    }

    // ------------------------------------------------------------------ indexes

    function test_registerIndex_andViews() public {
        _registerAll();
        vm.expectEmit(true, false, false, true, address(reg));
        emit IndexRegistered(INDEX_ID, RHX, 2);
        vm.prank(timelock);
        reg.registerIndex(INDEX_ID, RHX, _components2());

        (bytes32 pid, IStockTokenRegistry.IndexComponent[] memory comps) = reg.getIndex(INDEX_ID);
        assertEq(pid, RHX);
        assertEq(comps.length, 2);
        assertEq(comps[0].token, address(t18));
        assertEq(comps[1].weightBps, 4000);
        assertTrue(reg.isIndex(INDEX_ID));
        assertEq(reg.priceIdOf(INDEX_ID), RHX);
        assertEq(reg.indexes().length, 1);

        // re-weight in place (no duplicate listing)
        IStockTokenRegistry.IndexComponent[] memory c3 = new IStockTokenRegistry.IndexComponent[](3);
        c3[0] = IStockTokenRegistry.IndexComponent({token: address(t18), weightBps: 3334});
        c3[1] = IStockTokenRegistry.IndexComponent({token: address(t6), weightBps: 3333});
        c3[2] = IStockTokenRegistry.IndexComponent({token: address(t0), weightBps: 3333});
        vm.prank(admin);
        reg.registerIndex(INDEX_ID, "RHX5v2", c3);
        (pid, comps) = reg.getIndex(INDEX_ID);
        assertEq(pid, "RHX5v2");
        assertEq(comps.length, 3);
        assertEq(reg.indexes().length, 1);
    }

    function test_registerIndex_reverts() public {
        _registerAll();
        IStockTokenRegistry.IndexComponent[] memory c = _components2();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.Unauthorized.selector, stranger));
        reg.registerIndex(INDEX_ID, RHX, c);

        vm.startPrank(timelock);
        bytes32 tokenLike = bytes32(uint256(uint160(address(t18))));
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.BadIndexId.selector, tokenLike));
        reg.registerIndex(tokenLike, RHX, c);
        vm.expectRevert(StockTokenRegistry.BadPriceId.selector);
        reg.registerIndex(INDEX_ID, bytes32(0), c);

        IStockTokenRegistry.IndexComponent[] memory empty = new IStockTokenRegistry.IndexComponent[](0);
        vm.expectRevert(StockTokenRegistry.BadComponents.selector);
        reg.registerIndex(INDEX_ID, RHX, empty);

        IStockTokenRegistry.IndexComponent[] memory many = new IStockTokenRegistry.IndexComponent[](17);
        vm.expectRevert(StockTokenRegistry.BadComponents.selector);
        reg.registerIndex(INDEX_ID, RHX, many);

        IStockTokenRegistry.IndexComponent[] memory bad = _components2();
        bad[1].token = stranger;
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotCanonical.selector, stranger));
        reg.registerIndex(INDEX_ID, RHX, bad);

        bad = _components2();
        bad[1].weightBps = 0;
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.BadWeights.selector, 0));
        reg.registerIndex(INDEX_ID, RHX, bad);

        bad = _components2();
        bad[1].token = address(t18);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.DuplicateComponent.selector, address(t18)));
        reg.registerIndex(INDEX_ID, RHX, bad);

        bad = _components2();
        bad[1].weightBps = 3999;
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.BadWeights.selector, 9999));
        reg.registerIndex(INDEX_ID, RHX, bad);

        reg.setActive(address(t6), false);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotCanonical.selector, address(t6)));
        reg.registerIndex(INDEX_ID, RHX, c);
        vm.stopPrank();
    }

    function test_priceIdOf_and_isIndex() public {
        _registerAll();
        assertEq(reg.priceIdOf(bytes32(uint256(uint160(address(t18))))), NVDA);
        bytes32 unknownToken = bytes32(uint256(uint160(stranger)));
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.UnknownUnderlying.selector, unknownToken));
        reg.priceIdOf(unknownToken);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.UnknownUnderlying.selector, INDEX_ID));
        reg.priceIdOf(INDEX_ID);
        assertFalse(reg.isIndex(INDEX_ID));
        assertFalse(reg.isIndex(bytes32(uint256(uint160(address(t18))))));
    }

    // ------------------------------------------------------------------ valuation

    function test_valueUsd_decimalsAware() public {
        _registerAll();
        // 18 decimals: 2.5 tokens @ 190 = 475 USD
        assertEq(reg.valueUsd(address(t18), 25e17), 475e6);
        // 6 decimals: 3 tokens @ 440 = 1320 USD
        assertEq(reg.valueUsd(address(t6), 3e6), 1320e6);
        // 0 decimals: 4 tokens @ 255 = 1020 USD
        assertEq(reg.valueUsd(address(t0), 4), 1020e6);
        // dust floors to 0 (1 wei of an 18-dec token worth 1.9e-16 USD)
        assertEq(reg.valueUsd(address(t18), 1), 0);
        assertEq(reg.valueUsd(address(t18), 0), 0);
        assertEq(reg.valueUsdAt(address(t18), 1e18, 0), 0);
        assertEq(reg.valueUsdAt(address(t18), 1e18, 123_456_789e12), 123_456_789);
    }

    function test_valueUsd_reverts() public {
        _registerAll();
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotRegistered.selector, stranger));
        reg.valueUsd(stranger, 1);
        vm.expectRevert(abi.encodeWithSelector(StockTokenRegistry.NotRegistered.selector, stranger));
        reg.valueUsdAt(stranger, 1, 1e18);
        vm.warp(block.timestamp + 301);
        vm.expectRevert(
            abi.encodeWithSelector(IAttestedOracle.StalePrice.selector, NVDA, uint64(1_700_000_000))
        );
        reg.valueUsd(address(t18), 1e18);
    }

    function test_valueUsd_heldPriceStillValues() public {
        _registerAll();
        oracle.setHeld(NVDA, true);
        assertEq(reg.valueUsd(address(t18), 1e18), 190e6);
    }

    /// @notice RED-TEAM multiplier double-apply: multiplier 2e18 doubles value exactly, once.
    function test_redteam_multiplierAppliedExactlyOnce() public {
        _registerAll();
        uint256 v1 = reg.valueUsd(address(t18), 10e18);
        uint256 v1b = reg.valueUsd(address(t6), 10e6);
        assertEq(v1, 1900e6);
        assertEq(v1b, 4400e6);
        vm.startPrank(timelock);
        reg.setMultiplier(address(t18), 2e18);
        reg.setMultiplier(address(t6), 2e18);
        vm.stopPrank();
        assertEq(reg.valueUsd(address(t18), 10e18), 2 * v1);
        assertEq(reg.valueUsd(address(t6), 10e6), 2 * v1b);
        // a double application would give 4x
        assertTrue(reg.valueUsd(address(t18), 10e18) != 4 * v1);
        assertEq(reg.valueUsdAt(address(t18), 10e18, 190e18), 3800e6);
    }

    /// @dev Reference: floor(qty * mult * price / (10**dec * 1e18) / 1e12) (ARCHITECTURE §2.7).
    function testFuzz_valueMatchesFormula(uint96 qty, uint64 multSeed, uint96 price, bool sixDec) public {
        _registerAll();
        address token = sixDec ? address(t6) : address(t18);
        uint256 mult = bound(uint256(multSeed), 1, 10e18);
        vm.prank(timelock);
        reg.setMultiplier(token, mult);
        uint256 dec = sixDec ? 6 : 18;
        uint256 expected = uint256(qty) * mult * uint256(price) / (10 ** dec * 1e18) / 1e12;
        assertEq(reg.valueUsdAt(token, qty, price), expected);
    }

    /// @dev Doubling the multiplier doubles value up to the single floor (never 4x, never off by >1).
    function testFuzz_multiplierDoubling(uint96 qty, uint96 price, bool sixDec) public {
        _registerAll();
        address token = sixDec ? address(t6) : address(t18);
        uint256 v1 = reg.valueUsdAt(token, qty, price);
        vm.prank(timelock);
        reg.setMultiplier(token, 2e18);
        uint256 v2 = reg.valueUsdAt(token, qty, price);
        assertGe(v2, 2 * v1);
        assertLe(v2, 2 * v1 + 1);
    }

    function testFuzz_valueMonotonicInQty(uint96 a, uint96 b) public {
        _registerAll();
        (uint256 lo, uint256 hi) = a < b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        assertLe(reg.valueUsd(address(t18), lo), reg.valueUsd(address(t18), hi));
    }
}
