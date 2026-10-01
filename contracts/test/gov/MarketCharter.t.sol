// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IMarketCharter} from "../../src/interfaces/IMarketCharter.sol";
import {MarketCharter} from "../../src/MarketCharter.sol";

import {GovBase} from "./utils/GovBase.sol";
import {GovMockStaking, GovMockBook, GovMockBookNoFlag, GovNullFactory} from "./utils/GovMocks.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

contract MarketCharterTest is GovBase {
    // ------------------------------------------------------------------------------------------
    // constructor / views
    // ------------------------------------------------------------------------------------------

    function test_constructor_zeroConfigReverts() public {
        vm.expectRevert(MarketCharter.ZeroAddress.selector);
        new MarketCharter(address(0));
    }

    function test_views_unknownCharter() public view {
        IMarketCharter.CharterRecord memory r = charter.get(42);
        assertEq(uint8(r.status), uint8(BRTypes.CharterStatus.None));
        assertEq(charter.count(), 0);
        assertEq(charter.decisionDeadline(42), 0);
        assertFalse(charter.isOpen(42));
    }

    function test_bondLockId_isDistinctAndDeterministic() public view {
        assertEq(charter.bondLockId(1), keccak256(abi.encode(charter.SPONSOR_BOND_DOMAIN(), uint256(1))));
        assertTrue(charter.bondLockId(1) != charter.bondLockId(2));
    }

    // ------------------------------------------------------------------------------------------
    // file
    // ------------------------------------------------------------------------------------------

    function test_file_storesRecordPullsFeeLocksBond() public {
        BRTypes.Charter memory c = _charter();
        uint256 sponsorUsdcBefore = usdc.balanceOf(sponsor);

        vm.expectEmit(true, true, false, true, address(charter));
        emit IMarketCharter.CharterFiled(1, sponsor, c.underlying, c.venue, c.symbol, FEE, SPONSOR_BOND);
        uint256 id = _file(c);

        assertEq(id, 1, "ids start at 1");
        assertEq(charter.count(), 1);
        IMarketCharter.CharterRecord memory r = charter.get(id);
        assertEq(uint8(r.status), uint8(BRTypes.CharterStatus.Filed));
        assertEq(r.filedAt, block.timestamp);
        assertEq(r.decidedAt, 0);
        assertEq(r.juryCid, bytes32(0));
        assertEq(r.feePaidUsd, FEE);
        assertEq(r.bondBkrn, SPONSOR_BOND);
        assertEq(r.book, address(0));
        assertEq(keccak256(abi.encode(r.charter)), keccak256(abi.encode(c)), "charter stored verbatim");

        assertEq(usdc.balanceOf(address(charter)), FEE, "fee escrowed");
        assertEq(usdc.balanceOf(sponsor), sponsorUsdcBefore - FEE);
        assertEq(staking.lockOf(sponsor, charter.bondLockId(id)), SPONSOR_BOND, "bond locked");
        assertEq(staking.lockerOf(sponsor, charter.bondLockId(id)), address(charter));
        assertEq(charter.bondOutstanding(id), SPONSOR_BOND);
        assertEq(charter.decisionDeadline(id), block.timestamp + WINDOW);
        assertTrue(charter.isOpen(id));
    }

    function test_file_idsIncrement() public {
        assertEq(_file(), 1);
        assertEq(_file(), 2);
        assertEq(_file(_engineCharter()), 3);
        assertEq(charter.count(), 3);
        assertEq(usdc.balanceOf(address(charter)), 3 * FEE);
        assertEq(staking.lockedOf(sponsor), 3 * SPONSOR_BOND);
    }

    function test_file_revertsWhenNewBooksPaused() public {
        cfg.setNewBooksPaused(true);
        BRTypes.Charter memory c = _charter();
        vm.prank(sponsor);
        vm.expectRevert(IMarketCharter.NewBooksPaused.selector);
        charter.file(c);
    }

    function test_file_revertsWhenCallerIsNotSponsor() public {
        BRTypes.Charter memory c = _charter();
        vm.prank(outsider);
        vm.expectRevert(IMarketCharter.NotSponsor.selector);
        charter.file(c);
    }

    function test_file_revertsOnInvalidCharter() public {
        BRTypes.Charter memory c = _charter();
        c.symbol = bytes32(0);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(IMarketCharter.InvalidCharter.selector, bytes32("BAD_SYMBOL")));
        charter.file(c);
    }

    function test_file_revertsWithoutFeeAllowance() public {
        vm.prank(sponsor);
        usdc.approve(address(charter), FEE - 1);
        BRTypes.Charter memory c = _charter();
        vm.prank(sponsor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(charter), FEE - 1, FEE
            )
        );
        charter.file(c);
    }

    function test_file_revertsWithoutAvailableStake() public {
        address poor = makeAddr("poor sponsor");
        usdc.mint(poor, FEE);
        vm.prank(poor);
        usdc.approve(address(charter), FEE);
        BRTypes.Charter memory c = _charterFor(poor);
        vm.prank(poor);
        vm.expectRevert(GovMockStaking.Insufficient.selector);
        charter.file(c);
    }

    function test_file_revertsWhenCharterNotALocker() public {
        vm.prank(timelock);
        staking.setLocker(address(charter), false);
        BRTypes.Charter memory c = _charter();
        vm.prank(sponsor);
        vm.expectRevert(GovMockStaking.NotLocker.selector);
        charter.file(c);
    }

    function test_file_zeroFeeAndZeroBondSkipTransfers() public {
        cfg.setCharterFee(0);
        cfg.setSponsorBond(0);
        uint256 id = _file();
        assertEq(usdc.balanceOf(address(charter)), 0);
        assertEq(staking.lockedOf(sponsor), 0);
        assertEq(charter.get(id).feePaidUsd, 0);
        // reject path also skips the transfers
        vm.prank(address(committee));
        charter.decide(id, false, bytes32(0));
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Rejected));
    }

    function testFuzz_file_feeAndBondFollowConfig(uint256 fee, uint256 bond) public {
        fee = bound(fee, 0, 1_000_000e6);
        bond = bound(bond, 0, 1_000_000e18);
        cfg.setCharterFee(fee);
        cfg.setSponsorBond(bond);
        uint256 id = _file();
        assertEq(usdc.balanceOf(address(charter)), fee);
        assertEq(staking.lockOf(sponsor, charter.bondLockId(id)), bond);
        assertEq(charter.get(id).feePaidUsd, fee);
        assertEq(charter.get(id).bondBkrn, bond);
    }

    function test_escrowPinnedAcrossConfigChanges() public {
        uint256 usdcBefore = usdc.balanceOf(sponsor);
        uint256 id = _file();
        MarketCharter.Escrow memory e = charter.escrowOf(id);
        assertEq(e.feeToken, address(usdc));
        assertEq(e.staking, address(staking));
        assertEq(e.bondOutstanding, SPONSOR_BOND);

        // timelock migrates USDC + staking while the charter is under review
        MockERC20 usdc2 = new MockERC20("USD Coin v2", "USDC2", 6);
        GovMockStaking staking2 = new GovMockStaking(address(cfg), address(bkrn));
        cfg.setUsdc(address(usdc2));
        cfg.setStaking(address(staking2));

        vm.prank(address(committee));
        charter.decide(id, false, CID);
        assertEq(usdc.balanceOf(sponsor), usdcBefore, "refund in the token that was escrowed");
        assertEq(staking.lockedOf(sponsor), 0, "unlocked in the staking that holds the lock");
    }

    function test_escrowPinned_slashAndForwardUseFilingContracts() public {
        uint256 id = _file();
        MockERC20 usdc2 = new MockERC20("USD Coin v2", "USDC2", 6);
        GovMockStaking staking2 = new GovMockStaking(address(cfg), address(bkrn));
        vm.prank(timelock);
        staking2.setLocker(address(charter), true);
        cfg.setUsdc(address(usdc2));
        cfg.setStaking(address(staking2));

        vm.prank(address(committee));
        charter.decide(id, true, CID);
        assertEq(usdc.balanceOf(expenseRecipient), FEE, "forwarded in the escrowed token");

        GovMockBook book = _book(id);
        book.setSponsorAbandoned(true);
        vm.prank(address(committee));
        charter.slashSponsor(id, "ABANDONED");
        assertEq(bkrn.balanceOf(slashRecipient), SPONSOR_BOND, "slashed in the original staking");
        assertEq(staking.lockedOf(sponsor), 0);
    }

    // ------------------------------------------------------------------------------------------
    // validate — every reason code, with boundaries
    // ------------------------------------------------------------------------------------------

    function _reason(BRTypes.Charter memory c) internal view returns (bytes32) {
        return charter.validate(c);
    }

    function test_validate_validCharters() public view {
        assertEq(_reason(_charter()), bytes32(0));
        assertEq(_reason(_engineCharter()), bytes32(0));
    }

    function test_validate_badVenue() public view {
        BRTypes.Charter memory c = _charter();
        c.venue = 2;
        assertEq(_reason(c), bytes32("BAD_VENUE"));
        c.venue = type(uint8).max;
        assertEq(_reason(c), bytes32("BAD_VENUE"));
        // venue is checked before the per-venue IF minimum
        c.ifTargetUsd = 0;
        assertEq(_reason(c), bytes32("BAD_VENUE"));
    }

    function test_validate_ifBelowVenueMin() public view {
        BRTypes.Charter memory c = _charter();
        c.ifTargetUsd = uint128(ORDERLY_MIN_IF - 1);
        assertEq(_reason(c), bytes32("IF_BELOW_VENUE_MIN"));
        c.ifTargetUsd = uint128(ORDERLY_MIN_IF);
        assertEq(_reason(c), bytes32(0));

        BRTypes.Charter memory e = _engineCharter();
        e.ifTargetUsd = uint128(ENGINE_MIN_IF - 1);
        assertEq(_reason(e), bytes32("IF_BELOW_VENUE_MIN"));
        e.ifTargetUsd = uint128(ENGINE_MIN_IF);
        assertEq(_reason(e), bytes32(0));
    }

    function test_validate_badOracle() public view {
        BRTypes.Charter memory c = _charter();
        c.oracle = 2;
        assertEq(_reason(c), bytes32("BAD_ORACLE"));
        c.oracle = BRTypes.ORACLE_CHAINLINK;
        assertEq(_reason(c), bytes32(0));
    }

    function test_validate_badBps() public view {
        BRTypes.Charter memory c = _charter();
        c.seniorHurdleBps = 10_001;
        assertEq(_reason(c), bytes32("BAD_BPS"));
        c.seniorHurdleBps = 10_000;
        assertEq(_reason(c), bytes32(0));
        c.seniorHurdleBps = 0;
        assertEq(_reason(c), bytes32(0));

        c.seniorCapBps = 10_001;
        assertEq(_reason(c), bytes32("BAD_BPS"));
        c.seniorCapBps = 0;
        assertEq(_reason(c), bytes32("BAD_BPS"));
        c.seniorCapBps = 10_000;
        assertEq(_reason(c), bytes32(0));
        c.seniorCapBps = 1;
        assertEq(_reason(c), bytes32(0));
    }

    function test_validate_badWindow() public view {
        BRTypes.Charter memory c = _charter();
        c.subscriptionWindow = 59;
        assertEq(_reason(c), bytes32("BAD_WINDOW"));
        c.subscriptionWindow = 0;
        assertEq(_reason(c), bytes32("BAD_WINDOW"));
        c.subscriptionWindow = 60;
        assertEq(_reason(c), bytes32(0));
        c.subscriptionWindow = 30 days;
        assertEq(_reason(c), bytes32(0));
        c.subscriptionWindow = 30 days + 1;
        assertEq(_reason(c), bytes32("BAD_WINDOW"));
    }

    function test_validate_badNotice() public view {
        BRTypes.Charter memory c = _charter();
        c.juniorNoticeSeconds = 30 days + 1;
        assertEq(_reason(c), bytes32("BAD_NOTICE"));
        c.juniorNoticeSeconds = 30 days;
        assertEq(_reason(c), bytes32(0));
        c.juniorNoticeSeconds = 0;
        assertEq(_reason(c), bytes32(0));
    }

    function test_validate_badMandate() public view {
        BRTypes.Charter memory c;

        c = _charter();
        c.mandate.maxInventoryUsd = 0;
        assertEq(_reason(c), bytes32("BAD_MANDATE"), "maxInventory 0");

        c = _charter();
        c.mandate.minQuoteWidthBps = 0;
        assertEq(_reason(c), bytes32("BAD_MANDATE"), "min width 0");

        c = _charter();
        c.mandate.hedgeRatioMinBps = 12_001;
        assertEq(_reason(c), bytes32("BAD_MANDATE"), "band min > max");
        c.mandate.hedgeRatioMinBps = 12_000;
        assertEq(_reason(c), bytes32(0), "band min == max ok");

        c = _charter();
        c.mandate.killAtDrawdownBps = 0;
        assertEq(_reason(c), bytes32("BAD_MANDATE"), "kill 0");
        c.mandate.killAtDrawdownBps = 1;
        assertEq(_reason(c), bytes32("BAD_MANDATE"), "kill positive");
        c.mandate.killAtDrawdownBps = -5001;
        assertEq(_reason(c), bytes32("BAD_MANDATE"), "kill < -5000");
        c.mandate.killAtDrawdownBps = -5000;
        assertEq(_reason(c), bytes32(0), "kill -5000 ok");
        c.mandate.killAtDrawdownBps = -1;
        assertEq(_reason(c), bytes32(0), "kill -1 ok");

        c = _charter();
        c.mandate.maxSkewBps = 0;
        assertEq(_reason(c), bytes32("BAD_MANDATE"), "skew 0");
        c.mandate.maxSkewBps = -1;
        assertEq(_reason(c), bytes32("BAD_MANDATE"), "skew negative");
        c.mandate.maxSkewBps = 1;
        assertEq(_reason(c), bytes32(0), "skew 1 ok");
    }

    function test_validate_badUnderlying() public {
        BRTypes.Charter memory c = _charter();
        c.underlying = bytes32(uint256(uint160(makeAddr("not canonical"))));
        assertEq(_reason(c), bytes32("BAD_UNDERLYING"), "non-canonical token");

        c.underlying = bytes32(0);
        assertEq(_reason(c), bytes32("BAD_UNDERLYING"), "zero underlying");

        c.underlying = keccak256("BKRN.INDEX.UNKNOWN");
        assertEq(_reason(c), bytes32("BAD_UNDERLYING"), "unregistered index");

        // a registered index id is accepted only through isIndex, a token only through isCanonical
        registry.setCanonical(address(uint160(uint256(RHX5))), true);
        registry.setIndex(RHX5, false);
        c.underlying = RHX5;
        assertEq(_reason(c), bytes32("BAD_UNDERLYING"), "index id never treated as a token");

        registry.setCanonical(nvda, false);
        registry.setIndex(bytes32(uint256(uint160(nvda))), true);
        c.underlying = bytes32(uint256(uint160(nvda)));
        assertEq(_reason(c), bytes32("BAD_UNDERLYING"), "token-shaped id never treated as an index");

        registry.setCanonical(nvda, true);
        assertEq(_reason(c), bytes32(0));

        cfg.setStockRegistry(address(0));
        assertEq(_reason(c), bytes32("BAD_UNDERLYING"), "no registry configured");
    }

    function test_validate_badSymbol() public view {
        BRTypes.Charter memory c = _charter();
        c.symbol = bytes32(0);
        assertEq(_reason(c), bytes32("BAD_SYMBOL"));
    }

    function test_validate_badFees() public view {
        BRTypes.Charter memory e = _engineCharter();
        e.takerFeeBps = 101;
        assertEq(_reason(e), bytes32("BAD_FEES"));
        e.takerFeeBps = 100;
        assertEq(_reason(e), bytes32(0));
        // Orderly fees are the venue's: not checked
        BRTypes.Charter memory c = _charter();
        c.takerFeeBps = 5000;
        assertEq(_reason(c), bytes32(0));
    }

    function testFuzz_validate_windowAndNotice(uint32 window, uint64 notice) public view {
        BRTypes.Charter memory c = _charter();
        c.subscriptionWindow = window;
        c.juniorNoticeSeconds = notice;
        bytes32 expected;
        if (window < 60 || window > 30 days) expected = "BAD_WINDOW";
        else if (notice > 30 days) expected = "BAD_NOTICE";
        assertEq(_reason(c), expected);
    }

    function testFuzz_validate_bps(uint16 hurdle, uint16 cap) public view {
        BRTypes.Charter memory c = _charter();
        c.seniorHurdleBps = hurdle;
        c.seniorCapBps = cap;
        bytes32 expected = (hurdle > 10_000 || cap > 10_000 || cap == 0) ? bytes32("BAD_BPS") : bytes32(0);
        assertEq(_reason(c), expected);
    }

    function testFuzz_validate_killAndSkew(int16 kill, int16 skew) public view {
        BRTypes.Charter memory c = _charter();
        c.mandate.killAtDrawdownBps = kill;
        c.mandate.maxSkewBps = skew;
        bool bad = kill >= 0 || kill < -5000 || skew <= 0;
        assertEq(_reason(c), bad ? bytes32("BAD_MANDATE") : bytes32(0));
    }

    // ------------------------------------------------------------------------------------------
    // decide
    // ------------------------------------------------------------------------------------------

    function test_decide_onlyCommittee() public {
        uint256 id = _file();
        vm.prank(outsider);
        vm.expectRevert(MarketCharter.NotCommittee.selector);
        charter.decide(id, true, CID);
        vm.prank(sponsor);
        vm.expectRevert(MarketCharter.NotCommittee.selector);
        charter.decide(id, false, CID);
    }

    function test_decide_unknownCharterReverts() public {
        vm.prank(address(committee));
        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.None)
        );
        charter.decide(7, true, CID);
    }

    function test_decide_approveForwardsFeeAndCreatesBook() public {
        uint256 id = _file();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(address(committee));
        charter.decide(id, true, CID);

        IMarketCharter.CharterRecord memory r = charter.get(id);
        assertEq(uint8(r.status), uint8(BRTypes.CharterStatus.Approved));
        assertEq(r.juryCid, CID);
        assertEq(r.decidedAt, block.timestamp);
        assertEq(r.book, factory.bookOf(id));
        assertTrue(r.book != address(0));
        assertEq(usdc.balanceOf(expenseRecipient), FEE, "fee forwarded");
        assertEq(usdc.balanceOf(address(charter)), 0);
        assertEq(
            staking.lockOf(sponsor, charter.bondLockId(id)), SPONSOR_BOND, "bond stays locked while live"
        );
        assertFalse(charter.isOpen(id));
    }

    function test_decide_approveEmitsEvents() public {
        uint256 id = _file();
        vm.expectEmit(true, true, false, true, address(charter));
        emit MarketCharter.FeeForwarded(id, expenseRecipient, FEE);
        vm.prank(address(committee));
        charter.decide(id, true, CID);
    }

    function test_decide_approveRequiresJuryCid() public {
        uint256 id = _file();
        vm.prank(address(committee));
        vm.expectRevert(MarketCharter.MissingJuryCid.selector);
        charter.decide(id, true, bytes32(0));
    }

    function test_decide_approveRevertsWhilePaused_rejectStillWorks() public {
        uint256 id = _file();
        cfg.setNewBooksPaused(true);
        vm.prank(address(committee));
        vm.expectRevert(IMarketCharter.NewBooksPaused.selector);
        charter.decide(id, true, CID);

        vm.prank(address(committee));
        charter.decide(id, false, CID);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Rejected));
    }

    function test_decide_approveRevertsWithoutExpenseRecipient() public {
        uint256 id = _file();
        cfg.setExpenseRecipient(address(0));
        vm.prank(address(committee));
        vm.expectRevert(MarketCharter.ZeroAddress.selector);
        charter.decide(id, true, CID);
    }

    function test_decide_approveRevertsWhenFactoryReturnsNoBook() public {
        uint256 id = _file();
        cfg.setFactory(address(new GovNullFactory()));
        vm.prank(address(committee));
        vm.expectRevert(abi.encodeWithSelector(MarketCharter.BookNotCreated.selector, id));
        charter.decide(id, true, CID);
    }

    function test_decide_rejectRefundsFeeAndUnlocksBond() public {
        uint256 before = usdc.balanceOf(sponsor);
        uint256 id = _file();

        vm.expectEmit(true, false, false, true, address(charter));
        emit IMarketCharter.CharterDecided(id, false, CID, address(0));
        vm.expectEmit(true, true, false, true, address(charter));
        emit MarketCharter.FeeRefunded(id, sponsor, FEE);
        vm.expectEmit(true, true, false, true, address(charter));
        emit MarketCharter.SponsorBondReleased(id, sponsor, SPONSOR_BOND);
        vm.prank(address(committee));
        charter.decide(id, false, CID);

        IMarketCharter.CharterRecord memory r = charter.get(id);
        assertEq(uint8(r.status), uint8(BRTypes.CharterStatus.Rejected));
        assertEq(r.juryCid, CID);
        assertEq(r.decidedAt, block.timestamp);
        assertEq(r.book, address(0));
        assertEq(usdc.balanceOf(sponsor), before, "fee refunded");
        assertEq(usdc.balanceOf(address(charter)), 0);
        assertEq(staking.lockOf(sponsor, charter.bondLockId(id)), 0, "bond unlocked");
        assertEq(staking.lockedOf(sponsor), 0);
        assertEq(charter.bondOutstanding(id), 0);
    }

    function test_decide_onlyOnce() public {
        uint256 id = _file();
        vm.prank(address(committee));
        charter.decide(id, false, CID);
        vm.prank(address(committee));
        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.Rejected)
        );
        charter.decide(id, true, CID);
    }

    function test_decide_closedAtDeadline() public {
        uint256 id = _file();
        uint256 deadline = block.timestamp + WINDOW;
        vm.warp(deadline - 1);
        assertTrue(charter.isOpen(id));
        vm.warp(deadline);
        assertFalse(charter.isOpen(id));
        vm.prank(address(committee));
        vm.expectRevert(abi.encodeWithSelector(MarketCharter.DecisionWindowClosed.selector, id, deadline));
        charter.decide(id, false, CID);
    }

    // ------------------------------------------------------------------------------------------
    // expire
    // ------------------------------------------------------------------------------------------

    function test_expire_beforeDeadlineReverts() public {
        uint256 id = _file();
        uint256 deadline = block.timestamp + WINDOW;
        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(MarketCharter.DecisionWindowOpen.selector, id, deadline));
        charter.expire(id);
    }

    function test_expire_after48hRefundsAndUnlocks_anyoneMayCall() public {
        uint256 before = usdc.balanceOf(sponsor);
        uint256 id = _file();
        vm.warp(block.timestamp + 48 hours);

        vm.expectEmit(true, false, false, true, address(charter));
        emit IMarketCharter.CharterExpired(id);
        vm.prank(outsider);
        charter.expire(id);

        IMarketCharter.CharterRecord memory r = charter.get(id);
        assertEq(uint8(r.status), uint8(BRTypes.CharterStatus.Expired));
        assertEq(r.decidedAt, block.timestamp);
        assertEq(usdc.balanceOf(sponsor), before);
        assertEq(staking.lockedOf(sponsor), 0);
    }

    function test_expire_unknownOrDecidedReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.None)
        );
        charter.expire(1);

        uint256 id = _file();
        vm.prank(address(committee));
        charter.decide(id, true, CID);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.Approved)
        );
        charter.expire(id);
    }

    function test_expire_twiceReverts() public {
        uint256 id = _file();
        vm.warp(block.timestamp + WINDOW);
        charter.expire(id);
        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.Expired)
        );
        charter.expire(id);
    }

    function testFuzz_expire_timing(uint256 dt) public {
        dt = bound(dt, 0, 10 * uint256(WINDOW));
        uint256 id = _file();
        vm.warp(block.timestamp + dt);
        if (dt < WINDOW) {
            vm.expectRevert();
            charter.expire(id);
            assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed));
        } else {
            charter.expire(id);
            assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Expired));
        }
    }

    // ------------------------------------------------------------------------------------------
    // retire / onRetired / closeCancelled
    // ------------------------------------------------------------------------------------------

    function _approved() internal returns (uint256 id, GovMockBook book) {
        id = _file();
        vm.prank(address(committee));
        charter.decide(id, true, CID);
        book = _book(id);
    }

    function test_retire_bySponsor() public {
        (uint256 id, GovMockBook book) = _approved();
        book.setState(BRTypes.BookState.Live);
        vm.expectEmit(true, true, false, true, address(charter));
        emit MarketCharter.RetireRequested(id, sponsor);
        vm.prank(sponsor);
        charter.retire(id);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
        assertEq(book.retireCalls(), 1);
        assertEq(
            uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved), "status changes only on onRetired"
        );
    }

    function test_retire_byCommittee() public {
        (uint256 id, GovMockBook book) = _approved();
        book.setState(BRTypes.BookState.Live);
        vm.prank(address(committee));
        charter.retire(id);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
    }

    function test_retire_accessAndStatus() public {
        (uint256 id, GovMockBook book) = _approved();
        book.setState(BRTypes.BookState.Live);
        vm.prank(outsider);
        vm.expectRevert(MarketCharter.NotSponsorOrCommittee.selector);
        charter.retire(id);

        uint256 filed = _file();
        vm.prank(sponsor);
        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.Filed)
        );
        charter.retire(filed);
    }

    function test_retire_bookStateEnforcedByBook() public {
        (uint256 id,) = _approved(); // book still in Subscription
        vm.prank(sponsor);
        vm.expectRevert(GovMockBookNoFlag.NotLive.selector);
        charter.retire(id);
    }

    function test_onRetired_onlyBook_releasesBond() public {
        (uint256 id, GovMockBook book) = _approved();
        vm.prank(outsider);
        vm.expectRevert(MarketCharter.NotBook.selector);
        charter.onRetired(id);

        vm.expectEmit(true, false, false, true, address(charter));
        emit IMarketCharter.CharterRetired(id);
        book.finalize();
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Retired));
        assertEq(staking.lockedOf(sponsor), 0, "bond released");
        assertEq(charter.bondOutstanding(id), 0);

        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.Retired)
        );
        book.finalize();
    }

    function test_onRetired_otherBookCannotRelease() public {
        (uint256 id1,) = _approved();
        (, GovMockBook book2) = _approved();
        vm.prank(address(book2));
        vm.expectRevert(MarketCharter.NotBook.selector);
        charter.onRetired(id1);
    }

    function test_onRetired_unapprovedReverts() public {
        uint256 id = _file();
        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.Filed)
        );
        charter.onRetired(id);
    }

    function test_retire_synchronousFinalizeCallback() public {
        (uint256 id, GovMockBook book) = _approved();
        book.setState(BRTypes.BookState.Live);
        book.setFinalizeOnRetire(true);
        vm.prank(sponsor);
        charter.retire(id);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Retired));
        assertEq(staking.lockedOf(sponsor), 0);
    }

    function test_closeCancelled_releasesBond() public {
        (uint256 id, GovMockBook book) = _approved();
        vm.expectRevert(abi.encodeWithSelector(MarketCharter.BookNotCancelled.selector, id));
        charter.closeCancelled(id);

        book.setState(BRTypes.BookState.Cancelled);
        vm.prank(outsider);
        charter.closeCancelled(id);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Retired));
        assertEq(staking.lockedOf(sponsor), 0);

        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.Retired)
        );
        charter.closeCancelled(id);
    }

    function test_closeCancelled_unapprovedReverts() public {
        uint256 id = _file();
        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.Filed)
        );
        charter.closeCancelled(id);
    }

    // ------------------------------------------------------------------------------------------
    // slashSponsor
    // ------------------------------------------------------------------------------------------

    function test_slashSponsor_onlyCommittee() public {
        (uint256 id, GovMockBook book) = _approved();
        book.setSponsorAbandoned(true);
        vm.prank(sponsor);
        vm.expectRevert(MarketCharter.NotCommittee.selector);
        charter.slashSponsor(id, "ABANDONED");
    }

    function test_slashSponsor_requiresAbandonedFlag() public {
        (uint256 id,) = _approved();
        vm.prank(address(committee));
        vm.expectRevert(abi.encodeWithSelector(MarketCharter.SponsorNotAbandoned.selector, id));
        charter.slashSponsor(id, "ABANDONED");
    }

    function test_slashSponsor_requiresApproved() public {
        uint256 id = _file();
        vm.prank(address(committee));
        vm.expectRevert(
            abi.encodeWithSelector(IMarketCharter.WrongStatus.selector, BRTypes.CharterStatus.Filed)
        );
        charter.slashSponsor(id, "ABANDONED");
    }

    function test_slashSponsor_slashesFullBond() public {
        (uint256 id, GovMockBook book) = _approved();
        book.setSponsorAbandoned(true);
        vm.expectEmit(true, true, false, true, address(charter));
        emit IMarketCharter.SponsorSlashed(id, sponsor, SPONSOR_BOND, "ABANDONED");
        vm.prank(address(committee));
        charter.slashSponsor(id, "ABANDONED");

        assertEq(bkrn.balanceOf(slashRecipient), SPONSOR_BOND);
        assertEq(staking.lockedOf(sponsor), 0);
        assertEq(charter.bondOutstanding(id), 0);
        assertEq(charter.get(id).bondBkrn, SPONSOR_BOND, "record keeps the filed bond");

        vm.prank(address(committee));
        vm.expectRevert(abi.encodeWithSelector(MarketCharter.NothingToSlash.selector, id));
        charter.slashSponsor(id, "ABANDONED");

        // retirement after a slash completes without touching staking
        book.finalize();
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Retired));
    }

    function test_slashSponsor_bookWithoutFlagCountsAsNotAbandoned() public {
        GovMockBookNoFlag noFlag = new GovMockBookNoFlag();
        bytes32 kind = factory.BOOK();
        vm.prank(timelock);
        factory.setImplementation(kind, address(noFlag));
        (uint256 id,) = _approved();
        vm.prank(address(committee));
        vm.expectRevert(abi.encodeWithSelector(MarketCharter.SponsorNotAbandoned.selector, id));
        charter.slashSponsor(id, "ABANDONED");
    }
}
