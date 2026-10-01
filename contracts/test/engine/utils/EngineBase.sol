// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {AttestedOracle} from "../../../src/AttestedOracle.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {IAttestedOracle} from "../../../src/interfaces/IAttestedOracle.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";
import {EngineMockConfig, EngineMockFactory} from "./EngineMocks.sol";

/// @notice Shared fixture for the engine cluster: config, USDC, oracle (with a devnet signer), factory, engine.
abstract contract EngineBase is Test {
    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant T0 = 1_700_000_000;
    bytes32 internal constant PID_A = bytes32("RHX5");
    bytes32 internal constant PID_B = bytes32("NVDA");
    uint256 internal constant PX = 100e18; // $100 per unit
    uint256 internal constant UNIT = 1e18;
    uint256 internal constant USD = 1e6;

    address internal timelock = makeAddr("timelock");
    address internal signer;

    EngineMockConfig internal cfg;
    MockERC20 internal usdc;
    AttestedOracle internal oracle;
    EngineMockFactory internal factory;
    PoolEngine internal engine;

    function _deployCore() internal {
        vm.warp(T0);
        cfg = new EngineMockConfig(timelock);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cfg.setUsdc(address(usdc));
        signer = vm.addr(SIGNER_PK);
        oracle = new AttestedOracle(address(cfg), signer, bytes32("devnet-attestation"));
        cfg.setOracle(address(oracle));
        factory = new EngineMockFactory();
        cfg.setFactory(address(factory));
        engine = new PoolEngine(address(cfg));
        cfg.setPoolEngine(address(engine));
    }

    // ---------------------------------------------------------------- oracle helpers

    function _update(bytes32 pid, uint256 price, uint64 publishedAt, bool held, uint32 sources)
        internal
        pure
        returns (IAttestedOracle.PriceUpdate memory u)
    {
        u = IAttestedOracle.PriceUpdate({
            underlying: pid,
            priceWad: price,
            publishedAt: publishedAt,
            held: held,
            sourceCount: sources,
            sourcesHash: keccak256(abi.encode(pid, price, publishedAt))
        });
    }

    function _sign(uint256 pk, IAttestedOracle.PriceUpdate memory u) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, oracle.hashPrice(u));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Pushes a fresh signed price (warps 1s forward if needed so publishedAt is strictly newer).
    function _push(bytes32 pid, uint256 price, bool held) internal {
        uint64 stored = oracle.latest(pid).publishedAt;
        if (stored >= block.timestamp) vm.warp(uint256(stored) + 1);
        IAttestedOracle.PriceUpdate memory u = _update(pid, price, uint64(block.timestamp), held, 3);
        oracle.push(u, _sign(SIGNER_PK, u));
    }

    function _price(bytes32 pid, uint256 price) internal {
        _push(pid, price, false);
    }

    // ---------------------------------------------------------------- engine helpers

    function _defaultCfg(bytes32 pid, uint128 maxNet)
        internal
        pure
        returns (IPoolEngine.MarketConfig memory)
    {
        return IPoolEngine.MarketConfig({
            underlying: pid,
            symbol: bytes32("RHX5-PERP"),
            takerFeeBps: 10,
            makerFeeBps: 0,
            initialMarginBps: 1000,
            maintenanceMarginBps: 500,
            liquidationFeeBps: 50,
            fundingVelocityBps: 100,
            maxNetExposureUsd: maxNet
        });
    }

    function _createMarket(address adapter, IPoolEngine.MarketConfig memory c) internal returns (uint256 id) {
        factory.setComponent(adapter, true);
        vm.prank(adapter);
        id = engine.createMarket(c);
    }

    function _fundPool(address adapter, uint256 id, uint256 liquidity, uint256 insurance) internal {
        usdc.mint(adapter, liquidity + insurance);
        vm.startPrank(adapter);
        usdc.approve(address(engine), liquidity + insurance);
        if (liquidity != 0) engine.depositLiquidity(id, liquidity);
        if (insurance != 0) engine.depositInsurance(id, insurance);
        vm.stopPrank();
    }

    function _deposit(address trader, uint256 id, uint256 amount) internal {
        usdc.mint(trader, amount);
        vm.startPrank(trader);
        usdc.approve(address(engine), amount);
        engine.depositMargin(id, amount);
        vm.stopPrank();
    }

    function _trade(address trader, uint256 id, int256 size) internal returns (uint256 fill, uint256 fee) {
        uint256 acceptable = size > 0 ? type(uint256).max : 0;
        vm.prank(trader);
        (fill, fee) = engine.trade(id, size, acceptable);
    }

    function _setQuote(address adapter, uint256 id, uint16 spread, int16 skew, uint128 maxNet) internal {
        vm.prank(adapter);
        engine.setQuote(id, spread, skew, maxNet);
    }

    /// @dev Sum of the per-market ledgers the engine must hold in USDC.
    function _ledger(uint256 id) internal view returns (uint256) {
        IPoolEngine.MarketState memory s = engine.state(id);
        return s.poolCashUsd + s.insuranceUsd + s.feesAccruedUsd + engine.totalMarginUsd(id);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
