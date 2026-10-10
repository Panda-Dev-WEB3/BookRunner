// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IStockTokenRegistry} from "./interfaces/IStockTokenRegistry.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IAttestedOracle} from "./interfaces/IAttestedOracle.sol";
import {IScaledUIAmount} from "./interfaces/external/IScaledUIAmount.sol";

/// @title StockTokenRegistry — canonical Stock Token registry + multiplier-aware valuer.
/// @notice Governance: `config.timelock()` or (devnet / launch) an `admin` set at construction, which
///         the timelock or the admin itself can remove with {renounceAdmin}. Valuation (ARCHITECTURE §2.7):
///             valueUsd = qtyRaw * multiplierWad * priceWad / (10**decimals * 1e18) / 1e12
///         computed as a single floor over the full product (identical to the nested floors), with the
///         multiplier applied EXACTLY once. Prices are per 1 share of the equity (WAD) from
///         `AttestedOracle.priceOf(priceId)`, which reverts when stale.
///         Multiplier source (mainnet: VERIFY T2/C2): either the stored `multiplierWad` (devnet, testnet
///         mocks) or, after `setMultiplierSource(token, true)`, the token's own ERC-8056 `uiMultiplier()`
///         (WAD, 1e18 = 1.0) read at valuation time. Robinhood's Chainlink feed already includes that
///         multiplier (token price = share price x uiMultiplier); the oracle service divides it out with the
///         same on-chain value before signing, so the product here is qty x feed price: applied once. In
///         live mode the stored value is the governance ANCHOR: a live value further than
///         `multiplierBandBps` from it (and from the optional pre-approved `nextMultiplierAnchor`, for a
///         scheduled split) reverts MultiplierOutOfBand. The valuation then fails closed like a stale price
///         (the risk flatten path tolerates it) until governance re-anchors with {setMultiplier}.
/// @dev Non-upgradeable. Tokens are never deleted: deactivating a token (`setActive(false)`) removes it
///      from the canonical set (no new hedges, charters) while existing inventory stays valuable.
contract StockTokenRegistry is IStockTokenRegistry {
    /// @notice Max components of a registered index (bounded loops in registration / views).
    uint256 public constant MAX_INDEX_COMPONENTS = 16;
    /// @notice Largest token decimals accepted (keeps 10**decimals * 1e30 far from overflow).
    uint8 public constant MAX_DECIMALS = 30;
    uint256 internal constant BPS = 10_000;
    /// @dev 1e18 (multiplier WAD) * 1e12 (WAD USD -> 6dp USD).
    uint256 internal constant SCALE = 1e30;
    /// @notice Default live-multiplier band around the anchor (5%: years of reinvested dividends).
    uint16 public constant DEFAULT_MULTIPLIER_BAND_BPS = 500;
    /// @notice Widest band governance may set (50%): a split must be re-anchored, never absorbed.
    uint16 public constant MAX_MULTIPLIER_BAND_BPS = 5000;

    IBookrunnerConfig public immutable config;
    /// @notice Optional non-timelock governor (devnet / launch ops). address(0) once renounced.
    address public admin;

    mapping(address token => StockToken) internal _tokens;
    address[] internal _tokenList;

    struct IndexData {
        bytes32 priceId;
        IndexComponent[] components;
    }

    mapping(bytes32 indexId => IndexData) internal _indexes;
    bytes32[] internal _indexList;

    /// @notice Token whose multiplier is read live from its ERC-8056 `uiMultiplier()`.
    mapping(address token => bool) public multiplierFromToken;
    /// @notice Pre-approved anchor for a scheduled corporate action (0 = none), accepted besides the stored one.
    mapping(address token => uint256) public nextMultiplierAnchor;
    /// @notice Max distance (bps) of a live multiplier from an anchor.
    uint16 public multiplierBandBps;

    error Unauthorized(address caller);
    error ZeroAddress();
    error BadPriceId();
    error BadMultiplier();
    error BadDecimals(uint8 decimals);
    error AlreadyRegistered(address token);
    error NotRegistered(address token);
    error NotCanonical(address token);
    error BadIndexId(bytes32 indexId);
    error BadComponents();
    error BadWeights(uint256 sumBps);
    error DuplicateComponent(address token);
    error UnknownUnderlying(bytes32 underlying);
    error MultiplierOutOfBand(address token, uint256 live, uint256 anchor);
    error BadBand(uint16 bandBps);

    event AdminSet(address indexed admin);
    event TokenActiveSet(address indexed token, bool active);

    modifier onlyGov() {
        if (msg.sender != config.timelock() && (msg.sender != admin || admin == address(0))) {
            revert Unauthorized(msg.sender);
        }
        _;
    }

    /// @param config_ BookrunnerConfig (timelock + oracle are read from it).
    /// @param admin_ Optional governor besides the timelock (devnet deployer); address(0) on mainnet.
    constructor(address config_, address admin_) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        admin = admin_;
        multiplierBandBps = DEFAULT_MULTIPLIER_BAND_BPS;
        emit AdminSet(admin_);
        emit MultiplierBandSet(DEFAULT_MULTIPLIER_BAND_BPS);
    }

    // ------------------------------------------------------------------ governance

    /// @notice Register a canonical Stock Token. `decimals` is read from the token.
    /// @param token Stock Token address.
    /// @param priceId Oracle key of the underlying equity (e.g. bytes32("NVDA")).
    /// @param multiplierWad Shares of equity per 1 whole token (WAD), > 0.
    /// @param floatCapRaw Max hedge inventory a desk may hold (raw units). 0 = no hedge buys allowed.
    function register(address token, bytes32 priceId, uint256 multiplierWad, uint256 floatCapRaw)
        external
        override
        onlyGov
    {
        if (token == address(0)) revert ZeroAddress();
        if (priceId == bytes32(0)) revert BadPriceId();
        if (multiplierWad == 0) revert BadMultiplier();
        if (_tokens[token].token != address(0)) revert AlreadyRegistered(token);
        uint8 dec = IERC20Metadata(token).decimals();
        if (dec > MAX_DECIMALS) revert BadDecimals(dec);

        _tokens[token] = StockToken({
            token: token,
            priceId: priceId,
            multiplierWad: multiplierWad,
            decimals: dec,
            active: true,
            floatCapRaw: floatCapRaw
        });
        _tokenList.push(token);
        emit TokenRegistered(token, priceId, multiplierWad);
        emit FloatCapSet(token, floatCapRaw);
    }

    /// @notice Corporate action: update shares-of-equity per whole token (WAD, > 0). In live mode
    ///         ({multiplierFromToken}) this is the anchor the live `uiMultiplier()` must stay near.
    function setMultiplier(address token, uint256 multiplierWad) external override onlyGov {
        StockToken storage t = _registered(token);
        if (multiplierWad == 0) revert BadMultiplier();
        t.multiplierWad = multiplierWad;
        emit MultiplierSet(token, multiplierWad);
    }

    /// @notice Multiplier source: true = the token's live ERC-8056 `uiMultiplier()` (mainnet Stock Tokens),
    ///         false = the stored value. Enabling reads the token once: it must implement `uiMultiplier()`
    ///         and be within the band of the anchor (else MultiplierOutOfBand / a revert).
    function setMultiplierSource(address token, bool fromToken) external onlyGov {
        StockToken storage t = _registered(token);
        multiplierFromToken[token] = fromToken;
        if (fromToken) _multiplier(t);
        emit MultiplierSourceSet(token, fromToken);
    }

    /// @notice Pre-approve the anchor of a scheduled corporate action (e.g. a split staged on the token with
    ///         `updateMultiplier(m, effectiveAt)`), so live valuation does not fail closed between the
    ///         activation and the governance re-anchor. 0 clears it.
    function setNextMultiplierAnchor(address token, uint256 multiplierWad) external onlyGov {
        _registered(token);
        nextMultiplierAnchor[token] = multiplierWad;
        emit NextMultiplierAnchorSet(token, multiplierWad);
    }

    /// @notice Band (bps, 1..MAX_MULTIPLIER_BAND_BPS) a live multiplier may drift from its anchor.
    function setMultiplierBand(uint16 bandBps) external onlyGov {
        if (bandBps == 0 || bandBps > MAX_MULTIPLIER_BAND_BPS) revert BadBand(bandBps);
        multiplierBandBps = bandBps;
        emit MultiplierBandSet(bandBps);
    }

    /// @notice Update the float cap (raw units) bounding any desk's inventory of `token`.
    function setFloatCap(address token, uint256 floatCapRaw) external override onlyGov {
        StockToken storage t = _registered(token);
        t.floatCapRaw = floatCapRaw;
        emit FloatCapSet(token, floatCapRaw);
    }

    /// @notice (De)activate a registered token. Inactive tokens are not canonical (no new hedge buys,
    ///         no new charters) but remain valuable so existing inventory can be marked and flattened.
    function setActive(address token, bool active) external onlyGov {
        StockToken storage t = _registered(token);
        t.active = active;
        emit TokenActiveSet(token, active);
    }

    /// @notice Register (or re-weight) an index of canonical Stock Tokens.
    /// @param indexId Charter underlying of the index; upper 12 bytes must be non-zero
    ///        (e.g. keccak256("BKRN.INDEX.RHX5")) so it can never collide with a token address.
    /// @param priceId Oracle key of the weighted index level published by the oracle service.
    /// @param components Canonical tokens with weights summing to exactly 1e4 bps (1..16 entries).
    function registerIndex(bytes32 indexId, bytes32 priceId, IndexComponent[] calldata components)
        external
        override
        onlyGov
    {
        if (uint256(indexId) >> 160 == 0) revert BadIndexId(indexId);
        if (priceId == bytes32(0)) revert BadPriceId();
        uint256 n = components.length;
        if (n == 0 || n > MAX_INDEX_COMPONENTS) revert BadComponents();

        uint256 sum;
        for (uint256 i; i < n; ++i) {
            address tk = components[i].token;
            if (!_tokens[tk].active) revert NotCanonical(tk);
            if (components[i].weightBps == 0) revert BadWeights(0);
            for (uint256 j; j < i; ++j) {
                if (components[j].token == tk) revert DuplicateComponent(tk);
            }
            sum += components[i].weightBps;
        }
        if (sum != BPS) revert BadWeights(sum);

        IndexData storage d = _indexes[indexId];
        if (d.priceId == bytes32(0)) _indexList.push(indexId);
        d.priceId = priceId;
        delete d.components;
        for (uint256 i; i < n; ++i) {
            d.components.push(components[i]);
        }
        emit IndexRegistered(indexId, priceId, n);
    }

    /// @notice Timelock: set / replace the non-timelock admin (address(0) disables it).
    function setAdmin(address newAdmin) external {
        if (msg.sender != config.timelock()) revert Unauthorized(msg.sender);
        admin = newAdmin;
        emit AdminSet(newAdmin);
    }

    /// @notice Admin (or timelock) removes the non-timelock admin permanently (until the timelock sets one).
    function renounceAdmin() external onlyGov {
        admin = address(0);
        emit AdminSet(address(0));
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IStockTokenRegistry
    function isCanonical(address token) external view override returns (bool) {
        return _tokens[token].active;
    }

    /// @inheritdoc IStockTokenRegistry
    /// @dev `multiplierWad` is the EFFECTIVE multiplier ({multiplierOf}): in live mode the token's
    ///      `uiMultiplier()` (reverts MultiplierOutOfBand outside the band), so every off-chain mirror of the
    ///      valuation reads the value the contract applies. Unregistered tokens return a zero struct.
    function getToken(address token) external view override returns (StockToken memory s) {
        s = _tokens[token];
        if (s.token != address(0)) s.multiplierWad = _multiplier(_tokens[token]);
    }

    /// @inheritdoc IStockTokenRegistry
    function multiplierOf(address token) external view override returns (uint256) {
        return _multiplier(_registered(token));
    }

    /// @inheritdoc IStockTokenRegistry
    function getIndex(bytes32 indexId)
        external
        view
        override
        returns (bytes32 priceId, IndexComponent[] memory)
    {
        IndexData storage d = _indexes[indexId];
        return (d.priceId, d.components);
    }

    /// @inheritdoc IStockTokenRegistry
    function isIndex(bytes32 underlying) public view override returns (bool) {
        return uint256(underlying) >> 160 != 0 && _indexes[underlying].priceId != bytes32(0);
    }

    /// @inheritdoc IStockTokenRegistry
    /// @dev Reverts UnknownUnderlying for unregistered tokens / indexes.
    function priceIdOf(bytes32 underlying) external view override returns (bytes32) {
        if (uint256(underlying) >> 160 == 0) {
            bytes32 pid = _tokens[address(uint160(uint256(underlying)))].priceId;
            if (pid == bytes32(0)) revert UnknownUnderlying(underlying);
            return pid;
        }
        bytes32 ipid = _indexes[underlying].priceId;
        if (ipid == bytes32(0)) revert UnknownUnderlying(underlying);
        return ipid;
    }

    /// @inheritdoc IStockTokenRegistry
    /// @dev Uses `AttestedOracle.priceOf` (reverts StalePrice beyond config.maxPriceAge()). A held
    ///      (off-hours) price is still a valid valuation price.
    function valueUsd(address token, uint256 qtyRaw) external view override returns (uint256) {
        StockToken storage t = _registered(token);
        if (qtyRaw == 0) return 0;
        (uint256 priceWad,) = IAttestedOracle(config.oracle()).priceOf(t.priceId);
        return _value(t, qtyRaw, priceWad);
    }

    /// @inheritdoc IStockTokenRegistry
    function valueUsdAt(address token, uint256 qtyRaw, uint256 priceWad)
        external
        view
        override
        returns (uint256)
    {
        return _value(_registered(token), qtyRaw, priceWad);
    }

    /// @notice All registered tokens (active and inactive), registration order.
    function tokens() external view returns (address[] memory) {
        return _tokenList;
    }

    /// @notice All registered index ids, registration order.
    function indexes() external view returns (bytes32[] memory) {
        return _indexList;
    }

    // ------------------------------------------------------------------ internals

    function _registered(address token) internal view returns (StockToken storage t) {
        t = _tokens[token];
        if (t.token == address(0)) revert NotRegistered(token);
    }

    /// @dev floor(qty * mult * price / (10**dec * 1e18 * 1e12)). The multiplier appears exactly once.
    ///      qty * mult is checked (reverts only for absurd quantities); the product with the price is
    ///      taken at 512-bit precision by Math.mulDiv.
    function _value(StockToken storage t, uint256 qtyRaw, uint256 priceWad) internal view returns (uint256) {
        if (qtyRaw == 0 || priceWad == 0) return 0;
        return Math.mulDiv(qtyRaw * _multiplier(t), priceWad, (10 ** uint256(t.decimals)) * SCALE);
    }

    /// @dev Stored multiplier, or the token's live ERC-8056 `uiMultiplier()` (WAD) within the band of the
    ///      stored anchor or of the pre-approved next anchor.
    function _multiplier(StockToken storage t) internal view returns (uint256) {
        address token = t.token;
        if (!multiplierFromToken[token]) return t.multiplierWad;
        uint256 live = IScaledUIAmount(token).uiMultiplier();
        if (live == 0) revert BadMultiplier();
        uint256 anchor = t.multiplierWad;
        if (_inBand(live, anchor)) return live;
        uint256 next = nextMultiplierAnchor[token];
        if (next != 0 && _inBand(live, next)) return live;
        revert MultiplierOutOfBand(token, live, anchor);
    }

    function _inBand(uint256 live, uint256 anchor) internal view returns (bool) {
        uint256 diff = live > anchor ? live - anchor : anchor - live;
        return diff * BPS <= anchor * multiplierBandBps;
    }
}
