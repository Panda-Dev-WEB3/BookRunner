// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "./BRTypes.sol";

/// @title IMarketCharter — charter intake, bonds, fees, decisions, retirement.
interface IMarketCharter {
    struct CharterRecord {
        BRTypes.Charter charter;
        BRTypes.CharterStatus status;
        uint64 filedAt;
        uint64 decidedAt;
        bytes32 juryCid; // sha2-256 digest of the jury verdict (CIDv1 raw); full CID off-chain
        uint256 feePaidUsd;
        uint256 bondBkrn;
        address book; // set on approval
    }

    error InvalidCharter(bytes32 reason);
    error NotSponsor();
    error WrongStatus(BRTypes.CharterStatus status);
    error NewBooksPaused();

    /// @notice msg.sender must equal c.sponsor. Pulls config.charterFeeUsd() USDC and locks
    ///         config.sponsorBondBkrn() of the sponsor's BKRN stake. Non-payable (fee is USDC).
    function file(BRTypes.Charter calldata c) external returns (uint256 id);
    /// @notice Only RiskCommittee (2-of-3 + jury CID). Approve -> BookFactory.create; reject -> refund fee, unlock bond.
    function decide(uint256 id, bool ok, bytes32 juryCid) external;
    /// @notice Anyone after filedAt + committeeWindow with no decision: Expired, fee refunded, bond unlocked.
    function expire(uint256 id) external;
    /// @notice Sponsor or committee: book.retire().
    function retire(uint256 bookId) external;
    /// @notice Book callback once Retired: releases the sponsor bond.
    function onRetired(uint256 bookId) external;
    /// @notice Committee: slash the sponsor bond of a live book the sponsor abandoned.
    function slashSponsor(uint256 bookId, bytes32 reason) external;
    /// @notice Pure validation used by file() and the charter service (returns reason or 0).
    function validate(BRTypes.Charter calldata c) external view returns (bytes32 reason);

    function get(uint256 id) external view returns (CharterRecord memory);
    function count() external view returns (uint256);
    function bondLockId(uint256 id) external pure returns (bytes32);

    event CharterFiled(uint256 indexed id, address indexed sponsor, bytes32 underlying, uint8 venue, bytes32 symbol, uint256 feeUsd, uint256 bondBkrn);
    event CharterDecided(uint256 indexed id, bool approved, bytes32 juryCid, address book);
    event CharterExpired(uint256 indexed id);
    event CharterRetired(uint256 indexed id);
    event SponsorSlashed(uint256 indexed id, address indexed sponsor, uint256 amount, bytes32 reason);
}
