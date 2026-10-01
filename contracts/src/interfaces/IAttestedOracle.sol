// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IAttestedOracle — single on-chain price surface. Prices are produced by the oracle service
///        (multi-source median inside an attested TEE; attestation registry is VERIFY) and signed by a
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
    /// @notice Anyone may relay; reverts unless signed by an active signer and newer than stored.
    function push(PriceUpdate calldata u, bytes calldata sig) external;
    function pushMany(PriceUpdate[] calldata us, bytes[] calldata sigs) external;
    function latest(bytes32 underlying) external view returns (PriceData memory);
    /// @notice Reverts StalePrice if older than config.maxPriceAge().
    function priceOf(bytes32 underlying) external view returns (uint256 priceWad, bool held);
    function isStale(bytes32 underlying) external view returns (bool);
    function isSigner(address signer) external view returns (bool);
    /// @notice Timelock: register / remove signer; `attestation` = hash of the TEE quote (VERIFY flow).
    function setSigner(address signer, bool active, bytes32 attestation) external;
    /// @notice Minimum distinct sources required for a non-held price.
    function minSources() external view returns (uint32);

    error StalePrice(bytes32 underlying, uint64 publishedAt);
    error BadSigner(address recovered);
    error NotNewer(uint64 stored, uint64 incoming);

    event PricePushed(bytes32 indexed underlying, uint256 priceWad, uint64 publishedAt, bool held, uint32 sourceCount, address signer);
    event SignerSet(address indexed signer, bool active, bytes32 attestation);
}
