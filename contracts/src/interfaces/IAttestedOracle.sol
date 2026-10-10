// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IAttestedOracle — single on-chain price surface. Prices are produced by the oracle service
///        (multi-source median inside an attested TEE; AttestedOracle.setAttestedSigner, VERIFY E1) and signed by a
///        registered signer. `held` = feed holding off-hours (session closed): engine + mandate go
///        reduce-only; liquidations still run on margin at the held price.
/// @notice EIP-712 domain: name "Bookrunner AttestedOracle", version "1".
///         PRICE_TYPEHASH = keccak256("Price(bytes32 underlying,uint256 priceWad,uint64 publishedAt,bool held,uint32 sourceCount,bytes32 sourcesHash)")
interface IAttestedOracle {
    struct PriceUpdate {
        bytes32 underlying;
        uint256 priceWad;
        uint64 publishedAt;
        bool held;
        uint32 sourceCount;
        bytes32 sourcesHash; // keccak256 of the canonical sources JSON (kept off-chain, receipt-rooted)
    }

    struct PriceData {
        uint256 priceWad;
        uint64 publishedAt;
        bool held;
        uint32 sourceCount;
    }

    function PRICE_TYPEHASH() external view returns (bytes32);
    function hashPrice(PriceUpdate calldata u) external view returns (bytes32);
    /// @notice Heartbeat relay (an active signer, KEEPER or the timelock); reverts unless signed by an
    ///         active signer and newer than stored.
    function push(PriceUpdate calldata u, bytes calldata sig) external;
    /// @notice Heartbeat batch relay (same relayers as `push`); entries not newer than stored are skipped.
    function pushMany(PriceUpdate[] calldata us, bytes[] calldata sigs) external;
    /// @notice Pull oracle (LOW_GAS.md §1). Verifies and stores every update that is newer than the stored
    ///         one (skips the rest, never reverts for "not newer"; reverts on a bad signature). Callable by
    ///         anyone; consumers call it first. Empty `priceData` is a no-op. An update already stale on
    ///         arrival (older than config.maxPriceAge()) is skipped too: the open relay never lands an old
    ///         print a caller could have picked for being favourable.
    /// @param priceData abi.encode(PriceUpdate[] updates, bytes[] signatures)
    function update(bytes calldata priceData) external;
    function latest(bytes32 underlying) external view returns (PriceData memory);
    /// @notice Reverts StalePrice if older than config.maxPriceAge().
    function priceOf(bytes32 underlying) external view returns (uint256 priceWad, bool held);
    function isStale(bytes32 underlying) external view returns (bool);
    function isSigner(address signer) external view returns (bool);
    /// @notice Timelock: register / remove signer; `attestation` = recorded hash (TEE signers: AttestedOracle.setAttestedSigner).
    function setSigner(address signer, bool active, bytes32 attestation) external;
    /// @notice Minimum distinct sources required for a non-held price.
    function minSources() external view returns (uint32);

    error StalePrice(bytes32 underlying, uint64 publishedAt);
    error BadSigner(address recovered);
    error NotNewer(uint64 stored, uint64 incoming);

    event PricePushed(bytes32 indexed underlying, uint256 priceWad, uint64 publishedAt, bool held, uint32 sourceCount, address signer);
    event SignerSet(address indexed signer, bool active, bytes32 attestation);
}
