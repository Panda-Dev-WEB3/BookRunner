// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Book} from "../src/Book.sol";
import {BookFactory} from "../src/BookFactory.sol";
import {BRTypes} from "../src/interfaces/BRTypes.sol";
import {IBookrunnerConfig} from "../src/interfaces/IBookrunnerConfig.sol";
import {IMarkRegistry} from "../src/interfaces/IMarkRegistry.sol";

/// @notice Deploys a new Book implementation (and the external `BookLogic` library it links), registers it in
///         the factory for future books and UUPS-upgrades every live book proxy listed in
///         deployments/<chainId>.json (`.books[i].components.book`, all venues).
///         Caller = config.timelock() (the deployer on testnet): both `factory.setImplementations` and
///         `Book._authorizeUpgrade` require it. Storage is ERC-7201 namespaced and append-only, so the upgrade
///         carries no migration call (`upgradeToAndCall(impl, "")`).
///
///         Compatibility checks (audit 2026-10 D: the script did not check that existing clones are compatible).
///         An existing book keeps its clones (tranches, vault, mandate, router, desk, adapter) and its registry:
///         only the Book logic changes. Before anything is broadcast the script requires, for every listed book:
///           1. the new implementation answers every Book function the existing clones call (`BOOK_CALLED_BY_CLONES`);
///           2. each tranche, the vault and the mandate (EIP-1167 clones: their implementation; ERC-1967 proxies: their
///              implementation) carries every function the new Book / BookLogic calls on it (`TRANCHE_CALLED`,
///              `VAULT_CALLED`, `MANDATE_CALLED`; calls the Book wraps in try/catch are optional and only logged);
///           3. `config.markRegistry().getMark` returns the Mark struct the new Book decodes (same ABI size), e.g. a
///              registry older than the M-1 `held` field is refused;
///         and after the upgrades (simulated before broadcasting, so a failure broadcasts nothing): every view the old
///         implementation answered returns exactly the same bytes through the new one (storage layout compatible:
///         a moved namespace or a reordered field changes them).
///         Selector presence is checked on runtime bytecode (Solidity's dispatcher pushes each selector with PUSH4):
///         a necessary condition, not a proof of identical semantics; the rehearsal on a fork is the full check.
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
        address[] memory books = _books(json);

        vm.startBroadcast(key);
        address implAddr = _deployImplementation();
        vm.stopBroadcast();
        impl = Book(implAddr);

        // ---- compatibility (nothing below the implementation deployment is broadcast if this fails)
        _requireSelectors(implAddr, _bookCalledByClones(), "new Book implementation");
        bytes32[] memory before = new bytes32[](books.length * _views().length);
        bool[] memory answered = new bool[](before.length);
        for (uint256 i; i < books.length; ++i) {
            _checkClones(Book(books[i]));
            _snapshot(books[i], i, before, answered);
        }

        vm.startBroadcast(key);
        bytes32[] memory kinds = new bytes32[](1);
        address[] memory impls = new address[](1);
        (kinds[0], impls[0]) = (factory.BOOK(), implAddr);
        factory.setImplementations(kinds, impls);
        for (uint256 i; i < books.length; ++i) {
            Book(books[i]).upgradeToAndCall(implAddr, "");
            console2.log("upgraded book", books[i]);
        }
        vm.stopBroadcast();

        // post-conditions (simulated before broadcasting): every proxy points at the new logic, still answers with
        // its own book id and every view the old implementation answered returns the same bytes
        for (uint256 i; i < books.length; ++i) {
            address book = books[i];
            require(
                address(uint160(uint256(vm.load(book, IMPLEMENTATION_SLOT)))) == implAddr, "impl not set"
            );
            require(
                Book(book).bookId() == json.readUint(string.concat(".books[", vm.toString(i), "].bookId")),
                "bookId mismatch"
            );
            _requireSameState(book, i, before, answered);
        }
        require(factory.implementation(factory.BOOK()) == implAddr, "factory impl not set");
        console2.log("new Book implementation", implAddr);
    }

    /// @dev The implementation to install (overridable by tests).
    function _deployImplementation() internal virtual returns (address) {
        return address(new Book());
    }

    // ------------------------------------------------------------------------------------------- selectors

    /// @dev Book functions the existing clones / adapters call on the book (Tranche, UnderwritingVault,
    ///      RevenueRouter, MMMandate, BookrunnerDesk, OrderlyAdapter): the new implementation must answer them.
    function _bookCalledByClones() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](18);
        s[0] = bytes4(keccak256("bookId()"));
        s[1] = bytes4(keccak256("state()"));
        s[2] = bytes4(keccak256("getCharter()"));
        s[3] = bytes4(keccak256("components()"));
        s[4] = bytes4(keccak256("markInterval()"));
        s[5] = bytes4(keccak256("subscriptionEnds()"));
        s[6] = bytes4(keccak256("sharePrice(uint8)"));
        s[7] = bytes4(keccak256("retiredPrice(uint8)"));
        s[8] = bytes4(keccak256("trancheNav()"));
        s[9] = bytes4(keccak256("unfundedClaims()"));
        s[10] = bytes4(keccak256("flowNonce()"));
        s[11] = bytes4(keccak256("lastMarkPeriodEnd()"));
        s[12] = bytes4(keccak256("fundClaims()"));
        s[13] = bytes4(keccak256("onJuniorRedeemRequested(address)"));
        s[14] = bytes4(keccak256("onRetiredRedeem(uint256,uint256)"));
        s[15] = bytes4(keccak256("onCapitalFlow()"));
        s[16] = bytes4(keccak256("creditDistribution(uint256,uint256)"));
        s[17] = bytes4(keccak256("onKill(bytes32)"));
    }

    /// @dev Tranche functions Book / BookLogic call (none of them in a try/catch).
    function _trancheCalled() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](10);
        s[0] = bytes4(keccak256("totalCommitted()"));
        s[1] = bytes4(keccak256("committedOf(address)"));
        s[2] = bytes4(keccak256("markCancelled()"));
        s[3] = bytes4(keccak256("settleWindow(uint256,address)"));
        s[4] = bytes4(keccak256("settleAtMark(uint256,uint256,uint256,address)"));
        s[5] = bytes4(keccak256("cancelRound()"));
        s[6] = bytes4(keccak256("openRound(uint64)"));
        s[7] = bytes4(keccak256("claimableAllocation(address)"));
        s[8] = bytes4(keccak256("totalSupply()"));
        s[9] = bytes4(keccak256("balanceOf(address)"));
    }

    /// @dev UnderwritingVault functions Book / BookLogic call outside a try/catch.
    function _vaultCalled() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = bytes4(keccak256("idle()"));
        s[1] = bytes4(keccak256("deployToVenue(uint8,uint256)"));
        s[2] = bytes4(keccak256("payTo(address,uint256)"));
    }

    /// @dev MMMandate functions Book / BookLogic call outside a try/catch.
    function _mandateCalled() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = bytes4(keccak256("killed()"));
        s[1] = bytes4(keccak256("kill(bytes32)"));
    }

    function _checkClones(Book book) internal view {
        BRTypes.BookComponents memory c = book.components();
        _requireSelectors(_logicOf(c.senior), _trancheCalled(), "senior tranche");
        _requireSelectors(_logicOf(c.junior), _trancheCalled(), "junior tranche");
        _requireSelectors(_logicOf(c.vault), _vaultCalled(), "vault");
        _requireSelectors(_logicOf(c.mandate), _mandateCalled(), "mandate");
        // wrapped in try/catch by the Book: a missing one degrades (logged), it never blocks
        if (!_hasSelector(_logicOf(c.vault).code, bytes4(keccak256("repayBackstop(uint256)")))) {
            console2.log("  note: vault has no repayBackstop (backstop repayments stay owed)", c.vault);
        }
        if (!_hasSelector(_logicOf(c.mandate).code, bytes4(keccak256("setRetiring()")))) {
            console2.log("  note: mandate has no setRetiring (retire() emits MandateKillFailed)", c.mandate);
        }
        _checkRegistry(book);
    }

    /// @dev The Mark the new Book decodes from config.markRegistry().getMark must have the same ABI size.
    function _checkRegistry(Book book) internal view {
        IBookrunnerConfig cfg = IBookrunnerConfig(book.config());
        address reg = cfg.markRegistry();
        uint256 id = IMarkRegistry(reg).latestMarkId(book.bookId());
        (bool ok, bytes memory ret) = reg.staticcall(abi.encodeCall(IMarkRegistry.getMark, (id)));
        BRTypes.Mark memory empty;
        require(
            ok && ret.length == abi.encode(empty).length,
            "UpgradeBook: config.markRegistry().getMark is not the Mark ABI the new Book decodes"
        );
    }

    function _requireSelectors(address target, bytes4[] memory sels, string memory what) internal view {
        bytes memory code = target.code;
        require(code.length > 0, string.concat("UpgradeBook: no code for ", what));
        for (uint256 i; i < sels.length; ++i) {
            if (!_hasSelector(code, sels[i])) {
                console2.log(string.concat("  ", what, " lacks selector"), vm.toString(abi.encodePacked(sels[i])));
                revert(string.concat("UpgradeBook: incompatible ", what));
            }
        }
    }

    /// @dev True when `code` contains PUSH4 `sel` (0x63 followed by the 4 bytes), as Solidity's dispatcher does.
    function _hasSelector(bytes memory code, bytes4 sel) internal pure returns (bool) {
        uint256 n = code.length;
        if (n < 5) return false;
        for (uint256 i; i < n - 4; ++i) {
            if (
                code[i] == 0x63 && code[i + 1] == sel[0] && code[i + 2] == sel[1] && code[i + 3] == sel[2]
                    && code[i + 4] == sel[3]
            ) return true;
        }
        return false;
    }

    /// @dev The code that runs behind `a`: an EIP-1167 clone's implementation, an ERC-1967 proxy's
    ///      implementation, else `a` itself.
    function _logicOf(address a) internal view returns (address) {
        bytes memory code = a.code;
        if (code.length == 45 && code[0] == 0x36 && code[1] == 0x3d && code[9] == 0x73) {
            uint160 impl;
            for (uint256 i = 10; i < 30; ++i) {
                impl = (impl << 8) | uint160(uint8(code[i]));
            }
            return address(impl);
        }
        address p = address(uint160(uint256(vm.load(a, IMPLEMENTATION_SLOT))));
        return p != address(0) ? p : a;
    }

    // ------------------------------------------------------------------------------------------- state snapshot

    /// @dev Views whose answers must be identical before and after the upgrade (state carried by storage).
    function _views() internal pure returns (bytes[] memory v) {
        v = new bytes[](22);
        v[0] = abi.encodeWithSignature("bookId()");
        v[1] = abi.encodeWithSignature("state()");
        v[2] = abi.encodeWithSignature("getCharter()");
        v[3] = abi.encodeWithSignature("components()");
        v[4] = abi.encodeWithSignature("config()");
        v[5] = abi.encodeWithSignature("subscriptionEnds()");
        v[6] = abi.encodeWithSignature("markInterval()");
        v[7] = abi.encodeWithSignature("trancheNav()");
        v[8] = abi.encodeWithSignature("sharePrice(uint8)", uint8(0));
        v[9] = abi.encodeWithSignature("sharePrice(uint8)", uint8(1));
        v[10] = abi.encodeWithSignature("seniorImpairment()");
        v[11] = abi.encodeWithSignature("perfIndex()");
        v[12] = abi.encodeWithSignature("drawdownBps()");
        v[13] = abi.encodeWithSignature("flowNonce()");
        v[14] = abi.encodeWithSignature("lastMarkSummary()");
        v[15] = abi.encodeWithSignature("unfundedOf(uint8)", uint8(0));
        v[16] = abi.encodeWithSignature("unfundedOf(uint8)", uint8(1));
        v[17] = abi.encodeWithSignature("backstopDebt()");
        v[18] = abi.encodeWithSignature("topUp()");
        v[19] = abi.encodeWithSignature("sponsorAbandoned()");
        v[20] = abi.encodeWithSignature("lastKill()");
        v[21] = abi.encodeWithSignature("heldSince()");
    }

    function _snapshot(address book, uint256 bi, bytes32[] memory out, bool[] memory answered) internal view {
        bytes[] memory v = _views();
        for (uint256 j; j < v.length; ++j) {
            (bool ok, bytes memory ret) = book.staticcall(v[j]);
            answered[bi * v.length + j] = ok;
            out[bi * v.length + j] = keccak256(ret);
        }
    }

    function _requireSameState(address book, uint256 bi, bytes32[] memory before, bool[] memory answered)
        internal
        view
    {
        bytes[] memory v = _views();
        for (uint256 j; j < v.length; ++j) {
            if (!answered[bi * v.length + j]) continue; // a view the old implementation did not have
            (bool ok, bytes memory ret) = book.staticcall(v[j]);
            if (!ok || keccak256(ret) != before[bi * v.length + j]) {
                console2.log("  state differs after the upgrade: view", j, book);
                revert("UpgradeBook: storage layout incompatible (state differs after the upgrade)");
            }
        }
    }

    function _books(string memory json) internal view returns (address[] memory books) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".books[", vm.toString(n), "]"))) ++n;
        books = new address[](n);
        for (uint256 i; i < n; ++i) {
            books[i] = json.readAddress(string.concat(".books[", vm.toString(i), "].components.book"));
        }
    }
}
