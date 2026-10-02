// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMMMandate} from "./IMMMandate.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";

/// @title IBookrunnerDesk — per-book ERC-4337 smart account (EntryPoint v0.7) operated by bookrunner
///        session keys. There is NO generic execute: only typed actions, each validated by MMMandate.
///        Holds the book's hedge inventory (Stock Tokens) and USDC hedge budget. Also callable directly
///        by an active desk key (EOA tx) for environments without a bundler.
interface IBookrunnerDesk {
    enum ActionKind {
        Hedge, // swap USDC <-> Stock Token via HedgeExecutor (mandate.checkHedge)
        InventoryToVenue, // vault -> venue account (mandate.checkInventoryMove toVenue=true)
        InventoryToVault, // recall venue -> vault (always allowed for an active key)
        FundDesk, // vault -> desk USDC hedge budget (counts as inventory move)
        ReturnToVault, // desk USDC -> vault (always allowed)
        SetQuote, // in-house engine quote params (mandate.checkQuote)
        Flatten // reduce-only: sell hedge inventory back to USDC (allowed when killed / off-hours)
    }

    struct Action {
        ActionKind kind;
        bytes data; // abi-encoded per kind, see ARCHITECTURE.md §Desk actions
        bytes32[] proof; // hedge allow-list proof (Hedge only)
    }

    function initialize(address config, uint256 bookId, address book) external;
    function book() external view returns (address);

    /// @notice EntryPoint (after validateUserOp) or an active desk key.
    function execute(Action calldata action) external returns (bytes memory result);
    /// @notice Pull oracle (LOW_GAS.md §1): same callers and checks as `execute`; relays `priceData`
    ///         (abi.encode(IAttestedOracle.PriceUpdate[], bytes[])) to `AttestedOracle.update` first when
    ///         non-empty, then runs the `execute` path on the in-tx price.
    function executeWithPrices(Action calldata action, bytes calldata priceData)
        external
        returns (bytes memory result);
    /// @notice ERC-4337 v0.7. Signature = ECDSA(toEthSignedMessageHash(userOpHash)) by an active desk key;
    ///         callData must be `execute(Action)` or `executeWithPrices(Action,bytes)`. Returns
    ///         SIG_VALIDATION_FAILED (1) otherwise.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData);

    /// @notice Signed hedge notional held by the desk (USD 6dp): long Stock Token inventory value.
    function hedgeNotionalUsd() external view returns (int256);
    /// @notice USDC + Stock Token inventory value (USD 6dp) — part of deployedValueUsd.
    function valueUsd() external view returns (uint256);
    function heldTokens() external view returns (address[] memory);

    event ActionExecuted(address indexed key, ActionKind indexed kind, bytes data);
    event HedgeExecuted(address indexed token, bool buy, uint256 amountIn, uint256 amountOut, uint256 notionalUsd);
}
