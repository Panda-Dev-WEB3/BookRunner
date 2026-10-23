// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {BkrnStaking} from "../../src/BkrnStaking.sol";
import {BkrnFeeRouter} from "../../src/BkrnFeeRouter.sol";
import {BkrnV4Swapper} from "../../src/BkrnV4Swapper.sol";
import {IBkrnFeeRouter} from "../../src/interfaces/IBkrnFeeRouter.sol";
import {IBkrnV4Swapper} from "../../src/interfaces/IBkrnV4Swapper.sol";
import {IV4PoolManager} from "../../src/interfaces/external/IUniswapV4.sol";
import {UniswapV4Lib} from "../../src/libraries/UniswapV4Lib.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";
import {CoreMockOracle} from "./utils/CoreMocks.sol";
import {IMockV4Hook, MockV4Hook, MockV4PoolManager, MockWETH} from "../mocks/UniswapV4Mocks.sol";
import {UniV3MockFactory, UniV3MockPool} from "../mocks/UniswapV3Mocks.sol";

/// @dev Hook that re-enters the fee router from inside the PoolManager swap.
contract ReenterHook is IMockV4Hook {
    address internal immutable target;

    constructor(address target_) {
        target = target_;
    }

    function beforeSwap(address, IV4PoolManager.PoolKey calldata, IV4PoolManager.SwapParams calldata, bytes calldata)
        external
        returns (int128)
    {
        BkrnFeeRouter(target).executeBuyback(1, 0);
        return 0;
    }

    function afterSwap(address, IV4PoolManager.PoolKey calldata, IV4PoolManager.SwapParams calldata, int256, bytes calldata)
        external
        pure
        returns (int128)
    {
        return 0;
    }
}

/// @dev Hook that reverts with no data (like an out-of-gas).
contract BareRevertHook is IMockV4Hook {
    function beforeSwap(address, IV4PoolManager.PoolKey calldata, IV4PoolManager.SwapParams calldata, bytes calldata)
        external
        pure
        returns (int128)
    {
        revert();
    }

    function afterSwap(address, IV4PoolManager.PoolKey calldata, IV4PoolManager.SwapParams calldata, int256, bytes calldata)
        external
        pure
        returns (int128)
    {
        return 0;
    }
}

/// @dev Hook that calls PoolManager.sync(token) from afterSwap (sync is global, not per locker).
contract SyncingHook is IMockV4Hook {
    MockV4PoolManager internal immutable pm;
    address internal immutable token;

    constructor(MockV4PoolManager pm_, address token_) {
        pm = pm_;
        token = token_;
    }

    function beforeSwap(address, IV4PoolManager.PoolKey calldata, IV4PoolManager.SwapParams calldata, bytes calldata)
        external
        pure
        returns (int128)
    {
        return 0;
    }

    function afterSwap(address, IV4PoolManager.PoolKey calldata, IV4PoolManager.SwapParams calldata, int256, bytes calldata)
        external
        returns (int128)
    {
        pm.sync(token);
        return 0;
    }
}

