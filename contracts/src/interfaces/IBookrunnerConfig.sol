// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IBookrunnerConfig — protocol registry of addresses, parameters and roles.
/// @notice Admin is the 48h TimelockController. Every component reads siblings from here.
interface IBookrunnerConfig {
    // ---- roles (bytes32 ids; granted by timelock) ----
    // keccak256("MARK_SIGNER")   mark service signer for MarkRegistry.commit
    // keccak256("RISK")          risk service: kill, key revocation, exposure reports
    // keccak256("OPS_VENUE")     ops-venue service: Orderly reports, fee sweeps, withdraw execution
    // keccak256("JURY")          charter service: posts model-jury verdict CIDs
    // keccak256("KEEPER")        keepers: distribute, recall before marks, buybacks
    // keccak256("GUARDIAN")      may pause NEW books / deposits. Never redemptions.
    function MARK_SIGNER_ROLE() external view returns (bytes32);
    function RISK_ROLE() external view returns (bytes32);
    function OPS_VENUE_ROLE() external view returns (bytes32);
    function JURY_ROLE() external view returns (bytes32);
    function KEEPER_ROLE() external view returns (bytes32);
    function GUARDIAN_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);

    // ---- addresses ----
    /// @notice Protocol settlement token (name kept for ABI stability): USDC on devnet/testnet, USDG on
    ///         Robinhood Chain mainnet. BookrunnerConfig enforces `decimals() == 6` when it is set.
    ///         Components cache it at deployment/initialize: a repoint only affects new books/components.
    function usdc() external view returns (address);
    function bkrn() external view returns (address);
    function staking() external view returns (address);
    function feeRouter() external view returns (address);
    function backstop() external view returns (address);
    function markRegistry() external view returns (address);
    function oracle() external view returns (address); // AttestedOracle (single on-chain price surface)
    function stockRegistry() external view returns (address);
    function charter() external view returns (address); // MarketCharter
    function committee() external view returns (address); // RiskCommittee
    function factory() external view returns (address); // BookFactory
    function poolEngine() external view returns (address);
    function orderlyVault() external view returns (address); // VERIFY: Orderly Vault on RHC
    function hedgeExecutor() external view returns (address);
    function entryPoint() external view returns (address); // ERC-4337 EntryPoint v0.7 (VERIFY on RHC)
    function timelock() external view returns (address);
    function expenseRecipient() external view returns (address); // pays oracle + keeper gas
    function slashRecipient() external view returns (address);

    // ---- parameters ----
    function carryBps() external view returns (uint16); // 1000 = 10% protocol carry
    function expenseCapBps() external view returns (uint16); // max expenses as share of gross per distribution
    function charterFeeUsd() external view returns (uint256); // flat USDC fee per charter
    function sponsorBondBkrn() external view returns (uint256);
    function committeeBondBkrn() external view returns (uint256);
    function markInterval() external view returns (uint32); // 86400 on mainnet; short on devnet
    function maxMarkAge() external view returns (uint32); // mark must be committed within this of periodEnd
    function maxPriceAge() external view returns (uint32); // oracle staleness bound
    function committeeWindow() external view returns (uint32); // 48h
    function venueMinIfUsd(uint8 venue) external view returns (uint256);
    /// @notice Required locked BKRN stake to run a bookrunner key at `inventoryUsd` tier (0 below entry tier).
    function agentTierBond(uint256 inventoryUsd) external view returns (uint256);
    /// @notice Kill-criteria switch: pauses NEW charters/books/deposits. Never blocks redemptions.
    function newBooksPaused() external view returns (bool);

    event AddressSet(bytes32 indexed key, address value);
    event ParamSet(bytes32 indexed key, uint256 value);
    event NewBooksPaused(bool paused);
}
