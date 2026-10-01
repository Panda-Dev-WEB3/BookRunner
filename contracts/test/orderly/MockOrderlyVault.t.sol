// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {MockOrderlyVault} from "../../src/mocks/MockOrderlyVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {IOrderlyVault} from "../../src/interfaces/external/IOrderlyVault.sol";

/// @notice A contract account (Orderly smart-contract accounts must call delegateSigner themselves).
contract DelegatingContract {
    function delegate(IOrderlyVault v, bytes32 brokerHash, address signer) external {
        v.delegateSigner(IOrderlyVault.VaultDelegate({brokerHash: brokerHash, delegateSigner: signer}));
    }
}

contract MockOrderlyVaultTest is Test {
    bytes32 internal constant BROKER = keccak256("bookrunner");
    bytes32 internal constant USDC_HASH = keccak256("USDC");

    MockERC20 internal usdc;
    MockOrderlyVault internal ov;
    address internal operator = makeAddr("operator");
    address internal user = makeAddr("user");
    address internal stranger = makeAddr("stranger");
    bytes32 internal userAccount;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        ov = new MockOrderlyVault(address(this), address(usdc), USDC_HASH, BROKER);
        ov.setOperator(operator, true);
        userAccount = keccak256(abi.encode(user, BROKER));
        usdc.mint(user, 1000e6);
        vm.prank(user);
        usdc.approve(address(ov), type(uint256).max);
    }

    function _data(bytes32 id, uint128 amount) internal pure returns (IOrderlyVault.VaultDepositFE memory) {
        return IOrderlyVault.VaultDepositFE({
            accountId: id, brokerHash: BROKER, tokenHash: USDC_HASH, tokenAmount: amount
        });
    }

    function test_constructor_state() public view {
        assertEq(address(ov.token()), address(usdc));
        assertEq(ov.tokenHash(), USDC_HASH);
        assertTrue(ov.allowedBroker(BROKER));
        assertEq(ov.getAllowedToken(USDC_HASH), address(usdc));
        assertEq(ov.getAllowedToken(keccak256("USDG")), address(0));
        assertEq(ov.owner(), address(this));
        assertEq(ov.depositFee(), 0);
    }

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(MockOrderlyVault.AddressZero.selector);
        new MockOrderlyVault(address(this), address(0), USDC_HASH, BROKER);
    }

    function test_deposit_ledgerAndEvent() public {
        vm.expectEmit(true, true, true, true, address(ov));
        emit MockOrderlyVault.AccountDepositTo(userAccount, BROKER, user, 1, USDC_HASH, 100e6);
        vm.prank(user);
        ov.deposit(_data(userAccount, 100e6));
        assertEq(ov.balanceOf(userAccount), 100e6);
        assertEq(ov.totalLedger(), 100e6);
        assertEq(ov.accountOwner(userAccount), user);
        assertEq(ov.accountBroker(userAccount), BROKER);
        assertEq(ov.depositNonce(), 1);
        assertEq(usdc.balanceOf(address(ov)), 100e6);
    }

    function test_depositTo_recordsReceiver() public {
        address receiver = makeAddr("receiver");
        bytes32 id = keccak256(abi.encode(receiver, BROKER));
        vm.prank(user);
        ov.depositTo(receiver, _data(id, 10e6));
        assertEq(ov.accountOwner(id), receiver);
        assertEq(usdc.balanceOf(user), 990e6, "pulled from the sender");
        vm.prank(user);
        vm.expectRevert(MockOrderlyVault.AddressZero.selector);
        ov.depositTo(address(0), _data(id, 10e6));
    }

    function test_deposit_validation() public {
        vm.startPrank(user);
        vm.expectRevert(MockOrderlyVault.AccountIdInvalid.selector);
        ov.deposit(_data(bytes32(0), 1));
        vm.expectRevert(MockOrderlyVault.ZeroDeposit.selector);
        ov.deposit(_data(userAccount, 0));

        IOrderlyVault.VaultDepositFE memory d = _data(userAccount, 1);
        d.tokenHash = keccak256("USDG");
        vm.expectRevert(MockOrderlyVault.TokenNotAllowed.selector);
        ov.deposit(d);

        d = _data(userAccount, 1);
        d.brokerHash = keccak256("other");
        vm.expectRevert(MockOrderlyVault.BrokerNotAllowed.selector);
        ov.deposit(d);
        vm.stopPrank();

        ov.setTokenAllowed(false);
        vm.prank(user);
        vm.expectRevert(MockOrderlyVault.TokenNotAllowed.selector);
        ov.deposit(_data(userAccount, 1));
    }

    function test_deposit_feeMustMatch() public {
        ov.setDepositFee(1 gwei);
        assertEq(ov.getDepositFee(user, _data(userAccount, 1)), 1 gwei);
        vm.deal(user, 1 ether);
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(MockOrderlyVault.DepositFeeMismatch.selector, 1 gwei, 0));
        ov.deposit(_data(userAccount, 1));
        vm.expectRevert(abi.encodeWithSelector(MockOrderlyVault.DepositFeeMismatch.selector, 1 gwei, 2 gwei));
        ov.deposit{value: 2 gwei}(_data(userAccount, 1));
        ov.deposit{value: 1 gwei}(_data(userAccount, 1));
        vm.stopPrank();
        assertEq(address(ov).balance, 1 gwei);

        address payable sink = payable(makeAddr("sink"));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ov.sweepNative(sink);
        vm.expectRevert(MockOrderlyVault.AddressZero.selector);
        ov.sweepNative(payable(address(0)));
        ov.sweepNative(sink);
        assertEq(sink.balance, 1 gwei);
    }

    function test_getDepositFee_validates() public {
        vm.expectRevert(MockOrderlyVault.AccountIdInvalid.selector);
        ov.getDepositFee(user, _data(bytes32(0), 1));
    }

    function test_strictAccountIds_mirrorsOrderly() public {
        ov.setStrictAccountIds(true);
        bytes32 devnetStyle = keccak256(abi.encode(user, BROKER, uint8(1)));
        vm.prank(user);
        vm.expectRevert(MockOrderlyVault.AccountIdInvalid.selector);
        ov.deposit(_data(devnetStyle, 1e6));
        vm.prank(user);
        ov.deposit(_data(userAccount, 1e6));
        assertEq(ov.balanceOf(userAccount), 1e6);
    }

    function test_delegateSigner_rules() public {
        address eoa = makeAddr("delegate");
        vm.prank(user); // EOA caller
        vm.expectRevert(MockOrderlyVault.ZeroCodeLength.selector);
        ov.delegateSigner(IOrderlyVault.VaultDelegate({brokerHash: BROKER, delegateSigner: eoa}));

        DelegatingContract c = new DelegatingContract();
        vm.expectRevert(MockOrderlyVault.NotZeroCodeLength.selector);
        c.delegate(ov, BROKER, address(c));
        vm.expectRevert(MockOrderlyVault.BrokerNotAllowed.selector);
        c.delegate(ov, keccak256("nope"), eoa);

        vm.expectEmit(true, true, true, true, address(ov));
        emit MockOrderlyVault.AccountDelegate(address(c), BROKER, eoa, block.chainid, block.number);
        c.delegate(ov, BROKER, eoa);
        assertEq(ov.delegateOf(address(c), BROKER), eoa);
    }

    function test_operatorWithdraw() public {
        vm.prank(user);
        ov.deposit(_data(userAccount, 100e6));

        vm.prank(stranger);
        vm.expectRevert(MockOrderlyVault.NotOperator.selector);
        ov.operatorWithdraw(userAccount, user, 1);

        vm.startPrank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(MockOrderlyVault.ReceiverNotAccountOwner.selector, stranger, user)
        );
        ov.operatorWithdraw(userAccount, stranger, 1);
        vm.expectRevert(MockOrderlyVault.BalanceNotEnough.selector);
        ov.operatorWithdraw(userAccount, user, 101e6);
        vm.expectRevert(MockOrderlyVault.ZeroDeposit.selector);
        ov.operatorWithdraw(userAccount, user, 0);

        vm.expectEmit(true, true, false, true, address(ov));
        emit MockOrderlyVault.AccountWithdraw(userAccount, 1, BROKER, operator, user, USDC_HASH, 40e6, 0);
        ov.operatorWithdraw(userAccount, user, 40e6);
        vm.stopPrank();

        assertEq(ov.balanceOf(userAccount), 60e6);
        assertEq(ov.totalLedger(), 60e6);
        assertEq(usdc.balanceOf(user), 940e6);
        assertEq(ov.withdrawNonce(), 1);
    }

    function test_operatorWithdrawWithFee() public {
        vm.prank(user);
        ov.deposit(_data(userAccount, 100e6));
        vm.startPrank(operator);
        vm.expectRevert(MockOrderlyVault.FeeExceedsAmount.selector);
        ov.operatorWithdrawWithFee(userAccount, user, 1e6, 2e6);
        ov.operatorWithdrawWithFee(userAccount, user, 10e6, 1e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), 909e6);
        assertEq(ov.collectedWithdrawFees(), 1e6);
        assertEq(ov.unallocated(), 0);
    }

    function test_creditFees_requiresUnallocatedUsdc() public {
        vm.prank(user);
        ov.deposit(_data(userAccount, 100e6));

        vm.prank(stranger);
        vm.expectRevert(MockOrderlyVault.NotOperator.selector);
        ov.creditFees(userAccount, 1);

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(MockOrderlyVault.InsufficientUnallocated.selector, 1, 0));
        ov.creditFees(userAccount, 1);
        vm.expectRevert(MockOrderlyVault.AccountIdInvalid.selector);
        ov.creditFees(bytes32(0), 1);
        vm.expectRevert(MockOrderlyVault.AccountIdInvalid.selector);
        ov.creditFees(keccak256("never-deposited"), 1);
        vm.expectRevert(MockOrderlyVault.ZeroDeposit.selector);
        ov.creditFees(userAccount, 0);
        vm.stopPrank();

        usdc.mint(address(ov), 25e6);
        assertEq(ov.unallocated(), 25e6);
        vm.expectEmit(true, false, false, true, address(ov));
        emit MockOrderlyVault.FeesCredited(userAccount, 25e6);
        vm.prank(operator);
        ov.creditFees(userAccount, 25e6);
        assertEq(ov.balanceOf(userAccount), 125e6);
        assertEq(ov.unallocated(), 0);
    }

    function test_debitAccount() public {
        vm.prank(user);
        ov.deposit(_data(userAccount, 100e6));
        vm.startPrank(operator);
        vm.expectRevert(MockOrderlyVault.BalanceNotEnough.selector);
        ov.debitAccount(userAccount, 101e6);
        vm.expectRevert(MockOrderlyVault.ZeroDeposit.selector);
        ov.debitAccount(userAccount, 0);
        vm.expectEmit(true, false, false, true, address(ov));
        emit MockOrderlyVault.AccountDebited(userAccount, 30e6);
        ov.debitAccount(userAccount, 30e6);
        vm.stopPrank();
        assertEq(ov.balanceOf(userAccount), 70e6);
        assertEq(ov.unallocated(), 30e6);
        vm.prank(stranger);
        vm.expectRevert(MockOrderlyVault.NotOperator.selector);
        ov.debitAccount(userAccount, 1);
    }

    function test_admin_onlyOwner() public {
        vm.startPrank(stranger);
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.expectRevert(err);
        ov.setOperator(stranger, true);
        vm.expectRevert(err);
        ov.setAllowedBroker(BROKER, false);
        vm.expectRevert(err);
        ov.setTokenAllowed(false);
        vm.expectRevert(err);
        ov.setDepositFee(1);
        vm.expectRevert(err);
        ov.setStrictAccountIds(true);
        vm.stopPrank();

        vm.expectRevert(MockOrderlyVault.AddressZero.selector);
        ov.setOperator(address(0), true);

        vm.expectEmit(true, false, false, true, address(ov));
        emit MockOrderlyVault.OperatorSet(stranger, true);
        ov.setOperator(stranger, true);
        assertTrue(ov.isOperator(stranger));
        vm.expectEmit(true, false, false, true, address(ov));
        emit MockOrderlyVault.SetAllowedBroker(keccak256("b2"), true);
        ov.setAllowedBroker(keccak256("b2"), true);
        vm.expectEmit(false, false, false, true, address(ov));
        emit MockOrderlyVault.DepositFeeSet(5);
        ov.setDepositFee(5);
        vm.expectEmit(true, false, false, true, address(ov));
        emit MockOrderlyVault.SetAllowedToken(USDC_HASH, false);
        ov.setTokenAllowed(false);
        vm.expectEmit(false, false, false, true, address(ov));
        emit MockOrderlyVault.StrictAccountIdsSet(true);
        ov.setStrictAccountIds(true);
    }

    function testFuzz_ledgerConservation(uint96 a, uint96 b, uint96 w) public {
        a = uint96(bound(a, 1, 500e6));
        b = uint96(bound(b, 1, 500e6));
        bytes32 other = keccak256("other-account");
        vm.startPrank(user);
        ov.deposit(_data(userAccount, a));
        ov.deposit(_data(other, b));
        vm.stopPrank();
        w = uint96(bound(w, 0, a));
        if (w > 0) {
            vm.prank(operator);
            ov.operatorWithdraw(userAccount, user, w);
        }
        assertEq(ov.totalLedger(), uint256(a) + b - w);
        assertEq(
            usdc.balanceOf(address(ov)), ov.totalLedger() + ov.collectedWithdrawFees() + ov.unallocated()
        );
    }
}
