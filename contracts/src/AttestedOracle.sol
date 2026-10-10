// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAttestedOracle} from "./interfaces/IAttestedOracle.sol";
import {IBookrunnerConfig} from "./interfaces/IBookrunnerConfig.sol";

/// @title AttestedOracle — the protocol's single on-chain price surface.
/// @notice Prices are produced off-chain by the oracle service (multi-source median, TEE-attested — the
///         attestation flow: {setAttestedSigner}, docs/RUNBOOK.md "Oracle signer attestation", VERIFY E1)
///         and signed as EIP-712 `Price` structs by a registered
///         signer. Pull oracle (docs/LOW_GAS.md §1): the transaction that needs a price carries the signed
///         bundle and the consumer (PoolEngine, BookrunnerDesk, MarkRegistry) calls {update} first — anyone
///         may relay through {update}, which never lands a print already stale on arrival (older than
///         maxPriceAge). The latency-arbitrage bound moved to the consumer: an engine trade adding risk only
///         accepts a price published within `maxTradePriceAge` (a trader cannot pick an old favourable print;
///         the spread covers the residual). The heartbeat relays {push} / {pushMany} stay
///         restricted to an active signer, the KEEPER role or the timelock (backwards compatible). A `held`
///         price is the feed holding a closed session's last price (off-hours): consumers go reduce-only but
///         keep liquidating at the held price.
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
    /// @notice Last attestation hash registered for a signer: {attestationDigest} for signers registered
    ///         through {setAttestedSigner}, the caller-supplied value for {setSigner} (devnet: 0).
    mapping(address signer => bytes32 attestation) public attestationOf;

    // ---- TEE attestation (VERIFY E1; platform-agnostic: SGX/TDX, SEV-SNP, Nitro, ...) ----------------
    /// @notice Tag of the 32 bytes the enclave must put at the start of its quote's report data, binding the
    ///         quote to one signer key of this oracle on this chain: see {reportDataOf}.
    bytes32 public constant REPORT_DATA_TYPEHASH =
        keccak256("BookrunnerOracleSigner(uint256 chainId,address oracle,address signer)");
    /// @notice Tag of the registered attestation digest: see {attestationDigest}.
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "SignerAttestation(uint256 chainId,address oracle,address signer,bytes32 platform,bytes32 measurement,bytes32 quoteHash)"
    );
    /// @notice Enclave build measurements (a digest of the platform's launch measurement: MRENCLAVE / MRTD+RTMRs
    ///         / SNP MEASUREMENT / Nitro PCR0-2) the timelock accepts for new signers.
    mapping(bytes32 measurement => bool) public measurementAllowed;
    /// @notice Measurement a signer was registered with ({setAttestedSigner}); 0 for {setSigner}.
    mapping(address signer => bytes32 measurement) public measurementOf;
    /// @notice Once set (one-way), signers can only be activated through {setAttestedSigner}.
    bool public attestationRequired;

    mapping(bytes32 underlying => PriceData) internal _prices;

    error NotTimelock(address caller);
    error ZeroAddress();
    error ZeroPrice(bytes32 underlying);
    error FuturePrice(uint64 publishedAt, uint256 nowTs);
    error InsufficientSources(uint32 sourceCount, uint32 minSources);
    error LengthMismatch(uint256 updates, uint256 sigs);
    error BadMinSources(uint32 value);
    error NotRelayer(address caller);
    error MeasurementNotAllowed(bytes32 measurement);
    error AttestationRequired();
    error BadAttestation();

    /// @notice Emitted by `pushMany` for an entry that was validly signed but not newer than stored.
    event PriceSkipped(bytes32 indexed underlying, uint64 storedPublishedAt, uint64 incomingPublishedAt);
    event MinSourcesSet(uint32 minSources);
    event MeasurementSet(bytes32 indexed measurement, bool allowed);
    event AttestationRequiredSet();
    event SignerAttested(
        address indexed signer, bytes32 indexed platform, bytes32 indexed measurement, bytes32 quoteHash, bytes32 attestation
    );

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
    function hashPrice(PriceUpdate calldata u) external view returns (bytes32) {
        return _hashPrice(u);
    }

    function _hashPrice(PriceUpdate memory u) internal view returns (bytes32) {
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
        PriceUpdate memory m = u;
        address signer = _verify(m, sig);
        uint64 stored = _prices[m.underlying].publishedAt;
        if (m.publishedAt <= stored) revert NotNewer(stored, m.publishedAt);
        _store(m, signer);
    }

    /// @inheritdoc IAttestedOracle
    /// @dev Every entry must be correctly signed and well-formed (reverts otherwise, like `push`), but an
    ///      entry that is not newer than the stored price is skipped (PriceSkipped) instead of reverting, so
    ///      one raced/stale entry never fails a relayer's whole batch. Only a relayer ({canRelay}).
    function pushMany(PriceUpdate[] calldata us, bytes[] calldata sigs) external onlyRelayer {
        uint256 n = us.length;
        if (n != sigs.length) revert LengthMismatch(n, sigs.length);
        for (uint256 i; i < n; ++i) {
            PriceUpdate memory u = us[i];
            address signer = _verify(u, sigs[i]);
            uint64 stored = _prices[u.underlying].publishedAt;
            if (u.publishedAt <= stored) {
                emit PriceSkipped(u.underlying, stored, u.publishedAt);
                continue;
            }
            _store(u, signer);
        }
    }

    /// @inheritdoc IAttestedOracle
    /// @dev Pull path (LOW_GAS.md §1), callable by anyone. `priceData = abi.encode(PriceUpdate[], bytes[])`;
    ///      empty `priceData` is a no-op. Skipped silently, without verification (neither can change state,
    ///      so the common case of several transactions carrying the same bundle costs no ecrecover and no
    ///      event): an entry that is not newer than the stored price, and an entry that is already stale on
    ///      arrival (publishedAt + config.maxPriceAge() < block.timestamp). The second rule closes the
    ///      lookback a permissionless relay would otherwise open on an idle market: reductions and
    ///      liquidations still run at whatever price is stored (stale included), so without it a trader or
    ///      a liquidator could land any old print newer than stored — e.g. the most favourable one since the
    ///      last landing — and trade on it. Every other entry is verified and stored, reverting exactly like
    ///      {push} (BadSigner, FuturePrice, ZeroPrice, InsufficientSources). Reverts LengthMismatch when the
    ///      arrays differ in length, and on malformed encoding.
    function update(bytes calldata priceData) external {
        if (priceData.length == 0) return;
        (PriceUpdate[] memory us, bytes[] memory sigs) = abi.decode(priceData, (PriceUpdate[], bytes[]));
        uint256 n = us.length;
        if (n != sigs.length) revert LengthMismatch(n, sigs.length);
        uint256 maxAge; // read once, only when an entry is newer than stored
        for (uint256 i; i < n; ++i) {
            PriceUpdate memory u = us[i];
            if (u.publishedAt <= _prices[u.underlying].publishedAt) continue;
            if (maxAge == 0) maxAge = config.maxPriceAge();
            if (uint256(u.publishedAt) + maxAge < block.timestamp) continue;
            _store(u, _verify(u, sigs[i]));
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
    /// @dev Plain registration (devnet / testnet key, or deactivation). Once {attestationRequired}, only
    ///      deactivation is possible here: activation goes through {setAttestedSigner}.
    function setSigner(address signer, bool active, bytes32 attestation) external onlyTimelock {
        if (signer == address(0)) revert ZeroAddress();
        if (active && attestationRequired) revert AttestationRequired();
        isSigner[signer] = active;
        attestationOf[signer] = attestation;
        if (!active) measurementOf[signer] = bytes32(0);
        emit SignerSet(signer, active, attestation);
    }

    /// @notice Timelock: activate a TEE signer whose quote was verified off-chain (VERIFY E1). The contract
    ///         cannot check the quote's vendor signature; it checks that `measurement` is an allowed enclave
    ///         build and records {attestationDigest} — binding chain, oracle, signer, platform, measurement and
    ///         the hash of the exact quote bytes — so anyone can re-verify the published quote against the
    ///         on-chain record during the timelock delay and afterwards.
    /// @param platform Platform tag, e.g. bytes32("INTEL_TDX"), bytes32("AMD_SEV_SNP"), bytes32("AWS_NITRO").
    /// @param measurement Allowed enclave measurement digest ({setMeasurement}).
    /// @param quoteHash keccak256 of the raw quote / attestation document bytes (published off-chain).
    function setAttestedSigner(address signer, bytes32 platform, bytes32 measurement, bytes32 quoteHash)
        external
        onlyTimelock
    {
        if (signer == address(0)) revert ZeroAddress();
        if (platform == bytes32(0) || quoteHash == bytes32(0)) revert BadAttestation();
        if (!measurementAllowed[measurement]) revert MeasurementNotAllowed(measurement);
        bytes32 digest = attestationDigest(signer, platform, measurement, quoteHash);
        isSigner[signer] = true;
        attestationOf[signer] = digest;
        measurementOf[signer] = measurement;
        emit SignerAttested(signer, platform, measurement, quoteHash, digest);
        emit SignerSet(signer, true, digest);
    }

    /// @notice Timelock: allow / revoke an enclave measurement for NEW registrations. Revoking does not
    ///         deactivate existing signers (no per-update cost on the price path): the runbook deactivates
    ///         every signer whose `measurementOf` is the revoked value ({SignerAttested} events list them).
    function setMeasurement(bytes32 measurement, bool allowed) external onlyTimelock {
        if (measurement == bytes32(0)) revert BadAttestation();
        measurementAllowed[measurement] = allowed;
        emit MeasurementSet(measurement, allowed);
    }

    /// @notice Timelock, one-way: from now on signers are activated only through {setAttestedSigner}.
    function requireAttestations() external onlyTimelock {
        attestationRequired = true;
        emit AttestationRequiredSet();
    }

    /// @notice The 32 bytes a TEE quote for `signer` must carry at the start of its report data (TDX/SNP
    ///         REPORTDATA[0:32], Nitro `user_data`): keccak256(abi.encode(REPORT_DATA_TYPEHASH, chainid,
    ///         this, signer)). The enclave generates the signer key inside and only ever exposes this binding.
    function reportDataOf(address signer) public view returns (bytes32) {
        return keccak256(abi.encode(REPORT_DATA_TYPEHASH, block.chainid, address(this), signer));
    }

    /// @notice Digest recorded in `attestationOf` by {setAttestedSigner}.
    function attestationDigest(address signer, bytes32 platform, bytes32 measurement, bytes32 quoteHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(ATTESTATION_TYPEHASH, block.chainid, address(this), signer, platform, measurement, quoteHash)
        );
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

    function _verify(PriceUpdate memory u, bytes memory sig) internal view returns (address signer) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashPrice(u), sig);
        if (err != ECDSA.RecoverError.NoError) recovered = address(0);
        if (recovered == address(0) || !isSigner[recovered]) revert BadSigner(recovered);
        if (u.priceWad == 0) revert ZeroPrice(u.underlying);
        if (u.publishedAt > block.timestamp + MAX_FUTURE_DRIFT) {
            revert FuturePrice(u.publishedAt, block.timestamp);
        }
        if (!u.held && u.sourceCount < minSources) revert InsufficientSources(u.sourceCount, minSources);
        return recovered;
    }

    function _store(PriceUpdate memory u, address signer) internal {
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
