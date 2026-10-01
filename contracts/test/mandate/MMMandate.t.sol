// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IMMMandate} from "../../src/interfaces/IMMMandate.sol";
import {MMMandate} from "../../src/MMMandate.sol";
import {MandateBase} from "./utils/MandateBase.sol";
import {MandateMockBook} from "./utils/MandateMocks.sol";

contract MMMandateTest is MandateBase {
    event KeyRegistered(
        address indexed key, address indexed operator, uint64 validUntil, uint128 inventoryTierUsd
    );
    event KeyRevoked(address indexed key, address indexed by, bytes32 reason);
    event Kill(bytes32 reason, address indexed by);
    event Remandated(bytes32 mandateHash);
    event OperatorConsentSet(address indexed operator, address indexed key, bool allowed);
    event BondReleased(address indexed key, address indexed operator, uint256 amount);
    event BondReleaseFailed(address indexed key, address indexed operator, uint256 amount);
    event DeskSyncFailed(address indexed key);
    event RetiringSet(address indexed by);
    event ReduceOnlyRequestFailed();
    event BookKillNotifyFailed(bytes32 reason);

    uint256 internal constant BOND = 25_000e18;

    // ------------------------------------------------------------------ helpers

    function _hp(address token, bytes32 v, bool buy, uint256 qty, uint256 notional, uint16 lev)
        internal
        pure
        returns (IMMMandate.HedgeParams memory)
    {
        return IMMMandate.HedgeParams({
            asset: bytes32(uint256(uint160(token))),
            venue: v,
            buy: buy,
            qtyRaw: qty,
            notionalUsd: notional,
            leverage: lev
        });
    }

    /// @dev Real desk inventory: fund + buy `usd` of NVDA with venue exposure `exp`.
    function _seedHedge(int256 exp, uint256 usd) internal {
        adapter.setExposure(exp);
        _fundDesk(usd);
        _buyNvda(usd);
    }

    function _mandateWithUnderlying(bytes32 u) internal returns (MMMandate m) {
        MandateMockBook b = new MandateMockBook();
        m = MMMandate(Clones.clone(address(mandateImpl)));
        BRTypes.Charter memory c = _charter(BRTypes.VENUE_POOL_ENGINE);
        c.underlying = u;
        BRTypes.BookComponents memory comps;
        comps.book = address(b);
        comps.mandate = address(m);
        comps.desk = address(desk);
        comps.vault = address(vault);
        comps.adapter = address(adapter);
        b.setUp(55, c, comps);
        m.initialize(address(cfg), 55, address(b));
    }

    function _newKey(string memory name) internal returns (address k) {
        k = makeAddr(name);
        _registerKey(k, operator, uint64(block.timestamp + 1 days), MAX_INV);
    }

    // ------------------------------------------------------------------ initialize

    function test_init_cachesCharterAndComponents() public view {
        assertEq(address(mandate.config()), address(cfg));
        assertEq(mandate.bookId(), BOOK_ID);
        assertEq(mandate.book(), address(book));
        assertEq(mandate.desk(), address(desk));
        assertEq(mandate.vault(), address(vault));
        assertEq(mandate.adapter(), address(adapter));
        assertEq(mandate.sponsor(), sponsor);
        assertEq(mandate.underlying(), _asset(address(nvda)));
        assertEq(mandate.venue(), BRTypes.VENUE_POOL_ENGINE);
        assertEq(mandate.ifTargetUsd(), IF_TARGET);
        assertEq(mandate.mmInventoryUsd(), MM_INV);
        BRTypes.Mandate memory m = mandate.getMandate();
        assertEq(m.maxInventoryUsd, MAX_INV);
        assertEq(m.hedgeAllowRoot, allowTree[0]);
        assertFalse(mandate.killed());
        assertFalse(mandate.retiring());
    }

    function test_init_implementationLocked() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        mandateImpl.initialize(address(cfg), BOOK_ID, address(book));
    }

    function test_init_onlyOnce() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        mandate.initialize(address(cfg), BOOK_ID, address(book));
    }

    function test_init_validation() public {
        MMMandate m = MMMandate(Clones.clone(address(mandateImpl)));
        vm.expectRevert(MMMandate.ZeroAddress.selector);
        m.initialize(address(0), BOOK_ID, address(book));
        vm.expectRevert(MMMandate.ZeroAddress.selector);
        m.initialize(address(cfg), BOOK_ID, address(0));
        // book whose components name another mandate
        vm.expectRevert(MMMandate.ComponentMismatch.selector);
        m.initialize(address(cfg), BOOK_ID, address(book));

        MandateMockBook b = new MandateMockBook();
        BRTypes.BookComponents memory comps;
        comps.mandate = address(m);
        comps.desk = address(desk);
        comps.vault = address(vault);
        comps.adapter = address(adapter);
        b.setUp(8, _charter(BRTypes.VENUE_POOL_ENGINE), comps);
        // bookId mismatch
        vm.expectRevert(MMMandate.ComponentMismatch.selector);
        m.initialize(address(cfg), 9, address(b));
        // missing desk
        comps.desk = address(0);
        b.setUp(8, _charter(BRTypes.VENUE_POOL_ENGINE), comps);
        vm.expectRevert(MMMandate.ComponentMismatch.selector);
        m.initialize(address(cfg), 8, address(b));
    }

    // ------------------------------------------------------------------ registerKey

    function test_registerKey_locksBondAndMirrorsToDesk() public view {
        IMMMandate.DeskKey memory k = mandate.getKey(key);
        assertEq(k.operator, operator);
        assertEq(k.validUntil, uint64(T0 + 30 days));
        assertEq(k.inventoryTierUsd, MAX_INV);
        assertTrue(k.active);
        assertTrue(mandate.isActiveKey(key));
        assertEq(mandate.bondOf(key), BOND);
        assertEq(staking.lockOf(operator, mandate.keyLockId(key)), BOND);
        assertEq(mandate.keyLockId(key), keccak256(abi.encode(BOOK_ID, key)));
        assertEq(desk.sessionKeyValidUntil(key), uint64(T0 + 30 days));
        address[] memory ks = mandate.activeKeys();
        assertEq(ks.length, 1);
        assertEq(ks[0], key);
        assertFalse(mandate.operatorConsent(operator, key));
    }

    function test_registerKey_emits() public {
        address k = makeAddr("k2");
        staking.setAvailable(operator, 1_000_000e18);
        vm.expectEmit(true, true, false, true, address(mandate));
        emit OperatorConsentSet(operator, k, true);
        vm.prank(operator);
        mandate.consentKey(k, true);
        assertTrue(mandate.operatorConsent(operator, k));
        vm.expectEmit(true, true, false, true, address(mandate));
        emit KeyRegistered(k, operator, uint64(block.timestamp + 1), 60_000e6);
        vm.prank(sponsor);
        mandate.registerKey(k, operator, uint64(block.timestamp + 1), 60_000e6);
    }

    function test_registerKey_onlySponsor() public {
        address k = makeAddr("k2");
        address[4] memory callers = [key, operator, stranger, committee];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, callers[i]));
            mandate.registerKey(k, operator, uint64(block.timestamp + 1 days), MAX_INV);
        }
    }

    function test_registerKey_validation() public {
        address k = makeAddr("k2");
        vm.prank(operator);
        mandate.consentKey(k, true);
        vm.startPrank(sponsor);
        vm.expectRevert(MMMandate.ZeroAddress.selector);
        mandate.registerKey(address(0), operator, uint64(block.timestamp + 1), MAX_INV);
        vm.expectRevert(MMMandate.ZeroAddress.selector);
        mandate.registerKey(k, address(0), uint64(block.timestamp + 1), MAX_INV);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.KeyExpired.selector, k));
        mandate.registerKey(k, operator, uint64(block.timestamp), MAX_INV);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.TierBelowMandate.selector, MAX_INV - 1, MAX_INV));
        mandate.registerKey(k, operator, uint64(block.timestamp + 1), MAX_INV - 1);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.KeyAlreadyActive.selector, key));
        mandate.registerKey(key, operator, uint64(block.timestamp + 1), MAX_INV);
        address k3 = makeAddr("k3");
        vm.expectRevert(abi.encodeWithSelector(MMMandate.OperatorConsentMissing.selector, operator, k3));
        mandate.registerKey(k3, operator, uint64(block.timestamp + 1), MAX_INV);
        vm.stopPrank();
    }

    function test_registerKey_revokedConsentBlocks() public {
        address k = makeAddr("k2");
        vm.prank(operator);
        mandate.consentKey(k, true);
        vm.prank(operator);
        mandate.consentKey(k, false);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.OperatorConsentMissing.selector, operator, k));
        mandate.registerKey(k, operator, uint64(block.timestamp + 1), MAX_INV);
    }

    function test_registerKey_consentIsSingleUse() public {
        address k = _newKey("k2");
        vm.prank(sponsor);
        mandate.revokeKey(k, "ROTATE");
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.OperatorConsentMissing.selector, operator, k));
        mandate.registerKey(k, operator, uint64(block.timestamp + 1 days), MAX_INV);
    }

    function test_registerKey_sponsorAsOperatorNeedsNoConsent() public {
        address k = makeAddr("sponsorKey");
        staking.setAvailable(sponsor, BOND);
        vm.prank(sponsor);
        mandate.registerKey(k, sponsor, uint64(block.timestamp + 1 days), MAX_INV);
        assertTrue(mandate.isActiveKey(k));
        assertEq(staking.availableOf(sponsor), 0);
    }

    function test_registerKey_whileKilledReverts() public {
        vm.prank(risk);
        mandate.kill("X");
        vm.prank(sponsor);
        vm.expectRevert(IMMMandate.MandateKilled.selector);
        mandate.registerKey(makeAddr("k2"), operator, uint64(block.timestamp + 1), MAX_INV);
    }

    function test_registerKey_belowEntryTierLocksNothing() public {
        uint256[] memory th = new uint256[](1);
        uint256[] memory bd = new uint256[](1);
        (th[0], bd[0]) = (100_000e6, 25_000e18);
        cfg.setTiers(th, bd);
        address k = makeAddr("k2");
        address op2 = makeAddr("op2");
        vm.prank(op2);
        mandate.consentKey(k, true);
        vm.prank(sponsor);
        mandate.registerKey(k, op2, uint64(block.timestamp + 1 days), 60_000e6);
        assertEq(mandate.bondOf(k), 0);
        assertEq(staking.lockOf(op2, mandate.keyLockId(k)), 0);
        assertTrue(mandate.isActiveKey(k));
    }

    function test_registerKey_tierBondMissing() public {
        address k = makeAddr("k2");
        address poor = makeAddr("poor");
        vm.prank(poor);
        mandate.consentKey(k, true);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.TierBondMissing.selector, poor, BOND, 0));
        mandate.registerKey(k, poor, uint64(block.timestamp + 1 days), MAX_INV);

        // higher tier requires a higher bond
        staking.setAvailable(poor, BOND);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.TierBondMissing.selector, poor, 100_000e18, 0));
        mandate.registerKey(k, poor, uint64(block.timestamp + 1 days), 250_000e6);
    }

    function test_registerKey_tierBondMissing_shortLockOrNotLocker() public {
        address k = makeAddr("k2");
        staking.setAvailable(operator, 1_000_000e18);
        vm.prank(operator);
        mandate.consentKey(k, true);
        staking.setShortLock(true);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.TierBondMissing.selector, operator, BOND, BOND / 2));
        mandate.registerKey(k, operator, uint64(block.timestamp + 1 days), MAX_INV);

        staking.setShortLock(false);
        staking.setLocker(address(mandate), false);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.TierBondMissing.selector, operator, BOND, 0));
        mandate.registerKey(k, operator, uint64(block.timestamp + 1 days), MAX_INV);
    }

    function test_registerKey_maxActiveKeys() public {
        for (uint256 i = 1; i < mandate.MAX_ACTIVE_KEYS(); ++i) {
            _newKey(string.concat("k", vm.toString(i)));
        }
        assertEq(mandate.activeKeys().length, 16);
        address extra = makeAddr("extra");
        vm.prank(operator);
        mandate.consentKey(extra, true);
        vm.prank(sponsor);
        vm.expectRevert(MMMandate.TooManyKeys.selector);
        mandate.registerKey(extra, operator, uint64(block.timestamp + 1 days), MAX_INV);
    }

    // ------------------------------------------------------------------ revokeKey

    function test_revokeKey_byEachAuthorisedParty() public {
        address[5] memory parties = [address(0), operator, sponsor, committee, risk];
        for (uint256 i; i < parties.length; ++i) {
            address k = _newKey(string.concat("rk", vm.toString(i)));
            address by = parties[i] == address(0) ? k : parties[i];
            uint256 availBefore = staking.availableOf(operator);
            vm.expectEmit(true, true, false, true, address(mandate));
            emit KeyRevoked(k, by, "TEST");
            vm.expectEmit(true, true, false, true, address(mandate));
            emit BondReleased(k, operator, BOND);
            vm.prank(by);
            mandate.revokeKey(k, "TEST");
            assertFalse(mandate.isActiveKey(k));
            assertFalse(mandate.getKey(k).active);
            assertEq(mandate.bondOf(k), 0);
            assertEq(staking.availableOf(operator), availBefore + BOND);
            assertEq(desk.sessionKeyValidUntil(k), 0);
        }
        assertEq(mandate.activeKeys().length, 1);
    }

    function test_revokeKey_unauthorised() public {
        address[2] memory callers = [stranger, keeper];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, callers[i]));
            mandate.revokeKey(key, "X");
        }
    }

    function test_revokeKey_expiredByAnyone() public {
        vm.warp(T0 + 30 days + 1);
        assertFalse(mandate.isActiveKey(key));
        vm.prank(stranger);
        mandate.revokeKey(key, "EXPIRED");
        assertEq(mandate.bondOf(key), 0);
    }

    function test_revokeKey_inactiveReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.NotDeskKey.selector, stranger));
        mandate.revokeKey(stranger, "X");
        vm.prank(key);
        mandate.revokeKey(key, "X");
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.NotDeskKey.selector, key));
        mandate.revokeKey(key, "X");
    }

    function test_revokeKey_bondReleaseFailureThenRetry() public {
        staking.setFailUnlock(true);
        vm.expectEmit(true, true, false, true, address(mandate));
        emit BondReleaseFailed(key, operator, BOND);
        vm.prank(sponsor);
        mandate.revokeKey(key, "X");
        assertFalse(mandate.isActiveKey(key));
        assertEq(mandate.bondOf(key), BOND);

        // a pending bond blocks re-registration of the same key
        vm.prank(operator);
        mandate.consentKey(key, true);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.BondPending.selector, key));
        mandate.registerKey(key, operator, uint64(block.timestamp + 1 days), MAX_INV);

        vm.expectRevert(bytes("unlock disabled"));
        mandate.releaseBond(key);

        staking.setFailUnlock(false);
        vm.expectEmit(true, true, false, true, address(mandate));
        emit BondReleased(key, operator, BOND);
        vm.prank(stranger);
        mandate.releaseBond(key);
        assertEq(mandate.bondOf(key), 0);
        assertEq(staking.lockOf(operator, mandate.keyLockId(key)), 0);

        vm.expectRevert(abi.encodeWithSelector(MMMandate.NoBond.selector, key));
        mandate.releaseBond(key);

        // re-registration now works
        vm.prank(sponsor);
        mandate.registerKey(key, operator, uint64(block.timestamp + 1 days), MAX_INV);
        assertTrue(mandate.isActiveKey(key));
        // an active key's bond cannot be released
        vm.expectRevert(abi.encodeWithSelector(MMMandate.NoBond.selector, key));
        mandate.releaseBond(key);
    }

    function test_isActiveKey_expiryAndActiveKeysFilter() public {
        address shortKey = makeAddr("short");
        _registerKey(shortKey, operator, uint64(block.timestamp + 10), MAX_INV);
        assertEq(mandate.activeKeys().length, 2);
        vm.warp(block.timestamp + 10);
        assertTrue(mandate.isActiveKey(shortKey));
        vm.warp(block.timestamp + 1);
        assertFalse(mandate.isActiveKey(shortKey));
        address[] memory ks = mandate.activeKeys();
        assertEq(ks.length, 1);
        assertEq(ks[0], key);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.KeyExpired.selector, shortKey));
        mandate.checkInventoryMove(shortKey, true, BRTypes.ACCOUNT_IF, 1);
    }

    // ------------------------------------------------------------------ kill

    function test_kill_byRiskRevokesAllKeysAndGoesReduceOnly() public {
        address k2 = _newKey("k2");
        address k3 = _newKey("k3");
        vm.expectEmit(true, true, false, true, address(mandate));
        emit Kill("BREACH", risk);
        vm.prank(risk);
        mandate.kill("BREACH");
        assertTrue(mandate.killed());
        assertEq(mandate.killReason(), "BREACH");
        assertEq(mandate.activeKeys().length, 0);
        address[3] memory ks = [key, k2, k3];
        for (uint256 i; i < 3; ++i) {
            assertFalse(mandate.getKey(ks[i]).active);
            assertEq(mandate.bondOf(ks[i]), 0);
            assertEq(desk.sessionKeyValidUntil(ks[i]), 0);
        }
        assertEq(staking.lockOf(operator, mandate.keyLockId(key)), 0);
        assertTrue(adapter.reduceOnly());
        assertEq(book.lastKill(), "BREACH");
        assertEq(book.killCount(), 1);
    }

    function test_kill_byBook() public {
        book.callKill("DRAWDOWN");
        assertTrue(mandate.killed());
        assertEq(book.lastKill(), "DRAWDOWN");
    }

    function test_kill_unauthorisedAndTwice() public {
        address[4] memory callers = [stranger, key, sponsor, committee];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, callers[i]));
            mandate.kill("X");
        }
        vm.prank(risk);
        mandate.kill("X");
        vm.prank(risk);
        vm.expectRevert(IMMMandate.MandateKilled.selector);
        mandate.kill("Y");
    }

    function test_kill_cannotBeBlockedBySiblingFailures() public {
        adapter.setRevertReduceOnly(true);
        book.setRevertOnKill(true);
        staking.setFailUnlock(true);
        vm.expectEmit(true, true, false, true, address(mandate));
        emit BondReleaseFailed(key, operator, BOND);
        vm.expectEmit(false, false, false, false, address(mandate));
        emit ReduceOnlyRequestFailed();
        vm.expectEmit(false, false, false, true, address(mandate));
        emit BookKillNotifyFailed("BREACH");
        vm.prank(risk);
        mandate.kill("BREACH");
        assertTrue(mandate.killed());
        assertFalse(mandate.isActiveKey(key));
        assertEq(mandate.bondOf(key), BOND);
    }

    function test_kill_orderlyBookDoesNotTouchAdapter() public {
        _deployBook(BRTypes.VENUE_ORDERLY);
        _registerDefaultKey();
        vm.prank(risk);
        mandate.kill("BREACH");
        assertEq(adapter.reduceOnlyCalls(), 0);
        assertEq(book.lastKill(), "BREACH");
    }

    function test_kill_blocksRiskAddingPaths() public {
        vm.prank(risk);
        mandate.kill("BREACH");
        assertFalse(mandate.isActiveKey(key));
        vm.expectRevert(IMMMandate.MandateKilled.selector);
        mandate.checkQuote(key, 10, 0, 1);
        vm.expectRevert(IMMMandate.MandateKilled.selector);
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_MM, 1);
        vm.expectRevert(IMMMandate.MandateKilled.selector);
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, true, 1, 1, 100), _proof(address(nvda), UNIV3));
        vm.expectRevert(IMMMandate.MandateKilled.selector);
        mandate.checkFundDesk(key, 1);
        // recalls stay open for RISK / KEEPER / book
        mandate.checkInventoryMove(risk, false, BRTypes.ACCOUNT_MM, 1);
        mandate.checkInventoryMove(keeper, false, BRTypes.ACCOUNT_IF, 1);
        mandate.checkInventoryMove(address(book), false, BRTypes.ACCOUNT_IF, 1);
        vm.expectRevert(IMMMandate.MandateKilled.selector);
        mandate.checkInventoryMove(stranger, false, BRTypes.ACCOUNT_IF, 1);
    }

    // ------------------------------------------------------------------ remandate

    function _newTerms() internal view returns (BRTypes.Mandate memory m) {
        m = _defaultMandate();
        m.maxInventoryUsd = 60_000e6;
        m.maxSkewBps = 30;
    }

    function test_remandate_onlyCommittee() public {
        address[4] memory callers = [stranger, sponsor, risk, key];
        BRTypes.Mandate memory m = _newTerms();
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, callers[i]));
            mandate.remandate(m);
        }
    }

    function test_remandate_rejectsBadTerms() public {
        BRTypes.Mandate[6] memory bad;
        for (uint256 i; i < 6; ++i) {
            bad[i] = _newTerms();
        }
        bad[0].maxInventoryUsd = 0;
        bad[1].minQuoteWidthBps = 0;
        bad[2].hedgeRatioMinBps = 13_000;
        bad[3].killAtDrawdownBps = 0;
        bad[4].killAtDrawdownBps = -5001;
        bad[5].maxSkewBps = 0;
        for (uint256 i; i < 6; ++i) {
            assertEq(mandate.validateMandate(bad[i]), "BAD_MANDATE");
            vm.prank(committee);
            vm.expectRevert(abi.encodeWithSelector(MMMandate.InvalidMandate.selector, bytes32("BAD_MANDATE")));
            mandate.remandate(bad[i]);
        }
        BRTypes.Mandate memory edge = _newTerms();
        edge.killAtDrawdownBps = -5000;
        edge.hedgeRatioMinBps = edge.hedgeRatioMaxBps;
        assertEq(mandate.validateMandate(edge), bytes32(0));
    }

    function test_remandate_clearsKillAndRequiresReRegistration() public {
        vm.prank(risk);
        mandate.kill("BREACH");
        BRTypes.Mandate memory m = _newTerms();
        vm.expectEmit(false, false, false, true, address(mandate));
        emit Remandated(keccak256(abi.encode(m)));
        vm.prank(committee);
        mandate.remandate(m);
        assertFalse(mandate.killed());
        assertEq(mandate.killReason(), bytes32(0));
        assertEq(mandate.getMandate().maxInventoryUsd, 60_000e6);
        assertEq(mandate.getMandate().maxSkewBps, 30);
        // engine reduce-only stays latched until RISK lifts it
        assertTrue(adapter.reduceOnly());
        assertFalse(mandate.isActiveKey(key));

        vm.prank(operator);
        mandate.consentKey(key, true);
        vm.prank(sponsor);
        vm.expectRevert(
            abi.encodeWithSelector(MMMandate.TierBelowMandate.selector, MAX_INV, uint128(60_000e6))
        );
        mandate.registerKey(key, operator, uint64(block.timestamp + 1 days), MAX_INV);
        vm.prank(sponsor);
        mandate.registerKey(key, operator, uint64(block.timestamp + 1 days), 60_000e6);
        assertTrue(mandate.isActiveKey(key));
    }

    function test_remandate_liveBookRevokesKeys() public {
        vm.expectEmit(true, true, false, true, address(mandate));
        emit KeyRevoked(key, committee, "REMANDATE");
        vm.prank(committee);
        mandate.remandate(_newTerms());
        assertFalse(mandate.isActiveKey(key));
        assertEq(mandate.bondOf(key), 0);
        assertEq(desk.sessionKeyValidUntil(key), 0);
    }

    // ------------------------------------------------------------------ retiring

    function test_setRetiring_onlyBookIdempotent() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, stranger));
        mandate.setRetiring();
        vm.prank(risk);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.Unauthorized.selector, risk));
        mandate.setRetiring();

        vm.expectEmit(true, false, false, false, address(mandate));
        emit RetiringSet(address(book));
        book.callSetRetiring();
        assertTrue(mandate.retiring());
        assertTrue(adapter.reduceOnly());
        assertTrue(mandate.isActiveKey(key));
        book.callSetRetiring();
        assertEq(adapter.reduceOnlyCalls(), 1);
    }

    function test_setRetiring_adapterFailureEvented() public {
        adapter.setRevertReduceOnly(true);
        vm.expectEmit(false, false, false, false, address(mandate));
        emit ReduceOnlyRequestFailed();
        book.callSetRetiring();
        assertTrue(mandate.retiring());
    }

    // ------------------------------------------------------------------ offHours

    function test_offHours_regimes() public {
        assertFalse(mandate.offHours());
        oracle.setHeld(NVDA_ID, true);
        assertTrue(mandate.offHours());
        oracle.setHeld(NVDA_ID, false);
        vm.warp(T0 + 300);
        assertFalse(mandate.offHours());
        vm.warp(T0 + 301);
        assertTrue(mandate.offHours());
        // publishedAt slightly in the future (oracle allows +5s)
        oracle.set(NVDA_ID, NVDA_PX, uint64(block.timestamp + 5), false);
        assertFalse(mandate.offHours());
        // never published
        oracle.set(NVDA_ID, 0, 0, false);
        assertTrue(mandate.offHours());
    }

    function test_offHours_unknownUnderlyingFailsSafe() public {
        MMMandate m = _mandateWithUnderlying(bytes32(uint256(uint160(stranger))));
        assertTrue(m.offHours());
    }

    // ------------------------------------------------------------------ checkInventoryMove

    function test_inventoryMove_toVenueCapacity() public {
        adapter.setEquity(20_000e6, 90_000e6);
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_IF, 5000e6);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, 25_000e6 + 1, IF_TARGET));
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_IF, 5000e6 + 1);
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_MM, 10_000e6);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, 100_000e6 + 1, MM_INV));
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_MM, 10_000e6 + 1);
        // negative margin equity counts as 0
        adapter.setEquity(0, -5000e6);
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_MM, MM_INV);
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, uint256(MM_INV) + 1, MM_INV)
        );
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_MM, uint256(MM_INV) + 1);
    }

    function test_inventoryMove_badAccount() public {
        vm.expectRevert(abi.encodeWithSelector(MMMandate.BadAccount.selector, uint8(2)));
        mandate.checkInventoryMove(key, true, 2, 1);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.BadAccount.selector, uint8(2)));
        mandate.checkInventoryMove(risk, false, 2, 1);
    }

    function test_inventoryMove_offHoursAndRetiringBlockToVenueOnly() public {
        oracle.setHeld(NVDA_ID, true);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_MM, 1);
        mandate.checkInventoryMove(key, false, BRTypes.ACCOUNT_MM, 1);
        oracle.setHeld(NVDA_ID, false);

        book.callSetRetiring();
        vm.expectRevert(MMMandate.MandateRetiring.selector);
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_IF, 1);
        mandate.checkInventoryMove(key, false, BRTypes.ACCOUNT_IF, 1);
    }

    function test_inventoryMove_offHoursFlagDisabled() public {
        BRTypes.Mandate memory m = _defaultMandate();
        m.noNewRiskOffHours = false;
        vm.prank(committee);
        mandate.remandate(m);
        _registerKey(key, operator, uint64(block.timestamp + 1 days), MAX_INV);
        oracle.setHeld(NVDA_ID, true);
        mandate.checkInventoryMove(key, true, BRTypes.ACCOUNT_MM, 1);
    }

    function test_inventoryMove_callers() public {
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.NotDeskKey.selector, stranger));
        mandate.checkInventoryMove(stranger, true, BRTypes.ACCOUNT_IF, 1);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.NotDeskKey.selector, risk));
        mandate.checkInventoryMove(risk, true, BRTypes.ACCOUNT_IF, 1);
        mandate.checkInventoryMove(key, false, BRTypes.ACCOUNT_IF, type(uint256).max);
        mandate.checkInventoryMove(risk, false, BRTypes.ACCOUNT_IF, 1);
        mandate.checkInventoryMove(keeper, false, BRTypes.ACCOUNT_IF, 1);
        mandate.checkInventoryMove(address(book), false, BRTypes.ACCOUNT_MM, 1);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.NotDeskKey.selector, stranger));
        mandate.checkInventoryMove(stranger, false, BRTypes.ACCOUNT_IF, 1);
    }

    // ------------------------------------------------------------------ checkQuote

    function test_checkQuote_boundaries() public view {
        mandate.checkQuote(key, 8, 25, MAX_INV);
        mandate.checkQuote(key, 8, -25, 0);
        mandate.checkQuote(key, type(uint16).max, 0, 1);
    }

    function test_checkQuote_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.QuoteWidthTooNarrow.selector, uint16(7), uint16(8)));
        mandate.checkQuote(key, 7, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.SkewTooWide.selector, int16(26), int16(25)));
        mandate.checkQuote(key, 10, 26, 1);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.SkewTooWide.selector, int16(-26), int16(25)));
        mandate.checkQuote(key, 10, -26, 1);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.SkewTooWide.selector, type(int16).min, int16(25)));
        mandate.checkQuote(key, 10, type(int16).min, 1);
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, uint256(MAX_INV) + 1, MAX_INV)
        );
        mandate.checkQuote(key, 10, 0, MAX_INV + 1);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.NotDeskKey.selector, stranger));
        mandate.checkQuote(stranger, 10, 0, 1);
    }

    function test_checkQuote_orderlyBookReverts() public {
        _deployBook(BRTypes.VENUE_ORDERLY);
        _registerDefaultKey();
        vm.expectRevert(MMMandate.NotEngineBook.selector);
        mandate.checkQuote(key, 10, 0, 1);
    }

    function test_checkQuote_offHoursForbidsAddingRiskCapacity() public {
        engine.setQuote(1, 20, 0, 30_000e6);
        oracle.setHeld(NVDA_ID, true);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        mandate.checkQuote(key, 19, 0, 30_000e6);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        mandate.checkQuote(key, 20, 0, 30_000e6 + 1);
        mandate.checkQuote(key, 20, 5, 30_000e6);
        mandate.checkQuote(key, 40, -5, 10_000e6);
        // stale counts as off-hours
        oracle.setHeld(NVDA_ID, false);
        vm.warp(block.timestamp + 301);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        mandate.checkQuote(key, 19, 0, 1);
    }

    function test_checkQuote_retiringForbidsAddingRiskCapacity() public {
        engine.setQuote(1, 20, 0, 30_000e6);
        book.callSetRetiring();
        vm.expectRevert(MMMandate.MandateRetiring.selector);
        mandate.checkQuote(key, 10, 0, 30_000e6);
        vm.expectRevert(MMMandate.MandateRetiring.selector);
        mandate.checkQuote(key, 20, 0, 40_000e6);
        mandate.checkQuote(key, 25, 0, 0);
    }

    function test_checkQuote_unreadableEngineFailsClosedOffHours() public {
        engine.setBroken(true);
        mandate.checkQuote(key, 100, 0, 1);
        oracle.setHeld(NVDA_ID, true);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        mandate.checkQuote(key, 100, 0, 0);
    }

    // ------------------------------------------------------------------ checkFundDesk

    function test_checkFundDesk_cap() public {
        uint256 cap = uint256(MAX_INV) * 12_000 / 10_000;
        mandate.checkFundDesk(key, cap);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, cap + 1, cap));
        mandate.checkFundDesk(key, cap + 1);
        _fundDesk(10_000e6);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, cap + 1, cap));
        mandate.checkFundDesk(key, cap - 10_000e6 + 1);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.NotDeskKey.selector, stranger));
        mandate.checkFundDesk(stranger, 1);
    }

    function test_checkFundDesk_offHoursAndRetiring() public {
        oracle.setHeld(NVDA_ID, true);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        mandate.checkFundDesk(key, 1);
        oracle.setHeld(NVDA_ID, false);
        book.callSetRetiring();
        vm.expectRevert(MMMandate.MandateRetiring.selector);
        mandate.checkFundDesk(key, 1);
    }

    // ------------------------------------------------------------------ checkHedge

    function test_checkHedge_inBand() public {
        adapter.setExposure(-20_000e6);
        mandate.checkHedge(
            key, _hp(address(nvda), UNIV3, true, 1e18, 15_000e6, 100), _proof(address(nvda), UNIV3)
        );
    }

    function test_checkHedge_spotRules() public {
        adapter.setExposure(-20_000e6);
        bytes32[] memory p = _proof(address(nvda), UNIV3);
        vm.expectRevert(IMMMandate.SpotShortNotAllowed.selector);
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, false, 1, 1, 100), p);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.FloatCapExceeded.selector, 1000e18 + 1, 1000e18));
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, true, 1000e18 + 1, 15_000e6, 100), p);

        bytes32 rogue = bytes32(uint256(uint160(stranger)));
        vm.expectRevert(abi.encodeWithSelector(MMMandate.NotCanonicalToken.selector, rogue));
        mandate.checkHedge(key, IMMMandate.HedgeParams(rogue, UNIV3, true, 1, 1, 100), p);
        bytes32 symbolLike = "PERP_NVDA_USDC";
        vm.expectRevert(abi.encodeWithSelector(MMMandate.NotCanonicalToken.selector, symbolLike));
        mandate.checkHedge(key, IMMMandate.HedgeParams(symbolLike, UNIV4, true, 1, 1, 100), p);

        vm.prank(timelock);
        registry.setActive(address(nvda), false);
        vm.expectRevert(abi.encodeWithSelector(MMMandate.NotCanonicalToken.selector, _asset(address(nvda))));
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, true, 1, 15_000e6, 100), p);
    }

    function test_checkHedge_leverageAndAllowList() public {
        adapter.setExposure(-20_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.HedgeLeverageTooHigh.selector, uint16(301), uint16(300))
        );
        mandate.checkHedge(
            key, _hp(address(nvda), V_ENGINE, true, 1, 15_000e6, 301), _proof(address(nvda), V_ENGINE)
        );
        mandate.checkHedge(
            key, _hp(address(nvda), V_ENGINE, true, 1, 15_000e6, 300), _proof(address(nvda), V_ENGINE)
        );

        // proof for a different leaf
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.HedgeNotAllowed.selector, _asset(address(nvda)), V_ENGINE)
        );
        mandate.checkHedge(
            key, _hp(address(nvda), V_ENGINE, true, 1, 15_000e6, 100), _proof(address(nvda), UNIV3)
        );
        // pair not in the tree
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.HedgeNotAllowed.selector, _asset(address(tsla)), V_ORDERLY)
        );
        mandate.checkHedge(
            key, _hp(address(tsla), V_ORDERLY, true, 1, 15_000e6, 100), _proof(address(nvda), V_ORDERLY)
        );
        // empty proof
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.HedgeNotAllowed.selector, _asset(address(nvda)), UNIV3)
        );
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, true, 1, 15_000e6, 100), new bytes32[](0));
    }

    function test_checkHedge_bandRule() public {
        adapter.setExposure(-20_000e6);
        bytes32[] memory p = _proof(address(nvda), V_ENGINE);
        // 0 -> 15000 bps: out of band but strictly closer than 0 (dist 3000 < 5000)
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 30_000e6, 100), p);
        // 0 -> 20000 bps: farther (8000 > 5000)
        vm.expectRevert(
            abi.encodeWithSelector(
                IMMMandate.HedgeRatioOutOfBand.selector, uint256(20_000), uint256(5000), uint256(12_000)
            )
        );
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 40_000e6, 100), p);
        // 0 -> 2000 bps: closer (3000 < 5000)
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 4000e6, 100), p);
        // a sell from 0 hedge -> negative hedge: ratio 0 both sides, not strictly closer
        vm.expectRevert(
            abi.encodeWithSelector(
                IMMMandate.HedgeRatioOutOfBand.selector, uint256(0), uint256(5000), uint256(12_000)
            )
        );
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, false, 1, 1000e6, 100), p);
    }

    function test_checkHedge_bandRuleFromInBand() public {
        _seedHedge(-20_000e6, 15_000e6); // ratio ~7500
        bytes32[] memory p = _proof(address(nvda), V_ENGINE);
        int256 h = desk.hedgeNotionalUsd();
        // in band -> above band is rejected (dist grows from 0)
        uint256 add = uint256(25_000e6 - h);
        vm.expectRevert(
            abi.encodeWithSelector(
                IMMMandate.HedgeRatioOutOfBand.selector, uint256(12_500), uint256(5000), uint256(12_000)
            )
        );
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, add, 100), p);
        // staying inside is fine
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 5000e6, 100), p);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, false, 1, 4000e6, 100), p);
    }

    function test_checkHedge_belowThresholdNotEnforced() public {
        adapter.setExposure(-2499e6); // < 5% of 50k
        bytes32[] memory p = _proof(address(nvda), V_ENGINE);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 40_000e6, 100), p);
        adapter.setExposure(0);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 40_000e6, 100), p);
    }

    function test_checkHedge_longExposureNotOffsetBySpot() public {
        adapter.setExposure(20_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IMMMandate.HedgeRatioOutOfBand.selector, uint256(0), uint256(5000), uint256(12_000)
            )
        );
        mandate.checkHedge(key, _hp(address(nvda), UNIV3, true, 1, 1000e6, 100), _proof(address(nvda), UNIV3));
    }

    function test_checkHedge_offHours() public {
        bytes32[] memory p = _proof(address(nvda), V_ENGINE);
        oracle.setHeld(NVDA_ID, true);
        // short venue + long hedge reduces |net|
        adapter.setExposure(-20_000e6);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 15_000e6, 100), p);
        // overshooting past flat adds net risk
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 40_000e6 + 1, 100), p);
        // long venue + long hedge adds risk
        adapter.setExposure(20_000e6);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 1, 100), p);
    }

    function test_checkHedge_orderlyStaleReportRule() public {
        _deployBook(BRTypes.VENUE_ORDERLY);
        _registerDefaultKey();
        adapter.setExposure(-20_000e6);
        bytes32[] memory p = _proof(address(nvda), V_ENGINE);
        uint256 maxAge = 300 * 4;
        adapter.report(uint64(block.timestamp - maxAge));
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 15_000e6, 100), p);
        adapter.report(uint64(block.timestamp - maxAge - 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                MMMandate.StaleVenueReport.selector, uint64(block.timestamp - maxAge - 1), maxAge
            )
        );
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 15_000e6, 100), p);
    }

    function test_checkHedge_retiringOnlyShrinks() public {
        _seedHedge(-20_000e6, 15_000e6);
        book.callSetRetiring();
        bytes32[] memory p = _proof(address(nvda), V_ENGINE);
        vm.expectRevert(MMMandate.MandateRetiring.selector);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, true, 1, 1000e6, 100), p);
        mandate.checkHedge(key, _hp(address(nvda), V_ENGINE, false, 1, 1000e6, 100), p);
    }

    function test_checkHedgeExecuted_floatCapOnBuysOnly() public {
        adapter.setExposure(-20_000e6);
        bytes32[] memory p = _proof(address(nvda), UNIV3);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.FloatCapExceeded.selector, 1000e18 + 1, 1000e18));
        mandate.checkHedgeExecuted(
            key, _hp(address(nvda), UNIV3, true, 1, 1, 100), p, 0, 15_000e6, 1000e18 + 1
        );
        // a sell while above a (lowered) cap is allowed: it reduces inventory
        mandate.checkHedgeExecuted(
            key, _hp(address(nvda), UNIV3, false, 1, 1, 100), p, 16_000e6, 15_000e6, 2000e18
        );
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.NotDeskKey.selector, stranger));
        mandate.checkHedgeExecuted(stranger, _hp(address(nvda), UNIV3, true, 1, 1, 100), p, 0, 15_000e6, 1);
    }

    // ------------------------------------------------------------------ views

    function test_hedgeRatioBps_view() public {
        assertEq(mandate.hedgeRatioBps(), type(uint256).max);
        _seedHedge(-20_000e6, 15_000e6);
        int256 h = desk.hedgeNotionalUsd();
        assertEq(mandate.deskHedgeNotionalUsd(), h);
        assertEq(mandate.hedgeRatioBps(), uint256(h) * 10_000 / 20_000e6);
        adapter.setExposure(20_000e6);
        assertEq(mandate.hedgeRatioBps(), 0);
        adapter.setExposure(-1000e6);
        assertEq(mandate.hedgeRatioBps(), type(uint256).max);
    }

    function test_allowLeaf_isStandardMerkleLeaf() public view {
        bytes32 a = _asset(address(nvda));
        assertEq(mandate.allowLeaf(a, UNIV3), keccak256(bytes.concat(keccak256(abi.encode(a, UNIV3)))));
    }
}
