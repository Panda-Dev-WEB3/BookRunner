// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {OrderlyIFAccount} from "../../src/OrderlyIFAccount.sol";
import {MockOrderlyVault} from "../../src/mocks/MockOrderlyVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";

import {OrderlyFixture} from "./utils/OrderlyFixture.sol";
import {OrderlyMockUWVault} from "./utils/OrderlyTestMocks.sol";
import {OrderlyAdapterV3} from "./utils/OrderlyAdapterV3.sol";

/// @notice VERIFY O6/O9: the adapter uses Orderly's real accounts (MockOrderlyVault strict mode, as on the real
///         Vault): MM = keccak256(abi.encode(adapter, brokerHash)), IF = keccak256(abi.encode(ifAccount,
///         brokerHash)) owned by a per-book OrderlyIFAccount; contract-account withdrawals are paid to the
///         contract itself (Orderly LedgerImplA: receiver must equal sender), so IF payouts land on the IF
///         account and are pulled by the adapter.
contract OrderlyAccountsTest is OrderlyFixture {
    function _ifAcc() internal view returns (OrderlyIFAccount) {
        return OrderlyIFAccount(adapter.ifAccount());
    }

    function test_ifAccount_deployedAtInitialize() public view {
        OrderlyIFAccount ifAcc = _ifAcc();
        assertEq(ifAcc.adapter(), address(adapter));
        assertTrue(ov.strictAccountIds());
        // deterministic: CREATE2 from the adapter proxy, salt = bookId
        bytes32 initHash = keccak256(type(OrderlyIFAccount).creationCode);
        address predicted = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(adapter), bytes32(BOOK_ID), initHash))))
        );
        assertEq(address(ifAcc), predicted);
    }

    function test_initialize_emitsAccountsBound() public {
        address predicted = _predictAdapter(BOOK_ID);
        bookMock.setComponents(_components(predicted));
        address ifPredicted =
            vm.computeCreate2Address(bytes32(BOOK_ID), keccak256(type(OrderlyIFAccount).creationCode), predicted);
        vm.expectEmit(true, false, false, true, predicted);
        emit OrderlyAdapter.OrderlyAccountsBound(
            ifPredicted, keccak256(abi.encode(ifPredicted, BROKER_HASH)), keccak256(abi.encode(predicted, BROKER_HASH))
        );
        OrderlyAdapter p = _deployAdapter(BOOK_ID, false);
        assertEq(
            p.accountId(BRTypes.ACCOUNT_IF), keccak256(abi.encode(p.ifAccount(), BROKER_HASH)), "IF = ifAccount's"
        );
        assertEq(p.accountId(BRTypes.ACCOUNT_MM), keccak256(abi.encode(address(p), BROKER_HASH)), "MM = adapter's");
    }

    function test_strictDeposits_IF_viaDepositTo_MM_viaDeposit() public {
        _deploy(IF, 25_001e6);
        _deploy(MM, 75_000e6);
        bytes32 ifId = adapter.accountId(IF);
        bytes32 mmId = adapter.accountId(MM);
        assertEq(ov.accountOwner(ifId), address(_ifAcc()), "IF account owned by the IF contract");
        assertEq(ov.accountOwner(mmId), address(adapter), "MM account owned by the adapter");
        assertEq(ov.balanceOf(ifId), 25_001e6);
        assertEq(ov.balanceOf(mmId), 75_000e6);
        assertEq(adapter.insuranceEquityUsd(), 25_001e6);
        assertEq(usdc.balanceOf(address(_ifAcc())), 0, "the adapter pays IF deposits; nothing parks on the IF contract");
        assertEq(usdc.violations(), 0);
    }

    function test_strictVault_rejectsLegacyDerivation() public {
        _makeLegacy(adapter);
        vm.expectRevert(MockOrderlyVault.AccountIdInvalid.selector);
        _deploy(MM, 1e6);
        vm.expectRevert(MockOrderlyVault.AccountIdInvalid.selector);
        adapter.depositNativeFee(IF, 1e6);
    }

    function test_legacyProxy_stillWorksOnPermissiveMock() public {
        ov.setStrictAccountIds(false);
        _makeLegacy(adapter);
        _deploy(IF, 1000e6);
        assertEq(ov.accountOwner(adapter.accountId(IF)), address(adapter));
        uint256 n = _recall(IF, 400e6);
        _confirm(n);
        _payOut(IF, 400e6); // legacy: paid to the adapter itself
        assertEq(adapter.sweepToVault(), 400e6);
    }

    function test_IF_withdrawal_paidToIfAccount_pulledOnSweep() public {
        _deploy(IF, 25_001e6);
        uint256 n = _recall(IF, 10_000e6);
        _confirm(n);
        _payOut(IF, 10_000e6); // Orderly pays the contract account (receiver == sender)
        assertEq(usdc.balanceOf(address(_ifAcc())), 10_000e6);
        assertEq(adapter.sweepableToVault(), 10_000e6, "views count USDC parked on the IF account");

        uint256 navBefore = _navUsd();
        uint256 idleBefore = uwVault.idle();
        vm.prank(alice);
        assertEq(adapter.sweepToVault(), 10_000e6);
        assertEq(usdc.balanceOf(address(_ifAcc())), 0);
        assertEq(uwVault.idle(), idleBefore + 10_000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(_navUsd(), navBefore);
        assertEq(usdc.violations(), 0);
    }

    function test_IF_payoutBeforeConfirm_isHeld() public {
        _deploy(IF, 25_001e6);
        uint256 n = _recall(IF, 5000e6);
        _payOut(IF, 5000e6);
        assertEq(adapter.heldForPendingWithdrawalsUsd(), 5000e6);
        assertEq(adapter.sweepToVault(), 0, "held for the unconfirmed request");
        _confirm(n);
        assertEq(adapter.sweepToVault(), 5000e6);
    }

    function test_feeForwarding_pullsFromIfAccount() public {
        _deploy(IF, 25_001e6);
        uint64 p = _firstFeePeriod();
        vm.warp(uint256(p) + 1);
        _applyCurrentMark();
        vm.prank(ops);
        adapter.sweepFees(p, 300e6);
        // e.g. a stray credit paid out of the IF account: once on the IF contract it is attributable fee flow
        _creditVenueFees(IF, 300e6);
        _payOut(IF, 300e6);
        assertEq(adapter.forwardableFees(), 300e6);
        assertEq(adapter.forwardPendingFees(), 300e6);
        assertEq(usdc.balanceOf(address(router)), 300e6);
        assertEq(usdc.violations(), 0);
    }

    function test_setDelegateSigner_registersBothAccounts() public {
        vm.expectEmit(true, true, true, true, address(ov));
        emit MockOrderlyVault.AccountDelegate(address(adapter), BROKER_HASH, delegateEoa, block.chainid, block.number);
        vm.expectEmit(true, true, true, true, address(ov));
        emit MockOrderlyVault.AccountDelegate(
            address(_ifAcc()), BROKER_HASH, delegateEoa, block.chainid, block.number
        );
        vm.prank(timelock);
        adapter.setDelegateSigner(delegateEoa);
        assertEq(ov.delegateOf(address(adapter), BROKER_HASH), delegateEoa);
        assertEq(ov.delegateOf(address(_ifAcc()), BROKER_HASH), delegateEoa);
    }

    function test_ifAccount_onlyAdapter() public {
        OrderlyIFAccount ifAcc = _ifAcc();
        vm.prank(alice);
        vm.expectRevert(OrderlyIFAccount.NotAdapter.selector);
        ifAcc.forward(address(usdc));
        vm.prank(timelock);
        vm.expectRevert(OrderlyIFAccount.NotAdapter.selector);
        ifAcc.delegateSigner(address(ov), BROKER_HASH, alice);
        // refuses ETH (no receive): nothing can get stuck there
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(ifAcc).call{value: 1}("");
        assertFalse(ok);
    }

    function test_rescueToken_sweepsNonUsdcFromIfAccount() public {
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(address(_ifAcc()), 3e18);
        vm.prank(timelock);
        adapter.rescueToken(address(junk), alice, 3e18);
        assertEq(junk.balanceOf(alice), 3e18);
        assertEq(junk.balanceOf(address(_ifAcc())), 0);
    }

    // ------------------------------------------------------------------ IF account mode (v4, VERIFY O10)

    address internal constant BUILDER_IF_EOA = address(0xB1F0);

    function _setIfOwner(address owner) internal {
        vm.prank(timelock);
        adapter.setIfAccountOwner(owner);
    }

    function test_ifMode_defaultIsContract() public view {
        assertEq(adapter.ifAccountOwner(), address(0));
        assertEq(adapter.accountOwner(IF), address(_ifAcc()));
        assertEq(adapter.accountId(IF), keccak256(abi.encode(address(_ifAcc()), BROKER_HASH)));
    }

    function test_ifMode_builder_bindsEoaAccount_andEmits() public {
        bytes32 ifId = keccak256(abi.encode(BUILDER_IF_EOA, BROKER_HASH));
        vm.expectEmit(true, false, false, true, address(adapter));
        emit OrderlyAdapter.IfAccountOwnerSet(BUILDER_IF_EOA, ifId);
        vm.expectEmit(true, false, false, true, address(adapter));
        emit OrderlyAdapter.OrderlyAccountsBound(BUILDER_IF_EOA, ifId, adapter.accountId(MM));
        _setIfOwner(BUILDER_IF_EOA);
        assertEq(adapter.ifAccountOwner(), BUILDER_IF_EOA);
        assertEq(adapter.accountOwner(IF), BUILDER_IF_EOA);
        assertEq(adapter.accountId(IF), ifId);
        assertEq(adapter.accountOwner(MM), address(adapter), "MM unchanged");
        assertEq(adapter.accountId(MM), keccak256(abi.encode(address(adapter), BROKER_HASH)), "MM unchanged");
        assertEq(adapter.ifAccount(), address(_ifAcc()), "the IF contract stays deployed (contract mode fallback)");
    }

    function test_ifMode_builder_depositViaDepositTo_recordedOnChain() public {
        _setIfOwner(BUILDER_IF_EOA);
        bytes32 ifId = adapter.accountId(IF);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit OrderlyAdapter.OrderlyDeposit(IF, ifId, 25_001e6, 0);
        _deploy(IF, 25_001e6); // strict vault: depositTo(eoa, accountId = keccak256(eoa, brokerHash))
        assertEq(ov.accountOwner(ifId), BUILDER_IF_EOA, "the builder EOA owns the IF account");
        assertEq(ov.balanceOf(ifId), 25_001e6);
        assertEq(adapter.insuranceEquityUsd(), 25_001e6);
        assertEq(usdc.balanceOf(BUILDER_IF_EOA), 0, "nothing paid to the EOA by a deposit");
        assertEq(usdc.violations(), 0);
    }

    function test_ifMode_builder_withdrawal_paidToEoa_returnedByOperator() public {
        _setIfOwner(BUILDER_IF_EOA);
        _deploy(IF, 25_001e6);
        uint256 n = _recall(IF, 10_000e6);
        _confirm(n);
        _payOut(IF, 10_000e6); // Orderly pays the EOA account's owner
        assertEq(usdc.balanceOf(BUILDER_IF_EOA), 10_000e6);
        assertEq(adapter.sweepableToVault(), 0, "nothing on the adapter until the operator returns it");
        assertEq(adapter.inTransitUsd(), 10_000e6);
        vm.prank(BUILDER_IF_EOA);
        usdc.transfer(address(adapter), 10_000e6); // operator step: back to the adapter
        uint256 navBefore = _navUsd();
        uint256 idleBefore = uwVault.idle();
        assertEq(adapter.sweepToVault(), 10_000e6);
        assertEq(uwVault.idle(), idleBefore + 10_000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(_navUsd(), navBefore);
    }

    function test_ifMode_setOwner_guards() public {
        vm.prank(ops);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.setIfAccountOwner(BUILDER_IF_EOA);
        // contracts (incl. the adapter and its IF contract) are refused: builder mode is an EOA-owned account
        for (uint256 i = 0; i < 3; i++) {
            address c = i == 0 ? address(adapter) : i == 1 ? address(_ifAcc()) : address(usdc);
            vm.prank(timelock);
            vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.IfOwnerNotEoa.selector, c));
            adapter.setIfAccountOwner(c);
        }
        // not while the IF account holds capital on our books
        _deploy(IF, 25_001e6);
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.VenueStateNotEmpty.selector);
        adapter.setIfAccountOwner(BUILDER_IF_EOA);
    }

    function test_ifMode_mmCapitalDoesNotBlock_switchBackOnceEmpty() public {
        _deploy(MM, 75_000e6);
        _setIfOwner(BUILDER_IF_EOA); // MM capital does not block: the MM account id never changes
        _deploy(IF, 1_000e6);
        uint256 n = _recall(IF, 1_000e6);
        // confirmation moves the IF amount venue-side -> in transit; the payout goes to the EOA
        _confirm(n);
        _payOut(IF, 1_000e6);
        assertEq(adapter.insuranceEquityUsd(), 0);
        _recallNone();
        vm.prank(BUILDER_IF_EOA);
        usdc.transfer(address(adapter), 1_000e6);
        assertEq(adapter.sweepToVault(), 1_000e6);
        _setIfOwner(address(0)); // back to contract mode once empty
        assertEq(adapter.accountOwner(IF), address(_ifAcc()));
        assertEq(adapter.accountId(IF), keccak256(abi.encode(address(_ifAcc()), BROKER_HASH)));
    }

    function test_ifMode_setOwner_refusedWhileIfRequestPending() public {
        _setIfOwner(BUILDER_IF_EOA);
        _deploy(IF, 1_000e6);
        _recall(IF, 1_000e6);
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.VenueStateNotEmpty.selector);
        adapter.setIfAccountOwner(address(0));
    }

    function test_ifMode_setOwner_bumpsLastFlowAt_soOldSnapshotsCannotLand() public {
        vm.warp(block.timestamp + 100);
        _setIfOwner(BUILDER_IF_EOA);
        assertEq(adapter.lastFlowAt(), uint64(block.timestamp));
        // a snapshot of the previous (contract) IF account taken before the switch is refused
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(OrderlyAdapter.ReportPredatesFlow.selector, uint64(block.timestamp), uint64(block.timestamp))
        );
        adapter.report(1e6, 0, 0, uint64(block.timestamp));
    }

    // ---- builder IF payouts not returned by the operator: written off from NAV

    function _paidToEoa(uint256 amount) internal returns (uint256 n) {
        _setIfOwner(BUILDER_IF_EOA);
        _deploy(IF, 25_001e6);
        n = _recall(IF, amount);
        _confirm(n);
        _payOut(IF, amount); // Orderly pays the EOA
    }

    function test_writeOff_removesUnreturnedPayoutFromNav_andNotifiesTheVault() public {
        uint256 n = _paidToEoa(10_000e6);
        uint256 navBefore = adapter.deployedValueUsd();
        uint64 nonceBefore = bookMock.flowNonce();
        vm.warp(block.timestamp + adapter.WRITE_OFF_MIN_AGE());
        vm.expectEmit(true, false, false, true, address(adapter));
        emit OrderlyAdapter.OperatorPayoutWrittenOff(n, 10_000e6);
        vm.prank(ops);
        adapter.writeOffOperatorPayout(n);
        assertEq(uint8(adapter.withdrawRequest(n).status), uint8(OrderlyAdapter.WithdrawStatus.WrittenOff));
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.deployedValueUsd(), navBefore - 10_000e6, "NAV no longer counts the operator's wallet");
        assertEq(bookMock.flowNonce(), nonceBefore + 1, "a mark valued with it can no longer be applied");
        assertEq(adapter.lastFlowAt(), uint64(block.timestamp));
        // a late return is unattributed USDC: swept to the vault as a gain
        vm.prank(BUILDER_IF_EOA);
        usdc.transfer(address(adapter), 10_000e6);
        uint256 idleBefore = uwVault.idle();
        assertEq(adapter.sweepToVault(), 10_000e6);
        assertEq(uwVault.idle(), idleBefore + 10_000e6);
        // terminal: never written off twice
        vm.prank(ops);
        vm.expectRevert(
            abi.encodeWithSelector(OrderlyAdapter.RequestNotConfirmed.selector, n, OrderlyAdapter.WithdrawStatus.WrittenOff)
        );
        adapter.writeOffOperatorPayout(n);
    }

    function test_writeOff_guards() public {
        uint256 n = _paidToEoa(1_000e6);
        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.NotOpsVenueOrTimelock.selector);
        adapter.writeOffOperatorPayout(n);
        uint64 earliest = adapter.withdrawRequest(n).confirmedAt + adapter.WRITE_OFF_MIN_AGE();
        vm.prank(ops);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.WriteOffTooEarly.selector, n, earliest));
        adapter.writeOffOperatorPayout(n);
        vm.warp(earliest);
        // an MM request is never an operator payout
        _deploy(MM, 75_000e6);
        uint256 m = _recall(MM, 1_000e6);
        _confirm(m);
        vm.prank(ops);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.NotBuilderIfPayout.selector, m));
        adapter.writeOffOperatorPayout(m);
        // a pending (Requested) request cannot be written off
        uint256 q = _recall(IF, 1_000e6);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.RequestNotConfirmed.selector, q, OrderlyAdapter.WithdrawStatus.Requested));
        adapter.writeOffOperatorPayout(q);
        vm.prank(timelock); // the timelock may write off too
        adapter.writeOffOperatorPayout(n);
    }

    function test_writeOff_refusedInContractMode() public {
        _deploy(IF, 25_001e6);
        uint256 n = _recall(IF, 1_000e6);
        _confirm(n);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ops);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.NotBuilderIfPayout.selector, n));
        adapter.writeOffOperatorPayout(n);
    }

    function test_ifMode_setOwner_refusedOnLegacyProxy() public {
        ov.setStrictAccountIds(false);
        _makeLegacy(adapter);
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.OrderlyAccountsNotBound.selector);
        adapter.setIfAccountOwner(BUILDER_IF_EOA);
    }

    /// @dev Nothing left pending on the IF account (keeps the switch-back test explicit).
    function _recallNone() internal view {
        assertEq(adapter.pendingWithdrawUsd(IF), 0);
    }

    // ------------------------------------------------------------------ migration of pre-v3 proxies

    function test_migrate_onlyTimelock_once_andOnlyWhenEmpty() public {
        address ifAcc = address(_ifAcc());
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.AlreadyOrderlyAccounts.selector, ifAcc));
        adapter.migrateToOrderlyAccounts();

        ov.setStrictAccountIds(false);
        _makeLegacy(adapter);
        _deploy(MM, 1e6);
        vm.prank(ops);
        vm.expectRevert(OrderlyAdapter.NotTimelock.selector);
        adapter.migrateToOrderlyAccounts();
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.VenueStateNotEmpty.selector);
        adapter.migrateToOrderlyAccounts();
    }

    function test_migrate_bindsRealAccountsAndDelegate() public {
        OrderlyAdapter p = _freshLegacyAdapter();
        vm.prank(timelock);
        p.setDelegateSigner(delegateEoa);
        vm.prank(timelock);
        p.migrateToOrderlyAccounts();
        address ifAcc = p.ifAccount();
        assertTrue(ifAcc != address(0));
        assertEq(p.accountId(IF), keccak256(abi.encode(ifAcc, BROKER_HASH)));
        assertEq(p.accountId(MM), keccak256(abi.encode(address(p), BROKER_HASH)));
        assertEq(ov.delegateOf(ifAcc, BROKER_HASH), delegateEoa, "current delegate registered for the IF account");

        // strict vault accepts the migrated proxy
        OrderlyMockUWVault v = OrderlyMockUWVault(_vaultFor(p));
        usdc.mint(address(v), 30_000e6);
        v.deployToVenue(IF, 25_001e6);
        assertEq(ov.accountOwner(p.accountId(IF)), ifAcc);
    }

    /// @dev A proxy whose IF contract was never deployed (pre-v3): deployed under another book id, then rewound.
    function _freshLegacyAdapter() internal returns (OrderlyAdapter p) {
        OrderlyMockUWVault v = new OrderlyMockUWVault(address(usdc), address(bookMock));
        bookMock.setBookId(BOOK_ID + 1);
        address predicted = _predictAdapter(BOOK_ID + 1);
        bookMock.setComponents(_componentsWith(predicted, address(v)));
        p = _deployAdapter(BOOK_ID + 1, false);
        v.setAdapter(address(p));
        _vaults[address(p)] = address(v);
        _rewindIfAccount(p);
    }

    mapping(address => address) private _vaults;

    function _vaultFor(OrderlyAdapter p) internal view returns (address) {
        return _vaults[address(p)];
    }

    function _componentsWith(address adapter_, address vault_) internal returns (BRTypes.BookComponents memory c) {
        c = _components(adapter_);
        c.vault = vault_;
    }

    /// @dev Removes the IF contract deployed at initialize (code + binding), so `migrateToOrderlyAccounts` can
    ///      CREATE2 it again at the same address, exactly as on a proxy initialized before v3.
    function _rewindIfAccount(OrderlyAdapter p) internal {
        address ifAcc = p.ifAccount();
        vm.etch(ifAcc, "");
        vm.setNonceUnsafe(ifAcc, 0);
        _makeLegacy(p);
    }
}

