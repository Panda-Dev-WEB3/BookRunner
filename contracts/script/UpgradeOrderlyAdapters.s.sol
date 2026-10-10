// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {OrderlyAdapter} from "../src/OrderlyAdapter.sol";
import {BookFactory} from "../src/BookFactory.sol";

/// @notice Deploys a new OrderlyAdapter implementation, registers it in the factory for future books and
///         UUPS-upgrades every live Orderly book's adapter proxy (venue 0 in deployments/<chainId>.json).
///         Caller = config.timelock() (the deployer on testnet). Same constructor hashes as Deploy.s.sol.
///
///         v3 (real Orderly accounts, docs/VERIFY.md O6): the upgrade is storage-append-only (`ifAccount` packs
///         into the slot of `lastSweptPeriod`, whose upper bytes were unused), so an upgraded proxy keeps its
///         devnet account ids (`ifAccount() == 0`) and every MockOrderlyVault balance stays where it is. Books
///         created after the upgrade get an OrderlyIFAccount at initialize. With MIGRATE_ORDERLY_ACCOUNTS=true the
///         script also calls `migrateToOrderlyAccounts()` on upgraded adapters that hold nothing venue-side (the
///         others are skipped and logged); restart ops-venue and mock-orderly afterwards (they cache account ids).
///   PRIVATE_KEY=... (or DEV_MNEMONIC) DEPLOY_OUT=deployments/46630.json \
///     bash scripts/forge.sh script script/UpgradeOrderlyAdapters.s.sol:UpgradeOrderlyAdapters --rpc-url $RPC --broadcast
contract UpgradeOrderlyAdapters is Script {
    using stdJson for string;

    /// @dev Same sources as Deploy.s.sol (DEPLOY_ORDERLY_BROKER_ID / DEPLOY_ORDERLY_TOKEN, defaults "bookrunner" /
    ///      "USDC"). Only books created after the upgrade use them; existing proxies keep their stored hashes.
    bytes32 internal BROKER_HASH = keccak256(bytes(vm.envOr("DEPLOY_ORDERLY_BROKER_ID", string("bookrunner"))));
    bytes32 internal TOKEN_HASH = keccak256(bytes(vm.envOr("DEPLOY_ORDERLY_TOKEN", string("USDC"))));

    function run() external {
        string memory path = vm.envOr("DEPLOY_OUT", string("deployments/46630.json"));
        string memory json = vm.readFile(path);
        uint256 key = vm.envOr("PRIVATE_KEY", uint256(0));
        if (key == 0) key = vm.deriveKey(vm.envString("DEV_MNEMONIC"), 0);
        bool migrate = vm.envOr("MIGRATE_ORDERLY_ACCOUNTS", false);
        BookFactory factory = BookFactory(json.readAddress(".contracts.factory"));

        vm.startBroadcast(key);
        OrderlyAdapter impl = new OrderlyAdapter(BROKER_HASH, TOKEN_HASH);
        bytes32[] memory kinds = new bytes32[](1);
        address[] memory impls = new address[](1);
        (kinds[0], impls[0]) = (factory.ORDERLY_ADAPTER(), address(impl));
        factory.setImplementations(kinds, impls);
        for (uint256 i = 0;; i++) {
            string memory b = string.concat(".books[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, b)) break;
            if (json.readUint(string.concat(b, ".venue")) != 0) continue; // Orderly books only
            OrderlyAdapter adapter =
                OrderlyAdapter(payable(json.readAddress(string.concat(b, ".components.adapter"))));
            adapter.upgradeToAndCall(address(impl), "");
            console2.log("upgraded adapter", address(adapter));
            if (migrate && adapter.ifAccount() == address(0)) _migrate(adapter);
        }
        vm.stopBroadcast();
        console2.log("new OrderlyAdapter implementation", address(impl));
    }

    function _migrate(OrderlyAdapter adapter) internal {
        bool empty = adapter.insuranceEquityUsd() == 0 && adapter.marginEquityUsd() == 0
            && adapter.inTransitUsd() == 0 && adapter.pendingWithdrawUsd(0) == 0 && adapter.pendingWithdrawUsd(1) == 0;
        if (!empty) {
            console2.log("  kept devnet account ids (venue-side balances):", address(adapter));
            return;
        }
        adapter.migrateToOrderlyAccounts();
        console2.log("  migrated to Orderly accounts; IF account contract:", adapter.ifAccount());
    }
}
