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
        address univ4Router; // optional (0 = UNIV4 stays NotConfigured, VERIFY U3)
        address entryPoint; // ERC-4337 v0.7 (VERIFY A1)
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
    }

    struct OracleSignerIn {
        address signer;
        bytes32 attestation; // TEE quote digest (VERIFY E1); must be non-zero on mainnet
    }

    struct StockTokenIn {
        string symbol;
        address token;
        bytes32 priceId;
        uint256 multiplierWad;
        uint256 floatCapRaw;
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
    StockTokenIn[] internal stocks;
    IndexIn[] internal indexes;
    FeedIn[] internal feeds;

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
        ext.univ4Router = json.readAddressOr(".externals.uniswapV4Router", address(0));
        ext.entryPoint = json.readAddress(".externals.entryPoint");
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
                    attestation: json.readBytes32(string.concat(k, ".attestation"))
                })
            );
        }
    }

    function _loadStocks(string memory json) private {
        for (uint256 i; ; ++i) {
            string memory k = string.concat(".stockTokens[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) break;
            stocks.push(
                StockTokenIn({
                    symbol: json.readString(string.concat(k, ".symbol")),
                    token: json.readAddress(string.concat(k, ".token")),
                    priceId: _b32(json.readString(string.concat(k, ".priceId"))),
                    multiplierWad: json.readUint(string.concat(k, ".multiplierWad")),
                    floatCapRaw: json.readUint(string.concat(k, ".floatCapRaw"))
                })
            );
        }
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
        _validateExternals();
        _validateBkrn();
        _validateRoles(mainnet);
        _validateParams(mainnet);
        _validateMarkets();
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

    function _validateExternals() private view {
        _req(ext.settlementToken, "externals.settlementToken");
        _req(ext.orderlyVault, "externals.orderlyVault");
        _req(ext.swapRouter02, "externals.uniswapV3SwapRouter02");
        _req(ext.entryPoint, "externals.entryPoint");
        _opt(ext.univ4Router, "externals.uniswapV4Router");
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

    function _validateRoles(bool mainnet) private view {
        _reqHolders(markSigners, "roles.markSigner");
        _reqHolders(riskHolders, "roles.risk");
        _reqHolders(opsVenueHolders, "roles.opsVenue");
        _reqHolders(juryHolders, "roles.jury");
        _reqHolders(keeperHolders, "roles.keeper");
        for (uint256 i; i < 3; ++i) _reqNotDeployer(committeeMembers[i], "committee");
        require(oracleSigners.length > 0, "input: oracle.signers empty");
        for (uint256 i; i < oracleSigners.length; ++i) {
            _reqNotDeployer(oracleSigners[i].signer, "oracle.signers");
            if (mainnet) require(oracleSigners[i].attestation != bytes32(0), "input: oracle signer attestation is 0 (VERIFY E1)");
        }
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
    }

    function _validateMarkets() private view {
        require(stocks.length > 0, "input: stockTokens empty");
        for (uint256 i; i < stocks.length; ++i) {
            _req(stocks[i].token, string.concat("stockTokens.", stocks[i].symbol));
            require(stocks[i].priceId != bytes32(0) && stocks[i].multiplierWad > 0, "input: stock token priceId / multiplier");
            for (uint256 j; j < i; ++j) {
                require(stocks[j].token != stocks[i].token && !_eq(stocks[j].symbol, stocks[i].symbol), "input: duplicate stock token");
            }
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
    }

    // ------------------------------------------------------------------------------------------- helpers

    function brokerHash() public view returns (bytes32) {
        return keccak256(bytes(ext.orderlyBrokerId));
    }

    function tokenHash() public view returns (bytes32) {
        return keccak256(bytes(ext.orderlyTokenSymbol));
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