/// @notice VENUE_UNIV4 buybacks against a v4 PoolManager stand-in with the real flash accounting
///         (MockV4PoolManager), on the three routes: USDG -> BKRN (direct), USDG -> ETH -> BKRN (two v4 pools, one
///         unlock) and USDG -> WETH (v3 router) -> unwrap -> ETH -> BKRN. Run twice (the concrete contracts below
///         place the settlement token below / above BKRN, so both direct-pool orders are covered).
abstract contract BkrnFeeRouterV4Base is Test {
    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");

    BookrunnerConfig internal config;
    MockERC20 internal usdc;
    MockERC20 internal bkrn;
    MockWETH internal weth;
    MockSwapRouter internal v3;
    BkrnStaking internal staking;
    BkrnFeeRouter internal fr;
    BkrnV4Swapper internal swapper;
    MockV4PoolManager internal pm;
    MockV4Hook internal hook;
    IV4PoolManager.PoolKey internal key; // USDG/BKRN, no hook, 0.3%
    IV4PoolManager.PoolKey internal hookKey; // USDG/BKRN Pons-like: fee 0, tickSpacing 200, fee-taking hook
    IV4PoolManager.PoolKey internal ethUsdcKey; // ETH/USDG 0.05%, no hook
    IV4PoolManager.PoolKey internal ethBkrnKey; // ETH/BKRN Pons-like: fee 0, tickSpacing 200, fee-taking hook

    uint256 internal constant REF = 20e18; // 20 BKRN per USDG
    uint256 internal constant ETH_USD = 2400e18; // 2,400 USDG per ETH
    uint256 internal constant BKRN_ETH = 48_000e18; // 48,000 BKRN per ETH (= 20 x 2,400)
    uint16 internal constant SLIP = 500;
    // one range ~1M USDG / 20M BKRN deep
    uint128 internal constant L_DIRECT = 4_472_135_954_999_579_392;
    // ~1,000 ETH / 2.4M USDG
    uint128 internal constant L_ETH_USDC = 48_989_794_855_663_561;
    // ~1,000 ETH / 48M BKRN
    uint128 internal constant L_ETH_BKRN = 219_089_023_002_066_449_000_000;

    uint8 internal constant DIRECT = 0;
    uint8 internal constant V4_ETH = 1;
    uint8 internal constant V3_WETH = 2;

    function _usdcIsCurrency0() internal pure virtual returns (bool);

    function setUp() public {
        address u = _usdcIsCurrency0() ? address(uint160(0x1000_0000)) : address(type(uint160).max - 0xffff);
        deployCodeTo("MockERC20.sol:MockERC20", abi.encode("USD Coin", "USDC", uint8(6)), u);
        usdc = MockERC20(u);
        bkrn = new MockERC20("Bookrunner", "BKRN", 18);
        assertEq(address(usdc) < address(bkrn), _usdcIsCurrency0());

        config = new BookrunnerConfig(admin);
        vm.startPrank(admin);
        config.setAddress("usdc", address(usdc));
        config.setAddress("bkrn", address(bkrn));
        vm.stopPrank();
        staking = new BkrnStaking(address(config));
        fr = new BkrnFeeRouter(address(config));
        swapper = BkrnV4Swapper(payable(address(fr.v4Swapper())));
        pm = new MockV4PoolManager();
        hook = new MockV4Hook(IV4PoolManager(address(pm)));
        weth = new MockWETH();
        v3 = new MockSwapRouter(admin);
        vm.startPrank(admin);
        config.setAddress("staking", address(staking));
        config.setAddress("feeRouter", address(fr));
        config.grantRole(config.KEEPER_ROLE(), keeper);
        fr.setBuybackParams(0, REF, SLIP, 1_000_000e6); // no v3 BKRN pool
        fr.setV4PoolManager(address(pm));
        fr.setEthReference(ETH_USD, BKRN_ETH);
        fr.setBuybackRouter(address(v3));
        v3.setPriceBoth(address(usdc), address(weth), 1e36 / ETH_USD);
        vm.stopPrank();

        key = _key(address(usdc), address(bkrn), 3000, 60, address(0));
        hookKey = _key(address(usdc), address(bkrn), 0, 200, address(hook));
        ethUsdcKey = _key(address(0), address(usdc), 500, 10, address(0));
        ethBkrnKey = _key(address(0), address(bkrn), 0, 200, address(hook));
        pm.initialize(key, _sqrtDirect(REF), L_DIRECT);
        pm.initialize(hookKey, _sqrtDirect(REF), L_DIRECT);
        pm.initialize(ethUsdcKey, _sqrtEthUsdc(ETH_USD), L_ETH_USDC);
        pm.initialize(ethBkrnKey, _sqrtEthBkrn(BKRN_ETH), L_ETH_BKRN);
        usdc.mint(address(pm), 5_000_000e6);
        bkrn.mint(address(pm), 100_000_000e18);
        vm.deal(address(pm), 2000 ether);
        vm.deal(address(this), 1000 ether);
        weth.deposit{value: 1000 ether}();
        weth.transfer(address(v3), 1000 ether);

        bkrn.mint(alice, 1e18);
        vm.startPrank(alice);
        bkrn.approve(address(staking), 1e18);
        staking.stake(1e18);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------- helpers

    function _key(address a, address b, uint24 fee, int24 spacing, address hooks)
        internal
        pure
        returns (IV4PoolManager.PoolKey memory)
    {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return IV4PoolManager.PoolKey(c0, c1, fee, spacing, hooks);
    }

    /// @dev Pool prices through the router's own limit maths (a limit at price p is the pool at price p).
    function _sqrtDirect(uint256 bkrnPerUsdc) internal pure returns (uint160) {
        return UniswapV4Lib.priceLimit(bkrnPerUsdc, 6, 18, _usdcIsCurrency0());
    }

    function _sqrtEthUsdc(uint256 usdcPerEth) internal pure returns (uint160) {
        return UniswapV4Lib.priceLimit(usdcPerEth, 18, 6, true); // ETH is currency0
    }

    function _sqrtEthBkrn(uint256 bkrnPerEth) internal pure returns (uint160) {
        return UniswapV4Lib.priceLimit(bkrnPerEth, 18, 18, true);
    }

    /// @dev The direct hop's limit on `key` (0.3% LP fee, no hook): the gross price whose net is the floor price,
    ///      plus 1 bp (BkrnFeeRouter._gross).
    function _directLimit() internal pure returns (uint160) {
        uint256 net = REF * (10_000 - SLIP) / 10_000;
        return _sqrtDirect(Math.mulDiv(net, 1e6 * 10_001, 997_000 * 10_000, Math.Rounding.Ceil));
    }

    function _seed(uint256 amount) internal {
        usdc.mint(address(fr), amount);
        fr.notifyMigration(amount);
    }

    function _emptyKey() internal pure returns (IV4PoolManager.PoolKey memory k) {}

    function _route(uint8 kind, IV4PoolManager.PoolKey memory bkrnPool) internal view returns (IBkrnV4Swapper.V4Route memory r) {
        r.kind = kind;
        r.bkrnPool = bkrnPool;
        if (kind == V4_ETH) r.ethPool = ethUsdcKey;
        if (kind == V3_WETH) (r.v3Fee, r.weth) = (100, address(weth));
    }

    function _use(IBkrnV4Swapper.V4Route memory r) internal {
        vm.startPrank(admin);
        if (r.bkrnPool.hooks != address(0)) fr.setV4HookAllowed(r.bkrnPool.hooks, true);
        fr.setV4Route(r);
        fr.setBuybackVenue(1);
        vm.stopPrank();
    }

    function _useDirect(IV4PoolManager.PoolKey memory k) internal {
        _use(_route(DIRECT, k));
    }

    function _assertNoStuckBalances() internal view {
        assertEq(usdc.balanceOf(address(fr)), fr.buybackPending(), "usdc == pending");
        assertEq(bkrn.balanceOf(address(fr)), 0, "no bkrn left");
        assertEq(usdc.allowance(address(fr), address(swapper)), 0, "no approval");
        assertEq(usdc.balanceOf(address(swapper)), 0, "swapper holds no usdc");
        assertEq(bkrn.balanceOf(address(swapper)), 0, "swapper holds no bkrn");
        assertEq(weth.balanceOf(address(swapper)), 0, "swapper holds no weth");
        assertEq(address(swapper).balance, 0, "swapper holds no eth");
        assertEq(address(fr).balance, 0, "router holds no eth");
        assertEq(pm.nonzeroDeltaCount(), 0, "deltas closed");
        assertFalse(pm.unlocked(), "manager locked");
    }

    // ------------------------------------------------------------------------------------------- direct

    function test_direct_swaps_settles_and_streams() public {
        _useDirect(key);
        _seed(100e6);
        uint256 pmUsdc = usdc.balanceOf(address(pm));
        vm.expectEmit(false, false, false, false, address(fr));
        emit IBkrnFeeRouter.BuybackExecuted(10e6, 0);
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(10e6, 0);
        assertApproxEqRel(out, 199.4e18, 0.0001e18); // 10 x 20 x (1 - 0.3%)
        assertGe(out, fr.buybackFloor(10e6));
        assertEq(fr.buybackPending(), 90e6);
        assertEq(usdc.balanceOf(address(pm)), pmUsdc + 10e6);
        assertEq(bkrn.balanceOf(address(staking)), 1e18 + out);
        assertEq(fr.totalBuybackUsdc(), 10e6);
        assertEq(fr.totalBkrnDistributed(), out);
        assertEq(pm.currencyDelta(address(swapper), address(usdc)), 0);
        assertEq(pm.currencyDelta(address(swapper), address(bkrn)), 0);
        _assertNoStuckBalances();
        vm.warp(block.timestamp + staking.rewardsDuration());
        assertApproxEqAbs(staking.earned(alice), out, 1e6);
    }

    /// @dev The price limit stops a large buyback at the floor price: partial fill, the rest stays pending.
    function test_direct_price_limit_partial_fill_refunds_pending() public {
        _useDirect(key);
        _seed(300_000e6);
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(300_000e6, 0);
        uint256 spent = fr.totalBuybackUsdc();
        assertLt(spent, 300_000e6);
        assertGt(spent, 0);
        assertEq(fr.buybackPending(), 300_000e6 - spent);
        (uint160 after_,) = pm.pools(UniswapV4Lib.poolId(key));
        assertEq(after_, _directLimit()); // stopped exactly at the slippage bound
        assertGe(out, spent * REF * (10_000 - SLIP) / 10_000 / 1e6);
        _assertNoStuckBalances();
    }

    /// @dev Review M-1 regression: with a Pons-like hook taking 3% of the output and a matching allowance, a buyback
    ///      too large for the pool stops at its (hook-aware) limit and still clears the floor: it partially fills,
    ///      the rest stays pending, instead of reverting every time at the same size.
    function test_hook_fee_allowance_makes_partial_fill_clear_the_floor() public {
        _useDirect(hookKey);
        hook.configure(0, 300, false);
        _seed(300_000e6);
        vm.prank(keeper); // no allowance: the stop at the plain limit fails the floor (whole-tx revert)
        vm.expectPartialRevert(BkrnFeeRouter.InsufficientOutput.selector);
        fr.executeBuyback(300_000e6, 0);
        vm.expectEmit(false, false, false, true, address(fr));
        emit BkrnFeeRouter.V4FeesSet(300, 0);
        vm.prank(admin);
        fr.setV4Fees(300, 0);
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(300_000e6, 0);
        uint256 spent = fr.totalBuybackUsdc();
        assertGt(spent, 0);
        assertLt(spent, 300_000e6); // partial fill
        assertEq(fr.buybackPending(), 300_000e6 - spent);
        assertGe(out, spent * REF * (10_000 - SLIP) / 10_000 / 1e6);
        _assertNoStuckBalances();
    }

    function test_setV4Fees_bounds() public {
        vm.startPrank(admin);
        vm.expectRevert(BkrnFeeRouter.BadBuybackParams.selector);
        fr.setV4Fees(1001, 0); // above MAX_V4_HOOK_FEE_BPS
        vm.expectRevert(BkrnFeeRouter.BadBuybackParams.selector);
        fr.setV4Fees(400, 0); // 400 + 500 / 4 >= 500
        vm.expectRevert(BkrnFeeRouter.BadBuybackParams.selector);
        fr.setV4Fees(200, 300); // 200 + 300 >= 500
        fr.setV4Fees(300, 100);
        assertEq(fr.v4HookFeeBps(), 300);
        assertEq(fr.v4EthHopBps(), 100);
        vm.expectRevert(BkrnFeeRouter.BadBuybackParams.selector);
        fr.setBuybackParams(0, REF, 400, 1_000_000e6); // slippage no longer above the allowances
        fr.setBuybackParams(0, REF, 1000, 1_000_000e6);
        fr.setV4Fees(0, 0);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotAdmin.selector, keeper));
        vm.prank(keeper);
        fr.setV4Fees(100, 0);
    }

    /// @dev Review M-2: previewBuyback simulates the exact swap and reverts BuybackPreview(spent, out).
    function test_previewBuyback_reports_the_simulated_fill() public {
        _useDirect(key);
        _seed(300_000e6);
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        uint256 real = fr.executeBuyback(300_000e6, 0);
        uint256 realSpent = fr.totalBuybackUsdc();
        vm.revertToState(snap);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BuybackPreview.selector, realSpent, real));
        fr.previewBuyback(300_000e6);
        assertEq(fr.buybackPending(), 300_000e6); // nothing persisted
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotKeeper.selector, alice));
        vm.prank(alice);
        fr.previewBuyback(1e6);
        vm.prank(admin);
        fr.setBuybackVenue(0);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BadVenue.selector, uint8(0)));
        vm.prank(keeper);
        fr.previewBuyback(1e6);
    }

    /// @dev A failing swap previews as (0, 0) (the keeper then sends nothing).
    function test_previewBuyback_failed_swap_is_zero() public {
        _useDirect(hookKey);
        hook.configure(0, 0, true);
        _seed(100e6);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BuybackPreview.selector, 0, 0));
        vm.prank(keeper);
        fr.previewBuyback(10e6);
    }

    /// @dev Review L-2: a swap that spends nothing (no liquidity up to the limit) emits BuybackNoFill.
    function test_no_fill_is_reported() public {
        IV4PoolManager.PoolKey memory k = _key(address(usdc), address(bkrn), 500, 10, address(0));
        pm.initialize(k, _sqrtDirect(REF), 0); // initialized, no liquidity
        _useDirect(k);
        _seed(100e6);
        vm.expectEmit(false, false, false, true, address(fr));
        emit BkrnFeeRouter.BuybackNoFill(10e6);
        vm.prank(keeper);
        assertEq(fr.executeBuyback(10e6, 0), 0);
        assertEq(fr.buybackPending(), 100e6);
        _assertNoStuckBalances();
    }

    /// @dev Review L-1: a bare revert (no data) inside the swap is re-raised, never a "successful" no-swap tx.
    function test_bare_revert_is_reraised() public {
        BareRevertHook bare = new BareRevertHook();
        IV4PoolManager.PoolKey memory k = _key(address(usdc), address(bkrn), 0, 200, address(bare));
        pm.initialize(k, _sqrtDirect(REF), L_DIRECT);
        _useDirect(k);
        _seed(100e6);
        vm.expectRevert(BkrnFeeRouter.V4SwapNoReason.selector);
        vm.prank(keeper);
        fr.executeBuyback(10e6, 0);
    }

    /// @dev Review L-1 regression: no gas window where executeBuyback succeeds without swapping (an inner out-of-
    ///      gas is re-raised): the lowest non-reverting gas limit swaps.
    function test_no_gas_window_without_swap() public {
        _use(_route(V3_WETH, ethBkrnKey));
        _seed(100e6);
        uint256 a = 50_000;
        uint256 b = 3_000_000;
        while (a + 1 < b) {
            uint256 m = (a + b) / 2;
            (bool ok,) = _tryGas(m);
            if (ok) b = m;
            else a = m;
        }
        (bool okAt, bool swappedAt) = _tryGas(b);
        assertTrue(okAt);
        assertTrue(swappedAt, "a non-reverting gas limit landed without swapping");
    }

    function _tryGas(uint256 g) internal returns (bool ok, bool swapped) {
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        (ok,) = address(fr).call{gas: g}(abi.encodeCall(BkrnFeeRouter.executeBuyback, (10e6, 0)));
        swapped = ok && fr.totalBuybackUsdc() > 0;
        vm.revertToState(snap);
    }

    /// @dev Review L-3: v4BlockedHop names the hop a stale reference blocks (alerts read it).
    function test_v4BlockedHop() public {
        assertEq(fr.v4BlockedHop(), 0); // venue v3
        _use(_route(V4_ETH, ethBkrnKey));
        assertEq(fr.v4BlockedHop(), 0);
        pm.setPrice(ethUsdcKey, _sqrtEthUsdc(2600e18)); // ETH up 8% vs the fixed reference
        assertEq(fr.v4BlockedHop(), 1);
        pm.setPrice(ethUsdcKey, _sqrtEthUsdc(ETH_USD));
        pm.setPrice(ethBkrnKey, _sqrtEthBkrn(BKRN_ETH * 90 / 100)); // BKRN 10% dearer in ETH
        assertEq(fr.v4BlockedHop(), 2);
        vm.startPrank(admin); // references refreshed (BKRN now 18 per USDG): nothing blocked
        fr.setEthReference(ETH_USD, BKRN_ETH * 90 / 100);
        fr.setBuybackParams(0, 18e18, SLIP, 1_000_000e6);
        vm.stopPrank();
        assertEq(fr.v4BlockedHop(), 0);
    }

    /// @dev Review I-1 regression: a hook calling sync(token) during the BKRN hop no longer breaks the native settle.
    function test_hook_sync_does_not_break_v3_weth_settle() public {
        SyncingHook sh = new SyncingHook(pm, address(usdc));
        IV4PoolManager.PoolKey memory k = _key(address(0), address(bkrn), 0, 200, address(sh));
        pm.initialize(k, _sqrtEthBkrn(BKRN_ETH), L_ETH_BKRN);
        _use(_route(V3_WETH, k));
        _seed(100e6);
        vm.prank(keeper);
        assertGt(fr.executeBuyback(10e6, 0), 0);
        _assertNoStuckBalances();
    }

    function test_direct_keeper_min_prorated_on_partial_fill() public {
        _useDirect(key);
        _seed(600_000e6);
        uint256 snap = vm.snapshotState();
        vm.prank(keeper); // the floor price for the full amount: pro-rated to what was spent, passes
        fr.executeBuyback(300_000e6, 300_000e6 * 19e18 / 1e6);
        vm.revertToState(snap);
        vm.prank(keeper); // 19.9 BKRN/USDG is above the average fill: refused
        vm.expectPartialRevert(BkrnFeeRouter.InsufficientOutput.selector);
        fr.executeBuyback(300_000e6, 300_000e6 * 19.9e18 / 1e6);
    }

    function test_direct_refuses_pool_already_past_the_limit() public {
        _useDirect(key);
        _seed(100e6);
        uint160 moved = _sqrtDirect(18.8e18); // 6% fewer BKRN per USDG than the reference (slippage 5%)
        pm.setPrice(key, moved);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.V4PriceBeyondLimit.selector, moved, _directLimit()));
        vm.prank(keeper);
        fr.executeBuyback(10e6, 0);
        assertEq(fr.buybackPending(), 100e6);
    }

    function test_floor_refuses_short_output() public {
        _useDirect(hookKey);
        hook.configure(0, 1000, false); // the hook takes 10% of the output: below the 5% floor
        _seed(100e6);
        vm.expectPartialRevert(BkrnFeeRouter.InsufficientOutput.selector);
        vm.prank(keeper);
        fr.executeBuyback(10e6, 0);
    }

    function test_keeper_min_above_output_refused() public {
        _useDirect(key);
        _seed(100e6);
        vm.expectPartialRevert(BkrnFeeRouter.InsufficientOutput.selector);
        vm.prank(keeper);
        fr.executeBuyback(10e6, 200e18);
    }

    // ------------------------------------------------------------------------------------------- hooks

    /// @dev A fee-taking hook (input via beforeSwap delta, output via afterSwapReturnDelta) is tolerated within
    ///      the floor; every delta still closes.
    function test_hook_fees_tolerated() public {
        _useDirect(hookKey);
        hook.configure(100, 100, false); // 1% of the input, 1% of the output
        _seed(100e6);
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(10e6, 0);
        assertEq(fr.totalBuybackUsdc(), 10e6); // the caller still pays exactly the input
        assertApproxEqRel(out, 10 * 20e18 * 99 / 100 * 99 / 100, 0.0001e18);
        assertEq(usdc.balanceOf(address(hook)), 0.1e6);
        assertGt(bkrn.balanceOf(address(hook)), 0);
        _assertNoStuckBalances();
    }

    function test_hook_revert_tolerated_funds_safe() public {
        _useDirect(hookKey);
        hook.configure(0, 0, true);
        _seed(100e6);
        uint256 pmUsdc = usdc.balanceOf(address(pm));
        vm.expectEmit(false, false, false, true, address(fr));
        emit BkrnFeeRouter.BuybackV4Failed(10e6, abi.encodeWithSelector(MockV4Hook.HookRevert.selector));
        vm.prank(keeper);
        assertEq(fr.executeBuyback(10e6, 0), 0);
        assertEq(fr.buybackPending(), 100e6);
        assertEq(usdc.balanceOf(address(pm)), pmUsdc);
        assertEq(fr.totalBuybackUsdc(), 0);
        _assertNoStuckBalances();
        hook.configure(0, 0, false); // the in-progress flags are cleared: a later buyback works
        vm.prank(keeper);
        assertGt(fr.executeBuyback(10e6, 0), 0);
    }

    function test_reentrancy_from_hook_blocked() public {
        ReenterHook evil = new ReenterHook(address(fr));
        IV4PoolManager.PoolKey memory k = _key(address(usdc), address(bkrn), 0, 200, address(evil));
        pm.initialize(k, _sqrtDirect(REF), L_DIRECT);
        _useDirect(k);
        _seed(100e6);
        vm.expectEmit(false, false, false, true, address(fr));
        emit BkrnFeeRouter.BuybackV4Failed(
            10e6, abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        vm.prank(keeper);
        assertEq(fr.executeBuyback(10e6, 0), 0);
        assertEq(fr.buybackPending(), 100e6);
    }

    /// @dev A manager reporting more owed than the input: the swapper refuses, the failure is caught.
    function test_bad_delta_refused() public {
        _useDirect(key);
        _seed(100e6);
        pm.setExtraOwed(1);
        vm.prank(keeper);
        assertEq(fr.executeBuyback(10e6, 0), 0);
        assertEq(fr.buybackPending(), 100e6);
        _assertNoStuckBalances();
    }

    // ------------------------------------------------------------------------------------------- via ETH

    /// @dev USDG -> ETH -> BKRN in one unlock: the ETH never leaves the PoolManager.
    function test_v4_eth_route_two_hops() public {
        _use(_route(V4_ETH, ethBkrnKey));
        _seed(100e6);
        uint256 pmEth = address(pm).balance;
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(10e6, 0);
        // 10 USDG -> 10 / 2400 ETH less 0.05% -> x 48,000 BKRN (fee-0 pool, hook off)
        assertApproxEqRel(out, 199.9e18, 0.0001e18);
        assertGe(out, fr.buybackFloor(10e6));
        assertEq(fr.totalBuybackUsdc(), 10e6);
        assertEq(address(pm).balance, pmEth); // no ETH moved
        assertEq(pm.currencyDelta(address(swapper), address(0)), 0);
        _assertNoStuckBalances();
    }

    function test_v4_eth_route_with_pons_like_hook_fee() public {
        _use(_route(V4_ETH, ethBkrnKey));
        hook.configure(100, 100, false); // takes 1% of the ETH in and 1% of the BKRN out
        _seed(100e6);
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(10e6, 0);
        assertApproxEqRel(out, 199.9e18 * 99 / 100 * 99 / 100, 0.0001e18);
        assertGt(address(hook).balance, 0); // the hook took its ETH inside the PoolManager
        _assertNoStuckBalances();
    }

    /// @dev The ETH -> BKRN hop stopping at its limit would leave ETH half-swapped: the whole path reverts
    ///      inside the unlock and the failure is caught.
    function test_v4_eth_route_partial_second_hop_reverts_safely() public {
        _use(_route(V4_ETH, ethBkrnKey));
        // BKRN hop sits ~0.3% above its limit (keep / (1 - s0) = 0.95 / 0.9875 ~ 0.962): 50k USDG runs through it
        pm.setPrice(ethBkrnKey, _sqrtEthBkrn(BKRN_ETH * 9650 / 10_000));
        _seed(100_000e6);
        uint256 pmEth = address(pm).balance;
        vm.recordLogs();
        vm.prank(keeper);
        assertEq(fr.executeBuyback(50_000e6, 0), 0);
        assertEq(fr.buybackPending(), 100_000e6);
        assertEq(address(pm).balance, pmEth);
        _assertNoStuckBalances();
        assertTrue(_logged(BkrnFeeRouter.BuybackV4Failed.selector));
    }

    function _logged(bytes32 topic) internal view returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(fr) && logs[i].topics[0] == topic) return true;
        }
        return false;
    }

    function test_v4_eth_route_refuses_moved_first_hop() public {
        _use(_route(V4_ETH, ethBkrnKey));
        _seed(100e6);
        pm.setPrice(ethUsdcKey, _sqrtEthUsdc(2600e18)); // ETH 8% dearer than the reference: fewer ETH per USDG
        vm.expectPartialRevert(BkrnFeeRouter.V4PriceBeyondLimit.selector);
        vm.prank(keeper);
        fr.executeBuyback(10e6, 0);
    }

    /// @dev USDG -> WETH (v3) -> unwrap (WETH9 `transfer`, 2300 gas) -> settle{value:} -> BKRN.
    function test_v3_weth_route() public {
        _use(_route(V3_WETH, ethBkrnKey));
        _seed(100e6);
        uint256 pmEth = address(pm).balance;
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(10e6, 0);
        assertApproxEqRel(out, 200e18, 0.0001e18); // mock v3 has no fee
        assertEq(usdc.balanceOf(address(v3)), 10e6);
        assertApproxEqAbs(address(pm).balance, pmEth + uint256(10e6) * 1e30 / ETH_USD, 1e6); // ETH settled
        _assertNoStuckBalances();
    }

    function test_v3_weth_route_v3_failure_caught() public {
        _use(_route(V3_WETH, ethBkrnKey));
        _seed(100e6);
        vm.prank(admin);
        v3.withdraw(address(weth), admin, 1000 ether); // v3 out of WETH: the hop reverts inside the unlock
        vm.prank(keeper);
        assertEq(fr.executeBuyback(10e6, 0), 0);
        assertEq(fr.buybackPending(), 100e6);
        _assertNoStuckBalances();
    }

    // ------------------------------------------------------------------------------------------- native ETH

    function test_eth_refused_outside_a_swap() public {
        vm.deal(address(this), 2 ether);
        vm.expectRevert(abi.encodeWithSelector(BkrnV4Swapper.UnexpectedEth.selector, address(this)));
        payable(address(swapper)).transfer(1 ether);
        (bool ok,) = address(fr).call{value: 1 ether}("");
        assertFalse(ok); // the fee router has no receive at all
    }

    /// @dev Forced ETH (selfdestruct) does not block buybacks and can be swept by governance only.
    function test_forced_eth_swept() public {
        vm.deal(address(swapper), 1 ether);
        _use(_route(V3_WETH, ethBkrnKey));
        _seed(100e6);
        vm.prank(keeper);
        assertGt(fr.executeBuyback(10e6, 0), 0);
        assertEq(address(swapper).balance, 1 ether); // the swap left exactly what was there
        vm.expectRevert(abi.encodeWithSelector(BkrnV4Swapper.NotAdmin.selector, keeper));
        vm.prank(keeper);
        swapper.sweepNative(payable(keeper));
        address treasury = makeAddr("treasury");
        vm.expectEmit(true, false, false, true, address(swapper));
        emit BkrnV4Swapper.NativeSwept(treasury, 1 ether);
        vm.prank(admin);
        swapper.sweepNative(payable(treasury));
        assertEq(treasury.balance, 1 ether);
        assertEq(address(swapper).balance, 0);
    }

    // ------------------------------------------------------------------------------------------- no-op / auth

    function test_noop_before_graduation() public {
        vm.prank(admin);
        fr.setBuybackVenue(1); // no route yet
        assertFalse(fr.v4BuybackReady());
        _seed(100e6);
        vm.expectEmit(false, false, false, true, address(fr));
        emit BkrnFeeRouter.BuybackDeferred(10e6);
        vm.prank(keeper);
        assertEq(fr.executeBuyback(10e6, 0), 0);
        assertEq(fr.buybackPending(), 100e6);
        // graduation: the pool appears, governance sets the route, buybacks run
        vm.startPrank(admin);
        fr.setV4HookAllowed(address(hook), true);
        fr.setV4Route(_route(V4_ETH, ethBkrnKey));
        vm.stopPrank();
        assertTrue(fr.v4BuybackReady());
        vm.prank(keeper);
        assertGt(fr.executeBuyback(10e6, 0), 0);
    }

    function test_still_checks_keeper_cap_and_pending() public {
        _useDirect(key);
        _seed(100e6);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotKeeper.selector, alice));
        vm.prank(alice);
        fr.executeBuyback(1e6, 0);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.InsufficientPending.selector, 100e6, 100e6 + 1));
        vm.prank(keeper);
        fr.executeBuyback(100e6 + 1, 0);
        vm.prank(admin);
        fr.setBuybackParams(0, REF, SLIP, 5e6);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BuybackTooLarge.selector, 5e6 + 1, 5e6));
        vm.prank(keeper);
        fr.executeBuyback(5e6 + 1, 0);
    }

    function test_swapper_auth() public {
        _useDirect(key);
        vm.expectRevert(abi.encodeWithSelector(BkrnV4Swapper.NotPoolManager.selector, alice));
        vm.prank(alice);
        swapper.unlockCallback("");
        // the real manager, but outside a swap of this swapper
        vm.expectRevert(abi.encodeWithSelector(BkrnV4Swapper.NotPoolManager.selector, address(pm)));
        vm.prank(address(pm));
        swapper.unlockCallback("");
        IBkrnV4Swapper.V4Job memory job;
        vm.expectRevert(abi.encodeWithSelector(BkrnV4Swapper.NotFeeRouter.selector, alice));
        vm.prank(alice);
        swapper.swap(address(pm), job);
        assertEq(swapper.feeRouter(), address(fr));
    }

    function test_attested_reference() public {
        CoreMockOracle o = new CoreMockOracle();
        o.set("BKRN", 0.05e18, false, false); // $0.05 = 20 BKRN per USDG
        vm.startPrank(admin);
        config.setAddress("oracle", address(o));
        fr.setBkrnPriceId("BKRN");
        vm.stopPrank();
        _useDirect(key);
        _seed(100e6);
        vm.prank(keeper);
        assertGt(fr.executeBuyback(10e6, 0), 190e18);
        o.set("BKRN", 0.045e18, false, false); // the oracle says 10% cheaper than the pool: past the limit
        vm.expectPartialRevert(BkrnFeeRouter.V4PriceBeyondLimit.selector);
        vm.prank(keeper);
        fr.executeBuyback(10e6, 0);
    }

    function test_fixed_eth_reference() public {
        vm.startPrank(admin);
        fr.setReferenceSource(3);
        assertEq(fr.referenceBkrnPerUsdc(), 20e18); // 48,000 BKRN/ETH / 2,400 USDG/ETH
        fr.setEthReference(3000e18, 48_000e18); // ETH up: BKRN worth more USDG
        assertEq(fr.referenceBkrnPerUsdc(), 16e18);
        vm.expectRevert(BkrnFeeRouter.BadBuybackParams.selector);
        fr.setEthReference(3000e18, 0); // REF_FIXED_ETH still selected
        vm.expectRevert(BkrnFeeRouter.BadBuybackParams.selector);
        fr.setEthReference(0, 48_000e18);
        fr.setReferenceSource(0);
        fr.setEthReference(3000e18, 0);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BadReferenceSource.selector, uint8(3)));
        fr.setReferenceSource(3);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------- governance

    function test_setters_are_governance_only() public {
        vm.startPrank(keeper);
        bytes memory na = abi.encodeWithSelector(BkrnFeeRouter.NotAdmin.selector, keeper);
        vm.expectRevert(na);
        fr.setBuybackVenue(1);
        vm.expectRevert(na);
        fr.setV4PoolManager(address(pm));
        vm.expectRevert(na);
        fr.setV4HookAllowed(address(hook), true);
        vm.expectRevert(na);
        fr.setV4Route(_route(DIRECT, key));
        vm.expectRevert(na);
        fr.setEthReference(1, 1);
        vm.stopPrank();
    }

    function test_setV4Route_direct_validation() public {
        vm.startPrank(admin);
        IBkrnV4Swapper.V4Route memory r = _route(DIRECT, key);
        (r.bkrnPool.currency0, r.bkrnPool.currency1) = (r.bkrnPool.currency1, r.bkrnPool.currency0); // unsorted
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);
        r = _route(DIRECT, _key(address(usdc), address(new MockERC20("O", "O", 18)), 3000, 60, address(0)));
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector); // not {USDG, BKRN}
        fr.setV4Route(r);
        r = _route(DIRECT, key);
        r.bkrnPool.fee = 500; // not initialized
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector); // hook not allowed
        fr.setV4Route(_route(DIRECT, hookKey));
        r = _route(DIRECT, key);
        r.ethPool = ethUsdcKey; // stray hop
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);
        r = _route(DIRECT, key);
        r.kind = 3;
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);

        vm.expectEmit(true, false, false, true, address(fr));
        emit BkrnFeeRouter.V4RouteSet(DIRECT, UniswapV4Lib.poolId(key), bytes32(0), 0, address(0));
        fr.setV4Route(_route(DIRECT, key));
        vm.stopPrank();
        IBkrnV4Swapper.V4Route memory got = fr.v4Route();
        assertEq(keccak256(abi.encode(got)), keccak256(abi.encode(_route(DIRECT, key))));
    }

    function test_setV4Route_eth_validation() public {
        vm.startPrank(admin);
        fr.setV4HookAllowed(address(hook), true);
        IBkrnV4Swapper.V4Route memory r = _route(V4_ETH, key); // BKRN pool must be the ETH one
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);
        r = _route(V4_ETH, ethBkrnKey);
        r.ethPool = _emptyKey(); // missing first hop
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);
        r = _route(V4_ETH, ethBkrnKey);
        r.v3Fee = 100; // v3 fields on a v4 route
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);
        r = _route(V3_WETH, ethBkrnKey);
        r.weth = makeAddr("noCode");
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);
        r = _route(V3_WETH, ethBkrnKey);
        r.v3Fee = 0;
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);
        r = _route(V3_WETH, ethBkrnKey);
        r.ethPool = ethUsdcKey; // stray v4 hop
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4Route(r);
        fr.setV4Route(_route(V4_ETH, ethBkrnKey));
        fr.setV4Route(_route(V3_WETH, ethBkrnKey));
        vm.stopPrank();
    }

    function test_setV4Route_eth_needs_eth_reference_and_router() public {
        BkrnFeeRouter fresh = new BkrnFeeRouter(address(config));
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotConfigured.selector, bytes32("v4PoolManager")));
        fresh.setV4Route(_route(DIRECT, key));
        fresh.setV4PoolManager(address(pm));
        fresh.setV4HookAllowed(address(hook), true);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotConfigured.selector, bytes32("ethReference")));
        fresh.setV4Route(_route(V4_ETH, ethBkrnKey));
        fresh.setEthReference(ETH_USD, 0);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotConfigured.selector, bytes32("buybackRouter")));
        fresh.setV4Route(_route(V3_WETH, ethBkrnKey));
        vm.stopPrank();
    }

    function test_setV4HookAllowed_and_disallow_clears_route() public {
        vm.startPrank(admin);
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4HookAllowed(address(0), true);
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4HookAllowed(makeAddr("eoa"), true); // no code
        vm.expectEmit(true, false, false, true, address(fr));
        emit BkrnFeeRouter.V4HookAllowedSet(address(hook), true);
        fr.setV4HookAllowed(address(hook), true);
        fr.setV4Route(_route(V4_ETH, ethBkrnKey));
        vm.expectEmit(false, false, false, false, address(fr));
        emit BkrnFeeRouter.V4RouteCleared();
        fr.setV4HookAllowed(address(hook), false);
        vm.stopPrank();
        assertEq(fr.v4Route().bkrnPool.currency1, address(0));
    }

    function test_setV4PoolManager_needs_code_and_clears_route() public {
        vm.startPrank(admin);
        vm.expectRevert(BkrnFeeRouter.BadV4Pool.selector);
        fr.setV4PoolManager(makeAddr("eoa"));
        fr.setV4Route(_route(DIRECT, key));
        MockV4PoolManager pm2 = new MockV4PoolManager();
        fr.setV4PoolManager(address(pm2));
        vm.stopPrank();
        assertEq(fr.v4PoolManager(), address(pm2));
        assertEq(fr.v4Route().bkrnPool.currency1, address(0));
    }

    /// @dev UNIV3 stays the default; the switch moves buybacks between the v3 router and the v4 route.
    function test_venue_switch() public {
        assertEq(fr.buybackVenue(), 0);
        bkrn.mint(address(v3), 1_000_000e18);
        vm.startPrank(admin);
        v3.setPriceBoth(address(usdc), address(bkrn), REF);
        fr.setBuybackParams(3000, REF, SLIP, 1_000_000e6);
        fr.setV4Route(_route(DIRECT, key));
        vm.stopPrank();
        _seed(100e6);
        uint256 pmUsdc = usdc.balanceOf(address(pm));
        vm.prank(keeper);
        fr.executeBuyback(10e6, 0); // v3
        assertEq(usdc.balanceOf(address(v3)), 10e6);
        assertEq(usdc.balanceOf(address(pm)), pmUsdc);

        vm.expectEmit(false, false, false, true, address(fr));
        emit BkrnFeeRouter.BuybackVenueSet(1);
        vm.prank(admin);
        fr.setBuybackVenue(1);
        vm.prank(keeper);
        fr.executeBuyback(10e6, 0); // v4
        assertEq(usdc.balanceOf(address(v3)), 10e6);
        assertEq(usdc.balanceOf(address(pm)), pmUsdc + 10e6);

        vm.startPrank(admin);
        fr.setBuybackVenue(0);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BadVenue.selector, uint8(2)));
        fr.setBuybackVenue(2);
        vm.stopPrank();
        vm.prank(keeper);
        fr.executeBuyback(10e6, 0); // v3 again
        assertEq(usdc.balanceOf(address(v3)), 20e6);
    }

    /// @dev v4 has no TWAP oracle: REF_TWAP and VENUE_UNIV4 refuse each other.
    function test_twap_and_v4_are_exclusive() public {
        UniV3MockFactory f = new UniV3MockFactory();
        UniV3MockPool pool = f.createPool(address(usdc), address(bkrn), 3000, 0);
        vm.startPrank(admin);
        fr.setTwapParams(address(pool), 30 minutes, 200);
        fr.setBuybackVenue(1);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BadReferenceSource.selector, uint8(1)));
        fr.setReferenceSource(1);
        fr.setBuybackVenue(0);
        fr.setReferenceSource(1);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BadVenue.selector, uint8(1)));
        fr.setBuybackVenue(1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------- properties

    /// @dev Any size, the pool anywhere from 3% worse to 10% better than the reference: the buyback lands, pays at
    ///      least the floor on what it spent, and leaves no balance behind.
    function testFuzz_direct_conservation(uint256 amountIn, uint256 offsetBps) public {
        amountIn = bound(amountIn, 1e6, 400_000e6);
        offsetBps = bound(offsetBps, 9700, 11_000);
        pm.setPrice(key, _sqrtDirect(REF * offsetBps / 10_000));
        _useDirect(key);
        _seed(amountIn);
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(amountIn, 0);
        uint256 spent = fr.totalBuybackUsdc();
        assertLe(spent, amountIn);
        assertEq(fr.buybackPending(), amountIn - spent);
        assertGe(out, spent * REF * (10_000 - SLIP) / 10_000 / 1e6);
        assertEq(bkrn.balanceOf(address(staking)), 1e18 + out);
        _assertNoStuckBalances();
    }

    /// @dev Via ETH, any size up to the ETH pool's depth: either it lands above the floor or it fails safe.
    function testFuzz_v4_eth_conservation(uint256 amountIn, uint256 kindSeed) public {
        amountIn = bound(amountIn, 1e6, 200_000e6);
        uint8 kind = kindSeed % 2 == 0 ? V4_ETH : V3_WETH;
        _use(_route(kind, ethBkrnKey));
        _seed(amountIn);
        vm.prank(keeper);
        uint256 out = fr.executeBuyback(amountIn, 0);
        uint256 spent = fr.totalBuybackUsdc();
        assertEq(fr.buybackPending(), amountIn - spent);
        if (out > 0) assertGe(out, spent * REF * (10_000 - SLIP) / 10_000 / 1e6);
        _assertNoStuckBalances();
    }
}

contract BkrnFeeRouterV4UsdcCurrency0Test is BkrnFeeRouterV4Base {
    function _usdcIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract BkrnFeeRouterV4UsdcCurrency1Test is BkrnFeeRouterV4Base {
    function _usdcIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
