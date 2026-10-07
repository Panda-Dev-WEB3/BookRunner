// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IRiskCommittee} from "./interfaces/IRiskCommittee.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBkrnStaking} from "./interfaces/IBkrnStaking.sol";
import {IMarketCharter} from "./interfaces/IMarketCharter.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IMMMandate} from "./interfaces/IMMMandate.sol";
import {CharterRules} from "./MarketCharter.sol";

/// @title RiskCommittee — model-jury verdict + three bonded human members.
/// @notice Charter decisions: the JURY role posts the verdict digest once per charter; seated members
///         with `config.committeeBondBkrn()` locked vote once per charter. Approve = verdict posted AND
///         2 approvals (3 if the jury recommended reject); reject = 2 rejections (no verdict needed).
///         Votes and action approvals are tracked per member address and only count while that
///         address holds a seat AND is bonded (`isBonded`): the ballots of a replaced member, or of a
///         member slashed below (or not re-bonded after a raise of) `committeeBondBkrn`, stop counting
///         immediately and count again only once that seated member re-bonds.
///         Action deadlines are fixed at proposal (`expiresAt`), independent of later window changes.
///         Live-book actions (2-of-3): REMANDATE, RETIRE, SLASH_SPONSOR, REVOKE_KEY.
///         Seat changes and slashing only via `config.timelock()`. Non-upgradeable.
contract RiskCommittee is IRiskCommittee, ReentrancyGuardTransient {
    // ---- action kinds ----
    bytes32 public constant REMANDATE = "REMANDATE"; // data = abi.encode(BRTypes.Mandate)
    bytes32 public constant RETIRE = "RETIRE"; // data = ""
    bytes32 public constant SLASH_SPONSOR = "SLASH_SPONSOR"; // data = "" | abi.encode(bytes32 reason)
    bytes32 public constant REVOKE_KEY = "REVOKE_KEY"; // data = abi.encode(address key)

    /// @notice Reason passed to MMMandate.revokeKey for committee revocations.
    bytes32 public constant COMMITTEE_REASON = "COMMITTEE";
    /// @notice BkrnStaking lock id of member bonds (locks are keyed by (account, lockId)).
    bytes32 public constant BOND_LOCK_ID = keccak256("BKRN.COMMITTEE_BOND");

    uint8 public constant SEATS = 3;
    uint8 public constant APPROVE_THRESHOLD = 2;
    uint8 public constant APPROVE_THRESHOLD_JURY_REJECT = 3;
    uint8 public constant REJECT_THRESHOLD = 2;
    uint8 public constant ACTION_THRESHOLD = 2;

    uint256 private constant MANDATE_ENCODED_LENGTH = 9 * 32; // BRTypes.Mandate: 9 static words

    enum Ballot {
        None,
        Approve,
        Reject
    }

    struct Verdict {
        bytes32 cid;
        bool recommendApprove;
        bool posted;
    }

    struct Action {
        uint256 bookId;
        bytes32 kind;
        bytes data;
        address proposer;
        uint64 proposedAt;
        bool executed;
        /// @dev proposedAt + committeeWindow at proposal time; later window changes do not move it.
        uint64 expiresAt;
    }

    /// @notice Protocol registry (addresses, params, roles).
    IBookrunnerConfig public immutable config;

    address[3] private _members;
    /// @dev Set by bond(); cleared whenever the address enters or leaves a seat.
    mapping(address member => bool) private _bondActive;
    /// @dev BKRN currently locked by this committee for the address.
    mapping(address member => uint256) private _bondOf;
    /// @dev Staking contract holding the address's bond lock (pinned at bond time, see bondStakingOf).
    mapping(address member => address) private _bondStaking;

    mapping(uint256 charterId => Verdict) private _verdicts;
    mapping(uint256 charterId => mapping(address member => Ballot)) private _ballots;
    mapping(uint256 charterId => bool) private _finalized;

    uint256 private _actionCount;
    mapping(uint256 actionId => Action) private _actions;
    mapping(uint256 actionId => mapping(address member => bool)) private _actionApproved;

    error ZeroAddress();
    error DuplicateMember(address member);
    error BadSeat(uint8 index);
    error NotTimelock();
    error NotJury();
    error NotMember();
    error NotBondedMember();
    error AlreadyBonded();
    error StillSeated();
    error NoBond();
    error BadCid();
    error JuryAlreadyPosted(uint256 charterId);
    error CharterNotOpen(uint256 charterId);
    error AlreadyVoted(uint256 charterId, address member);
    error UnknownActionKind(bytes32 kind);
    error BadActionData(bytes32 kind);
    error InvalidMandate(bytes32 reason);
    error UnknownBook(uint256 bookId);
    error UnknownAction(uint256 actionId);
    error ActionAlreadyExecuted(uint256 actionId);
    error ActionExpired(uint256 actionId);
    error AlreadyApproved(uint256 actionId, address member);
    error BadSlashAmount(uint256 amount, uint256 bonded);

    /// @notice A member approved a live-book action (the proposer's approval is implicit).
    event ActionApproved(uint256 indexed actionId, address indexed member);
    /// @notice A former member released their bond.
    event MemberBondReleased(address indexed member, uint256 amount);

    /// @param config_ BookrunnerConfig address. The committee must be registered as
    ///        `config.committee()` and as a BkrnStaking locker by the timelock.
    /// @param initialMembers The three seats (non-zero, distinct). Members must call bond() to vote.
    constructor(address config_, address[3] memory initialMembers) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        for (uint8 i; i < SEATS; ++i) {
            address m = initialMembers[i];
            if (m == address(0)) revert ZeroAddress();
            for (uint8 j; j < i; ++j) {
                if (initialMembers[j] == m) revert DuplicateMember(m);
            }
            _members[i] = m;
            emit MemberSet(i, m);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Membership & bonds
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IRiskCommittee
    function members() external view returns (address[3] memory) {
        return _members;
    }

    /// @inheritdoc IRiskCommittee
    function isMember(address a) public view returns (bool) {
        return a != address(0) && (a == _members[0] || a == _members[1] || a == _members[2]);
    }

    /// @inheritdoc IRiskCommittee
    /// @dev Seated, bonded since the last seat change, and still holding >= committeeBondBkrn()
    ///      (a slash below the requirement or a raised requirement suspends voting until re-bond).
    function isBonded(address member) public view returns (bool) {
        return isMember(member) && _bondActive[member] && _bondOf[member] >= config.committeeBondBkrn();
    }

    /// @notice BKRN currently locked by this committee for `member` (seated or former).
    function bondOf(address member) external view returns (uint256) {
        return _bondOf[member];
    }

    /// @notice Staking contract that holds `member`'s bond lock (config.staking() when it bonded), so
    ///         release / slash keep working if the timelock repoints config.staking().
    function bondStakingOf(address member) external view returns (address) {
        return _bondStaking[member];
    }

    /// @inheritdoc IRiskCommittee
    /// @dev Seated members only. Re-locks to exactly `committeeBondBkrn()`: any lock left from a previous
    ///      seat (or reduced by slashing) is unlocked first. Reverts AlreadyBonded when isBonded.
    function bond() external nonReentrant {
        address m = msg.sender;
        if (!isMember(m)) revert NotMember();
        uint256 required = config.committeeBondBkrn();
        uint256 current = _bondOf[m];
        if (_bondActive[m] && current >= required) revert AlreadyBonded();

        address previousStaking = _bondStaking[m];
        address staking = config.staking();
        _bondActive[m] = true;
        _bondOf[m] = required;
        _bondStaking[m] = staking;
        emit MemberBonded(m, required);

        if (current > 0) IBkrnStaking(previousStaking).unlock(m, BOND_LOCK_ID);
        if (required > 0) IBkrnStaking(staking).lock(m, BOND_LOCK_ID, required);
    }

    /// @inheritdoc IRiskCommittee
    /// @dev Former members only (StillSeated otherwise). The timelock should batch slashMember before
    ///      setMember when it removes a member for cause, so the bond cannot be released first.
    function releaseBond() external nonReentrant {
        address m = msg.sender;
        if (isMember(m)) revert StillSeated();
        if (_bondOf[m] == 0) revert NoBond();
        _bondOf[m] = 0;
        _bondActive[m] = false;
        uint256 released = IBkrnStaking(_bondStaking[m]).unlock(m, BOND_LOCK_ID);
        emit MemberBondReleased(m, released);
    }

    // ------------------------------------------------------------------------------------------
    // Charter decisions
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IRiskCommittee
    /// @dev Only holders of `config.JURY_ROLE()`; once per charter; `cid != 0`; the charter must be
    ///      Filed and inside its committee window. Does not finalize (call tryFinalize or vote).
    function postJuryVerdict(uint256 charterId, bytes32 cid, bool recommendApprove) external {
        IBookrunnerConfig cfg = config;
        if (!cfg.hasRole(cfg.JURY_ROLE(), msg.sender)) revert NotJury();
        if (cid == bytes32(0)) revert BadCid();
        Verdict storage v = _verdicts[charterId];
        if (v.posted) revert JuryAlreadyPosted(charterId);
        if (_finalized[charterId] || !_isOpen(charterId)) revert CharterNotOpen(charterId);

        v.cid = cid;
        v.recommendApprove = recommendApprove;
        v.posted = true;
        emit JuryVerdictPosted(charterId, cid, recommendApprove);
    }

    /// @inheritdoc IRiskCommittee
    /// @dev Bonded seated members, once per charter per address, while the charter is open. Votes may
    ///      be cast before the verdict; approval can only finalize once the verdict is posted.
    ///      Auto-finalizes when a threshold is met (approval is deferred while newBooksPaused).
    function vote(uint256 charterId, bool approve) external nonReentrant {
        address m = msg.sender;
        if (!isBonded(m)) revert NotBondedMember();
        if (_ballots[charterId][m] != Ballot.None) revert AlreadyVoted(charterId, m);
        if (_finalized[charterId] || !_isOpen(charterId)) revert CharterNotOpen(charterId);

        _ballots[charterId][m] = approve ? Ballot.Approve : Ballot.Reject;
        emit Voted(charterId, m, approve);
        _finalizeIfReady(charterId);
    }

    /// @inheritdoc IRiskCommittee
    /// @dev Anyone. Returns false (no revert) when the charter is not open, already finalized, below
    ///      threshold, or the approval threshold is met while newBooksPaused.
    function tryFinalize(uint256 charterId) external nonReentrant returns (bool decided) {
        if (_finalized[charterId] || !_isOpen(charterId)) return false;
        return _finalizeIfReady(charterId);
    }

    /// @inheritdoc IRiskCommittee
    function juryVerdict(uint256 charterId)
        external
        view
        returns (bytes32 cid, bool recommendApprove, bool posted)
    {
        Verdict storage v = _verdicts[charterId];
        return (v.cid, v.recommendApprove, v.posted);
    }

    /// @inheritdoc IRiskCommittee
    /// @dev Counts only ballots of currently seated AND bonded members (see isBonded).
    function votesOf(uint256 charterId) public view returns (uint8 approvals, uint8 rejections) {
        address[3] memory voters = _bondedSeats();
        for (uint256 i; i < SEATS; ++i) {
            if (voters[i] == address(0)) continue;
            Ballot b = _ballots[charterId][voters[i]];
            if (b == Ballot.Approve) ++approvals;
            else if (b == Ballot.Reject) ++rejections;
        }
    }

    /// @inheritdoc IRiskCommittee
    /// @dev Per address: true if `member` cast a ballot, even if it no longer counts.
    function hasVoted(uint256 charterId, address member) external view returns (bool) {
        return _ballots[charterId][member] != Ballot.None;
    }

    /// @notice True once this committee called MarketCharter.decide for `charterId`.
    function isFinalized(uint256 charterId) external view returns (bool) {
        return _finalized[charterId];
    }

    // ------------------------------------------------------------------------------------------
    // Live-book actions (2-of-3)
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IRiskCommittee
    /// @dev Bonded seated members. The book must exist in the factory, `actionKind` must be one of
    ///      REMANDATE / RETIRE / SLASH_SPONSOR / REVOKE_KEY and `data` well-formed for it (REMANDATE
    ///      terms must also pass the charter mandate rules). The proposer's approval is recorded.
    ///      The action expires `config.committeeWindow()` after proposal; the deadline is stored here, so
    ///      a later window change can neither revive an expired action nor cut a pending one short. [ext]
    function proposeAction(uint256 bookId, bytes32 actionKind, bytes calldata data)
        external
        nonReentrant
        returns (uint256 actionId)
    {
        if (!isBonded(msg.sender)) revert NotBondedMember();
        if (IBookFactory(config.factory()).bookOf(bookId) == address(0)) revert UnknownBook(bookId);
        _checkActionData(actionKind, data);

        actionId = ++_actionCount;
        Action storage a = _actions[actionId];
        a.bookId = bookId;
        a.kind = actionKind;
        a.data = data;
        a.proposer = msg.sender;
        a.proposedAt = uint64(block.timestamp);
        a.expiresAt = uint64(block.timestamp + config.committeeWindow());
        _actionApproved[actionId][msg.sender] = true;

        emit ActionProposed(actionId, bookId, actionKind, msg.sender);
        emit ActionApproved(actionId, msg.sender);
    }

    /// @inheritdoc IRiskCommittee
    /// @dev Bonded seated members, once per address, before the action's stored `expiresAt`. Executes
    ///      when approvals of currently seated and bonded members reach ACTION_THRESHOLD; a failing
    ///      execution reverts the approval too.
    function approveAction(uint256 actionId) external nonReentrant {
        address m = msg.sender;
        if (!isBonded(m)) revert NotBondedMember();
        Action storage a = _actions[actionId];
        if (a.proposer == address(0)) revert UnknownAction(actionId);
        if (a.executed) revert ActionAlreadyExecuted(actionId);
        if (block.timestamp >= a.expiresAt) revert ActionExpired(actionId);
        if (_actionApproved[actionId][m]) revert AlreadyApproved(actionId, m);

        _actionApproved[actionId][m] = true;
        emit ActionApproved(actionId, m);

        if (actionApprovals(actionId) >= ACTION_THRESHOLD) {
            a.executed = true;
            _execute(a.bookId, a.kind, a.data);
            emit ActionExecuted(actionId);
        }
    }

    /// @notice Approvals of currently seated and bonded members for `actionId`.
    function actionApprovals(uint256 actionId) public view returns (uint8 approvals) {
        address[3] memory voters = _bondedSeats();
        for (uint256 i; i < SEATS; ++i) {
            if (voters[i] != address(0) && _actionApproved[actionId][voters[i]]) ++approvals;
        }
    }

    /// @notice Stored action (proposer == 0 for unknown ids).
    function getAction(uint256 actionId) external view returns (Action memory) {
        return _actions[actionId];
    }

    /// @notice True if `member` approved `actionId` (even if that approval no longer counts).
    function hasApprovedAction(uint256 actionId, address member) external view returns (bool) {
        return _actionApproved[actionId][member];
    }

    /// @notice Number of actions proposed (ids start at 1).
    function actionCount() external view returns (uint256) {
        return _actionCount;
    }

    // ------------------------------------------------------------------------------------------
    // Timelock
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IRiskCommittee
    /// @dev Only `config.timelock()`. `member` must be non-zero and not already seated. Both the
    ///      outgoing and incoming addresses lose bonded status (the newcomer must bond()); ballots of
    ///      the outgoing address stop counting on open charters and pending actions.
    function setMember(uint8 index, address member) external {
        if (msg.sender != config.timelock()) revert NotTimelock();
        if (index >= SEATS) revert BadSeat(index);
        if (member == address(0)) revert ZeroAddress();
        if (isMember(member)) revert DuplicateMember(member);
        address old = _members[index];
        _members[index] = member;
        _bondActive[old] = false;
        _bondActive[member] = false;
        emit MemberSet(index, member);
    }

    /// @inheritdoc IRiskCommittee
    /// @dev Only `config.timelock()`. 0 < amount <= bondOf(member); seated or former members. Slashed
    ///      BKRN goes to `config.slashRecipient()` (staking). A member left below the requirement can
    ///      no longer vote until it re-bonds.
    function slashMember(address member, uint256 amount, bytes32 reason) external nonReentrant {
        IBookrunnerConfig cfg = config;
        if (msg.sender != cfg.timelock()) revert NotTimelock();
        uint256 bonded = _bondOf[member];
        if (amount == 0 || amount > bonded) revert BadSlashAmount(amount, bonded);
        _bondOf[member] = bonded - amount;
        uint256 slashed = IBkrnStaking(_bondStaking[member]).slash(member, BOND_LOCK_ID, amount);
        if (slashed < amount) _bondOf[member] = bonded - slashed;
        emit MemberSlashed(member, slashed, reason);
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    /// @dev The seats whose ballots count (same rule as isBonded); a non-counting seat is address(0).
    function _bondedSeats() private view returns (address[3] memory voters) {
        uint256 required = config.committeeBondBkrn();
        for (uint256 i; i < SEATS; ++i) {
            address m = _members[i];
            if (_bondActive[m] && _bondOf[m] >= required) voters[i] = m;
        }
    }

    /// @dev Filed in MarketCharter and inside the committee window.
    function _isOpen(uint256 charterId) private view returns (bool) {
        IMarketCharter.CharterRecord memory r = IMarketCharter(config.charter()).get(charterId);
        return r.status == BRTypes.CharterStatus.Filed
            && block.timestamp < uint256(r.filedAt) + config.committeeWindow();
    }

    /// @dev Caller guarantees the charter is open and not finalized.
    function _finalizeIfReady(uint256 charterId) private returns (bool) {
        (uint8 approvals, uint8 rejections) = votesOf(charterId);
        Verdict memory v = _verdicts[charterId];
        bool approved;
        if (rejections >= REJECT_THRESHOLD) {
            approved = false;
        } else if (
            v.posted && approvals >= (v.recommendApprove ? APPROVE_THRESHOLD : APPROVE_THRESHOLD_JURY_REJECT)
        ) {
            // New books paused: keep the ballots, finalize after unpause (or let the charter expire).
            if (config.newBooksPaused()) return false;
            approved = true;
        } else {
            return false;
        }

        _finalized[charterId] = true;
        emit Decided(charterId, approved);
        IMarketCharter(config.charter()).decide(charterId, approved, v.cid);
        return true;
    }

    function _checkActionData(bytes32 kind, bytes calldata data) private pure {
        if (kind == REMANDATE) {
            if (data.length != MANDATE_ENCODED_LENGTH) revert BadActionData(kind);
            BRTypes.Mandate memory m = abi.decode(data, (BRTypes.Mandate));
            bytes32 reason = CharterRules.mandateReason(m);
            if (reason != bytes32(0)) revert InvalidMandate(reason);
        } else if (kind == RETIRE) {
            if (data.length != 0) revert BadActionData(kind);
        } else if (kind == SLASH_SPONSOR) {
            if (data.length != 0 && data.length != 32) revert BadActionData(kind);
        } else if (kind == REVOKE_KEY) {
            if (data.length != 32) revert BadActionData(kind);
            if (uint256(bytes32(data)) >> 160 != 0) revert BadActionData(kind);
            if (address(uint160(uint256(bytes32(data)))) == address(0)) revert BadActionData(kind);
        } else {
            revert UnknownActionKind(kind);
        }
    }

    function _execute(uint256 bookId, bytes32 kind, bytes memory data) private {
        IBookrunnerConfig cfg = config;
        if (kind == REMANDATE) {
            IMMMandate(_mandateOf(cfg, bookId)).remandate(abi.decode(data, (BRTypes.Mandate)));
        } else if (kind == RETIRE) {
            IMarketCharter(cfg.charter()).retire(bookId);
        } else if (kind == SLASH_SPONSOR) {
            bytes32 reason = data.length == 32 ? abi.decode(data, (bytes32)) : SLASH_SPONSOR;
            IMarketCharter(cfg.charter()).slashSponsor(bookId, reason);
        } else {
            // REVOKE_KEY (kind validated at proposal)
            IMMMandate(_mandateOf(cfg, bookId)).revokeKey(abi.decode(data, (address)), COMMITTEE_REASON);
        }
    }

    function _mandateOf(IBookrunnerConfig cfg, uint256 bookId) private view returns (address mandate) {
        mandate = IBookFactory(cfg.factory()).componentsOf(bookId).mandate;
        if (mandate == address(0)) revert UnknownBook(bookId);
    }
}
