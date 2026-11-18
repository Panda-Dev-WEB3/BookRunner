// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {GasTank} from "../../src/GasTank.sol";

/// @notice Random top-ups, time jumps, governance edits, funding and withdrawals. A ghost ledger records what the
///         tank sent per service and per UTC day.
contract GasTankHandler is Test {
    GasTank public tank;
    address public admin;
    address[3] public svcs;
    uint256 public constant START = 1_800_000_000;

    mapping(uint256 day => mapping(address => uint256)) public sentByDay;
    mapping(uint256 day => uint256) public globalByDay;
    uint256 public totalFunded;
    uint256 public totalWithdrawn;
    uint256 public totalOut;
    /// @dev the largest cap in force during a day (a cap change only bounds later sends).
    mapping(uint256 day => uint256) public maxGlobalCap;
    mapping(uint256 day => mapping(address => uint256)) public maxSvcCap;

    constructor(GasTank t, address admin_, address[3] memory s) {
        tank = t;
        admin = admin_;
        svcs = s;
        for (uint256 i; i < 3; ++i) _noteCaps(s[i]);
    }

    function _day() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _noteCaps(address s) internal {
        (,,, uint256 cap,) = tank.serviceInfo(s);
        if (cap > maxSvcCap[_day()][s]) maxSvcCap[_day()][s] = cap;
        uint256 g = tank.globalDailyCap();
        if (g > maxGlobalCap[_day()]) maxGlobalCap[_day()] = g;
    }

    function topUp(uint256 who, uint256 bal) external {
        address s = svcs[who % 3];
        vm.deal(s, bound(bal, 0, 0.003 ether));
        try tank.topUp(s) returns (uint256 sent) {
            sentByDay[_day()][s] += sent;
            globalByDay[_day()] += sent;
            totalOut += sent;
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
        for (uint256 i; i < 3; ++i) _noteCaps(svcs[i]);
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 0, 1 ether);
        vm.deal(address(this), amount);
        (bool ok,) = address(tank).call{value: amount}("");
        if (ok) totalFunded += amount;
    }

    function withdraw(uint256 amount) external {
        amount = bound(amount, 0, address(tank).balance);
        vm.prank(admin);
        tank.withdraw(payable(address(0xBEEF)), amount);
        totalWithdrawn += amount;
    }

    function setCaps(uint256 which, uint256 svcCap, uint256 globalCap) external {
        address s = svcs[which % 3];
        vm.startPrank(admin);
        tank.setService(s, 0.002 ether, 0.01 ether, bound(svcCap, 0.01 ether, 0.05 ether));
        tank.setGlobalDailyCap(bound(globalCap, 0, 0.2 ether));
        vm.stopPrank();
        _noteCaps(s);
    }

    function pause(bool on) external {
        vm.startPrank(admin);
        if (on && !tank.paused()) tank.pause();
        if (!on && tank.paused()) tank.unpause();
        vm.stopPrank();
    }

    function dayRange() external view returns (uint256 first, uint256 last) {
        return (START / 1 days, _day());
    }
}

contract GasTankInvariantTest is Test {
    BookrunnerConfig internal config;
    GasTank internal tank;
    GasTankHandler internal h;
    address internal admin = makeAddr("admin");
    address[3] internal svcs = [makeAddr("s0"), makeAddr("s1"), makeAddr("s2")];

    function setUp() public {
        vm.warp(1_800_000_000);
        config = new BookrunnerConfig(admin);
        tank = new GasTank(address(config));
        vm.startPrank(admin);
        for (uint256 i; i < 3; ++i) {
            tank.setService(svcs[i], 0.002 ether, 0.01 ether, 0.02 ether);
        }
        tank.setGlobalDailyCap(0.1 ether);
        vm.stopPrank();
        vm.deal(address(tank), 1 ether);
        h = new GasTankHandler(tank, admin, svcs);
        targetContract(address(h));
    }

    /// @dev The tank never sends beyond the caps: per service and per day at most the largest service cap in force
    ///      that day, per day at most the largest global cap in force that day.
    function invariant_neverBeyondCaps() public view {
        (uint256 first, uint256 last) = h.dayRange();
        for (uint256 d = first; d <= last; ++d) {
            assertLe(h.globalByDay(d), h.maxGlobalCap(d));
            for (uint256 i; i < 3; ++i) {
                assertLe(h.sentByDay(d, svcs[i]), h.maxSvcCap(d, svcs[i]));
            }
        }
    }

    /// @dev The tank's own accounting equals the ghost ledger for the current day.
    function invariant_countersMatchLedger() public view {
        uint256 d = block.timestamp / 1 days;
        assertEq(tank.globalSentToday(), h.globalByDay(d));
        for (uint256 i; i < 3; ++i) {
            (,,,, uint256 today) = tank.serviceInfo(svcs[i]);
            assertEq(today, h.sentByDay(d, svcs[i]));
        }
    }

    /// @dev ETH conservation: balance == initial + funded - sent out - withdrawn.
    function invariant_ethConserved() public view {
        assertEq(address(tank).balance, 1 ether + h.totalFunded() - h.totalOut() - h.totalWithdrawn());
    }
}
