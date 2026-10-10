// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {MainnetInput} from "./MainnetInput.sol";
import {BookrunnerConfig} from "../src/BookrunnerConfig.sol";
import {BkrnToken} from "../src/BkrnToken.sol";
import {BkrnStaking} from "../src/BkrnStaking.sol";
import {BkrnFeeRouter} from "../src/BkrnFeeRouter.sol";
import {Backstop} from "../src/Backstop.sol";
import {MarkRegistry} from "../src/MarkRegistry.sol";
import {RevenueRouter} from "../src/RevenueRouter.sol";
import {Book} from "../src/Book.sol";
import {Tranche} from "../src/Tranche.sol";
import {UnderwritingVault} from "../src/UnderwritingVault.sol";
import {MarketCharter} from "../src/MarketCharter.sol";
import {RiskCommittee} from "../src/RiskCommittee.sol";
import {BookFactory} from "../src/BookFactory.sol";
import {MMMandate} from "../src/MMMandate.sol";
import {BookrunnerDesk} from "../src/BookrunnerDesk.sol";
import {HedgeExecutor} from "../src/HedgeExecutor.sol";
import {StockTokenRegistry} from "../src/StockTokenRegistry.sol";
import {AttestedOracle} from "../src/AttestedOracle.sol";
import {PoolEngine} from "../src/PoolEngine.sol";
import {PoolEngineAdapter} from "../src/PoolEngineAdapter.sol";
import {OrderlyAdapter} from "../src/OrderlyAdapter.sol";
import {BRTypes} from "../src/interfaces/BRTypes.sol";
import {IStockTokenRegistry} from "../src/interfaces/IStockTokenRegistry.sol";

