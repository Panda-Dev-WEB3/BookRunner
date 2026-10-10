// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {BRTypes} from "./interfaces/BRTypes.sol";

/// @title BookrunnerConfig — protocol registry of addresses, parameters and roles.
/// @notice `DEFAULT_ADMIN_ROLE` is held by the TimelockController (48h on mainnet, 0s on devnet). Every
///         component reads its siblings and parameters from here. Addresses and parameters are keyed by
///         ASCII short strings equal to their getter name (e.g. `bytes32("usdc")`, `bytes32("carryBps")`),
///         so deploy scripts can set everything through `setAddress(es)` / `setParam(s)`.
/// @dev Non-upgradeable. Role ids are `keccak256("<NAME>")`; all roles are administered by
///      `DEFAULT_ADMIN_ROLE`.
contract BookrunnerConfig is AccessControl, IBookrunnerConfig {
    // ---------------------------------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IBookrunnerConfig
    bytes32 public constant MARK_SIGNER_ROLE = keccak256("MARK_SIGNER");
    /// @inheritdoc IBookrunnerConfig
    bytes32 public constant RISK_ROLE = keccak256("RISK");
    /// @inheritdoc IBookrunnerConfig
    bytes32 public constant OPS_VENUE_ROLE = keccak256("OPS_VENUE");
    /// @inheritdoc IBookrunnerConfig
    bytes32 public constant JURY_ROLE = keccak256("JURY");
    /// @inheritdoc IBookrunnerConfig
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER");
    /// @inheritdoc IBookrunnerConfig
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN");

    // ---------------------------------------------------------------------------------------------
    // Address keys (bytes32 ASCII short strings == getter names)
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant KEY_USDC = "usdc";
    bytes32 public constant KEY_BKRN = "bkrn";
    bytes32 public constant KEY_STAKING = "staking";
    bytes32 public constant KEY_FEE_ROUTER = "feeRouter";
    bytes32 public constant KEY_BACKSTOP = "backstop";
    bytes32 public constant KEY_MARK_REGISTRY = "markRegistry";
    bytes32 public constant KEY_ORACLE = "oracle";
    bytes32 public constant KEY_STOCK_REGISTRY = "stockRegistry";
    bytes32 public constant KEY_CHARTER = "charter";
    bytes32 public constant KEY_COMMITTEE = "committee";
    bytes32 public constant KEY_FACTORY = "factory";
    bytes32 public constant KEY_POOL_ENGINE = "poolEngine";
    bytes32 public constant KEY_ORDERLY_VAULT = "orderlyVault";
    bytes32 public constant KEY_HEDGE_EXECUTOR = "hedgeExecutor";
    bytes32 public constant KEY_ENTRY_POINT = "entryPoint";
    bytes32 public constant KEY_TIMELOCK = "timelock";
    bytes32 public constant KEY_EXPENSE_RECIPIENT = "expenseRecipient";
    bytes32 public constant KEY_SLASH_RECIPIENT = "slashRecipient";

    // ---------------------------------------------------------------------------------------------
    // Parameter keys
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant KEY_CARRY_BPS = "carryBps";
    bytes32 public constant KEY_EXPENSE_CAP_BPS = "expenseCapBps";
    bytes32 public constant KEY_CHARTER_FEE_USD = "charterFeeUsd";
    bytes32 public constant KEY_SPONSOR_BOND_BKRN = "sponsorBondBkrn";
    bytes32 public constant KEY_COMMITTEE_BOND_BKRN = "committeeBondBkrn";
    bytes32 public constant KEY_MARK_INTERVAL = "markInterval";
    bytes32 public constant KEY_MAX_MARK_AGE = "maxMarkAge";
    bytes32 public constant KEY_MAX_PRICE_AGE = "maxPriceAge";
    bytes32 public constant KEY_COMMITTEE_WINDOW = "committeeWindow";
    /// @notice LOW_GAS.md §1: max age of the price any engine trade may use (seconds).
    bytes32 public constant KEY_MAX_TRADE_PRICE_AGE = "maxTradePriceAge";

    /// @notice Upper bound on the number of agent bond tiers (keeps `agentTierBond` O(1)-bounded).
    uint256 public constant MAX_TIERS = 16;

    /// @notice Lower bound of `committeeWindow` (charter review + committee action expiry).
    uint256 public constant MIN_COMMITTEE_WINDOW = 1 days;

    /// @notice Decimals the settlement token (`usdc`: USDC on devnet/testnet, USDG on Robinhood Chain
    ///         mainnet) must have; `setAddress("usdc", t)` reverts `BadSettlementToken` otherwise.
    uint8 public constant SETTLEMENT_DECIMALS = 6;

    uint256 private constant BPS = 10_000;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    struct Tier {
        uint256 threshold; // inventory USD (6dp) at or above which `bond` applies
        uint256 bond; // BKRN (18dp) required locked stake
    }

    mapping(bytes32 key => address value) private _addresses;

    uint16 private _carryBps;
    uint16 private _expenseCapBps;
    uint32 private _markInterval;
    uint32 private _maxMarkAge;
    uint32 private _maxPriceAge;
    uint32 private _committeeWindow;
    bool private _newBooksPaused;
    uint32 private _maxTradePriceAge; // packed with the params above (one slot with maxPriceAge)
    uint256 private _charterFeeUsd;
    uint256 private _sponsorBondBkrn;
    uint256 private _committeeBondBkrn;

    mapping(uint8 venue => uint256 minIfUsd) private _venueMinIfUsd;
    Tier[] private _tiers;

    // ---------------------------------------------------------------------------------------------
    // Errors / events
    // ---------------------------------------------------------------------------------------------

    error ZeroAddress();
    error UnknownKey(bytes32 key);
    error ParamOutOfRange(bytes32 key, uint256 value);
    error LengthMismatch();
    error TooManyTiers(uint256 count, uint256 max);
    error TiersNotAscending(uint256 index);
    error NotAdminOrGuardian(address caller);
    error TimelockNotAdmin(address timelock);
    /// @notice `usdc` (settlement token) is not a contract returning `decimals() == 6` (`decimals` = what
    ///         it returned, 0 when the call failed / the address has no code).
    error BadSettlementToken(address token, uint256 decimals);

    /// @notice Minimum insurance-fund size for `venue` changed.
    event VenueMinIfSet(uint8 indexed venue, uint256 amountUsd);
    /// @notice Agent bond tier table replaced.
    event TiersSet(uint256[] thresholds, uint256[] bonds);

    // ---------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------

    /// @param admin Holder of `DEFAULT_ADMIN_ROLE` (the TimelockController, or the deployer until handover).
    ///              Also recorded as the initial `timelock()` address. Handover: grant
    ///              `DEFAULT_ADMIN_ROLE` to the TimelockController, `setAddress("timelock", controller)`,
    ///              then renounce the deployer's roles (`timelock()` follows the admin role, see there).
    /// @dev Initialises the mainnet defaults of ARCHITECTURE §2.1. Devnet overrides are applied by the
    ///      deploy script through `setParams`.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setAddress(KEY_TIMELOCK, admin);

        _setParam(KEY_CARRY_BPS, 1000);
        _setParam(KEY_EXPENSE_CAP_BPS, 2000);
        _setParam(KEY_CHARTER_FEE_USD, 5000e6);
        _setParam(KEY_SPONSOR_BOND_BKRN, 100_000e18);
        _setParam(KEY_COMMITTEE_BOND_BKRN, 250_000e18);
        _setParam(KEY_MARK_INTERVAL, 86_400);
        _setParam(KEY_MAX_MARK_AGE, 21_600);
        _setParam(KEY_MAX_PRICE_AGE, 300);
        _setParam(KEY_COMMITTEE_WINDOW, 172_800);
        _setParam(KEY_MAX_TRADE_PRICE_AGE, 15);

        _setVenueMinIf(BRTypes.VENUE_ORDERLY, 25_000e6); // VERIFY: Orderly minimum IF per symbol on RHC
        _setVenueMinIf(BRTypes.VENUE_POOL_ENGINE, 10_000e6);

        uint256[] memory thresholds = new uint256[](3);
        uint256[] memory bonds = new uint256[](3);
        (thresholds[0], bonds[0]) = (50_000e6, 25_000e18);
        (thresholds[1], bonds[1]) = (250_000e6, 100_000e18);
        (thresholds[2], bonds[2]) = (1_000_000e6, 400_000e18);
        _setTiers(thresholds, bonds);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin setters
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets the address registered under `key` (one of the `KEY_*` address keys).
    /// @dev Admin only. Reverts on unknown keys and the zero address. Emits `AddressSet`.
    function setAddress(bytes32 key, address value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setAddress(key, value);
    }

    /// @notice Batch form of `setAddress` for deploy scripts.
    function setAddresses(bytes32[] calldata keys, address[] calldata values)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (keys.length != values.length) revert LengthMismatch();
        for (uint256 i; i < keys.length; ++i) {
            _setAddress(keys[i], values[i]);
        }
    }

    /// @notice Sets the numeric parameter `key` (one of the `KEY_*` parameter keys).
    /// @dev Admin only. Range checks: bps <= 1e4; markInterval, maxMarkAge, maxPriceAge and
    ///      maxTradePriceAge > 0; committeeWindow >= MIN_COMMITTEE_WINDOW (1 day); uint32 params fit
    ///      uint32. Emits `ParamSet`.
    function setParam(bytes32 key, uint256 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setParam(key, value);
    }

    /// @notice Batch form of `setParam` for deploy scripts (e.g. devnet overrides).
    function setParams(bytes32[] calldata keys, uint256[] calldata values)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (keys.length != values.length) revert LengthMismatch();
        for (uint256 i; i < keys.length; ++i) {
            _setParam(keys[i], values[i]);
        }
    }

    /// @notice Sets the minimum insurance-fund size (USD 6dp) a charter must target on `venue`.
    function setVenueMinIf(uint8 venue, uint256 amountUsd) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setVenueMinIf(venue, amountUsd);
    }

    /// @notice Replaces the agent bond tier table. `thresholds` (USD 6dp) strictly ascending, `bonds`
    ///         (BKRN 18dp) non-decreasing, at most `MAX_TIERS` entries. Empty table => no bond required.
    function setTiers(uint256[] calldata thresholds, uint256[] calldata bonds)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setTiers(thresholds, bonds);
    }

    /// @notice Kill-criteria switch for NEW charters / books / deposits. Never affects redemptions.
    /// @dev Callable by the admin or a GUARDIAN, in both directions.
    function setNewBooksPaused(bool paused) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotAdminOrGuardian(msg.sender);
        }
        _newBooksPaused = paused;
        emit NewBooksPaused(paused);
    }

    // ---------------------------------------------------------------------------------------------
    // Views — roles
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IBookrunnerConfig
    function hasRole(bytes32 role, address account)
        public
        view
        override(AccessControl, IBookrunnerConfig)
        returns (bool)
    {
        return super.hasRole(role, account);
    }

    // ---------------------------------------------------------------------------------------------
    // Views — addresses
    // ---------------------------------------------------------------------------------------------

    /// @notice Generic address lookup by key (zero when unset). `timelock` resolves as `timelock()`.
    function addressOf(bytes32 key) external view returns (address) {
        return key == KEY_TIMELOCK ? _timelock() : _addresses[key];
    }

    /// @inheritdoc IBookrunnerConfig
    function usdc() external view returns (address) {
        return _addresses[KEY_USDC];
    }

    /// @inheritdoc IBookrunnerConfig
    function bkrn() external view returns (address) {
        return _addresses[KEY_BKRN];
    }

    /// @inheritdoc IBookrunnerConfig
    function staking() external view returns (address) {
        return _addresses[KEY_STAKING];
    }

    /// @inheritdoc IBookrunnerConfig
    function feeRouter() external view returns (address) {
        return _addresses[KEY_FEE_ROUTER];
    }

    /// @inheritdoc IBookrunnerConfig
    function backstop() external view returns (address) {
        return _addresses[KEY_BACKSTOP];
    }

    /// @inheritdoc IBookrunnerConfig
    function markRegistry() external view returns (address) {
        return _addresses[KEY_MARK_REGISTRY];
    }

    /// @inheritdoc IBookrunnerConfig
    function oracle() external view returns (address) {
        return _addresses[KEY_ORACLE];
    }

    /// @inheritdoc IBookrunnerConfig
    function stockRegistry() external view returns (address) {
        return _addresses[KEY_STOCK_REGISTRY];
    }

    /// @inheritdoc IBookrunnerConfig
    function charter() external view returns (address) {
        return _addresses[KEY_CHARTER];
    }

    /// @inheritdoc IBookrunnerConfig
    function committee() external view returns (address) {
        return _addresses[KEY_COMMITTEE];
    }

    /// @inheritdoc IBookrunnerConfig
    function factory() external view returns (address) {
        return _addresses[KEY_FACTORY];
    }

    /// @inheritdoc IBookrunnerConfig
    function poolEngine() external view returns (address) {
        return _addresses[KEY_POOL_ENGINE];
    }

    /// @inheritdoc IBookrunnerConfig
    function orderlyVault() external view returns (address) {
        return _addresses[KEY_ORDERLY_VAULT];
    }

    /// @inheritdoc IBookrunnerConfig
    function hedgeExecutor() external view returns (address) {
        return _addresses[KEY_HEDGE_EXECUTOR];
    }

    /// @inheritdoc IBookrunnerConfig
    function entryPoint() external view returns (address) {
        return _addresses[KEY_ENTRY_POINT];
    }

    /// @inheritdoc IBookrunnerConfig
    /// @dev The recorded timelock only while it still holds `DEFAULT_ADMIN_ROLE`, else address(0): every
    ///      48h-gated power (`msg.sender == config.timelock()`) follows the admin role and fails closed if
    ///      the role is moved/renounced without repointing the timelock (no stale holder keeps it).
    function timelock() external view returns (address) {
        return _timelock();
    }

    /// @inheritdoc IBookrunnerConfig
    function expenseRecipient() external view returns (address) {
        return _addresses[KEY_EXPENSE_RECIPIENT];
    }

    /// @inheritdoc IBookrunnerConfig
    function slashRecipient() external view returns (address) {
        return _addresses[KEY_SLASH_RECIPIENT];
    }

    // ---------------------------------------------------------------------------------------------
    // Views — parameters
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IBookrunnerConfig
    function carryBps() external view returns (uint16) {
        return _carryBps;
    }

    /// @inheritdoc IBookrunnerConfig
    function expenseCapBps() external view returns (uint16) {
        return _expenseCapBps;
    }

    /// @inheritdoc IBookrunnerConfig
    function charterFeeUsd() external view returns (uint256) {
        return _charterFeeUsd;
    }

    /// @inheritdoc IBookrunnerConfig
    function sponsorBondBkrn() external view returns (uint256) {
        return _sponsorBondBkrn;
    }

    /// @inheritdoc IBookrunnerConfig
    function committeeBondBkrn() external view returns (uint256) {
        return _committeeBondBkrn;
    }

    /// @inheritdoc IBookrunnerConfig
    function markInterval() external view returns (uint32) {
        return _markInterval;
    }

    /// @inheritdoc IBookrunnerConfig
    function maxMarkAge() external view returns (uint32) {
        return _maxMarkAge;
    }

    /// @inheritdoc IBookrunnerConfig
    function maxPriceAge() external view returns (uint32) {
        return _maxPriceAge;
    }

    /// @inheritdoc IBookrunnerConfig
    function committeeWindow() external view returns (uint32) {
        return _committeeWindow;
    }

    /// @notice Pull-oracle latency-arbitrage bound (LOW_GAS.md §1): any engine trade (opens, increases,
    ///         reductions, closes, flips) may only use a price with
    ///         `publishedAt >= block.timestamp - maxTradePriceAge` (default 15 s, timelock-settable via
    ///         `setParam("maxTradePriceAge", v)`, v > 0). Liquidations are not bound by it.
    /// @dev Not part of IBookrunnerConfig (keeps existing config stand-ins compiling); consumers read it
    ///      through `IBookrunnerConfigTradeAge` (PoolEngine.sol).
    function maxTradePriceAge() external view returns (uint32) {
        return _maxTradePriceAge;
    }

    /// @inheritdoc IBookrunnerConfig
    function venueMinIfUsd(uint8 venue) external view returns (uint256) {
        return _venueMinIfUsd[venue];
    }

    /// @inheritdoc IBookrunnerConfig
    /// @dev Step function: the bond of the highest tier whose threshold is <= `inventoryUsd`.
    function agentTierBond(uint256 inventoryUsd) external view returns (uint256) {
        for (uint256 i = _tiers.length; i > 0; --i) {
            Tier storage t = _tiers[i - 1];
            if (inventoryUsd >= t.threshold) return t.bond;
        }
        return 0;
    }

    /// @notice Current tier table.
    function tiers() external view returns (uint256[] memory thresholds, uint256[] memory bonds) {
        uint256 n = _tiers.length;
        thresholds = new uint256[](n);
        bonds = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            thresholds[i] = _tiers[i].threshold;
            bonds[i] = _tiers[i].bond;
        }
    }

    /// @inheritdoc IBookrunnerConfig
    function newBooksPaused() external view returns (bool) {
        return _newBooksPaused;
    }

    /// @notice True if `key` is a known address key.
    function isAddressKey(bytes32 key) public pure returns (bool) {
        return key == KEY_USDC || key == KEY_BKRN || key == KEY_STAKING || key == KEY_FEE_ROUTER
            || key == KEY_BACKSTOP || key == KEY_MARK_REGISTRY || key == KEY_ORACLE
            || key == KEY_STOCK_REGISTRY || key == KEY_CHARTER || key == KEY_COMMITTEE || key == KEY_FACTORY
            || key == KEY_POOL_ENGINE || key == KEY_ORDERLY_VAULT || key == KEY_HEDGE_EXECUTOR
            || key == KEY_ENTRY_POINT || key == KEY_TIMELOCK || key == KEY_EXPENSE_RECIPIENT
            || key == KEY_SLASH_RECIPIENT;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _setAddress(bytes32 key, address value) private {
        if (!isAddressKey(key)) revert UnknownKey(key);
        if (value == address(0)) revert ZeroAddress();
        if (key == KEY_TIMELOCK && !hasRole(DEFAULT_ADMIN_ROLE, value)) revert TimelockNotAdmin(value);
        if (key == KEY_USDC) _checkSettlementToken(value);
        _addresses[key] = value;
        emit AddressSet(key, value);
    }

    function _timelock() private view returns (address t) {
        t = _addresses[KEY_TIMELOCK];
        if (!hasRole(DEFAULT_ADMIN_ROLE, t)) t = address(0);
    }

    function _setParam(bytes32 key, uint256 value) private {
        if (key == KEY_CARRY_BPS) {
            _checkMax(key, value, BPS);
            _carryBps = uint16(value);
        } else if (key == KEY_EXPENSE_CAP_BPS) {
            _checkMax(key, value, BPS);
            _expenseCapBps = uint16(value);
        } else if (key == KEY_CHARTER_FEE_USD) {
            _charterFeeUsd = value;
        } else if (key == KEY_SPONSOR_BOND_BKRN) {
            _sponsorBondBkrn = value;
        } else if (key == KEY_COMMITTEE_BOND_BKRN) {
            _committeeBondBkrn = value;
        } else if (key == KEY_MARK_INTERVAL) {
            _checkNonZeroU32(key, value);
            _markInterval = uint32(value);
        } else if (key == KEY_MAX_MARK_AGE) {
            // 0 would make a mark committable only in the exact second its period ends (marks stop).
            _checkNonZeroU32(key, value);
            _maxMarkAge = uint32(value);
        } else if (key == KEY_MAX_PRICE_AGE) {
            _checkNonZeroU32(key, value);
            _maxPriceAge = uint32(value);
        } else if (key == KEY_COMMITTEE_WINDOW) {
            // A short window makes every charter expire before review and every committee action
            // (REVOKE_KEY / RETIRE / SLASH_SPONSOR) expire before a second member can approve it.
            if (value < MIN_COMMITTEE_WINDOW || value > type(uint32).max) revert ParamOutOfRange(key, value);
            _committeeWindow = uint32(value);
        } else if (key == KEY_MAX_TRADE_PRICE_AGE) {
            _checkNonZeroU32(key, value);
            _maxTradePriceAge = uint32(value);
        } else {
            revert UnknownKey(key);
        }
        emit ParamSet(key, value);
    }

    function _setVenueMinIf(uint8 venue, uint256 amountUsd) private {
        _venueMinIfUsd[venue] = amountUsd;
        emit VenueMinIfSet(venue, amountUsd);
    }

    function _setTiers(uint256[] memory thresholds, uint256[] memory bonds) private {
        uint256 n = thresholds.length;
        if (n != bonds.length) revert LengthMismatch();
        if (n > MAX_TIERS) revert TooManyTiers(n, MAX_TIERS);
        for (uint256 i = 1; i < n; ++i) {
            if (thresholds[i] <= thresholds[i - 1] || bonds[i] < bonds[i - 1]) revert TiersNotAscending(i);
        }
        delete _tiers;
        for (uint256 i; i < n; ++i) {
            _tiers.push(Tier({threshold: thresholds[i], bond: bonds[i]}));
        }
        emit TiersSet(thresholds, bonds);
    }

    /// @dev The settlement token must be a contract whose `decimals()` returns exactly
    ///      SETTLEMENT_DECIMALS: every USD amount in the protocol (tranches, vaults, marks, fees, bonds
    ///      tiers, engine margin) is 6-decimal and valued 1:1 in USD.
    function _checkSettlementToken(address token) private view {
        if (token.code.length == 0) revert BadSettlementToken(token, 0);
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || ret.length < 32) revert BadSettlementToken(token, 0);
        uint256 dec = abi.decode(ret, (uint256));
        if (dec != SETTLEMENT_DECIMALS) revert BadSettlementToken(token, dec);
    }

    function _checkMax(bytes32 key, uint256 value, uint256 max) private pure {
        if (value > max) revert ParamOutOfRange(key, value);
    }

    function _checkNonZeroU32(bytes32 key, uint256 value) private pure {
        if (value == 0 || value > type(uint32).max) revert ParamOutOfRange(key, value);
    }
}