/// @notice O3/O7: the adapter settles in whatever 6-decimals token config.usdc() is, under the Orderly token hash
///         the implementation was built with (USDG on Robinhood Chain: keccak256("USDG")).
contract OrderlyUsdgTest is OrderlyFixture {
    bytes32 internal constant USDG_HASH = 0x50c06f78ad2e5bdc0d81007456f70e6c87ac46669280a41f915860e5145b02ea;

    function test_usdgHash_isKeccakOfSymbol() public pure {
        assertEq(USDG_HASH, keccak256(bytes("USDG")));
    }

    function test_usdgBook_endToEnd() public {
        MockERC20 usdg = new MockERC20("Global Dollar", "USDG", 6);
        MockOrderlyVault ovG = new MockOrderlyVault(address(this), address(usdg), USDG_HASH, BROKER_HASH);
        ovG.setStrictAccountIds(true);
        ovG.setOperator(orderlyOperator, true);
        cfg.setUsdc(address(usdg));
        cfg.setOrderlyVault(address(ovG));
        impl = new OrderlyAdapter(BROKER_HASH, USDG_HASH);

        OrderlyMockUWVault v = new OrderlyMockUWVault(address(usdg), address(bookMock));
        address predicted = _predictAdapter(BOOK_ID);
        BRTypes.BookComponents memory c = _components(predicted);
        c.vault = address(v);
        bookMock.setComponents(c);
        OrderlyAdapter p = _deployAdapter(BOOK_ID + 0, false);
        v.setAdapter(address(p));

        assertEq(p.usdc(), address(usdg));
        assertEq(p.tokenHash(), USDG_HASH);
        usdg.mint(address(v), 100_001e6);
        v.deployToVenue(IF, 25_001e6);
        v.deployToVenue(MM, 75_000e6);
        assertEq(ovG.balanceOf(p.accountId(IF)), 25_001e6);
        assertEq(ovG.balanceOf(p.accountId(MM)), 75_000e6);

        v.recall(IF, 1000e6);
        uint256 n = p.withdrawNonce();
        vm.prank(ops);
        p.confirmWithdraw(n);
        (bytes32 ifId, address ifOwner) = (p.accountId(IF), p.accountOwner(IF));
        vm.prank(orderlyOperator);
        ovG.operatorWithdraw(ifId, ifOwner, 1000e6);
        assertEq(p.sweepToVault(), 1000e6);
        assertEq(usdg.balanceOf(address(v)), 1000e6);
    }

    function test_rejectsNonSixDecimalsSettlementToken() public {
        MockERC20 usdg18 = new MockERC20("Global Dollar 18", "USDG", 18);
        cfg.setUsdc(address(usdg18));
        _expectDeployRevert(abi.encodeWithSelector(OrderlyAdapter.UnsupportedTokenDecimals.selector, uint8(18)), BOOK_ID, true);
    }

    function test_rejectsTokenHashTheVaultDoesNotList() public {
        // implementation built with the USDC hash, venue lists the settlement token under USDG only
        MockERC20 usdg = new MockERC20("Global Dollar", "USDG", 6);
        MockOrderlyVault ovG = new MockOrderlyVault(address(this), address(usdg), USDG_HASH, BROKER_HASH);
        cfg.setUsdc(address(usdg));
        cfg.setOrderlyVault(address(ovG));
        _expectDeployRevert(
            abi.encodeWithSelector(OrderlyAdapter.TokenNotAllowedByVenue.selector, TOKEN_HASH, address(0)), BOOK_ID, true
        );
    }
}

