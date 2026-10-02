// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAttestedOracle} from "./interfaces/IAttestedOracle.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";

/// @title AttestedOracle — the protocol's single on-chain price surface.
/// @notice Prices are produced off-chain by the oracle service (multi-source median, TEE-attested — the
///         attestation verification flow is VERIFY) and signed as EIP-712 `Price` structs by a registered
///         signer. Relaying is restricted to an active signer, the KEEPER role or the timelock: a signed
///         update lands only when the oracle (or a keeper) sends it, so a leaked / observed signature can
///         never be pushed by a trader inside its own transaction (trade -> push -> close sandwich of the
///         in-house pool). A `held` price is the feed holding a closed session's last price (off-hours):
///         consumers go reduce-only but keep liquidating at the held price.
/// @dev    Non-upgradeable (ARCHITECTURE §2.0). EIP-712 domain ("Bookrunner AttestedOracle", "1"); the type
///         string MUST stay byte-identical to `packages/shared/src/eip712.ts` (`priceTypes`).
contract AttestedOracle is IAttestedOracle, EIP712 {
    /// @inheritdoc IAttestedOracle
    bytes32 public constant PRICE_TYPEHASH = keccak256(
        "Price(bytes32 underlying,uint256 priceWad,uint64 publishedAt,bool held,uint32 sourceCount,bytes32 sourcesHash)"
    );

    /// @notice Maximum tolerated signer clock lead over the chain (seconds).
    uint64 public constant MAX_FUTURE_DRIFT = 5;
    /// @notice Default minimum number of distinct sources for a non-held price.
    uint32 public constant DEFAULT_MIN_SOURCES = 3;
    /// @dev BookrunnerConfig KEEPER role id (relayers besides the signers and the timelock).
    bytes32 internal constant KEEPER_ROLE = keccak256("KEEPER");

    /// @notice Protocol registry (timelock + maxPriceAge).
    IBookrunnerConfig public immutable config;

    /// @inheritdoc IAttestedOracle
    uint32 public minSources;

    /// @inheritdoc IAttestedOracle
    mapping(address signer => bool active) public isSigner;
    /// @notice Last attestation hash (TEE quote digest) registered for a signer. VERIFY: verification flow.
    mapping(address signer => bytes32 attestation) public attestationOf;

    mapping(bytes32 underlying => PriceData) internal _prices;

    error NotTimelock(address caller);
    error ZeroAddress();
    error ZeroPrice(bytes32 underlying);
    error FuturePrice(uint64 publishedAt, uint256 nowTs);
    error InsufficientSources(uint32 sourceCount, uint32 minSources);
    error LengthMismatch(uint256 updates, uint256 sigs);
    error BadMinSources(uint32 value);
    error NotRelayer(address caller);

    /// @notice Emitted by `pushMany` for an entry that was validly signed but not newer than stored.
    event PriceSkipped(bytes32 indexed underlying, uint64 storedPublishedAt, uint64 incomingPublishedAt);
    event MinSourcesSet(uint32 minSources);

    modifier onlyTimelock() {
        if (msg.sender != config.timelock()) revert NotTimelock(msg.sender);
        _;
    }

    modifier onlyRelayer() {
        if (!canRelay(msg.sender)) revert NotRelayer(msg.sender);
        _;
    }

    /// @param config_ BookrunnerConfig (timelock + maxPriceAge are read from it at call time).
    /// @param initialSigner Optional bootstrap signer (devnet oracle key); address(0) registers none.
    ///        Mainnet deployments pass address(0) and register TEE signers through the timelock.
    /// @param initialAttestation Attestation hash recorded for `initialSigner` (VERIFY flow; devnet 0).
    constructor(address config_, address initialSigner, bytes32 initialAttestation)
        EIP712("Bookrunner AttestedOracle", "1")
    {
        if (config_ == address(0)) revert ZeroAddress();
        config = IBookrunnerConfig(config_);
        minSources = DEFAULT_MIN_SOURCES;
        emit MinSourcesSet(DEFAULT_MIN_SOURCES);
        if (initialSigner != address(0)) {
            isSigner[initialSigner] = true;
            attestationOf[initialSigner] = initialAttestation;
            emit SignerSet(initialSigner, true, initialAttestation);
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Relaying
    // ------------------------------------------------------------------------------------------------

    /// @inheritdoc IAttestedOracle
    function hashPrice(PriceUpdate calldata u) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PRICE_TYPEHASH,
                    u.underlying,
                    u.priceWad,
                    u.publishedAt,
                    u.held,
                    u.sourceCount,
                    u.sourcesHash
                )
            )
        );
    }

    /// @notice EIP-712 domain separator of this oracle (convenience for off-chain signers).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Whether `relayer` may push signed updates: an active signer, the KEEPER role or the timelock.
    function canRelay(address relayer) public view returns (bool) {
        return isSigner[relayer] || relayer == config.timelock() || config.hasRole(KEEPER_ROLE, relayer);
    }

    /// @inheritdoc IAttestedOracle
    /// @dev Only a relayer ({canRelay}, else NotRelayer). Reverts BadSigner (unsigned / unregistered),
    ///      NotNewer, FuturePrice, ZeroPrice, InsufficientSources.
    function push(PriceUpdate calldata u, bytes calldata sig) external onlyRelayer {
        address signer = _verify(u, sig);
        uint64 stored = _prices[u.underlying].publishedAt;
        if (u.publishedAt <= stored) revert NotNewer(stored, u.publishedAt);
        _store(u, signer);
    }

    /// @inheritdoc IAttestedOracle
    /// @dev Every entry must be correctly signed and well-formed (reverts otherwise, like `push`), but an
    ///      entry that is not newer than the stored price is skipped (PriceSkipped) instead of reverting, so
    ///      one raced/stale entry never fails a relayer's whole batch. Only a relayer ({canRelay}).
    function pushMany(PriceUpdate[] calldata us, bytes[] calldata sigs) external onlyRelayer {
        uint256 n = us.length;
        if (n != sigs.length) revert LengthMismatch(n, sigs.length);
        for (uint256 i; i < n; ++i) {
            PriceUpdate calldata u = us[i];
            address signer = _verify(u, sigs[i]);
            uint64 stored = _prices[u.underlying].publishedAt;
            if (u.publishedAt <= stored) {
                emit PriceSkipped(u.underlying, stored, u.publishedAt);
                continue;
            }
            _store(u, signer);
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------------------------------------

    /// @inheritdoc IAttestedOracle
    function latest(bytes32 underlying) external view returns (PriceData memory) {
        return _prices[underlying];
    }

    /// @inheritdoc IAttestedOracle
    function priceOf(bytes32 underlying) external view returns (uint256 priceWad, bool held) {
        PriceData memory d = _prices[underlying];
        if (_stale(d.publishedAt)) revert StalePrice(underlying, d.publishedAt);
        return (d.priceWad, d.held);
    }

    /// @inheritdoc IAttestedOracle
    /// @dev Never-published underlyings are stale.
    function isStale(bytes32 underlying) external view returns (bool) {
        return _stale(_prices[underlying].publishedAt);
    }

    // ------------------------------------------------------------------------------------------------
    // Admin (timelock)
    // ------------------------------------------------------------------------------------------------

    /// @inheritdoc IAttestedOracle
    function setSigner(address signer, bool active, bytes32 attestation) external onlyTimelock {
        if (signer == address(0)) revert ZeroAddress();
        isSigner[signer] = active;
        attestationOf[signer] = attestation;
        emit SignerSet(signer, active, attestation);
    }

    /// @notice Timelock: minimum distinct sources for a non-held price (held prices may carry fewer).
    function setMinSources(uint32 value) external onlyTimelock {
        if (value == 0) revert BadMinSources(value);
        minSources = value;
        emit MinSourcesSet(value);
    }

    // ------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------

    function _verify(PriceUpdate calldata u, bytes calldata sig) internal view returns (address signer) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashPrice(u), sig);
        if (err != ECDSA.RecoverError.NoError) recovered = address(0);
        if (recovered == address(0) || !isSigner[recovered]) revert BadSigner(recovered);
        if (u.priceWad == 0) revert ZeroPrice(u.underlying);
        if (u.publishedAt > block.timestamp + MAX_FUTURE_DRIFT) {
            revert FuturePrice(u.publishedAt, block.timestamp);
        }
        if (!u.held && u.sourceCount < minSources) revert InsufficientSources(u.sourceCount, minSources);
        return recovered;
    }

    function _store(PriceUpdate calldata u, address signer) internal {
        _prices[u.underlying] = PriceData({
            priceWad: u.priceWad, publishedAt: u.publishedAt, held: u.held, sourceCount: u.sourceCount
        });
        emit PricePushed(u.underlying, u.priceWad, u.publishedAt, u.held, u.sourceCount, signer);
    }

    function _stale(uint64 publishedAt) internal view returns (bool) {
        // publishedAt may lead block.timestamp by up to MAX_FUTURE_DRIFT: compare without subtraction.
        return publishedAt == 0 || uint256(publishedAt) + config.maxPriceAge() < block.timestamp;
    }
}
