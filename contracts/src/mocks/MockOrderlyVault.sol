// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IOrderlyVault} from "../interfaces/external/IOrderlyVault.sol";

/// @title MockOrderlyVault — devnet stand-in for Orderly's chain Vault (never deploy to mainnet).
/// @notice Mirrors the parts of github.com/OrderlyNetwork/contract-evm `Vault.sol` the protocol touches:
///         `deposit` / `depositTo` (pull the token, emit `AccountDepositTo`), `getDepositFee`,
///         `delegateSigner` (caller must be a contract, delegate must be an EOA, broker allowed — emits
///         `AccountDelegate`), `getAllowedToken`. Event signatures match the real `IVault` so the same
///         decoder works for the mock-orderly REST server and for mainnet indexing.
///
///         Off-chain venue behaviour is simulated by an operator (the mock-orderly server / ops-venue):
///           - `operatorWithdraw(accountId, to, amount)` pays a withdrawal to the account's on-chain owner
///             (Orderly pays withdrawals to the account address), emitting the real `AccountWithdraw` event;
///           - `creditFees(accountId, amount)` credits builder fee settlement / realised PnL from USDC the
///             vault already holds but has not allocated (mint via MockERC20 to this vault first);
///           - `debitAccount(accountId, amount)` books a realised venue loss (USDC becomes unallocated).
///
///         Differences from the real vault (see docs/VERIFY.md): by default any non-zero accountId is
///         accepted (the protocol's devnet derivation uses two accounts per adapter); set
///         `strictAccountIds` to enforce Orderly's `accountId == keccak256(abi.encode(receiver, brokerHash))`.
///         A single deposit token is supported. The deposit fee defaults to 0; when set, `msg.value` must
///         equal it exactly (the real vault forwards it to LayerZero with a refund).
contract MockOrderlyVault is IOrderlyVault, Ownable {
    using SafeERC20 for IERC20;

    // ---- real-Vault event signatures (OrderlyNetwork/contract-evm src/interface/IVault.sol) ----
    event AccountDepositTo(
        bytes32 indexed accountId,
        bytes32 indexed brokerHash,
        address indexed userAddress,
        uint64 depositNonce,
        bytes32 tokenHash,
        uint128 tokenAmount
    );
    event AccountWithdraw(
        bytes32 indexed accountId,
        uint64 indexed withdrawNonce,
        bytes32 brokerHash,
        address sender,
        address receiver,
        bytes32 tokenHash,
        uint128 tokenAmount,
        uint128 fee
    );
    event AccountDelegate(
        address indexed delegateContract,
        bytes32 indexed brokerHash,
        address indexed delegateSigner,
        uint256 chainId,
        uint256 blockNumber
    );
    event SetAllowedToken(bytes32 indexed _tokenHash, bool _allowed);
    event SetAllowedBroker(bytes32 indexed _brokerHash, bool _allowed);

    // ---- mock-only events ----
    event OperatorSet(address indexed operator, bool enabled);
    event DepositFeeSet(uint256 fee);
    event StrictAccountIdsSet(bool strict);
    event FeesCredited(bytes32 indexed accountId, uint256 amount);
    event AccountDebited(bytes32 indexed accountId, uint256 amount);
    event NativeSwept(address indexed to, uint256 amount);

    // ---- real-Vault error names where they exist ----
    error AccountIdInvalid();
    error TokenNotAllowed();
    error BrokerNotAllowed();
    error BalanceNotEnough();
    error ZeroDeposit();
    error ZeroCodeLength();
    error NotZeroCodeLength();
    error AddressZero();
    // ---- mock-only errors ----
    error NotOperator();
    error DepositFeeMismatch(uint256 expected, uint256 provided);
    error ReceiverNotAccountOwner(address receiver, address owner);
    error InsufficientUnallocated(uint256 requested, uint256 unallocated);
    error FeeExceedsAmount();
    error NativeTransferFailed();

    /// @notice The single deposit token (devnet USDC).
    IERC20 public immutable token;
    /// @notice keccak256(bytes(symbol)) of `token`.
    bytes32 public immutable tokenHash;

    bool public tokenAllowed = true;
    bool public strictAccountIds;
    uint256 public depositFee;
    uint64 public depositNonce;
    uint64 public withdrawNonce;
    /// @notice Sum of all account ledgers.
    uint256 public totalLedger;
    /// @notice Withdrawal fees retained by the vault (part of its token balance, not of any ledger).
    uint256 public collectedWithdrawFees;

    mapping(bytes32 brokerHash => bool) public allowedBroker;
    mapping(address => bool) public isOperator;
    /// @notice Ledger balance per Orderly account.
    mapping(bytes32 accountId => uint256) public balanceOf;
    /// @notice On-chain owner of an account: the receiver of its first deposit. Withdrawals pay only here.
    mapping(bytes32 accountId => address) public accountOwner;
    /// @notice Broker of an account (from its first deposit).
    mapping(bytes32 accountId => bytes32) public accountBroker;
    /// @notice Delegate signer per (contract, broker).
    mapping(address delegateContract => mapping(bytes32 brokerHash => address)) public delegateOf;

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    /// @param owner_ Admin of the mock (deployer on devnet).
    /// @param token_ Deposit token (MockERC20 USDC).
    /// @param tokenHash_ keccak256(bytes("USDC")).
    /// @param brokerHash_ Initially allowed broker (keccak256(bytes(brokerId))).
    constructor(address owner_, address token_, bytes32 tokenHash_, bytes32 brokerHash_) Ownable(owner_) {
        if (token_ == address(0)) revert AddressZero();
        token = IERC20(token_);
        tokenHash = tokenHash_;
        allowedBroker[brokerHash_] = true;
        emit SetAllowedToken(tokenHash_, true);
        emit SetAllowedBroker(brokerHash_, true);
    }

    // ---------------------------------------------------------------------------------------------
    // IOrderlyVault
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IOrderlyVault
    function deposit(VaultDepositFE calldata data) external payable {
        _deposit(msg.sender, data);
    }

    /// @inheritdoc IOrderlyVault
    function depositTo(address receiver, VaultDepositFE calldata data) external payable {
        _deposit(receiver, data);
    }

    /// @inheritdoc IOrderlyVault
    /// @dev Validates like a deposit (as the real vault does), then returns the configured fee (default 0).
    function getDepositFee(address receiver, VaultDepositFE calldata data) external view returns (uint256) {
        _validateDeposit(receiver, data);
        return depositFee;
    }

    /// @inheritdoc IOrderlyVault
    function delegateSigner(VaultDelegate calldata data) external {
        if (msg.sender.code.length == 0) revert ZeroCodeLength();
        if (data.delegateSigner.code.length != 0) revert NotZeroCodeLength();
        if (!allowedBroker[data.brokerHash]) revert BrokerNotAllowed();
        delegateOf[msg.sender][data.brokerHash] = data.delegateSigner;
        emit AccountDelegate(msg.sender, data.brokerHash, data.delegateSigner, block.chainid, block.number);
    }

    /// @inheritdoc IOrderlyVault
    function getAllowedToken(bytes32 tokenHash_) public view returns (address) {
        return (tokenAllowed && tokenHash_ == tokenHash) ? address(token) : address(0);
    }

    // ---------------------------------------------------------------------------------------------
    // Operator simulation of off-chain venue behaviour
    // ---------------------------------------------------------------------------------------------

    /// @notice Operator: simulates Orderly paying a withdrawal of `amount` from `accountId` to `to`.
    /// @dev `to` must be the account's on-chain owner (Orderly pays the account address).
    function operatorWithdraw(bytes32 accountId, address to, uint256 amount) external onlyOperator {
        _withdraw(accountId, to, amount, 0);
    }

    /// @notice Operator: as `operatorWithdraw`, retaining a venue withdrawal fee; `to` receives amount - fee.
    function operatorWithdrawWithFee(bytes32 accountId, address to, uint256 amount, uint256 fee)
        external
        onlyOperator
    {
        _withdraw(accountId, to, amount, fee);
    }

    /// @notice Operator: credits `amount` to `accountId` (builder fee settlement or realised PnL). The account
    ///         must exist (have received a deposit, so it has an on-chain owner to withdraw to) and the vault
    ///         must already hold the USDC unallocated (e.g. MockERC20.mint to this vault first).
    function creditFees(bytes32 accountId, uint256 amount) external onlyOperator {
        if (accountOwner[accountId] == address(0)) revert AccountIdInvalid();
        if (amount == 0) revert ZeroDeposit();
        uint256 free = unallocated();
        if (amount > free) revert InsufficientUnallocated(amount, free);
        balanceOf[accountId] += amount;
        totalLedger += amount;
        emit FeesCredited(accountId, amount);
    }

    /// @notice Operator: books a realised venue loss on `accountId`; the USDC becomes unallocated.
    function debitAccount(bytes32 accountId, uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroDeposit();
        uint256 bal = balanceOf[accountId];
        if (amount > bal) revert BalanceNotEnough();
        balanceOf[accountId] = bal - amount;
        totalLedger -= amount;
        emit AccountDebited(accountId, amount);
    }

    /// @notice Token held by the vault that belongs to no account and no collected fee.
    function unallocated() public view returns (uint256) {
        uint256 held = token.balanceOf(address(this));
        uint256 owed = totalLedger + collectedWithdrawFees;
        return held > owed ? held - owed : 0;
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    /// @notice Owner: enables/disables an operator (mock-orderly server, ops-venue).
    function setOperator(address operator, bool enabled) external onlyOwner {
        if (operator == address(0)) revert AddressZero();
        isOperator[operator] = enabled;
        emit OperatorSet(operator, enabled);
    }

    /// @notice Owner: allows/disallows a broker hash.
    function setAllowedBroker(bytes32 brokerHash_, bool allowed) external onlyOwner {
        allowedBroker[brokerHash_] = allowed;
        emit SetAllowedBroker(brokerHash_, allowed);
    }

    /// @notice Owner: allows/disallows the deposit token (simulates Orderly disabling a token).
    function setTokenAllowed(bool allowed) external onlyOwner {
        tokenAllowed = allowed;
        emit SetAllowedToken(tokenHash, allowed);
    }

    /// @notice Owner: sets the native deposit fee returned by `getDepositFee` (devnet default 0).
    function setDepositFee(uint256 fee) external onlyOwner {
        depositFee = fee;
        emit DepositFeeSet(fee);
    }

    /// @notice Owner: enforce Orderly's real accountId derivation on deposits.
    function setStrictAccountIds(bool strict) external onlyOwner {
        strictAccountIds = strict;
        emit StrictAccountIdsSet(strict);
    }

    /// @notice Owner: withdraws collected native deposit fees.
    function sweepNative(address payable to) external onlyOwner {
        if (to == address(0)) revert AddressZero();
        uint256 amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeSwept(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _validateDeposit(address receiver, VaultDepositFE calldata data) private view {
        if (getAllowedToken(data.tokenHash) == address(0)) revert TokenNotAllowed();
        if (!allowedBroker[data.brokerHash]) revert BrokerNotAllowed();
        if (receiver == address(0)) revert AddressZero();
        if (data.accountId == bytes32(0)) revert AccountIdInvalid();
        if (strictAccountIds && keccak256(abi.encode(receiver, data.brokerHash)) != data.accountId) {
            revert AccountIdInvalid();
        }
        if (data.tokenAmount == 0) revert ZeroDeposit();
    }

    function _deposit(address receiver, VaultDepositFE calldata data) private {
        _validateDeposit(receiver, data);
        if (msg.value != depositFee) revert DepositFeeMismatch(depositFee, msg.value);

        bytes32 id = data.accountId;
        if (accountOwner[id] == address(0)) {
            accountOwner[id] = receiver;
            accountBroker[id] = data.brokerHash;
        }
        balanceOf[id] += data.tokenAmount;
        totalLedger += data.tokenAmount;
        uint64 nonce = ++depositNonce;

        token.safeTransferFrom(msg.sender, address(this), data.tokenAmount);

        emit AccountDepositTo(id, data.brokerHash, receiver, nonce, data.tokenHash, data.tokenAmount);
    }

    function _withdraw(bytes32 accountId, address to, uint256 amount, uint256 fee) private {
        if (amount == 0) revert ZeroDeposit();
        if (fee > amount) revert FeeExceedsAmount();
        address owner_ = accountOwner[accountId];
        if (to == address(0) || to != owner_) revert ReceiverNotAccountOwner(to, owner_);
        uint256 bal = balanceOf[accountId];
        if (amount > bal) revert BalanceNotEnough();

        balanceOf[accountId] = bal - amount;
        totalLedger -= amount;
        collectedWithdrawFees += fee;
        uint64 nonce = ++withdrawNonce;

        token.safeTransfer(to, amount - fee);

        emit AccountWithdraw(
            accountId,
            nonce,
            accountBroker[accountId],
            msg.sender,
            to,
            tokenHash,
            SafeCast.toUint128(amount),
            SafeCast.toUint128(fee)
        );
    }
}
