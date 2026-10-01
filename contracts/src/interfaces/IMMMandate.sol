// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "./BRTypes.sol";

/// @title IMMMandate — the mandate letter in code. Session-key registry + validator for the book's
///        on-chain legs (hedges, inventory moves, in-house quotes) and policy mirror for the risk
///        service. Semantics: ARCHITECTURE.md §Mandate (normative).
interface IMMMandate {
    struct DeskKey {
        address operator; // the agent operator whose BKRN stake backs the key's inventory tier
        uint64 validUntil;
        uint128 inventoryTierUsd; // max inventory this key may run; requires config.agentTierBond(tier)
        bool active;
    }

    struct HedgeParams {
        bytes32 asset; // Stock Token address (left-padded) or perp symbol
        bytes32 venue; // e.g. "UNIV3", "UNIV4", "ORDERLY", "ENGINE"
        bool buy; // true = increase long hedge
        uint256 qtyRaw; // token raw units (spot) or 1e18 size units (perp)
        uint256 notionalUsd; // USD 6dp notional of this leg at the oracle price
        uint16 leverage; // 0.01x units; spot = 100
    }

    error NotDeskKey(address key);
    error KeyExpired(address key);
    error MandateKilled();
    error OffHoursNewRisk();
    error HedgeNotAllowed(bytes32 asset, bytes32 venue);
    error HedgeRatioOutOfBand(uint256 ratioBps, uint256 minBps, uint256 maxBps);
    error HedgeLeverageTooHigh(uint16 leverage, uint16 max);
    error InventoryLimit(uint256 attemptedUsd, uint256 maxUsd);
    error QuoteWidthTooNarrow(uint16 widthBps, uint16 minBps);
    error SkewTooWide(int16 skewBps, int16 maxBps);
    error TierBondMissing(address operator, uint256 required, uint256 locked);
    error SpotShortNotAllowed();
    error FloatCapExceeded(uint256 attemptedRaw, uint256 capRaw);

    function initialize(address config, uint256 bookId, address book) external;
    function book() external view returns (address);
    function getMandate() external view returns (BRTypes.Mandate memory);
    function killed() external view returns (bool);
    function killReason() external view returns (bytes32);

    // ---- keys (agent.register / agent.revoke) ----
    /// @notice Sponsor only. Locks config.agentTierBond(inventoryTierUsd) from `operator`'s stake.
    function registerKey(address key, address operator, uint64 validUntil, uint128 inventoryTierUsd) external;
    /// @notice Sponsor, RISK, committee, or the key itself. Effective immediately (same block).
    function revokeKey(address key, bytes32 reason) external;
    function isActiveKey(address key) external view returns (bool);
    function getKey(address key) external view returns (DeskKey memory);
    function activeKeys() external view returns (address[] memory);

    // ---- on-chain leg validation (view; reverts with the errors above) ----
    function checkHedge(address key, HedgeParams calldata p, bytes32[] calldata allowProof) external view;
    /// @param toVenue true = vault -> venue (adds risk); false = recall (always allowed unless key inactive)
    function checkInventoryMove(address key, bool toVenue, uint8 account, uint256 amountUsd) external view;
    function checkQuote(address key, uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd) external view;
    /// @notice Off-hours per the oracle `held` flag (or stale) for the charter underlying.
    function offHours() external view returns (bool);
    /// @notice |desk hedge notional| / |venue net exposure| in bps (type(uint256).max if exposure ~ 0).
    function hedgeRatioBps() external view returns (uint256);
    function deskHedgeNotionalUsd() external view returns (int256);

    // ---- kill / re-mandate ----
    /// @notice RISK role, or the book (drawdown at mark). Revokes all keys, reduce-only, notifies book.
    function kill(bytes32 reason) external;
    /// @notice Committee only: replace mandate terms and clear kill.
    function remandate(BRTypes.Mandate calldata m) external;

    event KeyRegistered(address indexed key, address indexed operator, uint64 validUntil, uint128 inventoryTierUsd);
    event KeyRevoked(address indexed key, address indexed by, bytes32 reason);
    event Kill(bytes32 reason, address indexed by);
    event Remandated(bytes32 mandateHash);
}
