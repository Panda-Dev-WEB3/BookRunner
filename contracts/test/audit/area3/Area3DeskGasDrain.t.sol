// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IBookrunnerDesk} from "../../../src/interfaces/IBookrunnerDesk.sol";
import {MandateBase} from "../../mandate/utils/MandateBase.sol";

interface IAccountV07 {
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData);
}

/// @dev Faithful subset of the EntryPoint v0.7 gas accounting (no paymaster, no initCode, no aggregator):
///        requiredPrefund = (verificationGasLimit + callGasLimit + preVerificationGas) * maxFeePerGas
///        missingAccountFunds = max(0, requiredPrefund - deposit)          (account pays it in validateUserOp)
///        AA21 unless deposit >= requiredPrefund; deposit -= requiredPrefund
///        execution: account.call{gas: callGasLimit}(callData) — a revert does NOT refund gas
///        actualGas = measured gas + preVerificationGas (+10% of unused execution gas, v0.7 penalty)
///        gasPrice  = min(maxFeePerGas, maxPriorityFeePerGas + basefee)
///        actualGasCost -> beneficiary (chosen by the bundler); prefund - actualGasCost -> account deposit.
contract MiniEntryPointV07 {
    uint256 internal constant UNUSED_GAS_PENALTY_PERCENT = 10;
    mapping(address => uint256) public balanceOf;

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function getUserOpHash(PackedUserOperation calldata op) public view returns (bytes32) {
        bytes32 h = keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                keccak256(op.paymasterAndData)
            )
        );
        return keccak256(abi.encode(h, address(this), block.chainid));
    }

    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external {
        uint256 collected;
        for (uint256 i; i < ops.length; ++i) {
            collected += _handle(ops[i]);
        }
        (bool ok,) = beneficiary.call{value: collected}("");
        require(ok, "AA91 failed send to beneficiary");
    }

    function _handle(PackedUserOperation calldata op) internal returns (uint256 actualGasCost) {
        uint256 preGas = gasleft();
        uint256 requiredPrefund = _validatePrepayment(op);

        uint256 callGas = uint128(uint256(op.accountGasLimits));
        uint256 execStart = gasleft();
        (bool success,) = op.sender.call{gas: callGas}(op.callData);
        success; // the op's own failure is not the bundle's
        uint256 execUsed = execStart - gasleft();

        uint256 actualGas = preGas - gasleft() + op.preVerificationGas;
        if (callGas > execUsed) actualGas += (callGas - execUsed) * UNUSED_GAS_PENALTY_PERCENT / 100;
        actualGasCost = actualGas * _gasPrice(op);
        require(actualGasCost <= requiredPrefund, "AA51 prefund below actualGasCost");
        balanceOf[op.sender] += requiredPrefund - actualGasCost;
    }

    function _gasPrice(PackedUserOperation calldata op) internal view returns (uint256) {
        uint256 maxPrio = uint256(op.gasFees) >> 128;
        uint256 maxFee = uint128(uint256(op.gasFees));
        return maxFee < maxPrio + block.basefee ? maxFee : maxPrio + block.basefee;
    }

    function _validatePrepayment(PackedUserOperation calldata op) internal returns (uint256 requiredPrefund) {
        uint256 verGas = uint256(op.accountGasLimits) >> 128;
        requiredPrefund =
            (verGas + uint128(uint256(op.accountGasLimits)) + op.preVerificationGas) * uint128(uint256(op.gasFees));
        uint256 bal = balanceOf[op.sender];
        uint256 missing = bal >= requiredPrefund ? 0 : requiredPrefund - bal;
        uint256 vd = IAccountV07(op.sender).validateUserOp{gas: verGas}(op, getUserOpHash(op), missing);
        require(uint160(vd) == 0, "AA24 signature error");
        uint48 validUntil = uint48(vd >> 160);
        require(validUntil == 0 || block.timestamp <= validUntil, "AA22 expired or not due");
        require(balanceOf[op.sender] >= requiredPrefund, "AA21 didn't pay prefund");
        balanceOf[op.sender] -= requiredPrefund;
    }
}

/// @notice AREA 3 — ERC-4337 gas policy. `validateUserOp` accepts any gas price / gas limits a key signs and pays
///         `missingAccountFunds` from the desk's ETH. A compromised desk key that also runs (or pays) the bundler
///         sets `preVerificationGas` / `maxFeePerGas` so that the op's charged cost ~= the desk's whole ETH balance,
///         names itself beneficiary and collects it — even when the typed action itself is rejected by the
///         mandate (execution reverts, gas is still charged). The unconsumed prefund is parked in the desk's
///         EntryPoint deposit, which the desk has no function to withdraw (timelock `withdrawNative` only moves the
///         desk's own balance), and is drained by the next such op.
contract Area3DeskGasDrainTest is MandateBase {
    MiniEntryPointV07 internal ep;
    address internal attackerBundler = makeAddr("attackerBundler");

    function setUp() public override {
        super.setUp();
        ep = new MiniEntryPointV07();
        cfg.setEntryPoint(address(ep));
        desk.syncEntryPoint();
        vm.deal(address(desk), 1 ether); // the desk's gas float
    }

    function _op(bytes memory callData, uint128 verGas, uint128 callGas, uint256 pvg, uint128 maxFee, uint256 nonce)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = address(desk);
        op.nonce = nonce;
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(verGas) << 128) | callGas);
        op.preVerificationGas = pvg;
        op.gasFees = bytes32((uint256(maxFee) << 128) | maxFee); // maxPriorityFeePerGas == maxFeePerGas
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyPk, MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op)));
        op.signature = abi.encodePacked(r, s, v);
    }

    function test_audit_keyDrainsDeskEthViaUserOpGas() public {
        // the typed action is one the mandate REJECTS (FundDesk far above the cap): execution reverts
        bytes memory cd = abi.encodeCall(
            desk.execute, (_action(IBookrunnerDesk.ActionKind.FundDesk, abi.encode(uint256(10_000_000e6))))
        );
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        // requiredPrefund = (200k + 300k + 500k) * 1,000 gwei = 1 ETH = the desk's whole balance
        ops[0] = _op(cd, 200_000, 300_000, 500_000, 1e12, 0);

        // (a desk that refuses the op makes the EntryPoint revert the bundle: nothing is charged)
        vm.prank(attackerBundler);
        try ep.handleOps(ops, payable(attackerBundler)) {} catch {}

        // second op drains what was parked in the (non-withdrawable) EntryPoint deposit
        uint256 parked = ep.balanceOf(address(desk));
        if (parked != 0) {
            ops[0] = _op(cd, 200_000, 300_000, 500_000, uint128(parked / 1_000_000), 1);
            vm.prank(attackerBundler);
            try ep.handleOps(ops, payable(attackerBundler)) {} catch {}
        }

        uint256 stolen = attackerBundler.balance;
        emit log_named_decimal_uint("ETH moved from the desk to the key's bundler", stolen, 18);
        emit log_named_decimal_uint("desk ETH left (balance + EP deposit)", address(desk).balance + ep.balanceOf(address(desk)), 18);
        // SECURE: a desk key cannot turn the desk's gas float into its own revenue (two rejected actions are
        // worth a fair gas bill, i.e. far below 0.01 ETH).
        assertLe(stolen, 0.01 ether, "desk key drained the desk's ETH through userOp gas pricing");
    }
}