/// @title DeployMainnet — Robinhood Chain MAINNET (4663) deployment + governance handover in one broadcast.
/// @notice No mocks. Every external address and parameter comes from the JSON input (MainnetInput.sol,
///         schema contracts/deploy-inputs/README.md). Sequence: validate input -> check externals on-chain
///         (code, 6-decimal settlement token, Orderly vault token) -> TimelockController (proposer = executor
///         = canceller = multisig, NO admin: self-administered) -> core + venues + governance wired as
///         Deploy.s.sol does (HedgeExecutor SwapRouter02 + v3 factory + one route per Stock Token; BkrnFeeRouter
///         buyback params + reference source FIXED / TWAP / ATTESTED) -> params (venueMinIf[Orderly] > 25,000e6),
///         oracle (measurement allow-list, attested TEE signers, requireAttestations), Stock Tokens (live
///         uiMultiplier mode + anchors), indexes, implementations (Book linked to BookLogic; OrderlyAdapter v3
///         with the input's broker / token hashes) -> service
///         roles to the input's PUBLIC addresses, GUARDIAN to the guardian -> handover: DEFAULT_ADMIN to the
///         timelock, `config.setAddress("timelock", controller)`, the deployer renounces DEFAULT_ADMIN.
///         After the broadcast the deployer holds no role, no BKRN and owns nothing; VerifyHandover.s.sol
///         asserts every RUNBOOK post-condition.
///         REHEARSAL: chain 46630 with REHEARSAL=1 and an input with `"network": "rehearsal"` runs the same
///         code path against the real testnet externals (Orderly testnet vault, testnet USDG, ...).
///         Output: deployments/<chainId>.json on a broadcast, deployments/<chainId>.simulation.json on a dry run.
///
///   DEPLOY_INPUT=deploy-inputs/4663.json bash scripts/forge.sh script script/DeployMainnet.s.sol:DeployMainnet \
///       --rpc-url $RHC_RPC_URL --sender <deployer> [--broadcast --slow --interactive]
///   (scripts/deploy-mainnet.sh wraps simulate -> confirm -> broadcast -> startBlock -> VerifyHandover)
contract DeployMainnet is MainnetInput {
    struct Deployed {
        address timelock;
        address config;
        address bkrn;
        address staking;
        address feeRouter;
        address backstop;
        address markRegistry;
        address oracle;
        address stockRegistry;
        address hedgeExecutor;
        address poolEngine;
        address bookImpl;
        address bookLogic;
        address charter;
        address committee;
        address factory;
        bool bkrnDeployed;
        uint256 startBlock;
    }

    Deployed internal d;

    function run() external {
        _requireDeployChain();
        string memory path = _inputPath();
        console2.log("input:", path);
        loadInput(vm.readFile(path));
        validateInput();
        checkExternals();
        string memory out = _outPath();
        // a broadcast never overwrites an existing deployment record (move it away deliberately first)
        if (_isLive()) require(!vm.exists(out), string.concat("DeployMainnet: ", out, " already exists"));
        deploy();
        _writeDeployment(out);
    }

    /// @notice Deploys, wires and hands over. Broadcasts from `deployer` (pass the wallet on the CLI).
    function deploy() public returns (Deployed memory) {
        require(inChainId != 0, "DeployMainnet: input not loaded");
        require(d.config == address(0), "DeployMainnet: already deployed");
        d.startBlock = block.number; // RHC (Arbitrum Orbit): parent-chain block — deploy-mainnet.sh rewrites it
        vm.startBroadcast(gov.deployer);
        _deployTimelock();
        _deployCore();
        _setHedgeRoutes();
        _deployVenuesAndGovernance();
        _setParams();
        _registerImplementations();
        _registerOracleSigners();
        _registerStockTokens();
        _grantServiceRoles();
        _handover();
        vm.stopBroadcast();
        return d;
    }

    function deployed() external view returns (Deployed memory) {
        return d;
    }

    // ------------------------------------------------------------------------------------------- steps

    function _deployTimelock() internal {
        address[] memory ms = new address[](1);
        ms[0] = gov.multisig;
        // admin = address(0): the controller administers itself; no EOA ever holds its DEFAULT_ADMIN_ROLE.
        d.timelock = address(new TimelockController(gov.timelockMinDelay, ms, ms, address(0)));
    }

    function _deployCore() internal {
        BookrunnerConfig config = new BookrunnerConfig(gov.deployer); // admin until _handover
        d.config = address(config);
        config.setAddress("usdc", ext.settlementToken); // protocol settlement token (USDG on RHC)

        if (bkrnIn.token != address(0)) {
            d.bkrn = bkrnIn.token;
        } else {
            d.bkrn = address(new BkrnToken(bkrnIn.community, bkrnIn.studio, bkrnIn.liquidity, bkrnIn.contributors));
            d.bkrnDeployed = true;
        }
        config.setAddress("bkrn", d.bkrn);

        d.staking = address(new BkrnStaking(d.config));
        d.feeRouter = address(new BkrnFeeRouter(d.config));
        d.backstop = address(new Backstop(d.config));
        d.markRegistry = address(new MarkRegistry(d.config));
        config.setAddress("staking", d.staking);
        config.setAddress("feeRouter", d.feeRouter);
        config.setAddress("backstop", d.backstop);
        config.setAddress("markRegistry", d.markRegistry);
        config.setAddress("expenseRecipient", gov.expenseRecipient);
        config.setAddress("slashRecipient", gov.slashRecipient);

        // no bootstrap signer: TEE signers are registered (with their attestation) in _registerOracleSigners
        d.oracle = address(new AttestedOracle(d.config, address(0), bytes32(0)));
        config.setAddress("oracle", d.oracle);

        // admin = address(0): governed by config.timelock() only, so the handover also hands over the registry
        d.stockRegistry = address(new StockTokenRegistry(d.config, address(0)));
        config.setAddress("stockRegistry", d.stockRegistry);

        d.hedgeExecutor = address(new HedgeExecutor(d.config, ext.swapRouter02));
        config.setAddress("hedgeExecutor", d.hedgeExecutor);
        if (ext.univ4Router != address(0)) HedgeExecutor(d.hedgeExecutor).setRouter("UNIV4", ext.univ4Router);
        // with the factory set, setRoute reverts PoolNotFound unless every pool of the route exists (VERIFY U4)
        if (ext.univ3Factory != address(0)) HedgeExecutor(d.hedgeExecutor).setV3Factory(ext.univ3Factory);

        d.poolEngine = address(new PoolEngine(d.config));
        config.setAddress("poolEngine", d.poolEngine);
        config.setAddress("orderlyVault", ext.orderlyVault);
        config.setAddress("entryPoint", ext.entryPoint);
    }

    /// @dev One UNIV3 route per Stock Token (agents / risk send poolFee 0 = the route). Needs config.usdc().
    function _setHedgeRoutes() internal {
        HedgeExecutor he = HedgeExecutor(d.hedgeExecutor);
        for (uint256 i; i < hedgeRoutes.length; ++i) {
            HedgeRouteIn storage r = hedgeRoutes[i];
            he.setRoute("UNIV3", _stockToken(r.symbol), uint24(r.fee), r.hop, uint24(r.hopFee));
        }
    }

    function _deployVenuesAndGovernance() internal {
        BookrunnerConfig config = BookrunnerConfig(d.config);
        d.charter = address(new MarketCharter(d.config));
        d.committee = address(new RiskCommittee(d.config, committeeMembers));
        d.factory = address(new BookFactory(d.config));
        config.setAddress("charter", d.charter);
        config.setAddress("committee", d.committee);
        config.setAddress("factory", d.factory);

        BkrnStaking staking = BkrnStaking(d.staking);
        staking.setLocker(d.charter, true);
        staking.setLocker(d.committee, true);
        if (staking.cooldown() != prm.stakingCooldown) staking.setCooldown(uint64(prm.stakingCooldown));
        if (staking.rewardsDuration() != prm.stakingRewardsDuration) {
            staking.setRewardsDuration(uint64(prm.stakingRewardsDuration));
        }

        BkrnFeeRouter feeRouter = BkrnFeeRouter(d.feeRouter);
        feeRouter.setBuybackRouter(ext.swapRouter02);
        feeRouter.setBuybackParams(
            uint24(bb.poolFee), bb.refBkrnPerUsdcWad, uint16(bb.maxSlippageBps), bb.maxPerCall
        );
        if (bb.bkrnPriceId != bytes32(0)) feeRouter.setBkrnPriceId(bb.bkrnPriceId); // selects REF_ATTESTED
        if (bb.referenceSource == REF_TWAP) {
            feeRouter.setTwapParams(bb.twapPool, uint32(bb.twapWindow), uint24(bb.twapMaxTickDeviation));
        }
        if (feeRouter.referenceSource() != bb.referenceSource) feeRouter.setReferenceSource(bb.referenceSource);

        Backstop(d.backstop).setMaxCoverBps(uint16(prm.backstopMaxCoverBps));
    }

    function _setParams() internal {
        BookrunnerConfig config = BookrunnerConfig(d.config);
        bytes32[] memory keys = new bytes32[](10);
        uint256[] memory vals = new uint256[](10);
        (keys[0], vals[0]) = ("markInterval", prm.markInterval);
        (keys[1], vals[1]) = ("maxMarkAge", prm.maxMarkAge);
        (keys[2], vals[2]) = ("maxPriceAge", prm.maxPriceAge);
        (keys[3], vals[3]) = ("maxTradePriceAge", prm.maxTradePriceAge);
        (keys[4], vals[4]) = ("committeeWindow", prm.committeeWindow);
        (keys[5], vals[5]) = ("carryBps", prm.carryBps);
        (keys[6], vals[6]) = ("expenseCapBps", prm.expenseCapBps);
        (keys[7], vals[7]) = ("charterFeeUsd", prm.charterFeeUsd);
        (keys[8], vals[8]) = ("sponsorBondBkrn", prm.sponsorBondBkrn);
        (keys[9], vals[9]) = ("committeeBondBkrn", prm.committeeBondBkrn);
        config.setParams(keys, vals);
        config.setVenueMinIf(BRTypes.VENUE_ORDERLY, prm.venueMinIfOrderly);
        config.setVenueMinIf(BRTypes.VENUE_POOL_ENGINE, prm.venueMinIfPoolEngine);
        config.setTiers(tierThresholds, tierBonds);
    }

    function _registerImplementations() internal {
        BookFactory factory = BookFactory(d.factory);
        bytes32[] memory kinds = new bytes32[](8);
        address[] memory impls = new address[](8);
        // Book links the external library BookLogic: forge deploys it (from the deployer) and links it here
        d.bookImpl = address(new Book());
        d.bookLogic = linkedBookLogic(d.bookImpl);
        require(d.bookLogic != address(0), "DeployMainnet: Book implementation not linked to BookLogic");
        (kinds[0], impls[0]) = (factory.BOOK(), d.bookImpl);
        (kinds[1], impls[1]) = (factory.TRANCHE(), address(new Tranche()));
        (kinds[2], impls[2]) = (factory.VAULT(), address(new UnderwritingVault()));
        (kinds[3], impls[3]) = (factory.MANDATE(), address(new MMMandate()));
        (kinds[4], impls[4]) = (factory.ROUTER(), address(new RevenueRouter()));
        (kinds[5], impls[5]) = (factory.DESK(), address(new BookrunnerDesk()));
        (kinds[6], impls[6]) = (factory.ORDERLY_ADAPTER(), _newOrderlyAdapterImpl());
        (kinds[7], impls[7]) = (factory.ENGINE_ADAPTER(), address(new PoolEngineAdapter(d.config)));
        factory.setImplementations(kinds, impls);
    }

    /// @dev The one place that knows the OrderlyAdapter constructor: broker hash + settlement token hash (VERIFY
    ///      O7). v3 accounts need nothing else here: MM = the adapter proxy's own Orderly account, IF = a per-book
    ///      OrderlyIFAccount the proxy deploys at initialize (VERIFY O6/O9); the implementation checks
    ///      `decimals() == 6` and `vault.getAllowedToken(tokenHash) == config.usdc()` there.
    function _newOrderlyAdapterImpl() internal returns (address) {
        return address(new OrderlyAdapter(brokerHash(), tokenHash()));
    }

    /// @dev VERIFY E1: enclave measurements allow-listed, then each TEE signer through setAttestedSigner (digest
    ///      binds chain, oracle, signer, platform, measurement, quote hash); plain setSigner only in a rehearsal.
    ///      requireAttestations last (one-way: from then on only attested signers can be activated).
    function _registerOracleSigners() internal {
        AttestedOracle oracle = AttestedOracle(d.oracle);
        for (uint256 i; i < oracleMeasurements.length; ++i) oracle.setMeasurement(oracleMeasurements[i], true);
        for (uint256 i; i < oracleSigners.length; ++i) {
            OracleSignerIn storage s = oracleSigners[i];
            if (_attested(s)) oracle.setAttestedSigner(s.signer, s.platform, s.measurement, s.quoteHash);
            else oracle.setSigner(s.signer, true, s.attestation);
        }
        if (oracle.minSources() != prm.oracleMinSources) oracle.setMinSources(uint32(prm.oracleMinSources));
        if (requireAttestations) oracle.requireAttestations();
    }

    function _registerStockTokens() internal {
        StockTokenRegistry registry = StockTokenRegistry(d.stockRegistry);
        if (multiplierBandBps != 0) registry.setMultiplierBand(uint16(multiplierBandBps));
        for (uint256 i; i < stocks.length; ++i) {
            StockTokenIn storage s = stocks[i];
            registry.register(s.token, s.priceId, s.multiplierWad, s.floatCapRaw); // multiplierWad = the anchor
            // live ERC-8056 uiMultiplier (reads the token once: must answer within the band of the anchor)
            if (s.liveMultiplier) registry.setMultiplierSource(s.token, true);
            if (s.nextMultiplierAnchor != 0) registry.setNextMultiplierAnchor(s.token, s.nextMultiplierAnchor);
        }
        for (uint256 i; i < indexes.length; ++i) {
            IndexIn storage x = indexes[i];
            IStockTokenRegistry.IndexComponent[] memory comps = new IStockTokenRegistry.IndexComponent[](x.symbols.length);
            for (uint256 j; j < x.symbols.length; ++j) {
                comps[j] = IStockTokenRegistry.IndexComponent({token: _stockToken(x.symbols[j]), weightBps: x.weightsBps[j]});
            }
            registry.registerIndex(keccak256(bytes(x.name)), x.priceId, comps);
        }
    }

    function _grantServiceRoles() internal {
        BookrunnerConfig config = BookrunnerConfig(d.config);
        _grantAll(config, config.MARK_SIGNER_ROLE(), markSigners);
        _grantAll(config, config.RISK_ROLE(), riskHolders);
        _grantAll(config, config.OPS_VENUE_ROLE(), opsVenueHolders);
        _grantAll(config, config.JURY_ROLE(), juryHolders);
        _grantAll(config, config.KEEPER_ROLE(), keeperHolders);
        config.grantRole(config.GUARDIAN_ROLE(), gov.guardian);
    }

    function _grantAll(BookrunnerConfig config, bytes32 role, address[] storage holders) internal {
        for (uint256 i; i < holders.length; ++i) config.grantRole(role, holders[i]);
    }

    /// @dev RUNBOOK handover: admin to the controller, repoint timelock() (requires the admin role first),
    ///      then the deployer renounces. The deployer never held GUARDIAN or a service role.
    function _handover() internal {
        BookrunnerConfig config = BookrunnerConfig(d.config);
        bytes32 admin = config.DEFAULT_ADMIN_ROLE();
        config.grantRole(admin, d.timelock);
        config.setAddress("timelock", d.timelock);
        config.renounceRole(admin, gov.deployer);
        require(config.timelock() == d.timelock, "handover: timelock() != controller");
        require(!config.hasRole(admin, gov.deployer), "handover: deployer still admin");
    }

    // ------------------------------------------------------------------------------------------- output

    function _isLive() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    /// @dev Broadcast: DEPLOY_OUT or deployments/<chainId>.json. Dry run / test: deployments/<chainId>.simulation.json.
    function _outPath() internal view returns (string memory) {
        if (_isLive()) return _deploymentPath();
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".simulation.json");
    }

    /// @notice deployments/<chainId>.json in the services' Deployment shape (packages/shared/src/types.ts),
    ///         plus the governance block VerifyHandover / the runbook read.
    function writeDeployment(string memory path) public {
        _writeDeployment(path);
    }

    function _writeDeployment(string memory path) internal {
        string memory root = "root";
        vm.serializeJson(root, "{\"books\":[]}");
        vm.serializeString(root, "network", inNetwork);
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "startBlock", d.startBlock);
        vm.serializeAddress(root, "expenseRecipient", gov.expenseRecipient);
        vm.serializeAddress(root, "slashRecipient", gov.slashRecipient);
        vm.serializeString(root, "governance", _governanceJson());
        vm.serializeString(root, "chainlinkFeeds", _feedsJson());
        // the oracle service's ORACLE_CHAIN_CONFIG (Stock Tokens + Chainlink feeds), as given in the input
        vm.serializeString(root, "chainPriceConfig", ext.chainPriceConfig);
        vm.serializeString(root, "contracts", _contractsJson());
        string memory out = vm.serializeString(root, "stockTokens", _stocksJson());
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        vm.writeJson(out, path);
        console2.log("deployment written:", path);
    }

    function _contractsJson() internal returns (string memory) {
        string memory c = "contracts";
        vm.serializeAddress(c, "config", d.config);
        vm.serializeAddress(c, "timelock", d.timelock);
        vm.serializeAddress(c, "usdc", ext.settlementToken); // services: the settlement token
        vm.serializeAddress(c, "usdg", ext.settlementToken);
        vm.serializeAddress(c, "bkrn", d.bkrn);
        vm.serializeAddress(c, "staking", d.staking);
        vm.serializeAddress(c, "feeRouter", d.feeRouter);
        vm.serializeAddress(c, "backstop", d.backstop);
        vm.serializeAddress(c, "markRegistry", d.markRegistry);
        vm.serializeAddress(c, "oracle", d.oracle);
        vm.serializeAddress(c, "stockRegistry", d.stockRegistry);
        vm.serializeAddress(c, "charter", d.charter);
        vm.serializeAddress(c, "committee", d.committee);
        vm.serializeAddress(c, "factory", d.factory);
        vm.serializeAddress(c, "poolEngine", d.poolEngine);
        vm.serializeAddress(c, "hedgeExecutor", d.hedgeExecutor);
        vm.serializeAddress(c, "bookImplementation", d.bookImpl);
        vm.serializeAddress(c, "bookLogic", d.bookLogic);
        vm.serializeAddress(c, "uniswapV3Factory", ext.univ3Factory);
        vm.serializeAddress(c, "orderlyVault", ext.orderlyVault);
        vm.serializeAddress(c, "entryPoint", ext.entryPoint);
        return vm.serializeAddress(c, "swapRouter", ext.swapRouter02);
    }

    function _governanceJson() internal returns (string memory) {
        string memory g = "governance";
        vm.serializeAddress(g, "deployer", gov.deployer);
        vm.serializeAddress(g, "multisig", gov.multisig);
        vm.serializeAddress(g, "guardian", gov.guardian);
        vm.serializeAddress(g, "timelockController", d.timelock);
        vm.serializeBool(g, "bkrnDeployed", d.bkrnDeployed);
        return vm.serializeUint(g, "timelockMinDelay", gov.timelockMinDelay);
    }

    function _feedsJson() internal returns (string memory out) {
        string memory f = "feeds";
        out = "{}";
        for (uint256 i; i < feeds.length; ++i) out = vm.serializeAddress(f, feeds[i].symbol, feeds[i].feed);
    }

    function _stocksJson() internal returns (string memory out) {
        string memory st = "stockTokens";
        out = "{}";
        for (uint256 i; i < stocks.length; ++i) {
            StockTokenIn storage s = stocks[i];
            string memory o = string.concat("st_", s.symbol);
            vm.serializeAddress(o, "token", s.token);
            vm.serializeBytes32(o, "priceId", s.priceId);
            vm.serializeString(o, "multiplierSource", s.liveMultiplier ? "uiMultiplier" : "stored");
            string memory one = vm.serializeString(o, "multiplierWad", vm.toString(s.multiplierWad));
            out = vm.serializeString(st, s.symbol, one);
        }
    }
}
