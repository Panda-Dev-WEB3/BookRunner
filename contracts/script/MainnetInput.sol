// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @title MainnetInput — the single JSON input of DeployMainnet / VerifyHandover.
/// @notice Every external address and every parameter of a mainnet (Robinhood Chain 4663) deployment lives in
///         ONE JSON file (`contracts/deploy-inputs/<chainId>.json`, schema: contracts/deploy-inputs/README.md),
///         so a constructor change in another package is a small edit here, never a hunt for constants.
///         Role holders are PUBLIC addresses only: no private key, mnemonic or KMS id is ever read by a script.
/// @dev    `loadInput` parses (types only); `validateInput` enforces the static rules (no placeholder left,
///         the deployer holds nothing, mainnet floors); `checkExternals` reads the chain (code, decimals,
///         venue token). Placeholders: any non-zero address <= 0xFFFF (the committed example uses them).
abstract contract MainnetInput is Script {
    using stdJson for string;

    uint256 internal constant MAINNET_CHAIN_ID = 4663;
    uint256 internal constant REHEARSAL_CHAIN_ID = 46630;
    /// @notice Minimum TimelockController delay on mainnet (RUNBOOK: 48h).
    uint256 internal constant MIN_MAINNET_TIMELOCK_DELAY = 48 hours;
    /// @notice Orderly Perp Anything IF requirement per symbol (VERIFY O10). The rule is STRICTLY greater, so
    ///         `venueMinIfOrderly` must be above it on mainnet (a charter at exactly 25,000 fails Orderly's check).
    uint256 internal constant ORDERLY_MAINNET_IF_REQUIREMENT = 25_000e6;
    /// @notice Mainnet marks are daily (Orderly settles builder fees once a day, VERIFY O11; scripts/dev.ts
    ///         --network mainnet runs MARK_INTERVAL_SECONDS=86400).
    uint256 internal constant MAINNET_MARK_INTERVAL = 1 days;
    uint160 internal constant PLACEHOLDER_MAX = 0xFFFF;
    uint8 internal constant SETTLEMENT_DECIMALS = 6;
    /// @notice BkrnFeeRouter reference sources (BkrnFeeRouter.REF_*).
    uint8 internal constant REF_FIXED = 0;
    uint8 internal constant REF_TWAP = 1;
    uint8 internal constant REF_ATTESTED = 2;
    /// @notice BkrnFeeRouter TWAP bounds (BkrnFeeRouter.MIN_TWAP_WINDOW / MAX_TWAP_WINDOW / MAX_TWAP_TICK_DEVIATION).
    uint256 internal constant MIN_TWAP_WINDOW = 10 minutes;
    uint256 internal constant MAX_TWAP_WINDOW = 2 days;
    uint256 internal constant MAX_TWAP_TICK_DEVIATION = 2000;
    /// @notice StockTokenRegistry.MAX_MULTIPLIER_BAND_BPS; 0 in the input keeps the registry default (500).
    uint256 internal constant MAX_MULTIPLIER_BAND_BPS = 5000;
    /// @notice HedgeExecutor.MAX_POOL_FEE.
    uint256 internal constant MAX_POOL_FEE = 999_999;

    struct Governance {
        address deployer; // fresh one-shot EOA; holds nothing after the handover
        address multisig; // TimelockController proposer + executor + canceller (a Safe: must have code)
        uint256 timelockMinDelay;
        address guardian; // BookrunnerConfig GUARDIAN_ROLE (pause new business only)
        address expenseRecipient; // charter fees (treasury multisig)
        address slashRecipient; // slashed BKRN (treasury multisig)
    }

    struct Externals {
        address settlementToken; // config.usdc(): USDG on RHC (VERIFY O3/S1), 6 decimals
        string settlementSymbol;
        address orderlyVault; // VERIFY O2
        string orderlyBrokerId; // VERIFY O7: brokerHash = keccak256(bytes(brokerId))
        string orderlyTokenSymbol; // VERIFY O7: tokenHash = keccak256(bytes(symbol)); vault.getAllowedToken(hash) == settlement
        address swapRouter02; // Uniswap v3 SwapRouter02 (VERIFY U1): HedgeExecutor UNIV3 + BKRN buybacks
        address univ3Factory; // UniswapV3Factory (VERIFY U1): HedgeExecutor.setV3Factory (setRoute checks pools)
        address univ4Router; // optional (0 = UNIV4 stays NotConfigured, VERIFY U3)
        address entryPoint; // ERC-4337 v0.7 (VERIFY A1)
        // Chain price config the oracle service loads (config/chains/<chainId>.json: Stock Tokens + Chainlink
        // feeds), relative to contracts/ or absolute; the input's tokens / feeds must match it. "" = none.
        string chainPriceConfig;
    }

    struct BkrnIn {
        address token; // pre-existing BKRN (0 = deploy BkrnToken with the four allocations below)
        address community;
        address studio;
        address liquidity;
        address contributors;
    }

    struct Params {
        uint256 markInterval;
        uint256 maxMarkAge;
        uint256 maxPriceAge;
        uint256 maxTradePriceAge;
        uint256 committeeWindow;
        uint256 carryBps;
        uint256 expenseCapBps;
        uint256 charterFeeUsd;
        uint256 sponsorBondBkrn;
        uint256 committeeBondBkrn;
        uint256 venueMinIfOrderly;
        uint256 venueMinIfPoolEngine;
        uint256 backstopMaxCoverBps;
        uint256 stakingCooldown;
        uint256 stakingRewardsDuration;
        uint256 oracleMinSources;
    }

    struct Buyback {
        uint256 poolFee;
        uint256 refBkrnPerUsdcWad;
        uint256 maxSlippageBps;
        uint256 maxPerCall;
        bytes32 bkrnPriceId; // optional ("" = governance reference price)
        // reference source (BkrnFeeRouter.setReferenceSource): "fixed" | "twap" | "attested"
        // (default: "attested" when bkrnPriceId is set, else "fixed")
        uint8 referenceSource;
        address twapPool; // BKRN/settlement Uniswap v3 pool (twap only; needs a pre-existing bkrn.token)
        uint256 twapWindow; // seconds, [10 min, 2 days]
        uint256 twapMaxTickDeviation; // [1, 2000] ticks
    }

    /// @dev Attested form (mainnet): `platform` + `measurement` + `quoteHash` -> AttestedOracle.setAttestedSigner
    ///      (measurement must be in `oracle.measurements`). Plain form (rehearsal only): `attestation` ->
    ///      AttestedOracle.setSigner.
    struct OracleSignerIn {
        address signer;
        bytes32 attestation; // plain form: recorded as is
        bytes32 platform; // e.g. "INTEL_TDX" / "AMD_SEV_SNP" / "AWS_NITRO" (VERIFY E1)
        bytes32 measurement; // allowed enclave build (32-byte digest)
        bytes32 quoteHash; // keccak256 of the raw quote bytes (published)
    }

    struct StockTokenIn {
        string symbol;
        address token;
        bytes32 priceId;
        uint256 multiplierWad; // stored multiplier; the anchor in live mode (current uiMultiplier())
        uint256 floatCapRaw;
        bool liveMultiplier; // multiplierSource "uiMultiplier": registry reads the token's ERC-8056 uiMultiplier()
        uint256 nextMultiplierAnchor; // optional pre-approved anchor of a staged corporate action (0 = none)
    }

    /// @dev One HedgeExecutor UNIV3 route per Stock Token: direct settlement/token pool (`hop` = 0) or a
    ///      two-pool route through `hop` (e.g. WETH).
    struct HedgeRouteIn {
        string symbol;
        uint256 fee;
        address hop;
        uint256 hopFee;
    }

    struct IndexIn {
        string name; // indexId = keccak256(bytes(name))
        bytes32 priceId;
        string[] symbols;
        uint256[] weightsBps;
    }

    struct FeedIn {
        string symbol;
        address feed; // Chainlink AggregatorV3 (VERIFY C4); consumed by the oracle service, checked here
    }

    // ---- parsed input (storage: a script contract is never deployed)
    string internal inNetwork;
    uint256 internal inChainId;
    Governance internal gov;
    Externals internal ext;
    BkrnIn internal bkrnIn;
    Params internal prm;
    Buyback internal bb;
    address[3] internal committeeMembers;
    address[] internal markSigners;
    address[] internal riskHolders;
    address[] internal opsVenueHolders;
    address[] internal juryHolders;
    address[] internal keeperHolders;
    uint256[] internal tierThresholds;
    uint256[] internal tierBonds;
    OracleSignerIn[] internal oracleSigners;
    bytes32[] internal oracleMeasurements;
    bool internal requireAttestations;
    StockTokenIn[] internal stocks;
    uint256 internal multiplierBandBps; // 0 = registry default
    IndexIn[] internal indexes;
    FeedIn[] internal feeds;
    HedgeRouteIn[] internal hedgeRoutes;

    // ------------------------------------------------------------------------------------------- paths

    /// @notice Input file: DEPLOY_INPUT (relative to contracts/ or absolute), default deploy-inputs/<chainId>.json.
    function _inputPath() internal view returns (string memory) {
        return _envPath("DEPLOY_INPUT", string.concat("deploy-inputs/", vm.toString(block.chainid), ".json"));
    }

    /// @notice Deployment file: DEPLOY_OUT (relative to contracts/ or absolute), default deployments/4663.json on
    ///         mainnet and deployments/46630.rehearsal.json for a rehearsal (never the testnet stack's 46630.json).
    function _deploymentPath() internal view returns (string memory) {
        string memory dflt = block.chainid == REHEARSAL_CHAIN_ID
            ? "deployments/46630.rehearsal.json"
            : string.concat("deployments/", vm.toString(block.chainid), ".json");
        return _envPath("DEPLOY_OUT", dflt);
    }

    function _envPath(string memory name, string memory dflt) internal view returns (string memory) {
        string memory p = vm.envOr(name, string(""));
        if (bytes(p).length == 0) p = dflt;
        return _resolve(p);
    }

    /// @dev Absolute, or relative to contracts/ (vm.projectRoot()).
    function _resolve(string memory p) internal view returns (string memory) {
        if (bytes(p)[0] == "/") return p;
        return string.concat(vm.projectRoot(), "/", p);
    }

    function _isRehearsalAllowed() internal view returns (bool) {
        return vm.envOr("REHEARSAL", uint256(0)) == 1;
    }

    /// @notice Chain gate shared by both scripts: 4663, or 46630 with REHEARSAL=1 (real testnet externals).
    function _requireDeployChain() internal view {
        require(
            block.chainid == MAINNET_CHAIN_ID || (block.chainid == REHEARSAL_CHAIN_ID && _isRehearsalAllowed()),
            "MainnetInput: chain 4663 only (46630 with REHEARSAL=1); devnet/testnet: Deploy.s.sol"
        );
    }

    // ------------------------------------------------------------------------------------------- parse

    /// @notice Parses `json` into storage (types only; see validateInput / checkExternals). Callable once.
    function loadInput(string memory json) public {
        require(inChainId == 0, "MainnetInput: input already loaded");
        inNetwork = json.readString(".network");
        inChainId = json.readUint(".chainId");
        _loadGovernance(json);
        _loadExternals(json);
        _loadBkrn(json);
        _loadParams(json);
        _loadBuyback(json);
        _loadRoles(json);
        _loadOracle(json);
        _loadStocks(json);
        _loadIndexes(json);
        _loadFeeds(json);
        _loadHedgeRoutes(json);
    }

    function _loadGovernance(string memory json) private {
        gov.deployer = json.readAddress(".deployer");
        gov.multisig = json.readAddress(".governance.multisig");
        gov.timelockMinDelay = json.readUint(".governance.timelockMinDelay");
        gov.guardian = json.readAddress(".governance.guardian");
        gov.expenseRecipient = json.readAddress(".treasury.expenseRecipient");
        gov.slashRecipient = json.readAddress(".treasury.slashRecipient");
    }

    function _loadExternals(string memory json) private {
        ext.settlementToken = json.readAddress(".externals.settlementToken");
        ext.settlementSymbol = json.readString(".externals.settlementSymbol");
        ext.orderlyVault = json.readAddress(".externals.orderlyVault");
        ext.orderlyBrokerId = json.readString(".externals.orderlyBrokerId");
        ext.orderlyTokenSymbol = json.readString(".externals.orderlyTokenSymbol");
        ext.swapRouter02 = json.readAddress(".externals.uniswapV3SwapRouter02");
        ext.univ3Factory = json.readAddressOr(".externals.uniswapV3Factory", address(0));
        ext.univ4Router = json.readAddressOr(".externals.uniswapV4Router", address(0));
        ext.entryPoint = json.readAddress(".externals.entryPoint");
        ext.chainPriceConfig = json.readStringOr(".externals.chainPriceConfig", "");
    }

    function _loadBkrn(string memory json) private {
        bkrnIn.token = json.readAddressOr(".bkrn.token", address(0));
        bkrnIn.community = json.readAddressOr(".bkrn.community", address(0));
        bkrnIn.studio = json.readAddressOr(".bkrn.studio", address(0));
        bkrnIn.liquidity = json.readAddressOr(".bkrn.liquidity", address(0));
        bkrnIn.contributors = json.readAddressOr(".bkrn.contributors", address(0));
    }

    function _loadParams(string memory json) private {
        prm.markInterval = json.readUint(".params.markInterval");
        prm.maxMarkAge = json.readUint(".params.maxMarkAge");
        prm.maxPriceAge = json.readUint(".params.maxPriceAge");
        prm.maxTradePriceAge = json.readUint(".params.maxTradePriceAge");
        prm.committeeWindow = json.readUint(".params.committeeWindow");
        prm.carryBps = json.readUint(".params.carryBps");
        prm.expenseCapBps = json.readUint(".params.expenseCapBps");
        prm.charterFeeUsd = json.readUint(".params.charterFeeUsd");
        prm.sponsorBondBkrn = json.readUint(".params.sponsorBondBkrn");
        prm.committeeBondBkrn = json.readUint(".params.committeeBondBkrn");
        prm.venueMinIfOrderly = json.readUint(".params.venueMinIfOrderly");
        prm.venueMinIfPoolEngine = json.readUint(".params.venueMinIfPoolEngine");
        prm.backstopMaxCoverBps = json.readUint(".params.backstopMaxCoverBps");
        prm.stakingCooldown = json.readUint(".params.stakingCooldown");
        prm.stakingRewardsDuration = json.readUint(".params.stakingRewardsDuration");
        prm.oracleMinSources = json.readUint(".params.oracleMinSources");
        uint256[] memory th = json.readUintArray(".params.tiers.thresholds");
        uint256[] memory bo = json.readUintArray(".params.tiers.bonds");
        for (uint256 i; i < th.length; ++i) tierThresholds.push(th[i]);
        for (uint256 i; i < bo.length; ++i) tierBonds.push(bo[i]);
    }

    function _loadBuyback(string memory json) private {
        bb.poolFee = json.readUint(".buyback.poolFee");
        bb.refBkrnPerUsdcWad = json.readUint(".buyback.refBkrnPerUsdcWad");
        bb.maxSlippageBps = json.readUint(".buyback.maxSlippageBps");
        bb.maxPerCall = json.readUint(".buyback.maxPerCall");
        bb.bkrnPriceId = _b32(json.readStringOr(".buyback.bkrnPriceId", ""));
        string memory src = json.readStringOr(".buyback.referenceSource", bb.bkrnPriceId != bytes32(0) ? "attested" : "fixed");
        if (_eq(src, "fixed")) bb.referenceSource = REF_FIXED;
        else if (_eq(src, "twap")) bb.referenceSource = REF_TWAP;
        else if (_eq(src, "attested")) bb.referenceSource = REF_ATTESTED;
        else revert("MainnetInput: buyback.referenceSource must be fixed | twap | attested");
        bb.twapPool = json.readAddressOr(".buyback.twap.pool", address(0));
        bb.twapWindow = json.readUintOr(".buyback.twap.window", 0);
        bb.twapMaxTickDeviation = json.readUintOr(".buyback.twap.maxTickDeviation", 0);
    }

    function _loadRoles(string memory json) private {
        _pushAll(markSigners, json.readAddressArray(".roles.markSigner"));
        _pushAll(riskHolders, json.readAddressArray(".roles.risk"));
        _pushAll(opsVenueHolders, json.readAddressArray(".roles.opsVenue"));
        _pushAll(juryHolders, json.readAddressArray(".roles.jury"));
        _pushAll(keeperHolders, json.readAddressArray(".roles.keeper"));
        address[] memory c = json.readAddressArray(".committee");
        require(c.length == 3, "MainnetInput: committee needs exactly 3 members");
        (committeeMembers[0], committeeMembers[1], committeeMembers[2]) = (c[0], c[1], c[2]);
    }

    function _loadOracle(string memory json) private {
        for (uint256 i; ; ++i) {
            string memory k = string.concat(".oracle.signers[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) break;
            oracleSigners.push(
                OracleSignerIn({
                    signer: json.readAddress(string.concat(k, ".signer")),
                    attestation: json.readBytes32Or(string.concat(k, ".attestation"), bytes32(0)),
                    platform: _b32(json.readStringOr(string.concat(k, ".platform"), "")),
                    measurement: json.readBytes32Or(string.concat(k, ".measurement"), bytes32(0)),
                    quoteHash: json.readBytes32Or(string.concat(k, ".quoteHash"), bytes32(0))
                })
            );
        }
        for (uint256 i; ; ++i) {
            string memory k = string.concat(".oracle.measurements[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) break;
            oracleMeasurements.push(json.readBytes32(k));
        }
        requireAttestations = json.readBoolOr(".oracle.requireAttestations", false);
    }

    function _loadStocks(string memory json) private {
        for (uint256 i; ; ++i) {
            string memory k = string.concat(".stockTokens[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) break;
            string memory src = json.readStringOr(string.concat(k, ".multiplierSource"), "stored");
            require(
                _eq(src, "uiMultiplier") || _eq(src, "stored"),
                "MainnetInput: stockTokens[].multiplierSource must be uiMultiplier | stored"
            );
            stocks.push(
                StockTokenIn({
                    symbol: json.readString(string.concat(k, ".symbol")),
                    token: json.readAddress(string.concat(k, ".token")),
                    priceId: _b32(json.readString(string.concat(k, ".priceId"))),
                    multiplierWad: json.readUint(string.concat(k, ".multiplierWad")),
                    floatCapRaw: json.readUint(string.concat(k, ".floatCapRaw")),
                    liveMultiplier: _eq(src, "uiMultiplier"),
                    nextMultiplierAnchor: json.readUintOr(string.concat(k, ".nextMultiplierAnchorWad"), 0)
                })
            );
        }
        multiplierBandBps = json.readUintOr(".stockRegistry.multiplierBandBps", 0);
    }

    function _loadIndexes(string memory json) private {
        for (uint256 i; ; ++i) {
            string memory k = string.concat(".indexes[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) break;
            IndexIn storage x = indexes.push();
            x.name = json.readString(string.concat(k, ".name"));
            x.priceId = _b32(json.readString(string.concat(k, ".priceId")));
            for (uint256 j; ; ++j) {
                string memory c = string.concat(k, ".components[", vm.toString(j), "]");
                if (!vm.keyExistsJson(json, c)) break;
                x.symbols.push(json.readString(string.concat(c, ".symbol")));
                x.weightsBps.push(json.readUint(string.concat(c, ".weightBps")));
            }
        }
    }

    function _loadFeeds(string memory json) private {
        for (uint256 i; ; ++i) {
            string memory k = string.concat(".externals.chainlinkFeeds[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) break;
            feeds.push(
                FeedIn({
                    symbol: json.readString(string.concat(k, ".symbol")),
                    feed: json.readAddress(string.concat(k, ".feed"))
                })
            );
        }
    }

    function _loadHedgeRoutes(string memory json) private {
        for (uint256 i; ; ++i) {
            string memory k = string.concat(".hedge.routes[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) break;
            hedgeRoutes.push(
                HedgeRouteIn({
                    symbol: json.readString(string.concat(k, ".symbol")),
                    fee: json.readUint(string.concat(k, ".fee")),
                    hop: json.readAddressOr(string.concat(k, ".hop"), address(0)),
                    hopFee: json.readUintOr(string.concat(k, ".hopFee"), 0)
                })
            );
        }
    }

    // ------------------------------------------------------------------------------------------- validate

    /// @notice Static rules (no chain reads). Reverts with the first violation.
    function validateInput() public view {
        bool mainnet = inChainId == MAINNET_CHAIN_ID;
        require(
            (mainnet && _eq(inNetwork, "mainnet")) || (inChainId == REHEARSAL_CHAIN_ID && _eq(inNetwork, "rehearsal")),
            "input: network/chainId must be mainnet/4663 or rehearsal/46630"
        );
        require(inChainId == block.chainid, "input: chainId differs from the RPC chain");
        _validateGovernance(mainnet);
        _validateExternals(mainnet);
        _validateBkrn();
        _validateRoles();
        _validateOracle(mainnet);
        _validateParams(mainnet);
        _validateBuybackReference();
        _validateMarkets(mainnet);
        _validateHedgeRoutes();
        _validateChainPriceConfig(mainnet);
    }

    function _validateGovernance(bool mainnet) private view {
        _req(gov.deployer, "deployer");
        _req(gov.multisig, "governance.multisig");
        _req(gov.guardian, "governance.guardian");
        _req(gov.expenseRecipient, "treasury.expenseRecipient");
        _req(gov.slashRecipient, "treasury.slashRecipient");
        if (mainnet) require(gov.timelockMinDelay >= MIN_MAINNET_TIMELOCK_DELAY, "input: timelockMinDelay < 48h on mainnet");
        address d = gov.deployer;
        require(d != gov.multisig && d != gov.guardian, "input: deployer must not be the multisig / guardian");
        require(d != gov.expenseRecipient && d != gov.slashRecipient, "input: treasury must not be the deployer");
    }

    function _validateExternals(bool mainnet) private view {
        _req(ext.settlementToken, "externals.settlementToken");
        _req(ext.orderlyVault, "externals.orderlyVault");
        _req(ext.swapRouter02, "externals.uniswapV3SwapRouter02");
        _req(ext.entryPoint, "externals.entryPoint");
        _opt(ext.univ4Router, "externals.uniswapV4Router");
        // mainnet: routes are only accepted for pools that exist (HedgeExecutor.setV3Factory, VERIFY U1/U4)
        if (mainnet) _req(ext.univ3Factory, "externals.uniswapV3Factory");
        else _opt(ext.univ3Factory, "externals.uniswapV3Factory");
        require(bytes(ext.orderlyBrokerId).length > 0, "input: externals.orderlyBrokerId empty");
        require(bytes(ext.orderlyTokenSymbol).length > 0, "input: externals.orderlyTokenSymbol empty");
        for (uint256 i; i < feeds.length; ++i) _req(feeds[i].feed, string.concat("chainlinkFeeds.", feeds[i].symbol));
    }

    function _validateBkrn() private view {
        _opt(bkrnIn.token, "bkrn.token");
        if (bkrnIn.token != address(0)) return;
        _reqNotDeployer(bkrnIn.community, "bkrn.community");
        _reqNotDeployer(bkrnIn.studio, "bkrn.studio");
        _reqNotDeployer(bkrnIn.liquidity, "bkrn.liquidity");
        _reqNotDeployer(bkrnIn.contributors, "bkrn.contributors");
    }

    function _validateRoles() private view {
        _reqHolders(markSigners, "roles.markSigner");
        _reqHolders(riskHolders, "roles.risk");
        _reqHolders(opsVenueHolders, "roles.opsVenue");
        _reqHolders(juryHolders, "roles.jury");
        _reqHolders(keeperHolders, "roles.keeper");
        for (uint256 i; i < 3; ++i) _reqNotDeployer(committeeMembers[i], "committee");
    }

    /// @dev Mainnet: every signer goes through the attestation flow (allow-listed measurement, platform, quote
    ///      hash; AttestedOracle.setAttestedSigner) and attestations are required from the start.
    function _validateOracle(bool mainnet) private view {
        require(oracleSigners.length > 0, "input: oracle.signers empty");
        for (uint256 i; i < oracleMeasurements.length; ++i) {
            require(oracleMeasurements[i] != bytes32(0), "input: oracle.measurements has a zero entry");
        }
        for (uint256 i; i < oracleSigners.length; ++i) {
            OracleSignerIn storage s = oracleSigners[i];
            _reqNotDeployer(s.signer, "oracle.signers");
            for (uint256 j; j < i; ++j) require(oracleSigners[j].signer != s.signer, "input: duplicate oracle signer");
            if (_attested(s)) {
                require(s.attestation == bytes32(0), "input: oracle signer has both attestation and platform/measurement/quoteHash");
                require(s.platform != bytes32(0) && s.quoteHash != bytes32(0), "input: oracle signer platform / quoteHash missing");
                require(_measurementListed(s.measurement), "input: oracle signer measurement not in oracle.measurements");
            } else {
                require(!mainnet, "input: oracle signer must be attested on mainnet (platform, measurement, quoteHash; VERIFY E1)");
                require(!requireAttestations, "input: oracle.requireAttestations needs every signer attested");
            }
        }
        if (mainnet) require(requireAttestations, "input: oracle.requireAttestations must be true on mainnet (VERIFY E1)");
    }

    function _attested(OracleSignerIn storage s) internal view returns (bool) {
        return s.platform != bytes32(0) || s.measurement != bytes32(0) || s.quoteHash != bytes32(0);
    }

    function _measurementListed(bytes32 m) internal view returns (bool) {
        if (m == bytes32(0)) return false;
        for (uint256 i; i < oracleMeasurements.length; ++i) {
            if (oracleMeasurements[i] == m) return true;
        }
        return false;
    }

    function _validateParams(bool mainnet) private view {
        if (mainnet) {
            require(prm.markInterval == MAINNET_MARK_INTERVAL, "input: mainnet markInterval must be 86400 (daily marks)");
            require(prm.venueMinIfOrderly > ORDERLY_MAINNET_IF_REQUIREMENT, "input: venueMinIfOrderly must be > 25,000e6 (VERIFY O10)");
        }
        require(prm.maxPriceAge > 0 && prm.maxTradePriceAge > 0 && prm.maxMarkAge > 0, "input: zero age param");
        require(prm.backstopMaxCoverBps > 0 && prm.backstopMaxCoverBps <= 10_000, "input: backstopMaxCoverBps");
        require(prm.stakingCooldown >= 1 days, "input: stakingCooldown < 1 day");
        require(prm.oracleMinSources > 0, "input: oracleMinSources 0");
        require(tierThresholds.length == tierBonds.length, "input: tiers length mismatch");
        require(bb.poolFee > 0 && bb.poolFee < (1 << 24), "input: buyback.poolFee");
        require(bb.refBkrnPerUsdcWad > 0 && bb.maxPerCall > 0, "input: buyback ref price / maxPerCall");
        require(bb.maxSlippageBps <= 2000, "input: buyback.maxSlippageBps > 2000");
        require(multiplierBandBps <= MAX_MULTIPLIER_BAND_BPS, "input: stockRegistry.multiplierBandBps > 5000");
    }

    /// @dev BkrnFeeRouter reference source (VERIFY U5). TWAP needs a pool of the pre-existing BKRN (a BKRN the
    ///      script deploys has no pool yet: start with "fixed" and switch through the timelock).
    function _validateBuybackReference() private view {
        if (bb.referenceSource == REF_ATTESTED) {
            require(bb.bkrnPriceId != bytes32(0), "input: buyback.referenceSource attested needs bkrnPriceId");
        }
        if (bb.referenceSource == REF_TWAP) {
            require(bkrnIn.token != address(0), "input: buyback twap needs a pre-existing bkrn.token (pool)");
            _req(bb.twapPool, "buyback.twap.pool");
            require(
                bb.twapWindow >= MIN_TWAP_WINDOW && bb.twapWindow <= MAX_TWAP_WINDOW,
                "input: buyback.twap.window outside [600, 172800]"
            );
            require(
                bb.twapMaxTickDeviation > 0 && bb.twapMaxTickDeviation <= MAX_TWAP_TICK_DEVIATION,
                "input: buyback.twap.maxTickDeviation outside [1, 2000]"
            );
        } else {
            require(bb.twapPool == address(0), "input: buyback.twap set but referenceSource is not twap");
        }
    }

    function _validateMarkets(bool mainnet) private view {
        require(stocks.length > 0, "input: stockTokens empty");
        for (uint256 i; i < stocks.length; ++i) {
            StockTokenIn storage s = stocks[i];
            _req(s.token, string.concat("stockTokens.", s.symbol));
            require(s.priceId != bytes32(0) && s.multiplierWad > 0, "input: stock token priceId / multiplier");
            for (uint256 j; j < i; ++j) {
                require(stocks[j].token != s.token && !_eq(stocks[j].symbol, s.symbol), "input: duplicate stock token");
            }
            // mainnet Stock Tokens carry their own ERC-8056 uiMultiplier (VERIFY T2): live mode only
            if (mainnet) require(s.liveMultiplier, string.concat("input: stockTokens.", s.symbol, " multiplierSource must be uiMultiplier on mainnet"));
            if (!s.liveMultiplier) require(s.nextMultiplierAnchor == 0, "input: nextMultiplierAnchorWad needs multiplierSource uiMultiplier");
        }
        for (uint256 i; i < indexes.length; ++i) {
            IndexIn storage x = indexes[i];
            require(x.symbols.length == x.weightsBps.length && x.symbols.length > 0, "input: index components");
            uint256 sum;
            for (uint256 j; j < x.symbols.length; ++j) {
                _stockToken(x.symbols[j]); // reverts if unknown
                sum += x.weightsBps[j];
            }
            require(sum == 10_000, "input: index weights must sum to 10000 bps");
        }
    }

    /// @dev Exactly one UNIV3 route per Stock Token (agents / risk send poolFee 0 = the route; a token without a
    ///      route cannot be hedged). Pool existence is checked on-chain by HedgeExecutor.setRoute (v3 factory).
    function _validateHedgeRoutes() private view {
        require(hedgeRoutes.length == stocks.length, "input: hedge.routes needs exactly one route per stock token");
        for (uint256 i; i < hedgeRoutes.length; ++i) {
            HedgeRouteIn storage r = hedgeRoutes[i];
            address token = _stockToken(r.symbol); // reverts if unknown
            for (uint256 j; j < i; ++j) require(!_eq(hedgeRoutes[j].symbol, r.symbol), "input: duplicate hedge route");
            require(r.fee > 0 && r.fee <= MAX_POOL_FEE, string.concat("input: hedge.routes.", r.symbol, " fee"));
            if (r.hop == address(0)) {
                require(r.hopFee == 0, string.concat("input: hedge.routes.", r.symbol, " hopFee without hop"));
            } else {
                _req(r.hop, string.concat("hedge.routes.", r.symbol, ".hop"));
                require(
                    r.hopFee > 0 && r.hopFee <= MAX_POOL_FEE && r.hop != token && r.hop != ext.settlementToken,
                    string.concat("input: hedge.routes.", r.symbol, " hop / hopFee")
                );
            }
        }
    }

    /// @dev The oracle service prices Stock Tokens from config/chains/<chainId>.json (ORACLE_CHAIN_CONFIG): the
    ///      input's tokens and feeds must be the same addresses, so the registry and the oracle agree (VERIFY
    ///      T3 / C4). Required on mainnet.
    function _validateChainPriceConfig(bool mainnet) private view {
        if (bytes(ext.chainPriceConfig).length == 0) {
            require(!mainnet, "input: externals.chainPriceConfig is required on mainnet (config/chains/4663.json)");
            return;
        }
        string memory c = vm.readFile(_resolve(ext.chainPriceConfig));
        require(stdJson.readUint(c, ".chainId") == inChainId, "input: chainPriceConfig chainId != input chainId");
        for (uint256 i; i < stocks.length; ++i) {
            string memory k = string.concat(".stockTokens.", stocks[i].symbol, ".token");
            require(vm.keyExistsJson(c, k), string.concat("input: stockTokens.", stocks[i].symbol, " missing from chainPriceConfig"));
            require(
                stdJson.readAddress(c, k) == stocks[i].token,
                string.concat("input: stockTokens.", stocks[i].symbol, " token != chainPriceConfig")
            );
        }
        for (uint256 i; i < feeds.length; ++i) {
            string memory k = string.concat(".chainlink.feeds.", feeds[i].symbol, ".proxy");
            require(vm.keyExistsJson(c, k), string.concat("input: chainlinkFeeds.", feeds[i].symbol, " missing from chainPriceConfig"));
            require(
                stdJson.readAddress(c, k) == feeds[i].feed,
                string.concat("input: chainlinkFeeds.", feeds[i].symbol, " feed != chainPriceConfig")
            );
        }
    }

    /// @notice Chain reads: code at every external address, settlement token decimals, the venue's token.
    function checkExternals() public view {
        _code(ext.settlementToken, "settlementToken");
        _code(ext.orderlyVault, "orderlyVault");
        _code(ext.swapRouter02, "uniswapV3SwapRouter02");
        _code(ext.entryPoint, "entryPoint");
        _code(gov.multisig, "governance.multisig (a Safe)");
        if (ext.univ4Router != address(0)) _code(ext.univ4Router, "uniswapV4Router");
        if (bkrnIn.token != address(0)) {
            _code(bkrnIn.token, "bkrn.token");
            require(_decimals(bkrnIn.token) == 18, "externals: bkrn.token decimals != 18");
        }
        require(_decimals(ext.settlementToken) == SETTLEMENT_DECIMALS, "externals: settlement token decimals != 6");
        (bool ok, bytes memory ret) = ext.orderlyVault.staticcall(
            abi.encodeWithSignature("getAllowedToken(bytes32)", keccak256(bytes(ext.orderlyTokenSymbol)))
        );
        require(
            ok && ret.length >= 32 && abi.decode(ret, (address)) == ext.settlementToken,
            "externals: orderlyVault.getAllowedToken(tokenHash) != settlementToken (VERIFY O3/O7)"
        );
        for (uint256 i; i < stocks.length; ++i) {
            _code(stocks[i].token, string.concat("stockTokens.", stocks[i].symbol));
            require(_decimals(stocks[i].token) <= 18, "externals: stock token decimals > 18");
        }
        for (uint256 i; i < feeds.length; ++i) {
            _code(feeds[i].feed, string.concat("chainlinkFeeds.", feeds[i].symbol));
            (bool fok,) = feeds[i].feed.staticcall(abi.encodeWithSignature("latestRoundData()"));
            require(fok, string.concat("externals: latestRoundData() reverts on feed ", feeds[i].symbol));
        }
        if (ext.univ3Factory != address(0)) _code(ext.univ3Factory, "uniswapV3Factory");
        if (bb.referenceSource == REF_TWAP) _code(bb.twapPool, "buyback.twap.pool");
        for (uint256 i; i < hedgeRoutes.length; ++i) {
            if (hedgeRoutes[i].hop != address(0)) _code(hedgeRoutes[i].hop, string.concat("hedge.routes.", hedgeRoutes[i].symbol, ".hop"));
        }
        _checkLiveMultiplierAnchors();
    }

    /// @dev Live-mode tokens: `uiMultiplier()` must answer and sit within the band of the input anchor (the
    ///      registry's setMultiplierSource would revert otherwise; this names the token).
    function _checkLiveMultiplierAnchors() internal view {
        uint256 band = multiplierBandBps == 0 ? 500 : multiplierBandBps;
        for (uint256 i; i < stocks.length; ++i) {
            StockTokenIn storage s = stocks[i];
            if (!s.liveMultiplier) continue;
            (bool ok, bytes memory ret) = s.token.staticcall(abi.encodeWithSignature("uiMultiplier()"));
            require(ok && ret.length >= 32, string.concat("externals: uiMultiplier() failed on stock token ", s.symbol));
            uint256 live = abi.decode(ret, (uint256));
            uint256 diff = live > s.multiplierWad ? live - s.multiplierWad : s.multiplierWad - live;
            require(
                diff * 10_000 <= s.multiplierWad * band,
                string.concat("externals: ", s.symbol, " uiMultiplier() outside the band of multiplierWad (set it to the current value)")
            );
        }
    }

    // ------------------------------------------------------------------------------------------- helpers

    function brokerHash() public view returns (bytes32) {
        return keccak256(bytes(ext.orderlyBrokerId));
    }

    function tokenHash() public view returns (bytes32) {
        return keccak256(bytes(ext.orderlyTokenSymbol));
    }

    /// @notice The BookLogic library linked into `bookImpl` (Book DELEGATECALLs its state transitions there),
    ///         found by scanning the runtime for PUSH20 operands whose code is the BookLogic artifact (a
    ///         library's runtime starts with PUSH20 <its own address>, so bytes [21:] are compared).
    ///         address(0) = not linked / library missing. forge deploys and links it on every `new Book()`.
    function linkedBookLogic(address bookImpl) public view returns (address) {
        bytes memory code = bookImpl.code;
        bytes memory want = vm.getDeployedCode("BookLogic.sol:BookLogic");
        bytes32 wantTail = _tailHash(want);
        for (uint256 i; i + 21 <= code.length; ++i) {
            if (code[i] != 0x73) continue; // PUSH20
            address a;
            assembly {
                a := shr(96, mload(add(add(code, 33), i)))
            }
            if (a.code.length != want.length) continue;
            if (_tailHash(a.code) == wantTail) return a;
        }
        return address(0);
    }

    function _tailHash(bytes memory b) private pure returns (bytes32 h) {
        if (b.length <= 21) return bytes32(0);
        assembly {
            h := keccak256(add(b, 53), sub(mload(b), 21))
        }
    }

    function _routeIndex(string memory symbol) internal view returns (uint256) {
        for (uint256 i; i < hedgeRoutes.length; ++i) {
            if (_eq(hedgeRoutes[i].symbol, symbol)) return i;
        }
        revert(string.concat("input: no hedge route for ", symbol));
    }

    function _stockToken(string memory symbol) internal view returns (address) {
        for (uint256 i; i < stocks.length; ++i) {
            if (_eq(stocks[i].symbol, symbol)) return stocks[i].token;
        }
        revert(string.concat("input: unknown stock symbol ", symbol));
    }

    function _pushAll(address[] storage dst, address[] memory src) private {
        for (uint256 i; i < src.length; ++i) dst.push(src[i]);
    }

    function _reqHolders(address[] storage holders, string memory what) private view {
        require(holders.length > 0, string.concat("input: ", what, " empty"));
        for (uint256 i; i < holders.length; ++i) _reqNotDeployer(holders[i], what);
    }

    function _reqNotDeployer(address a, string memory what) private view {
        _req(a, what);
        require(a != gov.deployer, string.concat("input: ", what, " is the deployer"));
    }

    function _req(address a, string memory what) internal pure {
        require(a != address(0), string.concat("input: ", what, " is zero"));
        require(uint160(a) > PLACEHOLDER_MAX, string.concat("input: ", what, " is still a placeholder"));
    }

    function _opt(address a, string memory what) internal pure {
        if (a != address(0)) _req(a, what);
    }

    function _code(address a, string memory what) internal view {
        require(a.code.length > 0, string.concat("externals: no code at ", what, " ", vm.toString(a)));
    }

    function _decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && ret.length >= 32, string.concat("externals: decimals() failed on ", vm.toString(token)));
        return abi.decode(ret, (uint8));
    }

    /// @dev ASCII id -> bytes32 right-padded with zeros (== `bytes32("NVDA")`, Deploy.s.sol's priceIds).
    function _b32(string memory s) internal pure returns (bytes32) {
        bytes memory b = bytes(s);
        require(b.length <= 32, "input: id longer than 32 bytes");
        return bytes32(b);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
