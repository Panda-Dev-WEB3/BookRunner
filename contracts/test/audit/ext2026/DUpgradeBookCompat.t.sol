// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {Book} from "../../../src/Book.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {UpgradeBook} from "../../../script/UpgradeBook.s.sol";
import {UpgradeBookScriptTest} from "../../book/UpgradeBookScript.t.sol";

/// @dev A Book "implementation" that answers every function the clones call but reads its state from the wrong
///      place (as a moved ERC-7201 namespace or a reordered field would): bookId() is right, everything else is 0.
contract ShiftedStorageBook is UUPSUpgradeable {
    bytes32 private constant LOC = 0xafd306892a6154f35c973e251e6b4f2659d2ae19802986651fcc8ec3ae5c4c00;

    function _authorizeUpgrade(address) internal override {}

    function bookId() external view returns (uint256 id) {
        bytes32 slot = bytes32(uint256(LOC) + 1);
        assembly {
            id := sload(slot)
        }
    }

    function state() external pure returns (uint8) {
        return 0;
    }

    function getCharter() external pure returns (BRTypes.Charter memory c) {}

    function components() external pure returns (BRTypes.BookComponents memory c) {}

    function config() external pure returns (address) {}
    function markInterval() external pure returns (uint32) {}
    function subscriptionEnds() external pure returns (uint64) {}
    function sharePrice(uint8) external pure returns (uint256) {}
    function retiredPrice(uint8) external pure returns (uint256, uint64) {}
    function trancheNav() external pure returns (uint256, uint256) {}
    function unfundedClaims() external pure returns (uint256) {}
    function flowNonce() external pure returns (uint64) {}
    function lastMarkPeriodEnd() external pure returns (uint64) {}
    function fundClaims() external pure returns (uint256) {}
    function onJuniorRedeemRequested(address) external pure {}
    function onRetiredRedeem(uint256, uint256) external pure {}
    function onCapitalFlow() external pure {}
    function creditDistribution(uint256, uint256) external pure {}
    function onKill(bytes32) external pure {}
}

contract UpgradeBookWithImpl is UpgradeBook {
    address internal immutable _impl;

    constructor(address impl_) {
        _impl = impl_;
    }

    function _deployImplementation() internal view override returns (address) {
        return _impl;
    }
}

/// @notice Audit 2026-10 D: UpgradeBook did not check that the existing clones are compatible with the new Book
///         (nor that the new implementation keeps the storage layout). It now refuses, before broadcasting anything
///         but the implementation itself, a book whose clones lack a function the new Book calls, a registry whose
///         Mark ABI differs, and an implementation whose views no longer return the stored state.
contract DUpgradeBookCompatTest is UpgradeBookScriptTest {
    function _rehearsalOut() internal pure override returns (string memory) {
        return "deployments/upgrade-book-compat-rehearsal.json";
    }

    /// @dev One file per test: tests run in parallel and share deployments/.
    function _writeOut(string memory tag) internal returns (string memory out) {
        out = string.concat("deployments/upgrade-book-compat-", tag, ".json");
        vm.createDir("deployments", true);
        vm.writeFile(
            out,
            string.concat(
                '{"contracts":{"factory":"',
                vm.toString(address(factory)),
                '"},"books":[{"bookId":1,"venue":0,"components":{"book":"',
                vm.toString(address(book)),
                '"}}]}'
            )
        );
    }

    /// @dev PoC: the senior tranche clone of a live book does not implement settleAtMark (an older / different
    ///      Tranche). The old script upgraded it anyway, and every later mark would have reverted.
    function test_D_poc_incompatibleTrancheClone_refused() public {
        string memory out = _writeOut("tranche");
        address seniorClone = book.components().senior;
        vm.etch(seniorClone, address(new MockERC20("x", "x", 6)).code);
        UpgradeBook s = new UpgradeBook();
        vm.expectRevert(bytes("UpgradeBook: incompatible senior tranche"));
        s.upgrade(out, TIMELOCK_PK);
        vm.removeFile(out);
        assertEq(factory.implementation(factory.BOOK()), oldImpl, "nothing registered");
    }

    function test_D_incompatibleMandateClone_refused() public {
        string memory out = _writeOut("mandate");
        vm.etch(book.components().mandate, address(new MockERC20("x", "x", 6)).code);
        UpgradeBook s = new UpgradeBook();
        vm.expectRevert(bytes("UpgradeBook: incompatible mandate"));
        s.upgrade(out, TIMELOCK_PK);
        vm.removeFile(out);
    }

    function test_D_registryWithOtherMarkAbi_refused() public {
        string memory out = _writeOut("registry");
        address reg = config.markRegistry();
        // a registry returning the pre-M-1 Mark (MarkInput without `held`): one word shorter
        BRTypes.Mark memory m;
        bytes memory short = abi.encode(m);
        assembly {
            mstore(short, sub(mload(short), 32))
        }
        vm.mockCall(reg, abi.encodeWithSignature("getMark(uint256)"), short);
        UpgradeBook s = new UpgradeBook();
        vm.expectRevert(bytes("UpgradeBook: config.markRegistry().getMark is not the Mark ABI the new Book decodes"));
        s.upgrade(out, TIMELOCK_PK);
        vm.removeFile(out);
    }

    function test_D_storageIncompatibleImplementation_refused() public {
        string memory out = _writeOut("storage");
        UpgradeBookWithImpl s = new UpgradeBookWithImpl(address(new ShiftedStorageBook()));
        vm.expectRevert(bytes("UpgradeBook: storage layout incompatible (state differs after the upgrade)"));
        s.upgrade(out, TIMELOCK_PK);
        vm.removeFile(out);
    }

    function test_D_newImplementationMissingAHook_refused() public {
        string memory out = _writeOut("hook");
        UpgradeBookWithImpl s = new UpgradeBookWithImpl(address(new MockERC20("x", "x", 6)));
        vm.expectRevert(bytes("UpgradeBook: incompatible new Book implementation"));
        s.upgrade(out, TIMELOCK_PK);
        vm.removeFile(out);
    }
}
