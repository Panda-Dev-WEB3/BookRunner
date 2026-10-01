// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {BRTypes} from "./interfaces/BRTypes.sol";
import {IBookFactory} from "./interfaces/IBookFactory.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";
import {IBook} from "./interfaces/IBook.sol";
import {ITranche} from "./interfaces/ITranche.sol";
import {IUnderwritingVault} from "./interfaces/IUnderwritingVault.sol";
import {IMMMandate} from "./interfaces/IMMMandate.sol";
import {IRevenueRouter} from "./interfaces/IRevenueRouter.sol";
import {IBookrunnerDesk} from "./interfaces/IBookrunnerDesk.sol";
import {IVenueAdapter} from "./interfaces/IVenueAdapter.sol";

/// @dev BkrnStaking extension (A-core): `setLocker` is callable by the admin or the factory.
interface ILockerAdmin {
    function setLocker(address locker, bool allowed) external;
}

/// @title BookProxy — ERC1967 proxy for the UUPS Book and venue adapters.
/// @notice OZ 5.7's ERC1967Proxy rejects empty init data by default. The factory deploys this proxy
///         with no init data and initializes it in the SAME transaction (the book's initializer needs
///         the addresses of every component, and the adapter must be initialized last), so leaving it
///         momentarily uninitialized is safe: no other party can call it in between.
contract BookProxy is ERC1967Proxy {
    constructor(address implementation) ERC1967Proxy(implementation, "") {}

    function _unsafeAllowUninitialized() internal pure override returns (bool) {
        return true;
    }
}

