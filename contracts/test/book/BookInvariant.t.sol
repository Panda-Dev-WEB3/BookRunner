// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console2} from "forge-std/console2.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {Tranche} from "../../src/Tranche.sol";
import {BookFixture} from "./utils/BookFixture.sol";
import {BookHandler} from "./utils/BookHandler.sol";

/// @notice A10 invariants for the book cluster (ARCHITECTURE §2.10):
///   (a) requestRedeem / claims never revert for lack of permission — fuzzed under tranche pause,
///       guardian pause (newBooksPaused), kill, Retiring and Retired; only InsufficientLiquidity may
///       revert a claim;
///   (b) waterfall conservation after every applyMark: S + J == marked NAV + backstop cover - backstop
///       repayment (before the settlement flows of the same mark, which are reconciled exactly);
///   (c) total claimable <= tranche redemption escrow + unfunded claims, per tranche;
///   plus the book accounting identity S + J + unfundedClaims == vault idle + venue value, and marks /
///   retirement are never blocked.
contract BookInvariantTest is StdInvariant, BookFixture {
    BookHandler internal handler;

    function setUp() public {
        _setUpBook();
        _goLive();
        // spread holdings so every actor holds both tranches at some point
        vm.prank(alice);
        senior.transfer(dave, 5000e6);
        vm.prank(carol);
        junior.transfer(eve, 5000e6);

        address[] memory actors = new address[](6);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = dave;
        actors[4] = eve;
        actors[5] = sponsor;

        handler = new BookHandler(
            BookHandler.Env({
                book: book,
                senior: senior,
                junior: junior,
                vault: vault,
                adapter: adapter,
                registry: registry,
                backstop: backstop,
                charterC: charterC,
                mandate: mandate,
                cfg: cfg,
                usdc: usdc,
                sponsor: sponsor,
                router: router,
                keeper: keeper,
                guardian: guardian,
                bookId: BOOK_ID,
                interval: INTERVAL
            }),
            actors
        );
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](32);
        uint256 k;
        // weights: redemption requests x4, claims x4, marks x5, warps x2
        for (uint256 w = 0; w < 4; w++) {
            selectors[k++] = BookHandler.requestRedeem.selector;
            selectors[k++] = BookHandler.claim.selector;
        }
        for (uint256 w = 0; w < 5; w++) {
            selectors[k++] = BookHandler.mark.selector;
        }
        selectors[k++] = BookHandler.warp.selector;
        selectors[k++] = BookHandler.warp.selector;
        selectors[k++] = BookHandler.requestRedeemViaOperator.selector;
        selectors[k++] = BookHandler.claimAllocation.selector;
        selectors[k++] = BookHandler.claimCancelledRefund.selector;
        selectors[k++] = BookHandler.fundClaims.selector;
        selectors[k++] = BookHandler.credit.selector;
        selectors[k++] = BookHandler.fundBackstop.selector;
        selectors[k++] = BookHandler.recall.selector;
        selectors[k++] = BookHandler.transferShares.selector;
        selectors[k++] = BookHandler.openTopUp.selector;
        selectors[k++] = BookHandler.depositTopUp.selector;
        selectors[k++] = BookHandler.pauseTranche.selector;
        selectors[k++] = BookHandler.setNewBooksPaused.selector;
        selectors[k++] = BookHandler.kill.selector;
        selectors[k++] = BookHandler.remandate.selector;
        selectors[k++] = BookHandler.retire.selector;
        selectors[k++] = BookHandler.finalize.selector;
        selectors[k++] = BookHandler.settleRetiredBacklog.selector;
        assert(k == selectors.length);
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev (a) RED-TEAM: redemption never permission-gated.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_redemptionNeverPermissionGated() public view {
        assertFalse(handler.permissionViolation(), handler.lastViolationTag());
    }

    /// @dev (b) waterfall conservation after each applyMark.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_waterfallConservation() public view {
        assertFalse(handler.conservationViolation(), "S + J != marked NAV + backstop cover - repayment");
    }

    /// @dev marks and retirement are never blocked.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_marksNeverBlocked() public view {
        assertFalse(handler.markViolation(), handler.lastViolationTag());
        assertFalse(handler.finalizeViolation(), handler.lastViolationTag());
    }

    /// @dev book accounting identity (venue value is always marked immediately by the handler).
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_accountingIdentity() public view {
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs, "S + J + unfunded != idle + deployed");
    }

    /// @dev (c) claimable <= escrow + unfunded, per tranche.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_claimableCovered() public view {
        _checkClaimable(senior, BRTypes.SENIOR);
        _checkClaimable(junior, BRTypes.JUNIOR);
    }

    function _checkClaimable(Tranche t, uint8 kind) internal view {
        uint256 total;
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            total += t.claimableAssets(handler.actorAt(i));
        }
        assertLe(total, t.redemptionLiquidity() + book.unfundedOf(kind), "claimable > escrow + unfunded");
        assertGe(usdc.balanceOf(address(t)), t.commitEscrow(), "subscription escrow under-funded");
    }

    /// @dev tranche shares are only ever held by known parties or in escrow.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_supplyAccounted() public view {
        _checkSupply(senior);
        _checkSupply(junior);
    }

    function _checkSupply(Tranche t) internal view {
        uint256 held = t.balanceOf(address(t));
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            held += t.balanceOf(handler.actorAt(i));
        }
        assertEq(held, t.totalSupply());
    }

    /// @dev Coverage report (visible with -vv): the handler must actually reach the interesting paths.
    function afterInvariant() external view {
        console2.log("marks applied", handler.marksApplied());
        console2.log("claims paid", handler.claimsPaid());
        console2.log("claim liquidity reverts", handler.liquidityReverts());
        console2.log("requests while paused", handler.requestsWhilePaused());
        console2.log("requests while killed", handler.requestsWhileKilled());
        console2.log("requests Retiring", handler.requestsRetiring());
        console2.log("requests Retired", handler.requestsRetired());
        console2.log("backstop covers", handler.backstopCovers());
        console2.log("backstop repayments", handler.backstopRepayments());
        console2.log("top-ups accepted", handler.topUpsAccepted());
        console2.log("finalized", handler.finalized());
    }

    /// @dev Deterministic walk through every handler path: proves each is reachable with valid inputs
    ///      and that none trips a ghost flag.
    function test_handlerScenario_coversAllPaths() public {
        // actors: 0 alice, 1 bob, 2 carol, 3 dave, 4 eve, 5 sponsor
        handler.requestRedeem(0, 0, 10_000e6, 0); // alice senior
        handler.requestRedeem(2, 1, 5000e6, 2); // carol junior (notice)
        handler.mark(0, 10_000); // settles senior; keeper recalls a quarter of the venue
        handler.claim(0, 0, 0, 0); // alice claimRedemption
        for (uint256 i = 0; i < 4; i++) {
            handler.mark(0, 0);
        }
        handler.claim(2, 1, 3, type(uint256).max); // carol withdraw(max)
        assertGt(handler.claimsPaid(), 1, "claims paid");

        // unfunded claim -> liquidity revert allowed, later funded
        handler.requestRedeem(1, 0, 5000e6, 1); // bob
        handler.recall(0);
        handler.mark(0, 0);
        handler.claim(1, 0, 1, 0);

        // losses through Junior into Senior with a backstop
        handler.fundBackstop(20_000e6);
        handler.mark(-5000, 0);
        handler.mark(-5000, 0);
        assertGt(handler.backstopCovers(), 0, "backstop covers");

        // fee flow + top-up round
        handler.credit(3000e6, 3000e6);
        handler.openTopUp(300, 50_000e6, 50_000e6);
        handler.depositTopUp(3, 1, 10_000e6); // dave junior
        handler.depositTopUp(4, 0, 5000e6); // eve senior
        handler.warp(600);
        handler.mark(0, 0);
        handler.mark(0, 0);
        handler.claimAllocation(3, 1);
        handler.claimAllocation(4, 0);
        assertGt(handler.topUpsAccepted(), 0, "top-ups accepted");

        // every pause + kill at once
        handler.pauseTranche(0, true, true);
        handler.pauseTranche(1, false, true);
        handler.setNewBooksPaused(true);
        handler.kill(0);
        handler.requestRedeem(3, 1, 1000e6, 3);
        handler.requestRedeem(5, 1, 1000e6, 5);
        handler.requestRedeemViaOperator(4, 0, 1000e6, 0);
        handler.transferShares(0, 1, 0, 100e6);
        assertGt(handler.requestsWhilePaused(), 0);
        assertGt(handler.requestsWhileKilled(), 0);

        // retirement
        handler.retire(0);
        handler.requestRedeem(1, 0, 1000e6, 1);
        handler.mark(0, 0);
        handler.finalize();
        assertEq(handler.finalized(), 1, "finalized");
        handler.requestRedeem(0, 0, type(uint256).max, 0);
        handler.requestRedeem(2, 1, type(uint256).max, 2);
        handler.credit(1000e6, 1000e6);
        handler.requestRedeem(3, 1, type(uint256).max, 3);
        handler.settleRetiredBacklog();
        for (uint256 a = 0; a < 6; a++) {
            handler.claim(a, 0, 1, 0);
            handler.claim(a, 1, 1, 0);
        }
        assertGt(handler.requestsRetiring(), 0);
        assertGt(handler.requestsRetired(), 0);

        assertFalse(handler.permissionViolation(), handler.lastViolationTag());
        assertFalse(handler.conservationViolation());
        assertFalse(handler.markViolation(), handler.lastViolationTag());
        assertFalse(handler.finalizeViolation(), handler.lastViolationTag());
        invariant_accountingIdentity();
        invariant_claimableCovered();
        invariant_supplyAccounted();
    }
}
