// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {ITranche} from "../../../src/interfaces/ITranche.sol";
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

/// @notice Invariant handler for the book cluster. Every redemption request / claim made with valid
///         inputs must succeed, except a claim reverting InsufficientLiquidity. Marks must always apply.
contract BookHandler is Test {
    struct Env {
        Book book;
        Tranche senior;
        Tranche junior;
        UnderwritingVault vault;
        MockVenueAdapter adapter;
        MockMarkRegistry registry;
        MockBackstop backstop;
        MockCharter charterC;
        MockMandate mandate;
        MockBookConfig cfg;
        MockERC20 usdc;
        address sponsor;
        address router;
        address keeper;
        address guardian;
        uint256 bookId;
        uint32 interval;
    }

    bytes32 internal constant MARK_SETTLED_SIG =
        keccak256("MarkSettled(uint256,uint256,uint256,uint256[2],uint256[2],uint256[2])");

    Env internal env;
    address[] internal actors;

    // ---- ghost flags ----
    bool public permissionViolation;
    bool public conservationViolation;
    bool public markViolation;
    bool public finalizeViolation;
    bytes public lastViolation;
    string public lastViolationTag;

    // ---- coverage counters ----
    mapping(bytes32 => uint256) public calls;
    uint256 public liquidityReverts;
    uint256 public marksApplied;
    uint256 public claimsPaid;
    uint256 public requestsWhilePaused;
    uint256 public requestsWhileKilled;
    uint256 public requestsRetiring;
    uint256 public requestsRetired;
    uint256 public backstopCovers;
    uint256 public topUpsAccepted;
    uint256 public finalized;

    constructor(Env memory e, address[] memory actors_) {
        env = e;
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    // =========================================================================================
    // helpers
    // =========================================================================================

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _tranche(uint256 seed) internal view returns (Tranche) {
        return seed % 2 == 0 ? env.senior : env.junior;
    }

    function _state() internal view returns (BRTypes.BookState) {
        return env.book.state();
    }

    function _flag(string memory tag, bytes memory err) internal {
        permissionViolation = true;
        lastViolation = err;
        lastViolationTag = tag;
    }

    function _isLiquidity(bytes memory err) internal pure returns (bool) {
        return err.length >= 4 && bytes4(err) == ITranche.InsufficientLiquidity.selector;
    }

    function _bump(bytes32 k) internal {
        calls[k]++;
    }

    // =========================================================================================
    // redemption requests (must never revert with valid inputs)
    // =========================================================================================

    function requestRedeem(uint256 actorSeed, uint256 kindSeed, uint256 amountSeed, uint256 controllerSeed)
        external
    {
        address owner = _actor(actorSeed);
        Tranche t = _tranche(kindSeed);
        uint256 bal = t.balanceOf(owner);
        if (bal == 0) return;
        uint256 shares = bound(amountSeed, 1, bal);
        address controller = _actor(controllerSeed);
        _bump("requestRedeem");
        _countRequestContext(t);
        vm.prank(owner);
        try t.requestRedeem(shares, controller, owner) {}
        catch (bytes memory err) {
            _flag("requestRedeem", err);
        }
    }

    function _countRequestContext(Tranche t) internal {
        if (t.paused() || env.cfg.newBooksPaused()) requestsWhilePaused++;
        if (env.mandate.killed()) requestsWhileKilled++;
        BRTypes.BookState st = _state();
        if (st == BRTypes.BookState.Retiring) requestsRetiring++;
        if (st == BRTypes.BookState.Retired) requestsRetired++;
    }

    function requestRedeemViaOperator(uint256 actorSeed, uint256 kindSeed, uint256 amountSeed, uint256 opSeed)
        external
    {
        address owner = _actor(actorSeed);
        address op = _actor(opSeed);
        Tranche t = _tranche(kindSeed);
        uint256 bal = t.balanceOf(owner);
        if (bal == 0 || op == owner) return;
        uint256 shares = bound(amountSeed, 1, bal);
        _bump("requestRedeemOp");
        vm.prank(owner);
        t.setOperator(op, true);
        vm.prank(op);
        try t.requestRedeem(shares, owner, owner) {}
        catch (bytes memory err) {
            _flag("requestRedeemViaOperator", err);
        }
    }

    // =========================================================================================
    // claims (only InsufficientLiquidity may revert)
    // =========================================================================================

    function claim(uint256 actorSeed, uint256 kindSeed, uint256 modeSeed, uint256 amountSeed) external {
        Tranche t = _tranche(kindSeed);
        // prefer a controller with something claimable (starting from the seeded actor)
        address c = _actor(actorSeed);
        for (uint256 i = 0; i < actors.length; i++) {
            address cand = _actor((actorSeed % actors.length) + i);
            if (t.claimableAssets(cand) > 0) {
                c = cand;
                break;
            }
        }
        uint256 mode = modeSeed % 4;
        _bump("claim");
        bytes memory err;
        bool ok = true;
        uint256 balBefore = env.usdc.balanceOf(c);
        if (mode == 0) {
            vm.prank(c);
            try t.claimRedemption(c, c) {}
            catch (bytes memory e) {
                ok = false;
                err = e;
            }
        } else if (mode == 1) {
            try t.claimFor(c) {}
            catch (bytes memory e) {
                ok = false;
                err = e;
            }
        } else {
            // ERC-7540 partial claims; keep within one call's bucket budget
            if (t.controllerBuckets(c).length > t.MAX_CLAIM_BUCKETS()) return;
            if (mode == 2) {
                uint256 maxR = t.maxRedeem(c);
                if (maxR == 0) return;
                uint256 shares = bound(amountSeed, 1, maxR);
                vm.prank(c);
                try t.redeem(shares, c, c) {}
                catch (bytes memory e) {
                    ok = false;
                    err = e;
                }
            } else {
                uint256 maxW = t.maxWithdraw(c);
                if (maxW == 0) return;
                uint256 assets = bound(amountSeed, 1, maxW);
                vm.prank(c);
                try t.withdraw(assets, c, c) {}
                catch (bytes memory e) {
                    ok = false;
                    err = e;
                }
            }
        }
        if (!ok) {
            if (_isLiquidity(err)) liquidityReverts++;
            else _flag("claim", err);
        } else if (env.usdc.balanceOf(c) > balBefore) {
            claimsPaid++;
        }
    }

    function claimAllocation(uint256 actorSeed, uint256 kindSeed) external {
        _bump("claimAllocation");
        try _tranche(kindSeed).claimAllocation(_actor(actorSeed)) {}
        catch (bytes memory err) {
            _flag("claimAllocation", err);
        }
    }

    function claimCancelledRefund(uint256 actorSeed, uint256 kindSeed) external {
        _bump("claimCancelledRefund");
        try _tranche(kindSeed).claimCancelledRefund(_actor(actorSeed)) {}
        catch (bytes memory err) {
            _flag("claimCancelledRefund", err);
        }
    }

    function fundClaims() external {
        _bump("fundClaims");
        try env.book.fundClaims() {}
        catch (bytes memory err) {
            _flag("fundClaims", err);
        }
    }

    // =========================================================================================
    // marks
    // =========================================================================================

    /// @param pnlBps venue P&L in bps of the deployed value, bounded to [-50%, +20%].
    /// @param extraRecallBps keeper recall beyond what claims need, bps of the deployed value.
    function mark(int256 pnlBps, uint256 extraRecallBps) external {
        BRTypes.BookState st = _state();
        if (st != BRTypes.BookState.Live && st != BRTypes.BookState.Retiring) return;
        _bump("mark");
        // keeper: recall so settled-but-unfunded claims are covered, plus an optional extra
        uint256 idle = env.vault.idle();
        uint256 owed = env.book.unfundedClaims();
        uint256 need = owed > idle ? owed - idle : 0;
        uint256 value = env.adapter.value();
        uint256 extra = (value * bound(extraRecallBps, 0, 10_000)) / 10_000 / 4;
        uint256 recallAmt = need + extra > value ? value : need + extra;
        if (recallAmt > 0) {
            vm.prank(env.keeper);
            env.vault.recall(BRTypes.ACCOUNT_MM, recallAmt);
        }
        if (need > 0) env.book.fundClaims();

        vm.warp(((block.timestamp / env.interval) + 1) * env.interval);
        value = env.adapter.value();
        int256 bps = bound(pnlBps, -5000, 2000);
        uint256 nv =
            bps >= 0 ? value + (value * uint256(bps)) / 10_000 : value - (value * uint256(-bps)) / 10_000;
        env.adapter.setValue(nv);
        _applyMarkAt(nv, value);
    }

    function _applyMarkAt(uint256 nv, uint256 prevValue) internal {
        uint64 pe = uint64((block.timestamp / env.interval) * env.interval);
        if (pe <= env.book.lastMarkPeriodEnd()) pe = env.book.lastMarkPeriodEnd() + env.interval;
        BRTypes.MarkInput memory m = BRTypes.MarkInput({
            bookId: env.bookId,
            periodEnd: pe,
            navUsd: 0,
            deployedValueUsd: nv,
            flowNonce: env.book.flowNonce(),
            inventoryRoot: 0,
            pnlJsonHash: 0,
            receiptsRoot: 0
        });
        uint256 id = env.registry.commit(m, "");
        vm.recordLogs();
        try env.book.applyMark(id) {
            marksApplied++;
            _checkConservation();
        } catch (bytes memory err) {
            markViolation = true;
            lastViolation = err;
            lastViolationTag = "applyMark";
            env.adapter.setValue(prevValue);
        }
    }

    function _checkConservation() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Book.LastMark memory lm = env.book.lastMarkSummary();
        (uint256 s, uint256 j) = env.book.trancheNav();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(env.book) || logs[i].topics[0] != MARK_SETTLED_SIG) continue;
            found = true;
            (uint256 covered, uint256[2] memory post, uint256[2] memory owed, uint256[2] memory topUp) =
                abi.decode(logs[i].data, (uint256, uint256[2], uint256[2], uint256[2]));
            if (covered > 0) backstopCovers++;
            if (topUp[0] + topUp[1] > 0) topUpsAccepted++;
            // waterfall conservation: S + J == marked NAV + backstop cover (before settlement flows)
            if (post[0] + post[1] != lm.navUsd + covered) conservationViolation = true;
            if (covered != lm.backstopCovered) conservationViolation = true;
            // settlement flows explain the final tranche NAVs exactly
            if (s != post[0] - owed[0] + topUp[0] || j != post[1] - owed[1] + topUp[1]) {
                conservationViolation = true;
            }
        }
        if (!found) conservationViolation = true;
    }

    function warp(uint256 secs) external {
        _bump("warp");
        vm.warp(block.timestamp + bound(secs, 1, 2 * uint256(env.interval)));
    }

    // =========================================================================================
    // fee flow / backstop / capital
    // =========================================================================================

    function credit(uint256 s, uint256 j) external {
        BRTypes.BookState st = _state();
        if (st == BRTypes.BookState.Subscription || st == BRTypes.BookState.Cancelled) return;
        _bump("credit");
        s = bound(s, 0, 5000e6);
        j = bound(j, 0, 5000e6);
        env.usdc.mint(address(env.vault), s + j);
        vm.prank(env.router);
        env.book.creditDistribution(s, j);
    }

    function fundBackstop(uint256 amount) external {
        _bump("fundBackstop");
        env.usdc.mint(address(env.backstop), bound(amount, 0, 20_000e6));
    }

    function recall(uint256 amountSeed) external {
        uint256 value = env.adapter.value();
        if (value == 0) return;
        _bump("recall");
        vm.prank(env.keeper);
        env.vault.recall(BRTypes.ACCOUNT_MM, bound(amountSeed, 1, value));
    }

    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 kindSeed, uint256 amountSeed) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        Tranche t = _tranche(kindSeed);
        uint256 bal = t.balanceOf(from);
        if (bal == 0 || from == to) return;
        _bump("transfer");
        vm.prank(from);
        t.transfer(to, bound(amountSeed, 1, bal));
    }

    // =========================================================================================
    // top-ups
    // =========================================================================================

    function openTopUp(uint256 window, uint256 sCap, uint256 jCap) external {
        if (_state() != BRTypes.BookState.Live || env.cfg.newBooksPaused()) return;
        (bool open,,,) = env.book.topUp();
        if (open) return;
        _bump("openTopUp");
        vm.prank(env.sponsor);
        env.book
            .openTopUp(
                uint32(bound(window, 1, 3 * uint256(env.interval))),
                uint128(bound(sCap, 0, 50_000e6)),
                uint128(bound(jCap, 1, 50_000e6))
            );
    }

    function depositTopUp(uint256 actorSeed, uint256 kindSeed, uint256 amount) external {
        Tranche t = _tranche(kindSeed);
        if (!t.depositsOpen()) return;
        address who = _actor(actorSeed);
        amount = bound(amount, 1, 20_000e6);
        if (t.maxDeposit(who) < amount) return;
        _bump("depositTopUp");
        env.usdc.mint(who, amount);
        vm.startPrank(who);
        env.usdc.approve(address(t), amount);
        t.deposit(amount, who);
        vm.stopPrank();
    }

    // =========================================================================================
    // pauses / kill / lifecycle
    // =========================================================================================

    function pauseTranche(uint256 kindSeed, bool bySponsor, bool doPause) external {
        _bump("pause");
        Tranche t = _tranche(kindSeed);
        if (!doPause && bySponsor && t.guardianPaused()) bySponsor = false; // only the guardian lifts its pause
        vm.prank(bySponsor ? env.sponsor : env.guardian);
        if (doPause) t.pause();
        else t.unpause();
    }

    function setNewBooksPaused(bool p) external {
        _bump("newBooksPaused");
        env.cfg.setNewBooksPaused(p);
    }

    function kill(uint256 seed) external {
        if (seed % 4 != 0 || env.mandate.killed()) return;
        _bump("kill");
        env.mandate.kill("RISK");
    }

    function remandate() external {
        _bump("remandate");
        env.mandate.remandate();
    }

    /// @dev Rare on purpose (1 in 16) so most runs explore the Live state before going terminal.
    function retire(uint256 seed) external {
        if (seed % 16 != 0 || _state() != BRTypes.BookState.Live) return;
        _bump("retire");
        env.charterC.retire(env.bookId);
    }

    /// @dev Retiring -> keeper recalls everything -> final mark with deployedValueUsd == 0 -> finalize.
    function finalize() external {
        if (_state() != BRTypes.BookState.Retiring) return;
        _bump("finalize");
        uint256 value = env.adapter.value();
        if (value > 0) {
            vm.prank(env.keeper);
            env.vault.recall(BRTypes.ACCOUNT_IF, value);
        }
        vm.warp(((block.timestamp / env.interval) + 1) * env.interval);
        _applyMarkAt(0, 0);
        try env.book.finalizeRetirement() {
            finalized++;
        } catch (bytes memory err) {
            finalizeViolation = true;
            lastViolation = err;
            lastViolationTag = "finalizeRetirement";
        }
    }

    function settleRetiredBacklog() external {
        if (_state() != BRTypes.BookState.Retired) return;
        _bump("backlog");
        env.book.settleRetiredBacklog();
    }
}