/// @title BookFactory — deploys and wires one book's components per approved charter.
/// @notice Book + venue adapter: BookProxy (ERC1967) -> UUPS implementation (upgrades via timelock in
///         the implementations). Senior + Junior tranches, vault, mandate, router, desk: EIP-1167
///         clones. All deployments use CREATE2 with salt keccak256(bookId, slot) so addresses are
///         predictable (`predictComponents`). Initialization order: book -> senior -> junior -> vault
///         -> mandate -> router -> desk -> (mandate registered as staking locker) -> adapter (last; it
///         reads the charter from the book). Non-upgradeable.
contract BookFactory is IBookFactory, ReentrancyGuardTransient {
    // ---- implementation kinds ----
    bytes32 public constant BOOK = "BOOK";
    bytes32 public constant TRANCHE = "TRANCHE";
    bytes32 public constant VAULT = "VAULT";
    bytes32 public constant MANDATE = "MANDATE";
    bytes32 public constant ROUTER = "ROUTER";
    bytes32 public constant DESK = "DESK";
    bytes32 public constant ORDERLY_ADAPTER = "ORDERLY_ADAPTER";
    bytes32 public constant ENGINE_ADAPTER = "ENGINE_ADAPTER";

    // ---- CREATE2 salt slots (two tranches share one implementation) ----
    bytes32 private constant SLOT_SENIOR = "SENIOR";
    bytes32 private constant SLOT_JUNIOR = "JUNIOR";

    /// @notice Protocol registry (addresses, params, roles).
    IBookrunnerConfig public immutable config;

    mapping(bytes32 kind => address) private _impl;
    mapping(uint256 bookId => BRTypes.BookComponents) private _components;
    mapping(address book => uint256) private _bookIdOf;
    mapping(address component => uint256) private _componentBookId;
    uint256[] private _bookIds;

    error ZeroAddress();
    error NotTimelock();
    error NotCharter();
    error NewBooksPaused();
    error UnknownKind(bytes32 kind);
    error NotAContract(address impl);
    error LengthMismatch();
    error ImplementationNotSet(bytes32 kind);
    error BookExists(uint256 bookId);
    error BadBookId();
    error BadVenue(uint8 venue);

    /// @param config_ BookrunnerConfig address. The factory must be registered as `config.factory()`
    ///        and authorised on BkrnStaking to call `setLocker` (mandate clones become lockers).
    constructor(address config_) {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
    }

    // ------------------------------------------------------------------------------------------
    // Implementations (timelock)
    // ------------------------------------------------------------------------------------------

    /// @notice Timelock: sets the implementation used for future books of `kind`.
    /// @dev Existing books are unaffected (clones are immutable; proxies upgrade via their own UUPS path).
    /// @param kind One of BOOK, TRANCHE, VAULT, MANDATE, ROUTER, DESK, ORDERLY_ADAPTER, ENGINE_ADAPTER.
    /// @param impl Implementation contract (must have code).
    function setImplementation(bytes32 kind, address impl) external {
        if (msg.sender != config.timelock()) revert NotTimelock();
        _setImplementation(kind, impl);
    }

    /// @notice Timelock: batch form of setImplementation.
    /// @param kinds Implementation kinds.
    /// @param impls Implementation addresses, same length as `kinds`.
    function setImplementations(bytes32[] calldata kinds, address[] calldata impls) external {
        if (msg.sender != config.timelock()) revert NotTimelock();
        if (kinds.length != impls.length) revert LengthMismatch();
        for (uint256 i; i < kinds.length; ++i) {
            _setImplementation(kinds[i], impls[i]);
        }
    }

    /// @notice Current implementation of `kind` (0 if unset).
    function implementation(bytes32 kind) external view returns (address) {
        return _impl[kind];
    }

    // ------------------------------------------------------------------------------------------
    // Create
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IBookFactory
    /// @dev Only `config.charter()`, not while `newBooksPaused`, once per id (id != 0). The venue picks
    ///      the adapter implementation (Orderly or PoolEngine). Every component is registered in
    ///      isComponent before any initializer runs, so initializers may query the factory.
    function create(uint256 charterId, BRTypes.Charter calldata charter)
        external
        nonReentrant
        returns (BRTypes.BookComponents memory c)
    {
        IBookrunnerConfig cfg = config;
        if (msg.sender != cfg.charter()) revert NotCharter();
        if (cfg.newBooksPaused()) revert NewBooksPaused();
        if (charterId == 0) revert BadBookId();
        if (_components[charterId].book != address(0)) revert BookExists(charterId);

        bytes32 adapterKind = _adapterKind(charter.venue);
        c = _deploy(charterId, adapterKind);
        _register(charterId, c);
        _initialize(cfg, charterId, charter, c);

        emit BookCreated(charterId, c.book, c);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IBookFactory
    function componentsOf(uint256 bookId) external view returns (BRTypes.BookComponents memory) {
        return _components[bookId];
    }

    /// @inheritdoc IBookFactory
    function bookOf(uint256 bookId) external view returns (address) {
        return _components[bookId].book;
    }

    /// @inheritdoc IBookFactory
    function isBook(address book) external view returns (bool) {
        return _bookIdOf[book] != 0;
    }

    /// @inheritdoc IBookFactory
    /// @dev 0 for addresses that are not books (book ids start at 1).
    function bookIdOf(address book) external view returns (uint256) {
        return _bookIdOf[book];
    }

    /// @inheritdoc IBookFactory
    function isComponent(address a) external view returns (bool) {
        return _componentBookId[a] != 0;
    }

    /// @notice Book id a component (book, tranches, vault, mandate, router, desk, adapter) belongs to;
    ///         0 if `a` is not a component.
    function componentBookId(address a) external view returns (uint256) {
        return _componentBookId[a];
    }

    /// @inheritdoc IBookFactory
    /// @dev Full list for off-chain enumeration; use bookCount/bookIdAt for paginated reads.
    function bookIds() external view returns (uint256[] memory) {
        return _bookIds;
    }

    /// @notice Number of books created.
    function bookCount() external view returns (uint256) {
        return _bookIds.length;
    }

    /// @notice Book id at creation index `i`.
    function bookIdAt(uint256 i) external view returns (uint256) {
        return _bookIds[i];
    }

    /// @notice Addresses `create(bookId, charter)` would deploy with the current implementations for a
    ///         charter on `venue`. Reverts if an implementation is unset or the venue is unknown.
    function predictComponents(uint256 bookId, uint8 venue)
        external
        view
        returns (BRTypes.BookComponents memory c)
    {
        bytes32 adapterKind = _adapterKind(venue);
        c.book = _predictProxy(_implOf(BOOK), _salt(bookId, BOOK));
        address tranche = _implOf(TRANCHE);
        c.senior = Clones.predictDeterministicAddress(tranche, _salt(bookId, SLOT_SENIOR));
        c.junior = Clones.predictDeterministicAddress(tranche, _salt(bookId, SLOT_JUNIOR));
        c.vault = Clones.predictDeterministicAddress(_implOf(VAULT), _salt(bookId, VAULT));
        c.mandate = Clones.predictDeterministicAddress(_implOf(MANDATE), _salt(bookId, MANDATE));
        c.router = Clones.predictDeterministicAddress(_implOf(ROUTER), _salt(bookId, ROUTER));
        c.desk = Clones.predictDeterministicAddress(_implOf(DESK), _salt(bookId, DESK));
        c.adapter = _predictProxy(_implOf(adapterKind), _salt(bookId, adapterKind));
    }

    // ------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------

    function _setImplementation(bytes32 kind, address impl) private {
        if (!_isKnownKind(kind)) revert UnknownKind(kind);
        if (impl.code.length == 0) revert NotAContract(impl);
        _impl[kind] = impl;
        emit ImplementationSet(kind, impl);
    }

    function _isKnownKind(bytes32 kind) private pure returns (bool) {
        return kind == BOOK || kind == TRANCHE || kind == VAULT || kind == MANDATE || kind == ROUTER
            || kind == DESK || kind == ORDERLY_ADAPTER || kind == ENGINE_ADAPTER;
    }

    function _adapterKind(uint8 venue) private pure returns (bytes32) {
        if (venue == BRTypes.VENUE_ORDERLY) return ORDERLY_ADAPTER;
        if (venue == BRTypes.VENUE_POOL_ENGINE) return ENGINE_ADAPTER;
        revert BadVenue(venue);
    }

    function _implOf(bytes32 kind) private view returns (address impl) {
        impl = _impl[kind];
        if (impl == address(0)) revert ImplementationNotSet(kind);
    }

    function _salt(uint256 bookId, bytes32 slot) private pure returns (bytes32) {
        return keccak256(abi.encode(bookId, slot));
    }

    function _predictProxy(address impl, bytes32 salt) private view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(BookProxy).creationCode, abi.encode(impl)));
        return Create2.computeAddress(salt, initCodeHash);
    }

    function _deploy(uint256 bookId, bytes32 adapterKind) private returns (BRTypes.BookComponents memory c) {
        c.book = address(new BookProxy{salt: _salt(bookId, BOOK)}(_implOf(BOOK)));
        address tranche = _implOf(TRANCHE);
        c.senior = Clones.cloneDeterministic(tranche, _salt(bookId, SLOT_SENIOR));
        c.junior = Clones.cloneDeterministic(tranche, _salt(bookId, SLOT_JUNIOR));
        c.vault = Clones.cloneDeterministic(_implOf(VAULT), _salt(bookId, VAULT));
        c.mandate = Clones.cloneDeterministic(_implOf(MANDATE), _salt(bookId, MANDATE));
        c.router = Clones.cloneDeterministic(_implOf(ROUTER), _salt(bookId, ROUTER));
        c.desk = Clones.cloneDeterministic(_implOf(DESK), _salt(bookId, DESK));
        c.adapter = address(new BookProxy{salt: _salt(bookId, adapterKind)}(_implOf(adapterKind)));
    }

    function _register(uint256 bookId, BRTypes.BookComponents memory c) private {
        _components[bookId] = c;
        _bookIdOf[c.book] = bookId;
        _bookIds.push(bookId);
        _componentBookId[c.book] = bookId;
        _componentBookId[c.senior] = bookId;
        _componentBookId[c.junior] = bookId;
        _componentBookId[c.vault] = bookId;
        _componentBookId[c.mandate] = bookId;
        _componentBookId[c.router] = bookId;
        _componentBookId[c.desk] = bookId;
        _componentBookId[c.adapter] = bookId;
    }

    function _initialize(
        IBookrunnerConfig cfg,
        uint256 bookId,
        BRTypes.Charter calldata charter,
        BRTypes.BookComponents memory c
    ) private {
        address cfgAddr = address(cfg);
        IBook(c.book).initialize(cfgAddr, bookId, charter, c);
        ITranche(c.senior).initialize(cfgAddr, bookId, c.book, BRTypes.SENIOR);
        ITranche(c.junior).initialize(cfgAddr, bookId, c.book, BRTypes.JUNIOR);
        IUnderwritingVault(c.vault).initialize(cfgAddr, bookId, c.book);
        IMMMandate(c.mandate).initialize(cfgAddr, bookId, c.book);
        IRevenueRouter(c.router).initialize(cfgAddr, bookId, c.book);
        IBookrunnerDesk(c.desk).initialize(cfgAddr, bookId, c.book);
        ILockerAdmin(cfg.staking()).setLocker(c.mandate, true);
        IVenueAdapter(c.adapter).initialize(cfgAddr, bookId, c.book);
    }
}
