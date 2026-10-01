// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {Book} from "../../../src/Book.sol";
import {Tranche} from "../../../src/Tranche.sol";
import {UnderwritingVault} from "../../../src/UnderwritingVault.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {
    MockBookConfig,
    MockMarkRegistry,
    MockVenueAdapter,
    MockMandate,
    MockBackstop,
    MockCharter
} from "./BookMocks.sol";

/// @notice Deploys one book the way BookFactory does: Book behind an ERC1967Proxy, Tranche x2 and the
///         vault as EIP-1167 clones; book initialized first, then the components. Siblings are mocks.
abstract contract BookFixture is Test {
    uint256 internal constant BOOK_ID = 1;
    uint256 internal constant WAD = 1e18;
    uint32 internal constant INTERVAL = 300;
    uint32 internal constant WINDOW = 600;
    uint64 internal constant NOTICE = 900;

    MockERC20 internal usdc;
    MockBookConfig internal cfg;
    MockMarkRegistry internal registry;
    MockBackstop internal backstop;
    MockCharter internal charterC;
    MockMandate internal mandate;
    MockVenueAdapter internal adapter;

    Book internal bookImpl;
    Tranche internal trancheImpl;
    UnderwritingVault internal vaultImpl;

    Book internal book;
    Tranche internal senior;
    Tranche internal junior;
    UnderwritingVault internal vault;

    address internal sponsor = makeAddr("sponsor");
    address internal router = makeAddr("router");
    address internal desk = makeAddr("desk");
    address internal timelock = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal risk = makeAddr("risk");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal eve = makeAddr("eve");

    function _defaultCharter() internal view returns (BRTypes.Charter memory c) {
        c.underlying = bytes32(uint256(0xBEEF));
        c.venue = BRTypes.VENUE_POOL_ENGINE;
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
            noNewRiskOffHours: true,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: bytes32(0)
        });
        c.seniorHurdleBps = 6000;
        c.seniorCapBps = 7000;
        c.subscriptionWindow = WINDOW;
        c.juniorNoticeSeconds = NOTICE;
        c.sponsor = sponsor;
        c.perWalletCapUsd = 250_000e6;
        c.symbol = bytes32("PERP_NVDA_USDC");
    }

    function _deployInfra() internal {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cfg = new MockBookConfig();
        registry = new MockMarkRegistry();
        backstop = new MockBackstop(IERC20(address(usdc)));
        charterC = new MockCharter();
        cfg.setUsdc(address(usdc));
        cfg.setMarkRegistry(address(registry));
        cfg.setBackstop(address(backstop));
        cfg.setCharter(address(charterC));
        cfg.setTimelock(timelock);
        cfg.setMarkInterval(INTERVAL);
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        cfg.grantRole(cfg.KEEPER_ROLE(), keeper);
        cfg.grantRole(cfg.RISK_ROLE(), risk);

        bookImpl = new Book();
        trancheImpl = new Tranche();
        vaultImpl = new UnderwritingVault();
    }

    function _components() internal view returns (BRTypes.BookComponents memory) {
        return BRTypes.BookComponents({
            book: address(0), // filled in by Book.initialize (proxy constructor init call)
            senior: address(senior),
            junior: address(junior),
            vault: address(vault),
            mandate: address(mandate),
            router: router,
            desk: desk,
            adapter: address(adapter)
        });
    }

    function _deployBook(BRTypes.Charter memory c) internal {
        senior = Tranche(Clones.clone(address(trancheImpl)));
        junior = Tranche(Clones.clone(address(trancheImpl)));
        vault = UnderwritingVault(Clones.clone(address(vaultImpl)));
        mandate = new MockMandate(address(0));
        adapter = new MockVenueAdapter(usdc);

        bytes memory init = abi.encodeCall(Book.initialize, (address(cfg), BOOK_ID, c, _components()));
        book = Book(address(new ERC1967Proxy(address(bookImpl), init)));
        mandate.setBook(address(book));
        senior.initialize(address(cfg), BOOK_ID, address(book), BRTypes.SENIOR);
        junior.initialize(address(cfg), BOOK_ID, address(book), BRTypes.JUNIOR);
        vault.initialize(address(cfg), BOOK_ID, address(book));
        adapter.initialize(address(cfg), BOOK_ID, address(book));
        adapter.setVault(address(vault));
        registry.setBook(BOOK_ID, address(book));
        backstop.setVault(address(vault));
        charterC.setBook(BOOK_ID, address(book));
    }

    function _setUpBook() internal {
        _deployInfra();
        _deployBook(_defaultCharter());
    }

    // ---------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------

    function _deposit(Tranche t, address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(t), amount);
        t.deposit(amount, who);
        vm.stopPrank();
    }

    /// @dev Default window: Senior alice 40k + bob 30k, Junior sponsor 10k + carol 20k -> fully allocated
    ///      (S 70k / J 30k), IF 25k + MM 75k deployed, vault idle 0.
    function _subscribeDefault() internal {
        _deposit(senior, alice, 40_000e6);
        _deposit(senior, bob, 30_000e6);
        _deposit(junior, sponsor, 10_000e6);
        _deposit(junior, carol, 20_000e6);
    }

    function _goLive() internal {
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        senior.claimAllocation(alice);
        senior.claimAllocation(bob);
        junior.claimAllocation(sponsor);
        junior.claimAllocation(carol);
    }

    /// @dev Next mark boundary strictly after the last applied mark (and >= now).
    function _nextPeriodEnd() internal view returns (uint64) {
        uint256 last = book.lastMarkPeriodEnd();
        uint256 t = (block.timestamp / INTERVAL) * INTERVAL;
        if (t <= last) t = last + INTERVAL;
        return uint64(t);
    }

    function _commitMark(uint64 periodEnd, uint256 deployed, uint64 nonce) internal returns (uint256 id) {
        BRTypes.MarkInput memory m = BRTypes.MarkInput({
            bookId: BOOK_ID,
            periodEnd: periodEnd,
            navUsd: 0,
            deployedValueUsd: deployed,
            flowNonce: nonce,
            inventoryRoot: bytes32(0),
            pnlJsonHash: bytes32(0),
            receiptsRoot: bytes32(0)
        });
        id = registry.commit(m, "");
    }

    /// @dev Warps to the next period boundary, moves the venue value by `pnl`, commits + applies a mark.
    function _markWithPnl(int256 pnl) internal returns (uint256 id) {
        id = _prepareMark(pnl);
        book.applyMark(id);
    }

    /// @dev Everything _markWithPnl does except applying the mark.
    function _prepareMark(int256 pnl) internal returns (uint256 id) {
        vm.warp(((block.timestamp / INTERVAL) + 1) * INTERVAL);
        uint256 v = adapter.value();
        uint256 nv = pnl >= 0 ? v + uint256(pnl) : (uint256(-pnl) > v ? 0 : v - uint256(-pnl));
        adapter.setValue(nv);
        id = _commitMark(_nextPeriodEnd(), nv, book.flowNonce());
    }

    /// @dev Recall `amount` from the MM account as KEEPER (sync on the mock venue).
    function _recall(uint256 amount) internal {
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, amount);
    }

    function _credit(uint256 s, uint256 j) internal {
        usdc.mint(address(vault), s + j);
        vm.prank(router);
        book.creditDistribution(s, j);
    }

    function _accountingIdentity() internal view returns (uint256 lhs, uint256 rhs) {
        (uint256 s, uint256 j) = book.trancheNav();
        lhs = s + j + book.unfundedClaims();
        rhs = vault.idle() + adapter.value();
    }
}
