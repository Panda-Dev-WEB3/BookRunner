// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {OrderlyAdapter} from "../src/OrderlyAdapter.sol";
import {BookFactory} from "../src/BookFactory.sol";

/// @notice Deploys a new OrderlyAdapter implementation, registers it in the factory for future books and
///         UUPS-upgrades every live Orderly book's adapter proxy (venue 0 in deployments/<chainId>.json).
///         Caller = config.timelock() (the deployer on testnet). Same constructor hashes as Deploy.s.sol.
///   PRIVATE_KEY=... (or DEV_MNEMONIC) DEPLOY_OUT=deployments/46630.json \
///     bash scripts/forge.sh script script/UpgradeOrderlyAdapters.s.sol:UpgradeOrderlyAdapters --rpc-url $RPC --broadcast
contract UpgradeOrderlyAdapters is Script {
    using stdJson for string;

    bytes32 internal constant BROKER_HASH = keccak256("bookrunner"); // keep in lockstep with Deploy.s.sol
    bytes32 internal constant TOKEN_HASH = keccak256("USDC"); // keep in lockstep with Deploy.s.sol

    function run() external {
        string memory path = vm.envOr("DEPLOY_OUT", string("deployments/46630.json"));
        string memory json = vm.readFile(path);
        uint256 key = vm.envOr("PRIVATE_KEY", uint256(0));
        if (key == 0) key = vm.deriveKey(vm.envString("DEV_MNEMONIC"), 0);
        BookFactory factory = BookFactory(json.readAddress(".contracts.factory"));

        vm.startBroadcast(key);
        OrderlyAdapter impl = new OrderlyAdapter(BROKER_HASH, TOKEN_HASH);
        bytes32[] memory kinds = new bytes32[](1);
        address[] memory impls = new address[](1);
        (kinds[0], impls[0]) = (factory.ORDERLY_ADAPTER(), address(impl));
        factory.setImplementations(kinds, impls);
        for (uint256 i = 0; ; i++) {
            string memory b = string.concat(".books[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, b)) break;
            if (json.readUint(string.concat(b, ".venue")) != 0) continue; // Orderly books only
            address adapter = json.readAddress(string.concat(b, ".components.adapter"));
            OrderlyAdapter(payable(adapter)).upgradeToAndCall(address(impl), "");
            console2.log("upgraded adapter", adapter);
        }
        vm.stopBroadcast();
        console2.log("new OrderlyAdapter implementation", address(impl));
    }
}
