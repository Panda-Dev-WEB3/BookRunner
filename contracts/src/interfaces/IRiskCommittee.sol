// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IRiskCommittee — model-jury verdict + three bonded human members.
/// @notice Approve: jury verdict posted AND 2-of-3 approve votes (3-of-3 if the jury recommended reject).
///         Reject: 2-of-3 reject votes. Members must have config.committeeBondBkrn() locked to vote.
///         Membership/quorum changes and slashing only via the 48h timelock.
interface IRiskCommittee {
    function members() external view returns (address[3] memory);
    function isMember(address a) external view returns (bool);
    function isBonded(address member) external view returns (bool);
    /// @notice Member locks config.committeeBondBkrn() of their stake.
    function bond() external;
    /// @notice Member releases bond after being replaced (not while seated).
    function releaseBond() external;
    /// @notice JURY role. `cid` = sha2-256 digest of the verdict JSON (CIDv1 raw codec).
    function postJuryVerdict(uint256 charterId, bytes32 cid, bool recommendApprove) external;
    function vote(uint256 charterId, bool approve) external;
    /// @notice Executes when thresholds are met (also auto-called from vote()).
    function tryFinalize(uint256 charterId) external returns (bool decided);
    function juryVerdict(uint256 charterId) external view returns (bytes32 cid, bool recommendApprove, bool posted);
    function votesOf(uint256 charterId) external view returns (uint8 approvals, uint8 rejections);
    function hasVoted(uint256 charterId, address member) external view returns (bool);

    // ---- committee actions on live books (2-of-3) ----
    function proposeAction(uint256 bookId, bytes32 actionKind, bytes calldata data) external returns (uint256 actionId);
    function approveAction(uint256 actionId) external;

    // ---- timelock ----
    function setMember(uint8 index, address member) external;
    function slashMember(address member, uint256 amount, bytes32 reason) external;

    event JuryVerdictPosted(uint256 indexed charterId, bytes32 cid, bool recommendApprove);
    event Voted(uint256 indexed charterId, address indexed member, bool approve);
    event Decided(uint256 indexed charterId, bool approved);
    event MemberSet(uint8 indexed index, address member);
    event MemberBonded(address indexed member, uint256 amount);
    event MemberSlashed(address indexed member, uint256 amount, bytes32 reason);
    event ActionProposed(uint256 indexed actionId, uint256 indexed bookId, bytes32 actionKind, address proposer);
    event ActionExecuted(uint256 indexed actionId);
}