/// @notice O5: Orderly's native deposit fee (Vault.getDepositFee) is paid from the adapter's ETH.
contract OrderlyDepositFeeTest is OrderlyFixture {
    uint256 internal constant FEE = 0.0004 ether;

    function test_fundNative_emitsAndHolds() public {
        vm.deal(alice, 1 ether);
        vm.expectEmit(true, false, false, true, address(adapter));
        emit OrderlyAdapter.NativeFunded(alice, 0.01 ether, 0.01 ether);
        vm.prank(alice);
        adapter.fundNative{value: 0.01 ether}();
        assertEq(address(adapter).balance, 0.01 ether);

        vm.prank(alice);
        vm.expectRevert(OrderlyAdapter.ZeroAmount.selector);
        adapter.fundNative{value: 0}();
    }

    function test_feePaidForBothAccounts_strict() public {
        ov.setDepositFee(FEE);
        assertEq(adapter.depositNativeFee(IF, 25_001e6), FEE, "fee quoted with the IF account's owner as receiver");
        assertEq(adapter.depositNativeFee(MM, 75_000e6), FEE);
        vm.deal(address(this), 1 ether);
        adapter.fundNative{value: 2 * FEE}();

        vm.expectEmit(true, true, false, true, address(adapter));
        emit OrderlyAdapter.OrderlyDeposit(IF, adapter.accountId(IF), 25_001e6, FEE);
        _deploy(IF, 25_001e6);
        _deploy(MM, 75_000e6);
        assertEq(address(adapter).balance, 0);
        assertEq(address(ov).balance, 2 * FEE);
    }

    function test_closeWindowDeployRevertsClearlyWithoutEth() public {
        ov.setDepositFee(FEE);
        vm.deal(address(this), 1 ether);
        adapter.fundNative{value: FEE}(); // enough for one deposit only
        _deploy(IF, 25_001e6);
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.InsufficientNativeForFee.selector, FEE, 0));
        _deploy(MM, 75_000e6);
        // topping up unblocks the deployment
        adapter.fundNative{value: FEE}();
        _deploy(MM, 75_000e6);
        assertEq(adapter.marginEquityUsd(), int256(75_000e6));
    }

    function test_refundsAccepted() public {
        vm.deal(address(ov), 1 ether);
        vm.prank(address(ov));
        (bool ok,) = address(adapter).call{value: 0.1 ether}("");
        assertTrue(ok, "venue / cross-chain manager refunds land on the adapter");
    }
}

