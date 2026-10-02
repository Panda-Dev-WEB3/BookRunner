// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {EngineBase} from "./utils/EngineBase.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";

/// @notice Gas evidence for LOW_GAS.md §1 (trade with vs without priceData):
///             scripts/forge.sh test --isolate --match-contract PullOracleGasTest -vv --gas-report
///         The logged figures are the execution gas of the call frame (no 21k intrinsic, no calldata gas).
///         Real receipts (one tx per block on a private anvil, ca27662 + this change): pushMany(1 price)
///         58,794; legacy trade 117,826 (push + trade 176,620); trade carrying a new price 145,566; trade
///         carrying an already-stored bundle 126,415; trade with empty priceData 118,441; update alone 55,505.
contract PullOracleGasTest is EngineBase {
    uint128 internal constant MAX_NET = 75_000e6;
    address internal adA = makeAddr("adapterA");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    uint256 internal mA;

    function setUp() public {
        _deployCore();
        cfg.grantRole(cfg.KEEPER_ROLE(), keeper);
        mA = _createMarket(adA, _defaultCfg(PID_A, MAX_NET));
        _fundPool(adA, mA, 100_000e6, 25_000e6);
        _setQuote(adA, mA, 10, 0, MAX_NET);
        _price(PID_A, PX);
        _deposit(alice, mA, 10_000e6);
        _deposit(bob, mA, 10_000e6);
        _trade(bob, mA, 5e18); // a live market: aggregates and the trader slot are non-zero
        _trade(alice, mA, 1e18);
        vm.warp(block.timestamp + 10);
    }

    function _bundle(uint64 at) internal view returns (IAttestedOracle.PriceUpdate[] memory us, bytes[] memory sigs) {
        us = new IAttestedOracle.PriceUpdate[](1);
        sigs = new bytes[](1);
        us[0] = _update(PID_A, 100.1e18, at, false, 3);
        sigs[0] = _sign(SIGNER_PK, us[0]);
    }

    /// @dev vm.lastFrameGas() via a raw staticcall (gasLimit, gasTotalUsed, ...): the vendored forge-std and
    ///      the Foundry image disagree on the Gas struct width, so only the leading words are decoded.
    function _gas() internal view returns (uint256 used) {
        (bool ok, bytes memory ret) = address(vm).staticcall(abi.encodeWithSignature("lastFrameGas()"));
        require(ok, "lastFrameGas");
        (, used) = abi.decode(ret, (uint64, uint64));
    }

    /// @dev Heartbeat model (before): a relayer push tx for the price, then the trader's legacy trade.
    function test_gas_heartbeat_pushThenLegacyTrade() public {
        (IAttestedOracle.PriceUpdate[] memory us, bytes[] memory sigs) = _bundle(uint64(block.timestamp));
        vm.prank(keeper);
        oracle.pushMany(us, sigs);
        uint256 push = _gas();
        vm.prank(alice);
        engine.trade(mA, 1e18, type(uint256).max);
        uint256 tradeGas = _gas();
        console2.log("pushMany(1 price)                 ", push);
        console2.log("trade(m,size,px) legacy           ", tradeGas);
        console2.log("push + legacy trade               ", push + tradeGas);
    }

    /// @dev Pull model (after), the price is new: the trade verifies (ecrecover) and stores it.
    function test_gas_pull_tradeWithNewPrice() public {
        (IAttestedOracle.PriceUpdate[] memory us, bytes[] memory sigs) = _bundle(uint64(block.timestamp));
        bytes memory pd = abi.encode(us, sigs);
        vm.prank(alice);
        engine.trade(mA, 1e18, type(uint256).max, pd);
        console2.log("trade(...,priceData) new price    ", _gas());
        console2.log("priceData bytes                   ", pd.length);
    }

    /// @dev Pull model, the bundle already landed this block (another tx carried it): skipped, no ecrecover.
    function test_gas_pull_tradeWithAlreadyStoredPrice() public {
        (IAttestedOracle.PriceUpdate[] memory us, bytes[] memory sigs) = _bundle(uint64(block.timestamp));
        bytes memory pd = abi.encode(us, sigs);
        oracle.update(pd);
        vm.prank(alice);
        engine.trade(mA, 1e18, type(uint256).max, pd);
        console2.log("trade(...,priceData) skipped price", _gas());
    }

    /// @dev Overhead of the overload itself with an empty bundle.
    function test_gas_pull_tradeEmptyPriceData() public {
        _price(PID_A, 100.1e18);
        vm.prank(alice);
        engine.trade(mA, 1e18, type(uint256).max, "");
        console2.log("trade(...,\"\") stored price fresh  ", _gas());
    }

    /// @dev Standalone permissionless update (multicall / pre-tx path).
    function test_gas_pull_updateAlone() public {
        (IAttestedOracle.PriceUpdate[] memory us, bytes[] memory sigs) = _bundle(uint64(block.timestamp));
        oracle.update(abi.encode(us, sigs));
        console2.log("oracle.update(1 price)            ", _gas());
    }
}
