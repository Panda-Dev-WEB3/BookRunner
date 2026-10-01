// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IMarketCharter} from "../../src/interfaces/IMarketCharter.sol";
import {MarketCharter} from "../../src/MarketCharter.sol";
import {RiskCommittee} from "../../src/RiskCommittee.sol";
import {BookFactory} from "../../src/BookFactory.sol";

import {GovBase} from "./utils/GovBase.sol";
import {GovMockConfig} from "./utils/GovMocks.sol";

/// @notice Random charter traffic: filing, jury posts, votes, member rotation, pausing, time, expiry.
contract GovHandler is Test {
    MarketCharter internal immutable charter;
    RiskCommittee internal immutable committee;
    BookFactory internal immutable factory;
    GovMockConfig internal immutable cfg;
    address internal immutable timelock;
    address internal immutable jury;

    address[] internal sponsors;
    address[] internal pool; // candidate members (all funded + staked)
    BRTypes.Charter internal template;

    uint256 public filed;
    uint256 public approvals;

    constructor(
        MarketCharter charter_,
        RiskCommittee committee_,
        BookFactory factory_,
        GovMockConfig cfg_,
        address timelock_,
        address jury_,
        address[] memory sponsors_,
        address[] memory pool_,
        BRTypes.Charter memory template_
    ) {
        charter = charter_;
        committee = committee_;
        factory = factory_;
        cfg = cfg_;
        timelock = timelock_;
        jury = jury_;
        sponsors = sponsors_;
        pool = pool_;
        template = template_;
    }

    function _pickId(uint256 seed) internal view returns (uint256) {
        uint256 n = charter.count();
        return n == 0 ? 1 : (seed % n) + 1;
    }

    function file(uint256 sponsorSeed) external {
        if (cfg.newBooksPaused()) return;
        BRTypes.Charter memory c = template;
        c.sponsor = sponsors[sponsorSeed % sponsors.length];
        vm.prank(c.sponsor);
        charter.file(c);
        filed++;
    }

    function postJury(uint256 idSeed, bool recommendApprove) external {
        uint256 id = _pickId(idSeed);
        (,, bool posted) = committee.juryVerdict(id);
        if (posted || !charter.isOpen(id) || committee.isFinalized(id)) return;
        vm.prank(jury);
        committee.postJuryVerdict(id, keccak256(abi.encode(id)), recommendApprove);
    }

    function vote(uint256 idSeed, uint256 seatSeed, bool approve) external {
        uint256 id = _pickId(idSeed);
        address m = committee.members()[seatSeed % 3];
        if (!committee.isBonded(m) || committee.hasVoted(id, m) || !charter.isOpen(id)) return;
        if (committee.isFinalized(id)) return;
        vm.prank(m);
        committee.vote(id, approve);
        if (charter.get(id).status == BRTypes.CharterStatus.Approved) approvals++;
    }

    function tryFinalize(uint256 idSeed) external {
        uint256 id = _pickId(idSeed);
        if (committee.tryFinalize(id)) {
            if (charter.get(id).status == BRTypes.CharterStatus.Approved) approvals++;
        }
    }

    function rotateMember(uint8 seat, uint256 candidateSeed) external {
        address candidate = pool[candidateSeed % pool.length];
        if (committee.isMember(candidate)) return;
        vm.prank(timelock);
        committee.setMember(seat % 3, candidate);
        vm.prank(candidate);
        committee.bond();
    }

    function releaseBond(uint256 candidateSeed) external {
        address candidate = pool[candidateSeed % pool.length];
        if (committee.isMember(candidate) || committee.bondOf(candidate) == 0) return;
        vm.prank(candidate);
        committee.releaseBond();
    }

    function togglePause(bool paused) external {
        cfg.setNewBooksPaused(paused);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
    }

    function expire(uint256 idSeed) external {
        uint256 id = _pickId(idSeed);
        if (charter.get(id).status != BRTypes.CharterStatus.Filed) return;
        if (block.timestamp < charter.decisionDeadline(id)) return;
        charter.expire(id);
    }
}

