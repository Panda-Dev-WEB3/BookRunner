// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Book} from "../src/Book.sol";
import {BookFactory} from "../src/BookFactory.sol";

/// @notice Deploys a new Book implementation (and the external `BookLogic` library it links), registers it in
///         the factory for future books and UUPS-upgrades every live book proxy listed in
///         deployments/<chainId>.json (`.books[i].components.book`, all venues).
///         Caller = config.timelock() (the deployer on testnet): both `factory.setImplementations` and
///         `Book._authorizeUpgrade` require it. Storage is ERC-7201 namespaced and unchanged by the
///         BookLogic extraction, so the upgrade carries no migration call (`upgradeToAndCall(impl, "")`).
/// @dev Library linking: `new Book()` needs `src/libraries/BookLogic.sol:BookLogic` deployed and linked.
///      `forge script` does this automatically — it pre-deploys every unlinked library from the single
///      broadcaster before the script's own transactions and links the bytecode; the library address is
///      recorded in broadcast/UpgradeBook.s.sol/<chainId>/run-latest.json (`libraries`). To reuse an already
///      deployed BookLogic instead, pass
///      `--libraries src/libraries/BookLogic.sol:BookLogic:<address>`.
///   PRIVATE_KEY=... (or DEV_MNEMONIC) DEPLOY_OUT=deployments/46630.json \
///     bash scripts/forge.sh script script/UpgradeBook.s.sol:UpgradeBook --rpc-url $RPC --broadcast --slow
contract UpgradeBook is Script {
    using stdJson for string;

    /// @dev ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function run() external {
        string memory path = vm.envOr("DEPLOY_OUT", string("deployments/46630.json"));
        uint256 key = vm.envOr("PRIVATE_KEY", uint256(0));
        if (key == 0) key = vm.deriveKey(vm.envString("DEV_MNEMONIC"), 0);
        upgrade(path, key);
    }

    /// @notice The whole upgrade for the deployment file at `path`, broadcast from `key` (= the timelock).
    function upgrade(string memory path, uint256 key) public returns (Book impl) {
        string memory json = vm.readFile(path);
        BookFactory factory = BookFactory(json.readAddress(".contracts.factory"));

        vm.startBroadcast(key);
        impl = new Book();
        bytes32[] memory kinds = new bytes32[](1);
        address[] memory impls = new address[](1);
        (kinds[0], impls[0]) = (factory.BOOK(), address(impl));
        factory.setImplementations(kinds, impls);
        for (uint256 i = 0;; i++) {
            string memory b = string.concat(".books[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, b)) break;
            address book = json.readAddress(string.concat(b, ".components.book"));
            Book(book).upgradeToAndCall(address(impl), "");
            console2.log("upgraded book", book);
        }
        vm.stopBroadcast();

        // post-conditions (simulated before broadcasting): every proxy points at the new logic and still
        // answers with its own book id
        for (uint256 i = 0;; i++) {
            string memory b = string.concat(".books[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, b)) break;
            address book = json.readAddress(string.concat(b, ".components.book"));
            require(
                address(uint160(uint256(vm.load(book, IMPLEMENTATION_SLOT)))) == address(impl), "impl not set"
            );
            require(Book(book).bookId() == json.readUint(string.concat(b, ".bookId")), "bookId mismatch");
        }
        require(factory.implementation(factory.BOOK()) == address(impl), "factory impl not set");
        console2.log("new Book implementation", address(impl));
    }
}