/// @notice v3 -> v4 (IF account mode): a proxy running the frozen v3 implementation with state (IF + MM venue-side,
///         a pending MM request, an IF payout in transit, its OrderlyIFAccount) keeps every value after the upgrade, is in
///         contract mode (`ifAccountOwner() == 0`) and keeps working; the new slot is untouched by v3 state.
contract OrderlyV4UpgradeTest is OrderlyFixture {
    function setUp() public override {
        super.setUp();
        // redeploy the book's adapter from the v3 implementation
        impl = OrderlyAdapter(payable(address(new OrderlyAdapterV3(BROKER_HASH, TOKEN_HASH))));
        bookMock.setBookId(BOOK_ID + 7);
        adapter = _deployAdapter(BOOK_ID + 7, true);
        uwVault.setAdapter(address(adapter));
        usdc.watch(address(adapter), address(uwVault), address(router), address(ov));
        usdc.setIfAccount(adapter.ifAccount());
    }

    struct Snap {
        address ifAcc;
        bytes32 ifId;
        bytes32 mmId;
        uint256 ins;
        int256 margin;
        uint256 transit;
        uint256 pendMm;
        uint64 flowAt;
        uint256 wn;
        uint256 nav;
        uint256 sweepable;
    }

    function _snap() internal view returns (Snap memory x) {
        x.ifAcc = adapter.ifAccount();
        x.ifId = adapter.accountId(IF);
        x.mmId = adapter.accountId(MM);
        x.ins = adapter.insuranceEquityUsd();
        x.margin = adapter.marginEquityUsd();
        x.transit = adapter.inTransitUsd();
        x.pendMm = adapter.pendingWithdrawUsd(MM);
        x.flowAt = adapter.lastFlowAt();
        x.wn = adapter.withdrawNonce();
        x.nav = adapter.deployedValueUsd();
        x.sweepable = adapter.sweepableToVault();
    }

    function test_upgradeV3ToV4_preservesState_contractMode() public {
        _deploy(IF, 25_001e6);
        _deploy(MM, 75_000e6);
        uint256 nIf = _recall(IF, 5_000e6);
        _confirm(nIf);
        _payOut(IF, 2_000e6); // part of the payout parked on the IF contract
        uint256 nMm = _recall(MM, 1_000e6); // still Requested
        vm.warp(block.timestamp + 10);

        Snap memory before = _snap();
        OrderlyAdapter v4 = new OrderlyAdapter(BROKER_HASH, TOKEN_HASH);
        vm.prank(timelock);
        adapter.upgradeToAndCall(address(v4), "");
        Snap memory afterUp = _snap();

        assertEq(adapter.ifAccountOwner(), address(0), "contract mode after the upgrade");
        assertEq(adapter.accountOwner(IF), before.ifAcc);
        assertEq(keccak256(abi.encode(afterUp)), keccak256(abi.encode(before)), "every view unchanged");
        assertEq(uint8(adapter.withdrawRequest(nIf).status), uint8(OrderlyAdapter.WithdrawStatus.Confirmed));
        assertEq(uint8(adapter.withdrawRequest(nMm).status), uint8(OrderlyAdapter.WithdrawStatus.Requested));

        // flows continue: the rest of the IF payout lands, the MM request confirms, everything sweeps
        _payOut(IF, 3_000e6);
        _confirm(nMm);
        _payOut(MM, 1_000e6);
        assertEq(adapter.sweepToVault(), 6_000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(usdc.violations(), 0);
        // the builder switch is refused while insurance is venue-side
        vm.prank(timelock);
        vm.expectRevert(OrderlyAdapter.VenueStateNotEmpty.selector);
        adapter.setIfAccountOwner(address(0xB1F0));
    }
}