contract GovInvariantTest is GovBase {
    GovHandler internal handler;
    address[] internal sponsorList;
    address[] internal memberPool;
    uint256 internal totalUsdc;

    function setUp() public override {
        super.setUp();

        sponsorList.push(sponsor);
        for (uint256 i; i < 2; ++i) {
            address s = makeAddr(string.concat("sponsor", vm.toString(i)));
            _fundSponsor(s);
            sponsorList.push(s);
        }
        memberPool.push(m1);
        memberPool.push(m2);
        memberPool.push(m3);
        for (uint256 i; i < 3; ++i) {
            address m = makeAddr(string.concat("candidate", vm.toString(i)));
            _fundMember(m);
            memberPool.push(m);
        }
        _bondAll();

        for (uint256 i; i < sponsorList.length; ++i) {
            totalUsdc += usdc.balanceOf(sponsorList[i]);
        }

        handler = new GovHandler(
            charter, committee, factory, cfg, timelock, jury, sponsorList, memberPool, _charter()
        );
        targetContract(address(handler));
    }

    /// @notice The handler's approve, reject and expire paths are all reachable.
    function test_handlerSmoke() public {
        handler.file(0); // id 1
        handler.postJury(0, true);
        handler.vote(0, 0, true);
        handler.vote(0, 1, true);
        assertEq(uint8(charter.get(1).status), uint8(BRTypes.CharterStatus.Approved));
        assertEq(handler.approvals(), 1);

        handler.file(1); // id 2
        handler.vote(1, 0, false);
        handler.vote(1, 2, false);
        assertEq(uint8(charter.get(2).status), uint8(BRTypes.CharterStatus.Rejected));

        handler.file(2); // id 3
        handler.rotateMember(0, 3);
        handler.warp(3 days);
        handler.expire(2);
        assertEq(uint8(charter.get(3).status), uint8(BRTypes.CharterStatus.Expired));
        handler.releaseBond(0);

        invariant_feeEscrowMatchesFiledCharters();
        invariant_usdcConservation();
        invariant_sponsorBondsTrackStatus();
        invariant_booksMatchApprovals();
        invariant_memberBondsBackedByLocks();
    }

    /// @notice Escrow: the charter holds exactly the fees of Filed charters.
    function invariant_feeEscrowMatchesFiledCharters() public view {
        uint256 n = charter.count();
        uint256 escrow;
        for (uint256 id = 1; id <= n; ++id) {
            IMarketCharter.CharterRecord memory r = charter.get(id);
            if (r.status == BRTypes.CharterStatus.Filed) escrow += r.feePaidUsd;
        }
        assertEq(usdc.balanceOf(address(charter)), escrow);
    }

    /// @notice USDC conservation: sponsors + escrow + expense recipient == initial sponsor balances,
    ///         and the expense recipient received exactly one fee per approved charter.
    function invariant_usdcConservation() public view {
        uint256 sum = usdc.balanceOf(address(charter)) + usdc.balanceOf(expenseRecipient);
        for (uint256 i; i < sponsorList.length; ++i) {
            sum += usdc.balanceOf(sponsorList[i]);
        }
        assertEq(sum, totalUsdc);
        assertEq(usdc.balanceOf(expenseRecipient), FEE * factory.bookCount());
    }

    /// @notice Sponsor bonds: locked exactly while Filed or Approved, and staking agrees.
    function invariant_sponsorBondsTrackStatus() public view {
        uint256 n = charter.count();
        for (uint256 id = 1; id <= n; ++id) {
            IMarketCharter.CharterRecord memory r = charter.get(id);
            bool shouldLock =
                r.status == BRTypes.CharterStatus.Filed || r.status == BRTypes.CharterStatus.Approved;
            assertEq(charter.bondOutstanding(id), shouldLock ? SPONSOR_BOND : 0);
            assertEq(staking.lockOf(r.charter.sponsor, charter.bondLockId(id)), charter.bondOutstanding(id));
        }
    }

    /// @notice Books exist exactly for Approved charters; decisions come only from this committee.
    function invariant_booksMatchApprovals() public view {
        uint256 n = charter.count();
        uint256 approved;
        for (uint256 id = 1; id <= n; ++id) {
            IMarketCharter.CharterRecord memory r = charter.get(id);
            bool isApproved = r.status == BRTypes.CharterStatus.Approved;
            if (isApproved) {
                approved++;
                assertTrue(r.book != address(0));
                assertEq(factory.bookOf(id), r.book);
                (bytes32 cid,, bool posted) = committee.juryVerdict(id);
                assertTrue(posted, "approval requires a jury verdict");
                assertEq(r.juryCid, cid);
            } else {
                assertEq(factory.bookOf(id), address(0));
            }
            bool decidedByCommittee =
                r.status == BRTypes.CharterStatus.Approved || r.status == BRTypes.CharterStatus.Rejected;
            assertEq(committee.isFinalized(id), decidedByCommittee);
        }
        assertEq(factory.bookCount(), approved);
        assertEq(handler.approvals(), approved);
    }

    /// @notice Member bonds held by the committee are backed 1:1 by staking locks.
    function invariant_memberBondsBackedByLocks() public view {
        for (uint256 i; i < memberPool.length; ++i) {
            address m = memberPool[i];
            assertEq(staking.lockOf(m, committee.BOND_LOCK_ID()), committee.bondOf(m));
        }
    }
}
