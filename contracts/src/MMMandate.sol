// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IMMMandate} from "./interfaces/IMMMandate.sol";
import {IBook} from "./interfaces/IBook.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBkrnStaking} from "./interfaces/IBkrnStaking.sol";
import {IAttestedOracle} from "./interfaces/IAttestedOracle.sol";
import {IStockTokenRegistry} from "./interfaces/IStockTokenRegistry.sol";
import {IVenueAdapter, IPoolEngineAdapter} from "./interfaces/IVenueAdapter.sol";
import {IPoolEngine} from "./interfaces/IPoolEngine.sol";
import {IBookrunnerDesk} from "./interfaces/IBookrunnerDesk.sol";

/// @title IMMMandateDesk — mandate checks used by the book's BookrunnerDesk on executed legs.
/// @notice Extension of IMMMandate (frozen interface untouched); implemented by MMMandate.
interface IMMMandateDesk {
    /// @notice Post-trade hedge validation with the desk's measured before/after hedge notionals.
    function checkHedgeExecuted(
        address key,
        IMMMandate.HedgeParams calldata p,
        bytes32[] calldata allowProof,
        int256 hedgeBeforeUsd,
        int256 hedgeAfterUsd,
        uint256 holdingsAfterRaw
    ) external view;

    /// @notice FundDesk rule: desk value after <= maxInventoryUsd * hedgeRatioMaxBps / 1e4.
    function checkFundDesk(address key, uint256 amountUsd) external view;
}

/// @title IDeskKeySync — desk hook the mandate calls so ERC-4337 validation only reads desk storage.
interface IDeskKeySync {
    /// @notice Only the book's mandate. validUntil == 0 deactivates the key on the desk.
    function syncKey(address key, uint64 validUntil) external;
}

