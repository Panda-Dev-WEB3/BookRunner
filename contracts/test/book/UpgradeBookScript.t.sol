// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {BookFactory} from "../../src/BookFactory.sol";
import {MarkRegistry} from "../../src/MarkRegistry.sol";
import {Backstop} from "../../src/Backstop.sol";
import {Book} from "../../src/Book.sol";
import {Tranche} from "../../src/Tranche.sol";
import {UnderwritingVault} from "../../src/UnderwritingVault.sol";
import {MMMandate} from "../../src/MMMandate.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {MockOrderlyVault} from "../../src/mocks/MockOrderlyVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {UpgradeBook} from "../../script/UpgradeBook.s.sol";

/// @dev Minimal BKRN staking stand-in (as in Area7CrossContract): lockers may lock any amount.
contract UBStaking {
    mapping(address => bool) public isLocker;
    mapping(address => mapping(bytes32 => uint256)) public lockOf;

    function setLocker(address l, bool ok) external {
        isLocker[l] = ok;
    }

    function lock(address account, bytes32 lockId, uint256 amount) external {
        require(isLocker[msg.sender], "locker");
        lockOf[account][lockId] += amount;
    }

    function unlock(address account, bytes32 lockId) external returns (uint256 released) {
        released = lockOf[account][lockId];
        lockOf[account][lockId] = 0;
    }
}

