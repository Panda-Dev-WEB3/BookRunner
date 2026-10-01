// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IMarketCharter} from "../../../src/interfaces/IMarketCharter.sol";
import {MarketCharter} from "../../../src/MarketCharter.sol";
import {RiskCommittee} from "../../../src/RiskCommittee.sol";
import {BookFactory} from "../../../src/BookFactory.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";

import {
    GovMockConfig,
    GovMockStaking,
    GovMockRegistry,
    GovMockBook,
    GovMockTranche,
    GovMockVault,
    GovMockRouter,
    GovMockDesk,
    GovMockMandate,
    GovMockAdapter
} from "./GovMocks.sol";

/// @notice Deploys MarketCharter + RiskCommittee + BookFactory against gov mocks, wired as the deploy
///         script must wire them (config addresses, staking lockers, factory implementations, JURY role).
abstract contract GovBase is Test {
    uint256 internal constant FEE = 5000e6;
    uint256 internal constant SPONSOR_BOND = 100_000e18;
    uint256 internal constant COMMITTEE_BOND = 250_000e18;
    uint32 internal constant WINDOW = 172_800;
    uint256 internal constant ORDERLY_MIN_IF = 25_000e6;
    uint256 internal constant ENGINE_MIN_IF = 10_000e6;
    bytes32 internal constant RHX5 = keccak256("BKRN.INDEX.RHX5");
    bytes32 internal constant CID = keccak256("jury verdict json");

    GovMockConfig internal cfg;
    MockERC20 internal usdc;
    MockERC20 internal bkrn;
    GovMockStaking internal staking;
    GovMockRegistry internal registry;

    MarketCharter internal charter;
    RiskCommittee internal committee;
    BookFactory internal factory;

    GovMockBook internal bookImpl;
    GovMockTranche internal trancheImpl;
    GovMockVault internal vaultImpl;
    GovMockMandate internal mandateImpl;
    GovMockRouter internal routerImpl;
    GovMockDesk internal deskImpl;
    GovMockAdapter internal orderlyImpl;
    GovMockAdapter internal engineImpl;

    address internal timelock = makeAddr("timelock");
    address internal jury = makeAddr("jury");
    address internal sponsor = makeAddr("sponsor");
    address internal expenseRecipient = makeAddr("expenseRecipient");
    address internal slashRecipient = makeAddr("slashRecipient");
    address internal m1 = makeAddr("member1");
    address internal m2 = makeAddr("member2");
    address internal m3 = makeAddr("member3");
    address internal outsider = makeAddr("outsider");
    address internal nvda = makeAddr("NVDA stock token");

    function setUp() public virtual {
        cfg = new GovMockConfig();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        bkrn = new MockERC20("Bookrunner", "BKRN", 18);
        staking = new GovMockStaking(address(cfg), address(bkrn));
        registry = new GovMockRegistry();

        charter = new MarketCharter(address(cfg));
        committee = new RiskCommittee(address(cfg), [m1, m2, m3]);
        factory = new BookFactory(address(cfg));

        cfg.setAddresses(
            address(usdc),
            address(bkrn),
            address(staking),
            address(registry),
            address(charter),
            address(committee),
            address(factory),
            timelock,
            expenseRecipient,
            slashRecipient
        );
        cfg.setParams(FEE, SPONSOR_BOND, COMMITTEE_BOND, WINDOW);
        cfg.setVenueMinIf(BRTypes.VENUE_ORDERLY, ORDERLY_MIN_IF);
        cfg.setVenueMinIf(BRTypes.VENUE_POOL_ENGINE, ENGINE_MIN_IF);
        cfg.grantRole(cfg.JURY_ROLE(), jury);

        registry.setCanonical(nvda, true);
        registry.setIndex(RHX5, true);

        vm.startPrank(timelock);
        staking.setLocker(address(charter), true);
        staking.setLocker(address(committee), true);
        vm.stopPrank();

        bookImpl = new GovMockBook();
        trancheImpl = new GovMockTranche();
        vaultImpl = new GovMockVault();
        mandateImpl = new GovMockMandate();
        routerImpl = new GovMockRouter();
        deskImpl = new GovMockDesk();
        orderlyImpl = new GovMockAdapter(BRTypes.VENUE_ORDERLY);
        engineImpl = new GovMockAdapter(BRTypes.VENUE_POOL_ENGINE);
        _setAllImplementations();

        _fundSponsor(sponsor);
        _fundMember(m1);
        _fundMember(m2);
        _fundMember(m3);
    }

    // ------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------

    function _setAllImplementations() internal {
        bytes32[] memory kinds = new bytes32[](8);
        address[] memory impls = new address[](8);
        kinds[0] = factory.BOOK();
        impls[0] = address(bookImpl);
        kinds[1] = factory.TRANCHE();
        impls[1] = address(trancheImpl);
        kinds[2] = factory.VAULT();
        impls[2] = address(vaultImpl);
        kinds[3] = factory.MANDATE();
        impls[3] = address(mandateImpl);
        kinds[4] = factory.ROUTER();
        impls[4] = address(routerImpl);
        kinds[5] = factory.DESK();
        impls[5] = address(deskImpl);
        kinds[6] = factory.ORDERLY_ADAPTER();
        impls[6] = address(orderlyImpl);
        kinds[7] = factory.ENGINE_ADAPTER();
        impls[7] = address(engineImpl);
        vm.prank(timelock);
        factory.setImplementations(kinds, impls);
    }

    function _fundSponsor(address who) internal {
        usdc.mint(who, 1_000_000e6);
        bkrn.mint(who, 1_000_000e18);
        vm.startPrank(who);
        usdc.approve(address(charter), type(uint256).max);
        bkrn.approve(address(staking), type(uint256).max);
        staking.stake(1_000_000e18);
        vm.stopPrank();
    }

    function _fundMember(address who) internal {
        bkrn.mint(who, 1_000_000e18);
        vm.startPrank(who);
        bkrn.approve(address(staking), type(uint256).max);
        staking.stake(1_000_000e18);
        vm.stopPrank();
    }

    function _mandate() internal pure returns (BRTypes.Mandate memory m) {
        m = BRTypes.Mandate({
            maxInventoryUsd: 50_000e6,
            maxSkewBps: 25,
            minQuoteWidthBps: 8,
            maxHedgeLeverage: 100,
            hedgeRatioMinBps: 5000,
            hedgeRatioMaxBps: 12_000,
            noNewRiskOffHours: true,
            killAtDrawdownBps: -800,
            hedgeAllowRoot: keccak256("allow root")
        });
    }

    /// @notice NVDA Stock Token book on Orderly (ARCHITECTURE.md §7).
    function _charterFor(address sponsor_) internal view returns (BRTypes.Charter memory c) {
        c.underlying = bytes32(uint256(uint160(nvda)));
        c.venue = BRTypes.VENUE_ORDERLY;
        c.oracle = BRTypes.ORACLE_ATTESTED;
        c.sessions = bytes32(uint256(1));
        c.ifTargetUsd = 25_000e6;
        c.mmInventoryUsd = 75_000e6;
        c.mandate = _mandate();
        c.seniorHurdleBps = 6000;
        c.seniorCapBps = 7000;
        c.subscriptionWindow = 600;
        c.juniorNoticeSeconds = 900;
        c.sponsor = sponsor_;
        c.perWalletCapUsd = 250_000e6;
        c.symbol = "PERP_NVDA_USDC";
        c.takerFeeBps = 0;
        c.makerFeeBps = 0;
    }

    function _charter() internal view returns (BRTypes.Charter memory) {
        return _charterFor(sponsor);
    }

    /// @notice RHX5 index book on the in-house PoolEngine.
    function _engineCharter() internal view returns (BRTypes.Charter memory c) {
        c = _charter();
        c.underlying = RHX5;
        c.venue = BRTypes.VENUE_POOL_ENGINE;
        c.mmInventoryUsd = 100_000e6;
        c.mandate.maxInventoryUsd = 75_000e6;
        c.symbol = "RHX5-PERP";
        c.takerFeeBps = 10;
        c.makerFeeBps = 0;
    }

    function _file(BRTypes.Charter memory c) internal returns (uint256 id) {
        vm.prank(c.sponsor);
        id = charter.file(c);
    }

    function _file() internal returns (uint256) {
        return _file(_charter());
    }

    function _bond(address m) internal {
        vm.prank(m);
        committee.bond();
    }

    function _bondAll() internal {
        _bond(m1);
        _bond(m2);
        _bond(m3);
    }

    function _postJury(uint256 id, bool recommendApprove) internal {
        vm.prank(jury);
        committee.postJuryVerdict(id, CID, recommendApprove);
    }

    function _vote(address m, uint256 id, bool approve) internal {
        vm.prank(m);
        committee.vote(id, approve);
    }

    /// @notice file -> jury approve -> 2 approvals -> book created. Returns the charter id.
    function _fileAndApprove(BRTypes.Charter memory c) internal returns (uint256 id) {
        id = _file(c);
        _postJury(id, true);
        _vote(m1, id, true);
        _vote(m2, id, true);
    }

    function _status(uint256 id) internal view returns (BRTypes.CharterStatus) {
        return charter.get(id).status;
    }

    function _book(uint256 id) internal view returns (GovMockBook) {
        return GovMockBook(charter.get(id).book);
    }

    function _setMember(uint8 index, address member) internal {
        vm.prank(timelock);
        committee.setMember(index, member);
    }
}
