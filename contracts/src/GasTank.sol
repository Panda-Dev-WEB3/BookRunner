// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";

/// @title GasTank -- an ETH reserve that tops up the protocol's service wallets, within caps.
/// @notice The treasury (governance) sends ETH here. The timelock allow-lists service addresses (deployer-side
///         wallets such as the mark signer, risk, ops-venue, jury, keeper and oracle signer), each with a FLOOR
///         and a TARGET balance and a daily cap, plus one GLOBAL daily cap. Anyone (the keeper job) may call
///         `topUp(service)` while that service's balance is below its floor: the tank sends up to the target,
///         never more than what is left of the service's daily cap and of the global daily cap. The GUARDIAN or the
///         timelock can pause; only the timelock lifts a pause, edits the allow-list and the caps, and withdraws.
///
///         No arbitrary calls: the only outgoing transfers are `topUp` (plain ETH to an allow-listed address) and
///         the timelock's `withdraw`. Reentrancy-safe: `topUp` is nonReentrant, every counter is updated before
///         the transfer, and the transfer is the last statement. The recipient gets a bounded gas stipend, so a
///         recipient that burns gas only fails its own top-up.
/// @dev Days are fixed UTC buckets (`block.timestamp / 1 days`): a caller timing two top-ups either side of the
///      midnight boundary can draw at most 2x a daily cap in a few seconds, never more. Hard ceilings
///      (`MAX_*`) bound what even a mistaken governance setting can arm. Not upgradeable; holds nothing but ETH.
contract GasTank is ReentrancyGuardTransient {
    bytes32 private constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 private constant GUARDIAN_ROLE = keccak256("GUARDIAN");

    /// @notice Hard ceilings of the governance settings (guard rails, not targets).
    uint256 public constant MAX_TARGET = 1 ether;
    uint256 public constant MAX_SERVICE_DAILY = 2 ether;
    uint256 public constant MAX_GLOBAL_DAILY = 5 ether;
    /// @notice Most allow-listed services.
    uint256 public constant MAX_SERVICES = 32;
    /// @notice Gas forwarded with a top-up (an EOA or a simple wallet needs far less).
    uint256 public constant TOPUP_GAS = 50_000;

    /// @notice Protocol registry (roles: DEFAULT_ADMIN = timelock, GUARDIAN).
    IBookrunnerConfig public immutable config;

    struct Service {
        bool listed;
        uint128 floor; // top-up is allowed while balance < floor
        uint128 target; // a top-up fills the balance up to this (> floor)
        uint128 dailyCap; // most ETH one UTC day may send to this service
        uint64 day; // UTC day of `sentToday`
        uint128 sentToday;
    }

    mapping(address service => Service) private _svc;
    address[] private _list;

    /// @notice Most ETH one UTC day may send in total (timelock-set).
    uint256 public globalDailyCap;
    uint64 private _globalDay;
    uint256 private _globalSent;

    /// @notice Paused: `topUp` reverts (the ETH stays; the timelock can still withdraw).
    bool public paused;

    error NotAdmin(address caller);
    error NotAdminOrGuardian(address caller);
    error ZeroAddress();
    error BadParams();
    error TooManyServices();
    error NotListed(address service);
    error AboveFloor(address service, uint256 balance, uint256 floor);
    error CapReached(address service, bool global);
    error TankEmpty(uint256 balance);
    error TopUpFailed(address service);
    error WithdrawFailed();
    error IsPaused();
    error NotPaused();

    event ServiceSet(address indexed service, uint256 floor, uint256 target, uint256 dailyCap);
    event ServiceRemoved(address indexed service);
    event GlobalDailyCapSet(uint256 cap);
    /// @notice `amount` was sent to `service`; `wanted` is what its target asked for (amount < wanted: limited by a
    ///         cap or by the tank's balance; services/alerts reads the shortfall).
    event ToppedUp(address indexed service, uint256 amount, uint256 wanted, address indexed caller);
    event PausedSet(bool paused, address indexed by);
    event Withdrawn(address indexed to, uint256 amount);
    event Funded(address indexed from, uint256 amount);

    constructor(address config_) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // ----------------------------------------------------------------------------------------------- top-up

    /// @notice Anyone: tops up an allow-listed `service` whose balance is below its floor, up to its target and
    ///         within its daily cap, the global daily cap and the tank's balance. Returns the amount sent.
    ///         Reverts `AboveFloor` (nothing to do), `CapReached` (no room left today), `TankEmpty`, `IsPaused`.
    function topUp(address service) external nonReentrant returns (uint256 sent) {
        if (paused) revert IsPaused();
        Service storage s = _svc[service];
        if (!s.listed) revert NotListed(service);
        uint256 bal = service.balance;
        if (bal >= s.floor) revert AboveFloor(service, bal, s.floor);

        uint256 wanted = uint256(s.target) - bal;
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 usedService = s.day >= today ? s.sentToday : 0;
        uint256 usedGlobal = _globalDay >= today ? _globalSent : 0;
        uint256 roomService = s.dailyCap > usedService ? s.dailyCap - usedService : 0;
        uint256 roomGlobal = globalDailyCap > usedGlobal ? globalDailyCap - usedGlobal : 0;
        if (roomService == 0) revert CapReached(service, false);
        if (roomGlobal == 0) revert CapReached(service, true);

        sent = wanted;
        if (sent > roomService) sent = roomService;
        if (sent > roomGlobal) sent = roomGlobal;
        uint256 tank = address(this).balance;
        if (tank < 1) revert TankEmpty(0);
        if (sent > tank) sent = tank;

        // effects before the interaction
        s.day = today;
        s.sentToday = uint128(usedService + sent);
        _globalDay = today;
        _globalSent = usedGlobal + sent;
        emit ToppedUp(service, sent, wanted, msg.sender);

        (bool ok,) = service.call{value: sent, gas: TOPUP_GAS}("");
        if (!ok) revert TopUpFailed(service);
    }

    // --------------------------------------------------------------------------------------------- governance

    /// @notice Timelock: allow-lists `service` (or updates it) with its floor, target and daily cap. Today's usage
    ///         is kept. `floor` > 0, `floor` < `target` <= MAX_TARGET, `target` <= `dailyCap` <= MAX_SERVICE_DAILY.
    function setService(address service, uint256 floor, uint256 target, uint256 dailyCap) external {
        _onlyAdmin();
        if (service == address(0)) revert ZeroAddress();
        if (floor == 0 || floor >= target || target > MAX_TARGET || dailyCap < target || dailyCap > MAX_SERVICE_DAILY) {
            revert BadParams();
        }
        Service storage s = _svc[service];
        if (!s.listed) {
            if (_list.length >= MAX_SERVICES) revert TooManyServices();
            s.listed = true;
            _list.push(service);
        }
        s.floor = uint128(floor);
        s.target = uint128(target);
        s.dailyCap = uint128(dailyCap);
        emit ServiceSet(service, floor, target, dailyCap);
    }

    /// @notice Timelock: removes `service` from the allow-list.
    function removeService(address service) external {
        _onlyAdmin();
        if (!_svc[service].listed) revert NotListed(service);
        delete _svc[service];
        uint256 n = _list.length;
        for (uint256 i; i < n; ++i) {
            if (_list[i] == service) {
                _list[i] = _list[n - 1];
                _list.pop();
                break;
            }
        }
        emit ServiceRemoved(service);
    }

    /// @notice Timelock: sets the global daily cap (<= MAX_GLOBAL_DAILY; 0 stops all top-ups).
    function setGlobalDailyCap(uint256 cap) external {
        _onlyAdmin();
        if (cap > MAX_GLOBAL_DAILY) revert BadParams();
        globalDailyCap = cap;
        emit GlobalDailyCapSet(cap);
    }

    /// @notice GUARDIAN or timelock: pauses top-ups.
    function pause() external {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !config.hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotAdminOrGuardian(msg.sender);
        }
        if (paused) revert IsPaused();
        paused = true;
        emit PausedSet(true, msg.sender);
    }

    /// @notice Timelock only: lifts the pause.
    function unpause() external {
        _onlyAdmin();
        if (!paused) revert NotPaused();
        paused = false;
        emit PausedSet(false, msg.sender);
    }

    /// @notice Timelock: sends `amount` of the tank's ETH to `to` (the treasury).
    function withdraw(address payable to, uint256 amount) external nonReentrant {
        _onlyAdmin();
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    // ----------------------------------------------------------------------------------------------- views

    /// @notice The allow-listed services (the keeper job iterates this).
    function services() external view returns (address[] memory) {
        return _list;
    }

    /// @notice Settings and today's usage of `service`.
    function serviceInfo(address service)
        external
        view
        returns (bool listed, uint256 floor, uint256 target, uint256 dailyCap, uint256 sentToday)
    {
        Service storage s = _svc[service];
        uint64 today = uint64(block.timestamp / 1 days);
        return (s.listed, s.floor, s.target, s.dailyCap, s.day >= today ? s.sentToday : 0);
    }

    /// @notice ETH sent in the current UTC day, all services.
    function globalSentToday() external view returns (uint256) {
        return _globalDay >= uint64(block.timestamp / 1 days) ? _globalSent : 0;
    }

    /// @notice What `topUp(service)` would send now (0 = it would revert), and why not: reason 0 sendable, 1 not listed
    ///         / paused / empty tank, 2 at or above the floor, 3 service cap reached, 4 global cap reached.
    function topUpQuote(address service) external view returns (uint256 amount, uint8 reason) {
        Service storage s = _svc[service];
        if (!s.listed || paused || address(this).balance < 1) return (0, 1);
        uint256 bal = service.balance;
        if (bal >= s.floor) return (0, 2);
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 usedService = s.day >= today ? s.sentToday : 0;
        uint256 usedGlobal = _globalDay >= today ? _globalSent : 0;
        if (s.dailyCap <= usedService) return (0, 3);
        if (globalDailyCap <= usedGlobal) return (0, 4);
        amount = uint256(s.target) - bal;
        uint256 r = s.dailyCap - usedService;
        if (amount > r) amount = r;
        r = globalDailyCap - usedGlobal;
        if (amount > r) amount = r;
        if (amount > address(this).balance) amount = address(this).balance;
    }

    function _onlyAdmin() private view {
        if (!config.hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
    }
}