/// @title MMMandate — the mandate letter in code (EIP-1167 clone per book).
/// @notice Session-key registry + validator for the book's on-chain legs (hedges, inventory moves,
///         in-house quotes) and the policy mirror of `packages/shared/src/mandate.ts` (normative).
///         Semantics: ARCHITECTURE.md §2.7.
///
///         Keys: the sponsor registers desk keys backed by an agent operator's BKRN stake
///         (`config.agentTierBond(tier)` locked on BkrnStaking under `keyLockId(key)`). Because the lock
///         encumbers the operator's stake, an operator other than the sponsor must first consent with
///         {consentKey}. Revocation is immediate (same block) and is mirrored to the desk.
///
///         Kill: RISK or the book. Revokes every key, sets the engine market reduce-only (in-house books)
///         and notifies the book. Neither the bond release, the adapter call nor the book callback can
///         block a kill (each is try/caught and evented). `remandate` (committee) replaces the terms,
///         clears the kill and revokes any remaining keys (keys must be re-registered); it does NOT lift
///         the engine reduce-only flag — the RISK role does that once fresh quotes are set.
///
///         Retiring (`setRetiring`, book only): reduce-only without kill — keys stay so the agent can
///         flatten, but no venue deployments, desk funding, hedge growth or risk-adding quotes.
contract MMMandate is IMMMandate, IMMMandateDesk, Initializable, ReentrancyGuardTransient {
    using EnumerableSet for EnumerableSet.AddressSet;

    // ------------------------------------------------------------------ constants

    bytes32 internal constant RISK_ROLE = keccak256("RISK");
    bytes32 internal constant KEEPER_ROLE = keccak256("KEEPER");
    uint256 internal constant BPS = 10_000;

    /// @notice Upper bound on simultaneously active keys (bounds the kill / remandate loops).
    uint256 public constant MAX_ACTIVE_KEYS = 16;
    /// @notice Band enforced once |exposure| >= this share (bps) of maxInventoryUsd (mandate.ts).
    uint256 public constant HEDGE_RATIO_MIN_EXPOSURE_BPS = 500;
    /// @notice Orderly books: hedge-adding legs need adapter.valuationAt within maxPriceAge * this.
    uint256 public constant ORDERLY_REPORT_AGE_FACTOR = 4;
    bytes32 public constant VENUE_UNIV3 = "UNIV3";
    bytes32 public constant VENUE_UNIV4 = "UNIV4";
    bytes32 public constant BAD_MANDATE = "BAD_MANDATE";

    // ------------------------------------------------------------------ storage

    IBookrunnerConfig public config;
    uint256 public bookId;
    /// @inheritdoc IMMMandate
    address public book;
    address public desk;
    address public vault;
    address public adapter;
    address public sponsor;
    bytes32 public underlying;
    uint8 public venue;
    uint128 public ifTargetUsd;
    uint128 public mmInventoryUsd;

    BRTypes.Mandate internal _mandate;

    /// @inheritdoc IMMMandate
    bool public killed;
    /// @notice Reduce-only wind-down flag set by the book on retire().
    bool public retiring;
    /// @inheritdoc IMMMandate
    bytes32 public killReason;

    mapping(address key => DeskKey) internal _keys;
    /// @notice BKRN currently locked on staking for `key` (0 once released).
    mapping(address key => uint256) public bondOf;
    /// @notice operator => key => consent to have the operator's stake bonded for that key.
    mapping(address operator => mapping(address key => bool)) public operatorConsent;
    EnumerableSet.AddressSet internal _keySet;

    // ------------------------------------------------------------------ errors / events (extensions)

    error Unauthorized(address caller);
    error ZeroAddress();
    error ComponentMismatch();
    error KeyAlreadyActive(address key);
    error TierBelowMandate(uint128 tierUsd, uint128 requiredUsd);
    error OperatorConsentMissing(address operator, address key);
    error TooManyKeys();
    error BondPending(address key);
    error NoBond(address key);
    error MandateRetiring();
    error BadAccount(uint8 account);
    error NotEngineBook();
    error NotCanonicalToken(bytes32 asset);
    error StaleVenueReport(uint64 valuationAt, uint256 maxAge);
    error InvalidMandate(bytes32 reason);

    event OperatorConsentSet(address indexed operator, address indexed key, bool allowed);
    event BondReleased(address indexed key, address indexed operator, uint256 amount);
    event BondReleaseFailed(address indexed key, address indexed operator, uint256 amount);
    event DeskSyncFailed(address indexed key);
    event RetiringSet(address indexed by);
    event ReduceOnlyRequestFailed();
    event BookKillNotifyFailed(bytes32 reason);

    // ------------------------------------------------------------------ init

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IMMMandate
    /// @dev Called by the factory after `book.initialize`; caches the charter terms and components.
    function initialize(address config_, uint256 bookId_, address book_) external override initializer {
        if (config_ == address(0) || book_ == address(0)) revert ZeroAddress();
        IBook b = IBook(book_);
        BRTypes.BookComponents memory c = b.components();
        if (c.mandate != address(this) || b.bookId() != bookId_) revert ComponentMismatch();
        if (c.desk == address(0) || c.vault == address(0) || c.adapter == address(0)) {
            revert ComponentMismatch();
        }
        BRTypes.Charter memory ch = b.getCharter();

        config = IBookrunnerConfig(config_);
        bookId = bookId_;
        book = book_;
        desk = c.desk;
        vault = c.vault;
        adapter = c.adapter;
        sponsor = ch.sponsor;
        underlying = ch.underlying;
        venue = ch.venue;
        ifTargetUsd = ch.ifTargetUsd;
        mmInventoryUsd = ch.mmInventoryUsd;
        _mandate = ch.mandate;
    }

    // ------------------------------------------------------------------ keys

    /// @notice Operator consent for {registerKey} to bond the caller's stake for `key` (single use).
    function consentKey(address key, bool allowed) external {
        operatorConsent[msg.sender][key] = allowed;
        emit OperatorConsentSet(msg.sender, key, allowed);
    }

    /// @inheritdoc IMMMandate
    /// @dev Sponsor only; not while killed. Requires `inventoryTierUsd >= maxInventoryUsd`, a future
    ///      `validUntil`, operator consent (unless operator == sponsor) and locks the tier bond, reverting
    ///      TierBondMissing if the lock fails or is short. Mirrors the key to the desk.
    function registerKey(address key, address operator, uint64 validUntil, uint128 inventoryTierUsd)
        external
        override
        nonReentrant
    {
        if (msg.sender != sponsor) revert Unauthorized(msg.sender);
        if (killed) revert MandateKilled();
        if (key == address(0) || operator == address(0)) revert ZeroAddress();
        if (validUntil <= block.timestamp) revert KeyExpired(key);
        uint128 required = _mandate.maxInventoryUsd;
        if (inventoryTierUsd < required) revert TierBelowMandate(inventoryTierUsd, required);
        if (_keys[key].active) revert KeyAlreadyActive(key);
        if (bondOf[key] != 0) revert BondPending(key);
        if (operator != msg.sender) {
            if (!operatorConsent[operator][key]) revert OperatorConsentMissing(operator, key);
            operatorConsent[operator][key] = false;
        }
        if (_keySet.length() >= MAX_ACTIVE_KEYS) revert TooManyKeys();

        uint256 bond = config.agentTierBond(inventoryTierUsd);
        _keys[key] = DeskKey({
            operator: operator, validUntil: validUntil, inventoryTierUsd: inventoryTierUsd, active: true
        });
        _keySet.add(key);
        bondOf[key] = bond;
        emit KeyRegistered(key, operator, validUntil, inventoryTierUsd);

        if (bond != 0) _lockBond(key, operator, bond);
        IDeskKeySync(desk).syncKey(key, validUntil);
    }

    /// @inheritdoc IMMMandate
    /// @dev Callers: the key itself, its operator, the sponsor, config.committee(), the RISK role, or
    ///      anyone once the key has expired. Effective immediately; the bond is released (best effort).
    function revokeKey(address key, bytes32 reason) external override nonReentrant {
        DeskKey storage k = _keys[key];
        if (!k.active) revert NotDeskKey(key);
        if (!_canRevoke(msg.sender, key, k)) revert Unauthorized(msg.sender);
        _revoke(key, reason);
    }

    /// @notice Anyone: retry releasing the bond of an inactive key whose release failed earlier.
    function releaseBond(address key) external nonReentrant {
        uint256 amount = bondOf[key];
        if (amount == 0 || _keys[key].active) revert NoBond(key);
        address op = _keys[key].operator;
        bondOf[key] = 0;
        uint256 released = IBkrnStaking(config.staking()).unlock(op, keyLockId(key));
        emit BondReleased(key, op, released);
    }

    /// @inheritdoc IMMMandate
    function isActiveKey(address key) public view override returns (bool) {
        DeskKey storage k = _keys[key];
        return !killed && k.active && block.timestamp <= k.validUntil;
    }

    /// @inheritdoc IMMMandate
    function getKey(address key) external view override returns (DeskKey memory) {
        return _keys[key];
    }

    /// @inheritdoc IMMMandate
    /// @dev Keys currently usable (registered, not revoked, not expired, mandate not killed).
    function activeKeys() external view override returns (address[] memory out) {
        uint256 n = _keySet.length();
        out = new address[](n);
        uint256 m;
        for (uint256 i; i < n; ++i) {
            address key = _keySet.at(i);
            if (isActiveKey(key)) out[m++] = key;
        }
        assembly ("memory-safe") {
            mstore(out, m)
        }
    }

    /// @notice Staking lock id of a key's tier bond: keccak256(abi.encode(bookId, key)).
    function keyLockId(address key) public view returns (bytes32) {
        return keccak256(abi.encode(bookId, key));
    }

    // ------------------------------------------------------------------ terms

    /// @inheritdoc IMMMandate
    function getMandate() external view override returns (BRTypes.Mandate memory) {
        return _mandate;
    }

    /// @notice Same BAD_MANDATE rules as MarketCharter.validate: returns 0 when valid.
    function validateMandate(BRTypes.Mandate calldata m) public pure returns (bytes32) {
        if (
            m.maxInventoryUsd == 0 || m.minQuoteWidthBps == 0 || m.hedgeRatioMinBps > m.hedgeRatioMaxBps
                || m.killAtDrawdownBps >= 0 || m.killAtDrawdownBps < -5000 || m.maxSkewBps <= 0
        ) return BAD_MANDATE;
        return bytes32(0);
    }

    // ------------------------------------------------------------------ validation (views)

    /// @inheritdoc IMMMandate
    /// @dev Pre-trade check against the desk's current inventory: hedge before = desk.hedgeNotionalUsd(),
    ///      after = before +/- p.notionalUsd. Spot legs (UNIV3/UNIV4) must be canonical Stock Tokens; sells
    ///      are capped by desk holdings (SpotShortNotAllowed) and buys by the registry float cap.
    function checkHedge(address key, HedgeParams calldata p, bytes32[] calldata allowProof)
        external
        view
        override
    {
        _requireActiveKey(key);
        if (_isSpotVenue(p.venue)) {
            address token = _spotToken(p.asset);
            uint256 held = IERC20(token).balanceOf(desk);
            if (p.buy) {
                uint256 cap = _registry().getToken(token).floatCapRaw;
                if (held + p.qtyRaw > cap) revert FloatCapExceeded(held + p.qtyRaw, cap);
            } else if (p.qtyRaw > held) {
                revert SpotShortNotAllowed();
            }
        }
        int256 before = IBookrunnerDesk(desk).hedgeNotionalUsd();
        int256 notional = SafeCast.toInt256(p.notionalUsd);
        int256 after_ = p.buy ? before + notional : before - notional;
        _checkLeg(p.asset, p.venue, p.leverage, allowProof, before, after_);
    }

    /// @inheritdoc IMMMandateDesk
    /// @dev Called by the desk after the swap, with the hedge notionals it measured before/after and its
    ///      post-trade holdings; the whole action reverts if the executed leg violates the mandate.
    function checkHedgeExecuted(
        address key,
        HedgeParams calldata p,
        bytes32[] calldata allowProof,
        int256 hedgeBeforeUsd,
        int256 hedgeAfterUsd,
        uint256 holdingsAfterRaw
    ) external view override {
        _requireActiveKey(key);
        if (_isSpotVenue(p.venue)) {
            address token = _spotToken(p.asset);
            if (p.buy) {
                uint256 cap = _registry().getToken(token).floatCapRaw;
                if (holdingsAfterRaw > cap) revert FloatCapExceeded(holdingsAfterRaw, cap);
            }
        }
        _checkLeg(p.asset, p.venue, p.leverage, allowProof, hedgeBeforeUsd, hedgeAfterUsd);
    }

    /// @inheritdoc IMMMandate
    /// @dev toVenue: active key, not retiring, not off-hours (if noNewRiskOffHours), IF/MM capacity.
    ///      Recall: an active key, the RISK or KEEPER role, or the book.
    function checkInventoryMove(address key, bool toVenue, uint8 account, uint256 amountUsd)
        external
        view
        override
    {
        if (account != BRTypes.ACCOUNT_IF && account != BRTypes.ACCOUNT_MM) revert BadAccount(account);
        if (!toVenue) {
            if (
                isActiveKey(key) || key == book || config.hasRole(RISK_ROLE, key)
                    || config.hasRole(KEEPER_ROLE, key)
            ) return;
            if (killed) revert MandateKilled();
            revert NotDeskKey(key);
        }
        _requireActiveKey(key);
        if (retiring) revert MandateRetiring();
        if (_mandate.noNewRiskOffHours && offHours()) revert OffHoursNewRisk();
        IVenueAdapter a = IVenueAdapter(adapter);
        if (account == BRTypes.ACCOUNT_IF) {
            uint256 attempted = a.insuranceEquityUsd() + amountUsd;
            if (attempted > ifTargetUsd) revert InventoryLimit(attempted, ifTargetUsd);
        } else {
            int256 me = a.marginEquityUsd();
            uint256 attempted = (me > 0 ? uint256(me) : 0) + amountUsd;
            if (attempted > mmInventoryUsd) revert InventoryLimit(attempted, mmInventoryUsd);
        }
    }

    /// @inheritdoc IMMMandate
    /// @dev Engine books only. spread >= minQuoteWidthBps, |skew| <= maxSkewBps, maxNetExposure <=
    ///      maxInventoryUsd. Reduce-only regimes (off-hours with noNewRiskOffHours, or retiring) further
    ///      forbid narrowing the live engine spread or raising its max net exposure.
    function checkQuote(address key, uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd)
        external
        view
        override
    {
        _requireActiveKey(key);
        if (venue != BRTypes.VENUE_POOL_ENGINE) revert NotEngineBook();
        BRTypes.Mandate storage m = _mandate;
        if (spreadBps < m.minQuoteWidthBps) revert QuoteWidthTooNarrow(spreadBps, m.minQuoteWidthBps);
        if (SafeCast.toInt256(_absInt(int256(skewBps))) > int256(m.maxSkewBps)) {
            revert SkewTooWide(skewBps, m.maxSkewBps);
        }
        if (maxNetExposureUsd > m.maxInventoryUsd) {
            revert InventoryLimit(maxNetExposureUsd, m.maxInventoryUsd);
        }
        bool offHoursReduceOnly = m.noNewRiskOffHours && offHours();
        if (retiring || offHoursReduceOnly) {
            (bool ok, uint16 curSpread, uint128 curMaxNet) = _engineQuote();
            if (!ok || spreadBps < curSpread || maxNetExposureUsd > curMaxNet) {
                if (retiring) revert MandateRetiring();
                revert OffHoursNewRisk();
            }
        }
    }

    /// @inheritdoc IMMMandateDesk
    function checkFundDesk(address key, uint256 amountUsd) external view override {
        _requireActiveKey(key);
        if (retiring) revert MandateRetiring();
        BRTypes.Mandate storage m = _mandate;
        if (m.noNewRiskOffHours && offHours()) revert OffHoursNewRisk();
        uint256 attempted = IBookrunnerDesk(desk).valueUsd() + amountUsd;
        uint256 cap = uint256(m.maxInventoryUsd) * m.hedgeRatioMaxBps / BPS;
        if (attempted > cap) revert InventoryLimit(attempted, cap);
    }

    /// @inheritdoc IMMMandate
    /// @dev Oracle `held`, never published, stale beyond config.maxPriceAge(), or an unresolvable price
    ///      id all count as off-hours (fail-safe).
    function offHours() public view override returns (bool) {
        bytes32 pid;
        try _registry().priceIdOf(underlying) returns (bytes32 p) {
            pid = p;
        } catch {
            return true;
        }
        try IAttestedOracle(config.oracle()).latest(pid) returns (IAttestedOracle.PriceData memory d) {
            if (d.held || d.publishedAt == 0) return true;
            return block.timestamp > uint256(d.publishedAt) + config.maxPriceAge();
        } catch {
            return true;
        }
    }

    /// @inheritdoc IMMMandate
    function hedgeRatioBps() external view override returns (uint256) {
        int256 exposure = IVenueAdapter(adapter).netExposureUsd();
        int256 hedge = IBookrunnerDesk(desk).hedgeNotionalUsd();
        (bool enforced, uint256 r) = _ratio(exposure, hedge, _mandate.maxInventoryUsd);
        return enforced ? r : type(uint256).max;
    }

    /// @inheritdoc IMMMandate
    function deskHedgeNotionalUsd() external view override returns (int256) {
        return IBookrunnerDesk(desk).hedgeNotionalUsd();
    }

    // ------------------------------------------------------------------ kill / retire / re-mandate

    /// @inheritdoc IMMMandate
    function kill(bytes32 reason) external override nonReentrant {
        if (msg.sender != book && !config.hasRole(RISK_ROLE, msg.sender)) revert Unauthorized(msg.sender);
        if (killed) revert MandateKilled();
        killed = true;
        killReason = reason;
        emit Kill(reason, msg.sender);
        _revokeAll(reason);
        if (venue == BRTypes.VENUE_POOL_ENGINE) _requestReduceOnly();
        try IBook(book).onKill(reason) {}
        catch {
            emit BookKillNotifyFailed(reason);
        }
    }

    /// @notice Book only (retire()): reduce-only wind-down without kill. Idempotent.
    function setRetiring() external nonReentrant {
        if (msg.sender != book) revert Unauthorized(msg.sender);
        if (retiring) return;
        retiring = true;
        emit RetiringSet(msg.sender);
        if (venue == BRTypes.VENUE_POOL_ENGINE) _requestReduceOnly();
    }

    /// @inheritdoc IMMMandate
    /// @dev config.committee() only. Terms must pass {validateMandate}. Clears the kill and revokes any
    ///      remaining keys (they must be re-registered against the new terms).
    function remandate(BRTypes.Mandate calldata m) external override nonReentrant {
        if (msg.sender != config.committee()) revert Unauthorized(msg.sender);
        bytes32 bad = validateMandate(m);
        if (bad != bytes32(0)) revert InvalidMandate(bad);
        _mandate = m;
        killed = false;
        killReason = bytes32(0);
        _revokeAll("REMANDATE");
        emit Remandated(keccak256(abi.encode(m)));
    }

    // ------------------------------------------------------------------ internals: keys

    function _canRevoke(address caller, address key, DeskKey storage k) internal view returns (bool) {
        if (caller == key || caller == k.operator || caller == sponsor) return true;
        if (block.timestamp > k.validUntil) return true;
        if (caller == config.committee()) return true;
        return config.hasRole(RISK_ROLE, caller);
    }

    function _revoke(address key, bytes32 reason) internal {
        _keys[key].active = false;
        _keySet.remove(key);
        emit KeyRevoked(key, msg.sender, reason);
        try IDeskKeySync(desk).syncKey(key, 0) {}
        catch {
            emit DeskSyncFailed(key);
        }
        _releaseBond(key);
    }

    /// @dev Bounded by MAX_ACTIVE_KEYS. Iterates from the end so removals do not skip entries.
    function _revokeAll(bytes32 reason) internal {
        for (uint256 n = _keySet.length(); n > 0; --n) {
            _revoke(_keySet.at(n - 1), reason);
        }
    }

    function _lockBond(address key, address operator, uint256 bond) internal {
        IBkrnStaking st = IBkrnStaking(config.staking());
        bytes32 lockId = keyLockId(key);
        try st.lock(operator, lockId, bond) {}
        catch {
            revert TierBondMissing(operator, bond, st.lockOf(operator, lockId));
        }
        uint256 locked = st.lockOf(operator, lockId);
        if (locked < bond) revert TierBondMissing(operator, bond, locked);
    }

    /// @dev Best effort: a failing unlock never blocks revocation / kill; {releaseBond} retries.
    function _releaseBond(address key) internal {
        uint256 amount = bondOf[key];
        if (amount == 0) return;
        address op = _keys[key].operator;
        bondOf[key] = 0;
        try IBkrnStaking(config.staking()).unlock(op, keyLockId(key)) returns (uint256 released) {
            emit BondReleased(key, op, released);
        } catch {
            bondOf[key] = amount;
            emit BondReleaseFailed(key, op, amount);
        }
    }

    function _requestReduceOnly() internal {
        try IPoolEngineAdapter(adapter).setReduceOnly(true) {}
        catch {
            emit ReduceOnlyRequestFailed();
        }
    }

    function _requireActiveKey(address key) internal view {
        if (killed) revert MandateKilled();
        DeskKey storage k = _keys[key];
        if (!k.active) revert NotDeskKey(key);
        if (block.timestamp > k.validUntil) revert KeyExpired(key);
    }

    // ------------------------------------------------------------------ internals: hedge math

    /// @dev Shared rule set of checkHedge / checkHedgeExecuted. Mirrors checkHedgeLeg (mandate.ts):
    ///      leverage -> off-hours -> band (in band OR strictly closer), plus the on-chain-only rules
    ///      (allow-list proof, retiring, Orderly report staleness for hedge-adding legs).
    function _checkLeg(
        bytes32 asset,
        bytes32 hedgeVenue,
        uint16 leverage,
        bytes32[] calldata proof,
        int256 before,
        int256 after_
    ) internal view {
        BRTypes.Mandate storage m = _mandate;
        if (leverage > m.maxHedgeLeverage) revert HedgeLeverageTooHigh(leverage, m.maxHedgeLeverage);
        if (!MerkleProof.verifyCalldata(proof, m.hedgeAllowRoot, allowLeaf(asset, hedgeVenue))) {
            revert HedgeNotAllowed(asset, hedgeVenue);
        }
        bool addsHedge = _absInt(after_) > _absInt(before);
        if (retiring && addsHedge) revert MandateRetiring();

        int256 exposure = IVenueAdapter(adapter).netExposureUsd();
        if (m.noNewRiskOffHours && offHours()) {
            if (_absInt(exposure + after_) > _absInt(exposure + before)) revert OffHoursNewRisk();
        }
        if (addsHedge && venue == BRTypes.VENUE_ORDERLY) {
            uint64 at = IVenueAdapter(adapter).valuationAt();
            uint256 maxAge = uint256(config.maxPriceAge()) * ORDERLY_REPORT_AGE_FACTOR;
            if (block.timestamp > uint256(at) + maxAge) revert StaleVenueReport(at, maxAge);
        }

        uint256 lo = m.hedgeRatioMinBps;
        uint256 hi = m.hedgeRatioMaxBps;
        (bool enforced, uint256 rAfter) = _ratio(exposure, after_, m.maxInventoryUsd);
        if (!enforced || (rAfter >= lo && rAfter <= hi)) return;
        (, uint256 rBefore) = _ratio(exposure, before, m.maxInventoryUsd);
        if (_dist(rAfter, lo, hi) < _dist(rBefore, lo, hi)) return;
        revert HedgeRatioOutOfBand(rAfter, lo, hi);
    }

    /// @notice StandardMerkleTree leaf of (bytes32 asset, bytes32 venue):
    ///         keccak256(bytes.concat(keccak256(abi.encode(asset, venue)))).
    function allowLeaf(bytes32 asset, bytes32 hedgeVenue) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(asset, hedgeVenue))));
    }

    /// @dev mandate.ts hedgeRatioBps: (false, 0) mirrors `null` (|exposure| below 5% of maxInventory).
    ///      |exposure| == 0 is also treated as not enforced (TS would divide by zero; only reachable
    ///      with maxInventoryUsd == 0, which validateMandate rejects).
    function _ratio(int256 exposure, int256 hedge, uint256 maxInventory)
        internal
        pure
        returns (bool enforced, uint256 ratioBps)
    {
        uint256 absExp = _absInt(exposure);
        if (absExp == 0 || absExp * BPS < maxInventory * HEDGE_RATIO_MIN_EXPOSURE_BPS) return (false, 0);
        int256 offset = exposure > 0 ? -hedge : hedge;
        uint256 effective = offset > 0 ? uint256(offset) : 0;
        return (true, effective * BPS / absExp);
    }

    function _dist(uint256 r, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (r < lo) return lo - r;
        if (r > hi) return r - hi;
        return 0;
    }

    function _absInt(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-(x + 1)) + 1;
    }

    function _isSpotVenue(bytes32 v) internal pure returns (bool) {
        return v == VENUE_UNIV3 || v == VENUE_UNIV4;
    }

    function _spotToken(bytes32 asset) internal view returns (address token) {
        if (uint256(asset) >> 160 != 0) revert NotCanonicalToken(asset);
        token = address(uint160(uint256(asset)));
        if (!_registry().isCanonical(token)) revert NotCanonicalToken(asset);
    }

    function _registry() internal view returns (IStockTokenRegistry) {
        return IStockTokenRegistry(config.stockRegistry());
    }

    /// @dev Live engine quote (spread from MarketState, cap from MarketConfig). ok=false if unreadable.
    ///      VERIFY (A-engine): PoolEngine.setQuote persists maxNetExposureUsd in MarketConfig.
    function _engineQuote() internal view returns (bool ok, uint16 spreadBps, uint128 maxNetExposureUsd) {
        IPoolEngine eng = IPoolEngine(config.poolEngine());
        uint256 mid;
        try IPoolEngineAdapter(adapter).marketId() returns (uint256 id) {
            mid = id;
        } catch {
            return (false, 0, 0);
        }
        try eng.state(mid) returns (IPoolEngine.MarketState memory s) {
            spreadBps = s.spreadBps;
        } catch {
            return (false, 0, 0);
        }
        try eng.config(mid) returns (IPoolEngine.MarketConfig memory c) {
            maxNetExposureUsd = c.maxNetExposureUsd;
        } catch {
            return (false, 0, 0);
        }
        ok = true;
    }
}
