// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {BkrnStaking} from "../../src/BkrnStaking.sol";
import {BkrnFeeRouter} from "../../src/BkrnFeeRouter.sol";
import {IBkrnV4Swapper} from "../../src/interfaces/IBkrnV4Swapper.sol";
import {IV4PoolManager} from "../../src/interfaces/external/IUniswapV4.sol";
import {UniswapV4Lib} from "../../src/libraries/UniswapV4Lib.sol";

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);

    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

/// @notice Smoke test against the deployed Uniswap v4 PoolManager on Robinhood Chain (4663), forked read-only (latest
///         block, or FORK_BLOCK): the storage / transient layouts UniswapV4Lib relies on, and a real buyback on each route
///         through graduated Pons pools (PonsV2MemeHook, fee 0, tickSpacing 200) standing in for BKRN. Skipped
///         without ETH_RPC_URL (e.g. ETH_RPC_URL=https://rpc.mainnet.chain.robinhood.com).
contract BkrnFeeRouterV4ForkTest is Test {
    address internal constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant SWAP_ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    // graduated Pons tokens: token/USDG (token is currency0), USDG/token (USDG is currency0), ETH/token
    address internal constant PONS_USDG_LOW = 0x04f0eE2197bC83aA3fa423A7EB6a697D1AFf0e04;
    address internal constant PONS_USDG_HIGH = 0xaa5265e27c7de70063544cA3a7BbeFcCdA3015A8;
    address internal constant PONS_ETH = 0xE75F02879217df5d6D7dC7CD842f31aBa6c3dc9f;
    bytes32 internal constant ID_USDG_LOW = 0x478e9c778920bd4b961719de6f377f2551d7ae14b604e323185f6933f39da17e;
    bytes32 internal constant ID_ETH_USDG = 0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982;
    bytes32 internal constant ID_ETH_PONS = 0xc4dfac457a5b578e0613fa860363113d419a98a616733ce5cedd4ecc2e0efad1;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    BookrunnerConfig internal config;
    BkrnFeeRouter internal fr;
    BkrnStaking internal staking;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        // the public RPC keeps recent state only: latest by default, FORK_BLOCK to pin one (archive RPC)
        uint256 blockNo = vm.envOr("FORK_BLOCK", uint256(0));
        if (blockNo == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blockNo);
    }

    function _pons(address c0, address c1) internal pure returns (IV4PoolManager.PoolKey memory) {
        return IV4PoolManager.PoolKey(c0, c1, 0, 200, PONS_HOOK);
    }

    function _ethUsdg() internal pure returns (IV4PoolManager.PoolKey memory) {
        return IV4PoolManager.PoolKey(address(0), USDG, 500, 10, address(0));
    }

    /// @dev Whole `out` per whole `in` (WAD) at the pool's spot price (both currencies 18 dp unless USDG).
    function _spot(IV4PoolManager.PoolKey memory key, address tokenIn) internal view returns (uint256) {
        uint256 sp = UniswapV4Lib.sqrtPriceX96(PM, key);
        uint256 decIn = tokenIn == USDG ? 6 : 18;
        uint256 decOut = (tokenIn == key.currency0 ? key.currency1 : key.currency0) == USDG ? 6 : 18;
        // raw token1 per token0 = sp^2 / 2^192, scaled by 1e36 (a raw ratio can be ~1e-18)
        uint256 raw1per0 = Math.mulDiv(Math.mulDiv(sp, sp, 1 << 96), 1e36, 1 << 96);
        uint256 rawOutPerInWad = tokenIn == key.currency0 ? raw1per0 / 1e18 : Math.mulDiv(1e36, 1e18, raw1per0);
        return Math.mulDiv(rawOutPerInWad, 10 ** decIn, 10 ** decOut);
    }

    function _deploy(address bkrnToken) internal {
        config = new BookrunnerConfig(admin);
        vm.startPrank(admin);
        config.setAddress("usdc", USDG);
        config.setAddress("bkrn", bkrnToken);
        vm.stopPrank();
        staking = new BkrnStaking(address(config));
        fr = new BkrnFeeRouter(address(config));
        vm.startPrank(admin);
        config.setAddress("staking", address(staking));
        config.setAddress("feeRouter", address(fr));
        config.grantRole(config.KEEPER_ROLE(), keeper);
        fr.setV4PoolManager(PM);
        fr.setV4HookAllowed(PONS_HOOK, true);
        fr.setBuybackRouter(SWAP_ROUTER02);
        vm.stopPrank();
        vm.prank(PM); // the PoolManager holds plenty of USDG
        IERC20(USDG).transfer(address(fr), 1000e6);
        fr.notifyMigration(1000e6);
    }

    function _buy(uint256 amountIn) internal returns (uint256 out) {
        vm.recordLogs();
        vm.prank(keeper);
        out = fr.executeBuyback(amountIn, 0);
        assertGt(out, 0, "buyback did not swap (deferred or failed: see logs)");
        assertEq(IERC20(USDG).balanceOf(address(fr)), fr.buybackPending());
        assertEq(IERC20(fr.bkrn()).balanceOf(address(fr)), 0);
        assertEq(IERC20(USDG).balanceOf(address(fr.v4Swapper())), 0);
        assertEq(address(fr.v4Swapper()).balance, 0);
        assertEq(IERC20(WETH).balanceOf(address(fr.v4Swapper())), 0);
        assertEq(IERC20(fr.bkrn()).balanceOf(address(staking)), out);
    }

    // ------------------------------------------------------------------------------------------- layouts

    function test_fork_layouts_match_v4_core() public view {
        IV4PoolManager.PoolKey memory k = _pons(PONS_USDG_LOW, USDG);
        assertEq(UniswapV4Lib.poolId(k), ID_USDG_LOW);
        assertEq(UniswapV4Lib.poolId(_ethUsdg()), ID_ETH_USDG);
        assertEq(UniswapV4Lib.poolId(_pons(address(0), PONS_ETH)), ID_ETH_PONS);
        (uint160 sp,,,) = IStateView(STATE_VIEW).getSlot0(ID_USDG_LOW);
        assertGt(sp, 0);
        assertEq(UniswapV4Lib.sqrtPriceX96(PM, k), sp);
        (uint160 sp2,,,) = IStateView(STATE_VIEW).getSlot0(ID_ETH_USDG);
        assertEq(UniswapV4Lib.sqrtPriceX96(PM, _ethUsdg()), sp2);
        // outside an unlock every delta and the non-zero delta count read 0 through exttload
        bytes32 countSlot = bytes32(uint256(keccak256("NonzeroDeltaCount")) - 1);
        assertEq(IV4PoolManager(PM).exttload(countSlot), bytes32(0));
        assertEq(IV4PoolManager(PM).exttload(UniswapV4Lib.deltaSlot(address(this), USDG)), bytes32(0));
        console2.log("ETH/USDG v4 liquidity", IStateView(STATE_VIEW).getLiquidity(ID_ETH_USDG));
        console2.log("ETH/Pons liquidity", IStateView(STATE_VIEW).getLiquidity(ID_ETH_PONS));
    }

    // ------------------------------------------------------------------------------------------- routes

    function test_fork_direct_token_is_currency0() public {
        _direct(PONS_USDG_LOW, _pons(PONS_USDG_LOW, USDG));
    }

    function test_fork_direct_usdg_is_currency0() public {
        _direct(PONS_USDG_HIGH, _pons(USDG, PONS_USDG_HIGH));
    }

    function _direct(address token, IV4PoolManager.PoolKey memory k) internal {
        _deploy(token);
        uint256 spot = _spot(k, USDG);
        IBkrnV4Swapper.V4Route memory r;
        r.bkrnPool = k;
        vm.startPrank(admin);
        // the pool 0.5% better than the reference; 10% slippage absorbs the hook's fee
        fr.setBuybackParams(0, spot * 995 / 1000, 1000, 1_000_000e6);
        fr.setV4Route(r);
        fr.setBuybackVenue(1);
        vm.stopPrank();
        uint256 out = _buy(10e6);
        console2.log("direct: BKRN out for 10 USDG", out, "spot x10", spot * 10);
        assertGe(out, fr.buybackFloor(10e6));
    }

    function test_fork_v4_eth_route() public {
        _deploy(PONS_ETH);
        uint256 usdgPerEth = _spot(_ethUsdg(), address(0));
        uint256 tokPerEth = _spot(_pons(address(0), PONS_ETH), address(0));
        _viaEth(1, usdgPerEth, tokPerEth);
    }

    function test_fork_v3_weth_route() public {
        _deploy(PONS_ETH);
        uint256 usdgPerEth = _spot(_ethUsdg(), address(0)); // within a few bps of the deep v3 USDG/WETH 0.01% pool
        uint256 tokPerEth = _spot(_pons(address(0), PONS_ETH), address(0));
        _viaEth(2, usdgPerEth, tokPerEth);
    }

    function _viaEth(uint8 kind, uint256 usdgPerEth, uint256 tokPerEth) internal {
        IBkrnV4Swapper.V4Route memory r;
        r.kind = kind;
        r.bkrnPool = _pons(address(0), PONS_ETH);
        if (kind == 1) r.ethPool = _ethUsdg();
        else (r.v3Fee, r.weth) = (100, WETH);
        vm.startPrank(admin);
        fr.setBuybackParams(0, 1, 1000, 1_000_000e6);
        fr.setEthReference(usdgPerEth * 1005 / 1000, tokPerEth * 995 / 1000); // both pools a little better
        fr.setReferenceSource(3); // REF_FIXED_ETH
        fr.setV4Route(r);
        fr.setBuybackVenue(1);
        vm.stopPrank();
        uint256 ethBefore = PM.balance;
        uint256 out = _buy(10e6);
        console2.log("via ETH: route", kind, "BKRN out for 10 USDG", out);
        console2.log("  reference BKRN/USDG", fr.referenceBkrnPerUsdc());
        assertGe(out, fr.buybackFloor(10e6));
        if (kind == 1) assertEq(PM.balance, ethBefore); // ETH never left the PoolManager
        else assertGt(PM.balance, ethBefore); // the unwrapped ETH was settled with value
    }
}
