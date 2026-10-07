// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../src/interfaces/IBookrunnerDesk.sol";
import {IMMMandate} from "../../src/interfaces/IMMMandate.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {HedgeExecutor} from "../../src/HedgeExecutor.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MandateBase} from "./utils/MandateBase.sol";
import {MandateMockBook, MandateMockEntryPoint} from "./utils/MandateMocks.sol";
import {StandardMerkle} from "./utils/StandardMerkle.sol";

/// @dev EntryPoint deposit stand-in for withdrawDepositTo.
contract DeskMockDepositEntryPoint {
    mapping(address => uint256) public balanceOf;

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }
}

contract DeskRejectingReceiver {
    receive() external payable {
        revert("no");
    }
}

contract BookrunnerDeskTest is MandateBase {
    using MessageHashUtils for bytes32;

    event ActionExecuted(address indexed key, IBookrunnerDesk.ActionKind indexed kind, bytes data);
    event HedgeExecuted(
        address indexed token, bool buy, uint256 amountIn, uint256 amountOut, uint256 notionalUsd
    );
    event SessionKeySynced(address indexed key, uint64 validUntil);
    event EntryPointSynced(address indexed entryPoint);
    event MaxSlippageSet(uint16 bps);
    event HeldTokenAdded(address indexed token);
    event HeldTokenRemoved(address indexed token);
    event NativeWithdrawn(address indexed to, uint256 amount);

    // ------------------------------------------------------------------ helpers

    function _userOp(IBookrunnerDesk.Action memory a, uint256 pk, bytes32 opHash)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = address(desk);
        op.callData = abi.encodeCall(IBookrunnerDesk.execute, (a));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, opHash.toEthSignedMessageHash());
        op.signature = abi.encodePacked(r, s, v);
    }

    function _seed(int256 exp, uint256 usd) internal returns (uint256 tokens) {
        adapter.setExposure(exp);
        _fundDesk(usd);
        tokens = _buyNvda(usd);
    }

    function _act(IBookrunnerDesk.ActionKind k, bytes memory d)
        internal
        pure
        returns (IBookrunnerDesk.Action memory)
    {
        return _action(k, d);
    }

    // ------------------------------------------------------------------ initialize

    function test_init_caches() public view {
        assertEq(address(desk.config()), address(cfg));
        assertEq(desk.bookId(), BOOK_ID);
        assertEq(desk.book(), address(book));
        assertEq(desk.mandate(), address(mandate));
        assertEq(desk.vault(), address(vault));
        assertEq(desk.adapter(), address(adapter));
        assertEq(desk.usdc(), address(usdc));
        assertEq(desk.venue(), BRTypes.VENUE_POOL_ENGINE);
        assertEq(desk.entryPoint(), entryPoint);
        assertEq(desk.maxSlippageBps(), 300);
        assertEq(desk.heldTokens().length, 0);
    }

    function test_init_lockedAndOnce() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        deskImpl.initialize(address(cfg), BOOK_ID, address(book));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        desk.initialize(address(cfg), BOOK_ID, address(book));
    }

    function test_init_validation() public {
        BookrunnerDesk d = BookrunnerDesk(payable(Clones.clone(address(deskImpl))));
        vm.expectRevert(BookrunnerDesk.ZeroAddress.selector);
        d.initialize(address(0), BOOK_ID, address(book));
        vm.expectRevert(BookrunnerDesk.ZeroAddress.selector);
        d.initialize(address(cfg), BOOK_ID, address(0));
        vm.expectRevert(BookrunnerDesk.ComponentMismatch.selector);
        d.initialize(address(cfg), BOOK_ID, address(book));

        MandateMockBook b = new MandateMockBook();
        BRTypes.BookComponents memory comps;
        comps.desk = address(d);
        comps.mandate = address(mandate);
        comps.vault = address(vault);
        comps.adapter = address(adapter);
        b.setUp(3, _charter(BRTypes.VENUE_POOL_ENGINE), comps);
        vm.expectRevert(BookrunnerDesk.ComponentMismatch.selector);
        d.initialize(address(cfg), 4, address(b));
        cfg.setUsdc(address(0));
        vm.expectRevert(BookrunnerDesk.ZeroAddress.selector);
        d.initialize(address(cfg), 3, address(b));
        cfg.setUsdc(address(usdc));
        comps.mandate = address(0);
        b.setUp(3, _charter(BRTypes.VENUE_POOL_ENGINE), comps);
        vm.expectRevert(BookrunnerDesk.ComponentMismatch.selector);
        d.initialize(address(cfg), 3, address(b));
    }

    // ------------------------------------------------------------------ authorisation

    function test_execute_unauthorisedCallers() public {
        for (uint8 k; k < 7; ++k) {
            IBookrunnerDesk.Action memory a = _act(IBookrunnerDesk.ActionKind(k), "");
            vm.prank(stranger);
            vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, stranger));
            desk.execute(a);
            // sponsor / operator are not desk keys either
            vm.prank(sponsor);
            vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, sponsor));
            desk.execute(a);
        }
    }

    function test_execute_riskOnlyReduceOnlyKinds() public {
        IBookrunnerDesk.ActionKind[4] memory riskAdding = [
            IBookrunnerDesk.ActionKind.Hedge,
            IBookrunnerDesk.ActionKind.InventoryToVenue,
            IBookrunnerDesk.ActionKind.FundDesk,
            IBookrunnerDesk.ActionKind.SetQuote
        ];
        for (uint256 i; i < 4; ++i) {
            vm.prank(risk);
            vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, risk));
            desk.execute(_act(riskAdding[i], ""));
        }
        _exec(risk, _act(IBookrunnerDesk.ActionKind.InventoryToVault, abi.encode(BRTypes.ACCOUNT_MM, 1e6)));
        assertEq(vault.recalled(BRTypes.ACCOUNT_MM), 1e6);
        _fundDesk(1000e6);
        _exec(risk, _act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(400e6))));
        assertEq(vault.returnedNotified(), 400e6);
    }

    function test_execute_expiredKeyRejected() public {
        vm.warp(T0 + 30 days + 1);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, key));
        desk.execute(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1))));
    }

    function test_execute_entryPointWithoutValidationRejected() public {
        vm.prank(entryPoint);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, address(0)));
        desk.execute(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1))));
    }

    /// @notice RED-TEAM mandate escalation: no generic call surface, no out-of-range kinds.
    function test_execute_noGenericCallSurface() public {
        vm.startPrank(key);
        // unknown selector (e.g. a generic `execute(address,uint256,bytes)`)
        (bool ok,) = address(desk)
            .call(
                abi.encodeWithSignature(
                    "execute(address,uint256,bytes)",
                    address(usdc),
                    0,
                    abi.encodeWithSignature("transfer(address,uint256)", key, 1)
                )
            );
        assertFalse(ok);
        (ok,) = address(desk).call(abi.encodeWithSignature("executeBatch(address[],uint256[],bytes[])"));
        assertFalse(ok);
        // kind 7 is out of the enum range
        bytes memory raw =
            abi.encodeCall(IBookrunnerDesk.execute, (_act(IBookrunnerDesk.ActionKind.Hedge, "")));
        assembly {
            mstore(add(raw, 0x44), 7) // length word (0x20) + selector (4) + tuple offset (0x20) -> kind
        }
        (ok,) = address(desk).call(raw);
        assertFalse(ok);
        vm.stopPrank();
        // plain ETH (gas money) is accepted
        vm.deal(address(this), 1 ether);
        (ok,) = address(desk).call{value: 1 ether}("");
        assertTrue(ok);
    }

    // ------------------------------------------------------------------ Hedge

    function test_hedge_buy() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
        IBookrunnerDesk.Action memory a = _hedgeAction(address(nvda), true, 15_000e6, 1);
        uint256 expectOut = router.quote(address(usdc), address(nvda), 15_000e6);
        uint256 expectNotional = registry.valueUsd(address(nvda), expectOut);
        vm.expectEmit(true, false, false, false, address(desk));
        emit HeldTokenAdded(address(nvda));
        vm.expectEmit(true, false, false, true, address(desk));
        emit HedgeExecuted(address(nvda), true, 15_000e6, expectOut, expectNotional);
        vm.expectEmit(true, true, false, true, address(desk));
        emit ActionExecuted(key, IBookrunnerDesk.ActionKind.Hedge, a.data);
        uint256 out = abi.decode(_exec(key, a), (uint256));
        assertEq(out, expectOut);
        assertEq(nvda.balanceOf(address(desk)), expectOut);
        assertEq(usdc.balanceOf(address(desk)), 0);
        assertEq(desk.heldTokens().length, 1);
        assertEq(desk.heldTokens()[0], address(nvda));
        assertEq(uint256(desk.hedgeNotionalUsd()), expectNotional);
        assertEq(desk.valueUsd(), expectNotional);
        assertEq(usdc.allowance(address(desk), address(exec)), 0);
    }

    function test_hedge_sellAllRemovesHeldToken() public {
        uint256 tokens = _seed(-20_000e6, 15_000e6);
        adapter.setExposure(0); // below the enforcement threshold
        vm.expectEmit(true, false, false, false, address(desk));
        emit HeldTokenRemoved(address(nvda));
        uint256 usdcOut = abi.decode(_exec(key, _hedgeAction(address(nvda), false, tokens, 0)), (uint256));
        assertEq(usdcOut, router.quote(address(nvda), address(usdc), tokens));
        assertEq(nvda.balanceOf(address(desk)), 0);
        assertEq(desk.heldTokens().length, 0);
        assertEq(desk.hedgeNotionalUsd(), 0);
        assertEq(nvda.allowance(address(desk), address(exec)), 0);
    }

    function test_hedge_inputValidation() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
        vm.prank(key);
        vm.expectRevert(BookrunnerDesk.ZeroAmount.selector);
        desk.execute(_hedgeAction(address(nvda), true, 0, 0));

        IBookrunnerDesk.Action memory a = _hedgeAction(address(nvda), true, 1000e6, 0);
        a.data = abi.encode(address(nvda), true, uint256(1000e6), uint256(0), uint24(3000), V_ORDERLY);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.BadVenue.selector, V_ORDERLY));
        desk.execute(a);

        MockERC20 rogue = new MockERC20("ROGUE", "RG", 18);
        IBookrunnerDesk.Action memory ra = _act(
            IBookrunnerDesk.ActionKind.Hedge,
            abi.encode(address(rogue), true, uint256(1000e6), uint256(0), uint24(3000), UNIV3)
        );
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotCanonical.selector, address(rogue)));
        desk.execute(ra);

        vm.prank(key);
        vm.expectRevert(IMMMandate.SpotShortNotAllowed.selector);
        desk.execute(_hedgeAction(address(nvda), false, 1, 0));

        vm.prank(key);
        vm.expectRevert(bytes("Too little received"));
        desk.execute(_hedgeAction(address(nvda), true, 1000e6, 100e18));
    }

    function test_hedge_mandateRejectionsBubble() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(50_000e6);
        // band: 0 -> 20000 bps is farther from the band
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_hedgeAction(address(nvda), true, 40_000e6, 0));
        // float cap (post-trade holdings)
        vm.prank(timelock);
        registry.setFloatCap(address(nvda), 1e18);
        uint256 q = router.quote(address(usdc), address(nvda), 15_000e6);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.FloatCapExceeded.selector, q, 1e18));
        desk.execute(_hedgeAction(address(nvda), true, 15_000e6, 0));
        // allow-list: wrong proof
        IBookrunnerDesk.Action memory a = _hedgeAction(address(tsla), true, 15_000e6, 0);
        a.proof = _proof(address(nvda), UNIV3);
        vm.prank(key);
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.HedgeNotAllowed.selector, _asset(address(tsla)), UNIV3)
        );
        desk.execute(a);
    }

    function test_hedge_slippageGuard() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(30_000e6);
        router.setHaircutBps(301);
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_hedgeAction(address(nvda), true, 15_000e6, 0));
        router.setHaircutBps(299);
        _exec(key, _hedgeAction(address(nvda), true, 15_000e6, 0));
        // sells are bounded the same way
        uint256 bal = nvda.balanceOf(address(desk));
        router.setHaircutBps(301);
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_hedgeAction(address(nvda), false, bal / 10, 0));
        // a better-than-oracle fill is fine
        router.setHaircutBps(0);
        router.setBonusBps(100);
        _exec(key, _hedgeAction(address(nvda), false, bal / 10, 0));
    }

    function test_hedge_univ4() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
        IBookrunnerDesk.Action memory a;
        a.kind = IBookrunnerDesk.ActionKind.Hedge;
        a.data = abi.encode(address(nvda), true, uint256(15_000e6), uint256(0), uint24(3000), UNIV4);
        a.proof = _proof(address(nvda), UNIV4);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.NotConfigured.selector, UNIV4));
        desk.execute(a);
        vm.prank(timelock);
        exec.setRouter(UNIV4, address(router));
        _exec(key, a);
        assertGt(nvda.balanceOf(address(desk)), 0);
    }

    function test_hedge_maxHeldTokens() public {
        uint256 n = desk.MAX_HELD_TOKENS() + 1;
        address[] memory toks = new address[](n);
        bytes32[] memory leaves = new bytes32[](n);
        vm.startPrank(timelock);
        for (uint256 i; i < n; ++i) {
            MockERC20 t = new MockERC20("T", "T", 18);
            bytes32 pid = bytes32(uint256(0x1000 + i));
            registry.register(address(t), pid, 1e18, 1000e18);
            oracle.set(pid, 100e18, uint64(block.timestamp), false);
            router.setPrice(address(t), 100e18);
            toks[i] = address(t);
            leaves[i] = StandardMerkle.leaf(_asset(address(t)), UNIV3);
        }
        vm.stopPrank();
        bytes32[] memory tree = StandardMerkle.build(leaves);
        BRTypes.Mandate memory m = _defaultMandate();
        m.hedgeAllowRoot = tree[0];
        vm.prank(committee);
        mandate.remandate(m);
        _registerKey(key, operator, uint64(block.timestamp + 1 days), MAX_INV);
        adapter.setExposure(0);
        _fundDesk(n * 100e6);
        for (uint256 i; i < n; ++i) {
            IBookrunnerDesk.Action memory a;
            a.kind = IBookrunnerDesk.ActionKind.Hedge;
            a.data = abi.encode(toks[i], true, uint256(100e6), uint256(0), uint24(3000), UNIV3);
            a.proof = StandardMerkle.proof(tree, leaves[i]);
            if (i + 1 == n) {
                vm.prank(key);
                vm.expectRevert(BookrunnerDesk.TooManyHeldTokens.selector);
                desk.execute(a);
            } else {
                _exec(key, a);
            }
        }
        assertEq(desk.heldTokens().length, desk.MAX_HELD_TOKENS());
        assertEq(desk.valueUsd(), n * 100e6);
    }

    // ------------------------------------------------------------------ Flatten

    function test_flatten_byRiskAfterKill_evenWithStalePrice() public {
        uint256 tokens = _seed(-20_000e6, 15_000e6);
        vm.prank(risk);
        mandate.kill("BREACH");
        vm.warp(block.timestamp + 301); // oracle stale
        uint256 expectUsdc = router.quote(address(nvda), address(usdc), tokens);
        vm.expectEmit(true, false, false, true, address(desk));
        emit HedgeExecuted(address(nvda), false, tokens, expectUsdc, 0);
        uint256 out = abi.decode(_exec(risk, _flattenAction(address(nvda), tokens, 0)), (uint256));
        assertEq(out, expectUsdc);
        assertEq(desk.heldTokens().length, 0);
        assertEq(usdc.balanceOf(address(desk)), expectUsdc);
        // and RISK returns the USDC to the vault
        _exec(risk, _act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(expectUsdc)));
        assertEq(usdc.balanceOf(address(desk)), 0);
        assertEq(vault.returnedNotified(), expectUsdc);
    }

    function test_flatten_byKey_slippageAndStaleChecked() public {
        uint256 tokens = _seed(-20_000e6, 15_000e6);
        router.setHaircutBps(400);
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_flattenAction(address(nvda), tokens / 2, 0));
        router.setHaircutBps(0);
        // off-hours (held): a key Flatten is reduce-only for real — selling spot that offsets a short venue
        // exposure would grow |exposure + hedge| (-5k -> -12.5k), so it reverts like a Hedge sell would
        oracle.setHeld(NVDA_ID, true);
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(_flattenAction(address(nvda), tokens / 2, 0));
        // ... while with a long venue exposure selling spot always reduces net risk: allowed off-hours
        adapter.setExposure(5000e6);
        uint256 notional = registry.valueUsd(address(nvda), tokens / 2);
        vm.expectEmit(true, false, false, true, address(desk));
        emit HedgeExecuted(
            address(nvda), false, tokens / 2, router.quote(address(nvda), address(usdc), tokens / 2), notional
        );
        _exec(key, _flattenAction(address(nvda), tokens / 2, 0));
        // a stale price blocks key flattening (no oracle bound) but not RISK
        vm.warp(block.timestamp + 301);
        uint256 rest = nvda.balanceOf(address(desk));
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.StalePrice.selector, NVDA_ID, uint64(T0)));
        desk.execute(_flattenAction(address(nvda), rest, 0));
        _exec(risk, _flattenAction(address(nvda), rest, 0));
        assertEq(nvda.balanceOf(address(desk)), 0);
    }

    function test_flatten_validation() public {
        uint256 tokens = _seed(-20_000e6, 15_000e6);
        vm.startPrank(risk);
        vm.expectRevert(BookrunnerDesk.ZeroAmount.selector);
        desk.execute(_flattenAction(address(nvda), 0, 0));
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotHeld.selector, address(tsla)));
        desk.execute(_flattenAction(address(tsla), 1, 0));
        vm.expectRevert(IMMMandate.SpotShortNotAllowed.selector);
        desk.execute(_flattenAction(address(nvda), tokens + 1, 0));
        IBookrunnerDesk.Action memory a = _flattenAction(address(nvda), 1, 0);
        a.data = abi.encode(address(nvda), uint256(1), uint256(0), uint24(3000), V_ENGINE);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.BadVenue.selector, V_ENGINE));
        desk.execute(a);
        vm.expectRevert(bytes("Too little received"));
        desk.execute(_flattenAction(address(nvda), tokens, type(uint256).max));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ inventory moves

    function test_inventoryToVenue_andToVault() public {
        uint64 nonce0 = book.flowNonce();
        _exec(
            key,
            _act(
                IBookrunnerDesk.ActionKind.InventoryToVenue, abi.encode(BRTypes.ACCOUNT_MM, uint256(10_000e6))
            )
        );
        assertEq(vault.deployed(BRTypes.ACCOUNT_MM), 10_000e6);
        assertEq(usdc.balanceOf(address(adapter)), 10_000e6);
        assertEq(book.flowNonce(), nonce0 + 1);
        _exec(
            key,
            _act(IBookrunnerDesk.ActionKind.InventoryToVault, abi.encode(BRTypes.ACCOUNT_MM, uint256(4000e6)))
        );
        assertEq(vault.recalled(BRTypes.ACCOUNT_MM), 4000e6);
        assertEq(book.flowNonce(), nonce0 + 2);
    }

    function test_inventoryMoves_validation() public {
        vm.startPrank(key);
        vm.expectRevert(BookrunnerDesk.ZeroAmount.selector);
        desk.execute(
            _act(IBookrunnerDesk.ActionKind.InventoryToVenue, abi.encode(BRTypes.ACCOUNT_IF, uint256(0)))
        );
        vm.expectRevert(
            abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, uint256(IF_TARGET) + 1, IF_TARGET)
        );
        desk.execute(
            _act(
                IBookrunnerDesk.ActionKind.InventoryToVenue,
                abi.encode(BRTypes.ACCOUNT_IF, uint256(IF_TARGET) + 1)
            )
        );
        vm.expectRevert();
        desk.execute(_act(IBookrunnerDesk.ActionKind.InventoryToVenue, abi.encode(uint8(9), uint256(1))));
        vm.stopPrank();
        // uint8 out of range in the encoding is rejected by the decoder
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_act(IBookrunnerDesk.ActionKind.InventoryToVault, abi.encode(uint256(256), uint256(1))));
    }

    // ------------------------------------------------------------------ FundDesk / ReturnToVault

    function test_fundDesk() public {
        _fundDesk(12_345e6);
        assertEq(usdc.balanceOf(address(desk)), 12_345e6);
        assertEq(vault.funded(), 12_345e6);
        assertEq(desk.valueUsd(), 12_345e6);
    }

    function test_fundDesk_validation() public {
        uint256 cap = uint256(MAX_INV) * 12_000 / 10_000;
        vm.startPrank(key);
        vm.expectRevert(BookrunnerDesk.ZeroAmount.selector);
        desk.execute(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(0))));
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.InventoryLimit.selector, cap + 1, cap));
        desk.execute(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(cap + 1)));
        vm.stopPrank();
        vault.setFundShortBy(1);
        vm.prank(key);
        vm.expectRevert(
            abi.encodeWithSelector(
                BookrunnerDesk.FundingShortfall.selector, uint256(100e6), uint256(100e6 - 1)
            )
        );
        desk.execute(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(100e6))));
    }

    function test_returnToVault() public {
        _fundDesk(5000e6);
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        uint64 nonce0 = book.flowNonce();
        _exec(key, _act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(2000e6))));
        assertEq(usdc.balanceOf(address(desk)), 3000e6);
        assertEq(usdc.balanceOf(address(vault)), vaultBefore + 2000e6);
        assertEq(vault.returnedNotified(), 2000e6);
        assertEq(book.flowNonce(), nonce0 + 1);

        vm.startPrank(key);
        vm.expectRevert(BookrunnerDesk.ZeroAmount.selector);
        desk.execute(_act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(0))));
        vm.expectRevert(
            abi.encodeWithSelector(
                BookrunnerDesk.InsufficientBalance.selector, uint256(3000e6 + 1), uint256(3000e6)
            )
        );
        desk.execute(_act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(3000e6 + 1))));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ SetQuote

    function test_setQuote_forwardsToAdapter() public {
        _exec(
            key,
            _act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(12), int16(-7), uint128(40_000e6)))
        );
        assertEq(adapter.lastSpread(), 12);
        assertEq(adapter.lastSkew(), -7);
        assertEq(adapter.lastMaxNet(), 40_000e6);
        assertEq(engine.maxNetExposureUsd(), 40_000e6);
    }

    function test_setQuote_mandateAndVenueChecks() public {
        vm.startPrank(key);
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.QuoteWidthTooNarrow.selector, uint16(7), uint16(8)));
        desk.execute(_act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(7), int16(0), uint128(1))));
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.SkewTooWide.selector, int16(30), int16(25)));
        desk.execute(_act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(10), int16(30), uint128(1))));
        vm.stopPrank();

        _deployBook(BRTypes.VENUE_ORDERLY);
        _registerDefaultKey();
        vm.prank(key);
        vm.expectRevert(BookrunnerDesk.NotEngineBook.selector);
        desk.execute(_act(IBookrunnerDesk.ActionKind.SetQuote, abi.encode(uint16(10), int16(0), uint128(1))));
    }

    // ------------------------------------------------------------------ ERC-4337

    function test_validateUserOp_onlyEntryPoint() public {
        PackedUserOperation memory op = _userOp(
            _act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1))), keyPk, bytes32(uint256(1))
        );
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotEntryPoint.selector, stranger));
        desk.validateUserOp(op, bytes32(uint256(1)), 0);
    }

    function test_validateUserOp_successPacksValidUntilAndPaysPrefund() public {
        vm.deal(address(desk), 1 ether);
        vm.prank(timelock);
        desk.setGasPolicy(0.01 ether, 0.15 ether);
        bytes32 h = keccak256("op1");
        PackedUserOperation memory op =
            _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1))), keyPk, h);
        vm.prank(entryPoint);
        uint256 vd = desk.validateUserOp(op, h, 0.1 ether);
        assertEq(vd, uint256(T0 + 30 days) << 160);
        assertEq(uint160(vd), 0); // sig success, no aggregator
        assertEq(entryPoint.balance, 0.1 ether);
        assertEq(address(desk).balance, 0.9 ether);
        assertEq(desk.prefundBudgetWei(), 0.05 ether);
    }

    function test_validateUserOp_failures() public {
        vm.deal(address(desk), 1 ether);
        vm.prank(timelock);
        desk.setGasPolicy(0.01 ether, 0.2 ether);
        bytes32 h = keccak256("op");
        IBookrunnerDesk.Action memory a = _act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1)));

        // wrong selector
        PackedUserOperation memory op = _userOp(a, keyPk, h);
        op.callData = abi.encodeWithSignature("transfer(address,uint256)", stranger, 1);
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0), 1);
        // short callData
        op.callData = hex"1234";
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0), 1);
        // signer is not a key
        (, uint256 strangerPk) = makeAddrAndKey("strangerKey");
        op = _userOp(a, strangerPk, h);
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0), 1);
        // signature over another hash
        op = _userOp(a, keyPk, keccak256("other"));
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0), 1);
        // malformed signature
        op.signature = hex"deadbeef";
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0.2 ether), 1);
        // prefund is still paid (EntryPoint accounting)
        assertEq(entryPoint.balance, 0.2 ether);
    }

    function _useMockEntryPoint() internal returns (MandateMockEntryPoint ep) {
        ep = new MandateMockEntryPoint();
        cfg.setEntryPoint(address(ep));
        desk.syncEntryPoint();
    }

    function test_validateUserOp_thenExecuteViaEntryPoint() public {
        MandateMockEntryPoint ep = _useMockEntryPoint();
        bytes32 h = keccak256("fund");
        IBookrunnerDesk.Action memory a =
            _act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(777e6)));
        PackedUserOperation memory op = _userOp(a, keyPk, h);

        vm.expectEmit(true, true, false, true, address(desk));
        emit ActionExecuted(key, IBookrunnerDesk.ActionKind.FundDesk, a.data);
        (uint256 vd, bool ok,) = ep.handleOp(address(desk), op, h);
        assertEq(uint160(vd), 0);
        assertTrue(ok);
        assertEq(usdc.balanceOf(address(desk)), 777e6);

        // the recorded signer never outlives the bundle: a later EntryPoint call is unauthorised
        vm.prank(address(ep));
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotAuthorized.selector, address(0)));
        desk.execute(a);
    }

    function test_entryPoint_executeOfOtherCallDataRejected() public {
        MandateMockEntryPoint ep = _useMockEntryPoint();
        bytes32 h = keccak256("fund");
        PackedUserOperation memory op =
            _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(777e6))), keyPk, h);
        bytes memory other = abi.encodeCall(
            IBookrunnerDesk.execute, (_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(778e6))))
        );
        vm.expectRevert(bytes("interleaved call failed"));
        ep.handleOpWithInterleave(address(desk), op, h, address(desk), other);
    }

    function test_entryPoint_twoOpsSameSenderInOneBundle() public {
        MandateMockEntryPoint ep = _useMockEntryPoint();
        bytes32 h1 = keccak256("op1");
        bytes32 h2 = keccak256("op2");
        PackedUserOperation memory op1 =
            _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(100e6))), keyPk, h1);
        PackedUserOperation memory op2 =
            _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(200e6))), keyPk, h2);
        (bool ok1, bool ok2) = ep.handleTwo(address(desk), op1, h1, op2, h2);
        assertTrue(ok1);
        assertTrue(ok2);
        assertEq(usdc.balanceOf(address(desk)), 300e6);
    }

    function test_syncKey_onlyMandate_andSyncEntryPoint() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotMandate.selector, stranger));
        desk.syncKey(stranger, 1);

        address ep2 = makeAddr("ep2");
        cfg.setEntryPoint(ep2);
        assertEq(desk.entryPoint(), entryPoint);
        vm.expectEmit(true, false, false, false, address(desk));
        emit EntryPointSynced(ep2);
        desk.syncEntryPoint();
        assertEq(desk.entryPoint(), ep2);
        bytes32 h = keccak256("x");
        PackedUserOperation memory op =
            _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1))), keyPk, h);
        vm.prank(entryPoint);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotEntryPoint.selector, entryPoint));
        desk.validateUserOp(op, h, 0);

        // unset EntryPoint: the 4337 path is closed entirely
        cfg.setEntryPoint(address(0));
        desk.syncEntryPoint();
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.NotEntryPoint.selector, address(0)));
        desk.validateUserOp(op, h, 0);
    }

    function test_validateUserOp_validUntilClampedToUint48() public {
        address k = makeAddr("longKey");
        (, uint256 pk) = makeAddrAndKey("longKey");
        _registerKey(k, operator, type(uint64).max, MAX_INV);
        bytes32 h = keccak256("long");
        PackedUserOperation memory op =
            _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1))), pk, h);
        vm.prank(entryPoint);
        assertEq(desk.validateUserOp(op, h, 0), uint256(type(uint48).max) << 160);
    }

    // ------------------------------------------------------------------ views

    function test_views_multiplierAndStaleness() public {
        uint256 tokens = _seed(-20_000e6, 15_000e6);
        _fundDesk(1000e6);
        uint256 hv = registry.valueUsd(address(nvda), tokens);
        assertEq(uint256(desk.hedgeNotionalUsd()), hv);
        assertEq(desk.valueUsd(), hv + 1000e6);
        vm.prank(timelock);
        registry.setMultiplier(address(nvda), 2e18);
        assertEq(uint256(desk.hedgeNotionalUsd()), registry.valueUsdAt(address(nvda), tokens, NVDA_PX));
        assertApproxEqAbs(uint256(desk.hedgeNotionalUsd()), 2 * hv, 1);
        vm.warp(block.timestamp + 301);
        vm.expectRevert();
        desk.hedgeNotionalUsd();
    }

    // ------------------------------------------------------------------ admin

    function test_setMaxSlippageBps() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.Unauthorized.selector, stranger));
        desk.setMaxSlippageBps(100);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.BadSlippage.selector, uint16(2001)));
        desk.setMaxSlippageBps(2001);
        vm.expectEmit(false, false, false, true, address(desk));
        emit MaxSlippageSet(50);
        vm.prank(timelock);
        desk.setMaxSlippageBps(50);
        assertEq(desk.maxSlippageBps(), 50);
        // tighter tolerance now rejects a 1% haircut
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
        router.setHaircutBps(100);
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_hedgeAction(address(nvda), true, 15_000e6, 0));
    }

    function test_withdrawNative() public {
        vm.deal(address(desk), 2 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.Unauthorized.selector, stranger));
        desk.withdrawNative(payable(stranger), 1);
        vm.prank(timelock);
        vm.expectRevert(BookrunnerDesk.ZeroAddress.selector);
        desk.withdrawNative(payable(address(0)), 1);
        DeskRejectingReceiver rej = new DeskRejectingReceiver();
        vm.prank(timelock);
        vm.expectRevert(BookrunnerDesk.NativeTransferFailed.selector);
        desk.withdrawNative(payable(address(rej)), 1);
        vm.expectEmit(true, false, false, true, address(desk));
        emit NativeWithdrawn(timelock, 1 ether);
        vm.prank(timelock);
        desk.withdrawNative(payable(timelock), 1 ether);
        assertEq(timelock.balance, 1 ether);
    }

    // ------------------------------------------------------------------ A3-01: userOp gas policy

    function _gasOp(uint128 verGas, uint128 callGas, uint256 pvg, uint128 maxFee, bytes32 h)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = _userOp(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1))), keyPk, h);
        op.accountGasLimits = bytes32((uint256(verGas) << 128) | callGas);
        op.preVerificationGas = pvg;
        op.gasFees = bytes32((uint256(maxFee) << 128) | maxFee);
    }

    function test_gasPolicy_defaults_and_timelockOnly() public {
        assertEq(desk.maxOpCostWei(), desk.DEFAULT_MAX_OP_COST_WEI());
        assertEq(desk.prefundBudgetWei(), 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.Unauthorized.selector, stranger));
        desk.setGasPolicy(1, 1);
        vm.prank(timelock);
        desk.setGasPolicy(0.002 ether, 0.05 ether);
        assertEq(desk.maxOpCostWei(), 0.002 ether);
        assertEq(desk.prefundBudgetWei(), 0.05 ether);
    }

    function test_validateUserOp_capsOpMaxCost() public {
        vm.deal(address(desk), 1 ether);
        vm.prank(timelock);
        desk.setGasPolicy(0.01 ether, 1 ether);
        bytes32 h = keccak256("gas");
        // (200k + 300k + 500k) * 10 gwei = 0.01 ether: at the cap
        PackedUserOperation memory op = _gasOp(200_000, 300_000, 500_000, 10 gwei, h);
        vm.prank(entryPoint);
        assertEq(uint160(desk.validateUserOp(op, h, 0.01 ether)), 0);
        // one wei of fee above: (1M gas) * (10 gwei + 1) > cap — even when the deposit covers it
        op = _gasOp(200_000, 300_000, 500_000, 10 gwei + 1, h);
        vm.prank(entryPoint);
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerDesk.OpCostTooHigh.selector, uint256(1_000_000) * (10 gwei + 1), 0.01 ether)
        );
        desk.validateUserOp(op, h, 0);
        // inflated preVerificationGas (charged in full by the EntryPoint) is capped the same way
        op = _gasOp(1, 1, 1e9, 1 gwei, h);
        vm.prank(entryPoint);
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerDesk.OpCostTooHigh.selector, uint256(1e9 + 2) * 1 gwei, 0.01 ether)
        );
        desk.validateUserOp(op, h, 0);
    }

    function test_validateUserOp_prefundBudgetIsCumulative() public {
        vm.deal(address(desk), 1 ether);
        vm.prank(timelock);
        desk.setGasPolicy(0.01 ether, 0.015 ether);
        bytes32 h = keccak256("b");
        PackedUserOperation memory op = _gasOp(200_000, 300_000, 500_000, 10 gwei, h);
        vm.prank(entryPoint);
        desk.validateUserOp(op, h, 0.01 ether);
        assertEq(desk.prefundBudgetWei(), 0.005 ether);
        vm.prank(entryPoint);
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerDesk.PrefundBudgetExceeded.selector, 0.01 ether, 0.005 ether)
        );
        desk.validateUserOp(op, h, 0.01 ether);
        // a deposit-funded op (missingAccountFunds == 0) does not touch the budget
        vm.prank(entryPoint);
        desk.validateUserOp(op, h, 0);
        assertEq(desk.prefundBudgetWei(), 0.005 ether);
        assertEq(address(desk).balance, 0.99 ether);
    }

    function test_withdrawDepositTo() public {
        DeskMockDepositEntryPoint ep = new DeskMockDepositEntryPoint();
        cfg.setEntryPoint(address(ep));
        desk.syncEntryPoint();
        ep.depositTo{value: 0.3 ether}(address(desk));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.Unauthorized.selector, stranger));
        desk.withdrawDepositTo(payable(stranger), 1);
        vm.prank(timelock);
        vm.expectRevert(BookrunnerDesk.ZeroAddress.selector);
        desk.withdrawDepositTo(payable(address(0)), 1);
        vm.prank(timelock);
        desk.withdrawDepositTo(payable(timelock), 0.3 ether);
        assertEq(timelock.balance, 0.3 ether);
        assertEq(ep.balanceOf(address(desk)), 0);
    }

    // ------------------------------------------------------------------ A3-02 / A7-01: mark-window gate

    function test_capitalFlows_blockedWhileMarkPending_riskExempt() public {
        _fundDesk(5000e6);
        uint256 interval = cfg.markInterval();
        uint64 periodStart = uint64(block.timestamp - (block.timestamp % interval));
        // Live, the period that ended at periodStart has no applied mark
        book.setMarkState(BRTypes.BookState.Live, periodStart - uint64(interval), 1);
        assertFalse(desk.capitalFlowOpen());
        bytes memory pending =
            abi.encodeWithSelector(BookrunnerDesk.MarkPending.selector, periodStart, periodStart - uint64(interval));
        vm.startPrank(key);
        vm.expectRevert(pending);
        desk.execute(_act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1e6))));
        vm.expectRevert(pending);
        desk.execute(_act(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(1e6))));
        vm.expectRevert(pending);
        desk.execute(_act(IBookrunnerDesk.ActionKind.InventoryToVault, abi.encode(BRTypes.ACCOUNT_MM, uint256(1e6))));
        vm.expectRevert(pending);
        desk.execute(_act(IBookrunnerDesk.ActionKind.InventoryToVenue, abi.encode(BRTypes.ACCOUNT_MM, uint256(1e6))));
        vm.stopPrank();
        // RISK is exempt
        _exec(risk, _act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1000e6))));
        // Retiring is gated the same way
        book.setMarkState(BRTypes.BookState.Retiring, periodStart - uint64(interval), 1);
        vm.prank(key);
        vm.expectRevert(pending);
        desk.execute(_act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1e6))));
        // the period's mark lands: flows reopen
        book.setMarkState(BRTypes.BookState.Live, periodStart, 1);
        assertTrue(desk.capitalFlowOpen());
        _exec(key, _act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1000e6))));
        assertEq(usdc.balanceOf(address(desk)), 3000e6);
    }

    function test_capitalFlows_firstPeriodAfterGoLive() public {
        _fundDesk(5000e6);
        uint256 interval = cfg.markInterval();
        uint64 periodStart = uint64(block.timestamp - (block.timestamp % interval));
        // went live in this period, no mark yet: nothing is due before the period ends
        book.setMarkState(BRTypes.BookState.Live, 0, periodStart + 1);
        assertTrue(desk.capitalFlowOpen());
        _exec(key, _act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1000e6))));
        // first period end passed, still no mark: pending
        vm.warp(uint256(periodStart) + interval + 60);
        _refreshPrices();
        assertFalse(desk.capitalFlowOpen());
        vm.prank(key);
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerDesk.MarkPending.selector, periodStart + uint64(interval), uint64(0))
        );
        desk.execute(_act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1000e6))));
        // not Live / Retiring (window, cancelled, retired): no mark cycle, gate open
        book.setMarkState(BRTypes.BookState.Retired, 0, periodStart + 1);
        assertTrue(desk.capitalFlowOpen());
    }

    function test_capitalFlows_nonFlowActionsNotGated() public {
        adapter.setExposure(-50_000e6);
        _fundDesk(20_000e6);
        _buyNvda(10_000e6);
        uint256 interval = cfg.markInterval();
        uint64 periodStart = uint64(block.timestamp - (block.timestamp % interval));
        book.setMarkState(BRTypes.BookState.Live, periodStart - uint64(interval), 1);
        assertFalse(desk.capitalFlowOpen());
        // hedge trading does not bump flowNonce: allowed while a mark is pending
        uint64 nonce0 = book.flowNonce();
        _buyNvda(5000e6);
        assertEq(book.flowNonce(), nonce0);
    }

    function test_returnToVault_minimumUnlessWholeBalance() public {
        _fundDesk(5e6);
        uint256 minRet = desk.MIN_RETURN_USD();
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.ReturnBelowMin.selector, uint256(1), minRet));
        desk.execute(_act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1))));
        _exec(key, _act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(5e6 - 1)));
        // the remaining dust may go back as the whole balance
        _exec(key, _act(IBookrunnerDesk.ActionKind.ReturnToVault, abi.encode(uint256(1))));
        assertEq(usdc.balanceOf(address(desk)), 0);
    }
}