/// @notice Rehearsal of script/UpgradeBook.s.sol on the real stack (BookrunnerConfig, BookFactory + BookProxy,
///         Book linked to BookLogic, tranches, vault, Orderly adapter, MarkRegistry): a Live book with an
///         applied mark is upgraded by the script (caller = config.timelock()) from a deployments JSON, keeps
///         every piece of state and keeps applying marks; the factory serves the new implementation.
contract UpgradeBookScriptTest is Test {
    uint256 internal constant BOOK_ID = 1;
    uint32 internal constant INTERVAL = 86_400;
    bytes32 internal constant BROKER_HASH = keccak256("bookrunner");
    bytes32 internal constant TOKEN_HASH = keccak256("USDC");
    uint256 internal constant MARK_PK = 0xA11CE;
    uint256 internal constant TIMELOCK_PK = 0x71E10C;
    string internal constant OUT = "deployments/upgrade-book-rehearsal.json";

    address internal timelock;
    address internal charterAddr = makeAddr("marketCharter");
    address internal sponsor = makeAddr("sponsor");
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");

    MockERC20 internal usdc;
    BookrunnerConfig internal config;
    BookFactory internal factory;
    MarkRegistry internal registry;
    Book internal book;
    UnderwritingVault internal vault;
    address internal oldImpl;

    function setUp() public {
        vm.warp(1_760_000_123);
        timelock = vm.addr(TIMELOCK_PK);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        config = new BookrunnerConfig(timelock);
        factory = new BookFactory(address(config));
        registry = new MarkRegistry(address(config));
        MockOrderlyVault ov = new MockOrderlyVault(address(this), address(usdc), TOKEN_HASH, BROKER_HASH);

        vm.startPrank(timelock);
        config.setAddress("usdc", address(usdc));
        config.setAddress("orderlyVault", address(ov));
        config.setAddress("factory", address(factory));
        config.setAddress("markRegistry", address(registry));
        config.setAddress("charter", charterAddr);
        config.setAddress("staking", address(new UBStaking()));
        config.setAddress("backstop", address(new Backstop(address(config))));
        config.setParam("markInterval", INTERVAL);
        config.grantRole(config.MARK_SIGNER_ROLE(), vm.addr(MARK_PK));
        bytes32[] memory kinds = new bytes32[](7);
        address[] memory impls = new address[](7);
        oldImpl = address(new Book());
        (kinds[0], impls[0]) = (factory.BOOK(), oldImpl);
        (kinds[1], impls[1]) = (factory.TRANCHE(), address(new Tranche()));
        (kinds[2], impls[2]) = (factory.VAULT(), address(new UnderwritingVault()));
        (kinds[3], impls[3]) = (factory.MANDATE(), address(new MMMandate()));
        (kinds[4], impls[4]) = (factory.ROUTER(), address(new RevenueRouter()));
        (kinds[5], impls[5]) = (factory.DESK(), address(new BookrunnerDesk()));
        (kinds[6], impls[6]) =
        (factory.ORDERLY_ADAPTER(), address(new OrderlyAdapter(BROKER_HASH, TOKEN_HASH)));
        factory.setImplementations(kinds, impls);
        vm.stopPrank();

        vm.prank(charterAddr);
        BRTypes.BookComponents memory c = factory.create(BOOK_ID, _charter());
        book = Book(c.book);
        vault = UnderwritingVault(c.vault);
        _deposit(Tranche(c.senior), alice, 70_000e6);
        _deposit(Tranche(c.junior), sponsor, 10_000e6);
        _deposit(Tranche(c.junior), carol, 20_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();

        // one applied mark with a gain, so there is non-trivial state to carry across the upgrade
        _applyMark(uint64((block.timestamp / INTERVAL + 1) * INTERVAL), 101_000e6);
    }

    function test_upgradeBookScript_preservesStateAndKeepsWorking() public {
        (uint256 s0, uint256 j0) = book.trancheNav();
        (uint256 pi0, uint256 hw0) = book.perfIndex();
        Book.LastMark memory lm0 = book.lastMarkSummary();
        uint64 nonce0 = book.flowNonce();
        uint256 price0 = book.sharePrice(BRTypes.JUNIOR);

        // a deployments/<chain>.json as Deploy.s.sol + launch-devnet.ts write it (fields the script reads)
        vm.createDir("deployments", true);
        vm.writeFile(
            OUT,
            string.concat(
                '{"contracts":{"factory":"',
                vm.toString(address(factory)),
                '"},"books":[{"bookId":1,"venue":0,"components":{"book":"',
                vm.toString(address(book)),
                '"}}]}'
            )
        );
        Book impl = new UpgradeBook().upgrade(OUT, TIMELOCK_PK);
        vm.removeFile(OUT);

        address newImpl = factory.implementation(factory.BOOK());
        assertEq(newImpl, address(impl));
        assertTrue(newImpl != oldImpl && newImpl.code.length > 0, "new impl registered");
        assertEq(
            address(
                uint160(
                    uint256(
                        vm.load(
                            address(book), bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
                        )
                    )
                )
            ),
            newImpl,
            "proxy upgraded"
        );

        (uint256 s1, uint256 j1) = book.trancheNav();
        (uint256 pi1, uint256 hw1) = book.perfIndex();
        Book.LastMark memory lm1 = book.lastMarkSummary();
        assertEq(s1, s0);
        assertEq(j1, j0);
        assertEq(pi1, pi0);
        assertEq(hw1, hw0);
        assertEq(lm1.markId, lm0.markId);
        assertEq(lm1.navUsd, lm0.navUsd);
        assertEq(book.flowNonce(), nonce0);
        assertEq(book.sharePrice(BRTypes.JUNIOR), price0);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));

        // the upgraded book still applies marks (logic runs through the linked BookLogic)
        _applyMark(lm0.periodEnd + INTERVAL, 102_000e6);
        assertEq(book.lastMarkPeriodEnd(), lm0.periodEnd + INTERVAL);
        (, uint256 j2) = book.trancheNav();
        assertEq(j2, j1 + 1000e6, "gain to Junior");
    }

    function _applyMark(uint64 periodEnd, uint256 deployed) internal {
        vm.warp(uint256(periodEnd) + 60);
        BRTypes.MarkInput memory m = BRTypes.MarkInput({
            bookId: BOOK_ID,
            periodEnd: periodEnd,
            navUsd: vault.idle() + deployed,
            deployedValueUsd: deployed,
            flowNonce: book.flowNonce(),
            inventoryRoot: keccak256("inventory"),
            pnlJsonHash: keccak256("pnl.json"),
            receiptsRoot: keccak256("receipts")
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MARK_PK, registry.hashMark(m));
        registry.commitAndApply(m, abi.encodePacked(r, s, v), "", "");
    }

    function _charter() internal view returns (BRTypes.Charter memory c) {
        c.underlying = bytes32(uint256(uint160(address(0xA0A0))));
        c.venue = BRTypes.VENUE_ORDERLY;
        c.oracle = BRTypes.ORACLE_ATTESTED;
        c.ifTargetUsd = 25_000e6;
        c.mmInventoryUsd = 75_000e6;
        c.mandate = BRTypes.Mandate({
            maxInventoryUsd: 50_000e6,
            maxSkewBps: 25,
            minQuoteWidthBps: 8,
            maxHedgeLeverage: 100,
            hedgeRatioMinBps: 5000,
            hedgeRatioMaxBps: 12_000,
            noNewRiskOffHours: false,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: bytes32(uint256(1))
        });
        c.seniorHurdleBps = 6000;
        c.seniorCapBps = 7000;
        c.subscriptionWindow = 600;
        c.juniorNoticeSeconds = 900;
        c.sponsor = sponsor;
        c.perWalletCapUsd = 250_000e6;
        c.symbol = bytes32("PERP_NVDA_USDC");
    }

    function _deposit(Tranche t, address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(t), amount);
        t.deposit(amount, who);
        vm.stopPrank();
    }
}
