// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";

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
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockOrderlyVault} from "../src/mocks/MockOrderlyVault.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {IAttestedOracle} from "../src/interfaces/IAttestedOracle.sol";
import {IStockTokenRegistry} from "../src/interfaces/IStockTokenRegistry.sol";

/// @title Deploy — devnet (anvil 31337) and Robinhood Chain TESTNET (46630) deployment of the Bookrunner core.
/// @notice Mainnet (RHC 4663) deployment is NOT done by this script: see docs/RUNBOOK.md (TimelockController
///         48h, multisig admin, VERIFY register). Role keys are derived from DEV_MNEMONIC by the indices in
///         packages/shared/src/devkeys.ts (testnet: the locally generated BKRN_TESTNET_MNEMONIC, passed in as
///         DEV_MNEMONIC; the public anvil mnemonic is refused). Testnet uses the same protocol-owned mocks as
///         devnet for USDC, Stock Tokens, the swap router and the Orderly vault (real venue/token integration
///         needs an Orderly builder account and canonical Stock Tokens — see docs/VERIFY.md).
///         Writes deployments/<chainId>.json; scripts/launch-devnet.ts then charters the launch books.
///
///   PRIVATE_KEY=<anvil #0> bash scripts/forge.sh script script/Deploy.s.sol:Deploy \
///       --rpc-url http://host.docker.internal:8547 --broadcast
contract Deploy is Script {
    string internal constant DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";
    bytes32 internal constant BROKER_HASH = keccak256("bookrunner"); // VERIFY: Orderly broker id
    bytes32 internal constant TOKEN_HASH = keccak256("USDC"); // VERIFY: Orderly token hash (RHC lists USDG)

    // ---- role addresses (devkeys.ts indices) ----
    address internal deployer;
    address internal markSigner;
    address internal riskSvc;
    address internal opsVenue;
    address internal jury;
    address internal keeper;
    address internal oracleSigner;
    uint256 internal oracleSignerKey;
    address internal sponsor;
    address[3] internal committeeMembers;

    // ---- deployed ----
    BookrunnerConfig internal config;
    MockERC20 internal usdc;
    MockERC20 internal usdg;
    BkrnToken internal bkrn;
    BkrnStaking internal staking;
    BkrnFeeRouter internal feeRouter;
    Backstop internal backstop;
    MarkRegistry internal markRegistry;
    AttestedOracle internal oracle;
    StockTokenRegistry internal registry;
    MockSwapRouter internal swapRouter;
    HedgeExecutor internal hedgeExecutor;
    PoolEngine internal poolEngine;
    MockOrderlyVault internal orderlyVault;
    MarketCharter internal charter;
    RiskCommittee internal committee;
    BookFactory internal factory;

    string[] internal tickers;
    mapping(string => MockERC20) internal stockToken;
    mapping(string => uint256) internal demoPrice; // WAD

    uint256 internal startBlock;

    function run() external {
        bool testnet = block.chainid == 46630;
        require(
            block.chainid == 31337 || (testnet && keccak256(bytes(vm.envOr("NETWORK", string("")))) == keccak256("testnet")),
            "Deploy.s.sol: devnet (31337) or NETWORK=testnet on 46630 only; mainnet: docs/RUNBOOK.md"
        );
        string memory mnemonic = vm.envOr("DEV_MNEMONIC", DEFAULT_MNEMONIC);
        if (testnet) require(keccak256(bytes(mnemonic)) != keccak256(bytes(DEFAULT_MNEMONIC)), "public mnemonic on testnet");
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) deployerKey = vm.deriveKey(mnemonic, 0);
        uint32 markInterval = uint32(vm.envOr("MARK_INTERVAL_SECONDS", uint256(300)));
        _roles(deployerKey, mnemonic);
        startBlock = block.number;

        tickers.push("NVDA");
        tickers.push("TSLA");
        tickers.push("AAPL");
        tickers.push("MSFT");
        tickers.push("AMZN");
        demoPrice["NVDA"] = 190e18; // devnet demo prices (ARCHITECTURE §7)
        demoPrice["TSLA"] = 440e18;
        demoPrice["AAPL"] = 255e18;
        demoPrice["MSFT"] = 520e18;
        demoPrice["AMZN"] = 230e18;

        vm.startBroadcast(deployerKey);
        _deployCore(markInterval);
        _deployVenuesAndGovernance();
        _registerImplementations();
        _grantRoles();
        _setupStockTokens();
        // ERC-4337 EntryPoint v0.7 (canonical address) where deployed — RHC testnet has it (verified)
        address ep = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
        if (ep.code.length > 0) config.setAddress("entryPoint", ep);
        vm.stopBroadcast();

        _writeDeployment();
    }

    function _roles(uint256 deployerKey, string memory mnemonic) internal {
        deployer = vm.addr(deployerKey);
        markSigner = vm.addr(vm.deriveKey(mnemonic, 1));
        riskSvc = vm.addr(vm.deriveKey(mnemonic, 2));
        opsVenue = vm.addr(vm.deriveKey(mnemonic, 3));
        jury = vm.addr(vm.deriveKey(mnemonic, 4));
        keeper = vm.addr(vm.deriveKey(mnemonic, 5));
        oracleSignerKey = vm.deriveKey(mnemonic, 6);
        oracleSigner = vm.addr(oracleSignerKey);
        sponsor = vm.addr(vm.deriveKey(mnemonic, 7));
        committeeMembers[0] = vm.addr(vm.deriveKey(mnemonic, 8));
        committeeMembers[1] = vm.addr(vm.deriveKey(mnemonic, 9));
        committeeMembers[2] = vm.addr(vm.deriveKey(mnemonic, 10));
    }

    function _deployCore(uint32 markInterval) internal {
        // admin = deployer, recorded as timelock() (devnet: 0s delay). Mainnet: TimelockController 48h.
        config = new BookrunnerConfig(deployer);

        usdc = new MockERC20("USD Coin (devnet)", "USDC", 6);
        usdg = new MockERC20("Global Dollar (devnet)", "USDG", 6);
        config.setAddress("usdc", address(usdc));

        // 80 / 10 / 5 / 5: community, studio (sponsor treasury), liquidity, contributors
        bkrn = new BkrnToken(deployer, sponsor, deployer, deployer);
        config.setAddress("bkrn", address(bkrn));

        staking = new BkrnStaking(address(config));
        feeRouter = new BkrnFeeRouter(address(config));
        backstop = new Backstop(address(config));
        markRegistry = new MarkRegistry(address(config));
        config.setAddress("staking", address(staking));
        config.setAddress("feeRouter", address(feeRouter));
        config.setAddress("backstop", address(backstop));
        config.setAddress("markRegistry", address(markRegistry));
        config.setAddress("expenseRecipient", deployer);
        config.setAddress("slashRecipient", deployer);

        oracle = new AttestedOracle(address(config), oracleSigner, keccak256("devnet-plain-key"));
        config.setAddress("oracle", address(oracle));

        registry = new StockTokenRegistry(address(config), deployer);
        config.setAddress("stockRegistry", address(registry));

        swapRouter = new MockSwapRouter(deployer);
        hedgeExecutor = new HedgeExecutor(address(config), address(swapRouter));
        config.setAddress("hedgeExecutor", address(hedgeExecutor));

        poolEngine = new PoolEngine(address(config));
        config.setAddress("poolEngine", address(poolEngine));

        bytes32[] memory keys = new bytes32[](3);
        uint256[] memory vals = new uint256[](3);
        keys[0] = "markInterval";
        vals[0] = markInterval;
        keys[1] = "maxMarkAge";
        vals[1] = markInterval * 2 > 3600 ? uint256(markInterval) * 2 : 3600;
        keys[2] = "committeeWindow";
        vals[2] = 172_800;
        config.setParams(keys, vals);
    }

    function _deployVenuesAndGovernance() internal {
        orderlyVault = new MockOrderlyVault(deployer, address(usdc), TOKEN_HASH, BROKER_HASH);
        orderlyVault.setOperator(opsVenue, true);
        config.setAddress("orderlyVault", address(orderlyVault));

        charter = new MarketCharter(address(config));
        committee = new RiskCommittee(address(config), committeeMembers);
        factory = new BookFactory(address(config));
        config.setAddress("charter", address(charter));
        config.setAddress("committee", address(committee));
        config.setAddress("factory", address(factory));

        staking.setLocker(address(charter), true);
        staking.setLocker(address(committee), true);
        feeRouter.setBuybackRouter(address(swapRouter));
    }

    function _registerImplementations() internal {
        bytes32[] memory kinds = new bytes32[](8);
        address[] memory impls = new address[](8);
        kinds[0] = factory.BOOK();
        impls[0] = address(new Book());
        kinds[1] = factory.TRANCHE();
        impls[1] = address(new Tranche());
        kinds[2] = factory.VAULT();
        impls[2] = address(new UnderwritingVault());
        kinds[3] = factory.MANDATE();
        impls[3] = address(new MMMandate());
        kinds[4] = factory.ROUTER();
        impls[4] = address(new RevenueRouter());
        kinds[5] = factory.DESK();
        impls[5] = address(new BookrunnerDesk());
        kinds[6] = factory.ORDERLY_ADAPTER();
        impls[6] = address(new OrderlyAdapter(BROKER_HASH, TOKEN_HASH));
        kinds[7] = factory.ENGINE_ADAPTER();
        impls[7] = address(new PoolEngineAdapter(address(config)));
        factory.setImplementations(kinds, impls);
    }

    function _grantRoles() internal {
        config.grantRole(config.MARK_SIGNER_ROLE(), markSigner);
        config.grantRole(config.RISK_ROLE(), riskSvc);
        config.grantRole(config.OPS_VENUE_ROLE(), opsVenue);
        config.grantRole(config.JURY_ROLE(), jury);
        config.grantRole(config.KEEPER_ROLE(), keeper);
        config.grantRole(config.GUARDIAN_ROLE(), deployer);
    }

    function _setupStockTokens() internal {
        IAttestedOracle.PriceUpdate[] memory ups = new IAttestedOracle.PriceUpdate[](tickers.length + 1);
        bytes[] memory sigs = new bytes[](tickers.length + 1);
        IStockTokenRegistry.IndexComponent[] memory comps = new IStockTokenRegistry.IndexComponent[](tickers.length);
        uint256 indexLevel;

        swapRouter.setUsdPrice(address(usdc), 1e18);
        swapRouter.setMintOnDemand(address(usdc), true);

        for (uint256 i = 0; i < tickers.length; i++) {
            string memory t = tickers[i];
            MockERC20 tok = new MockERC20(string.concat(t, " Stock Token (devnet)"), t, 18);
            stockToken[t] = tok;
            bytes32 pid = bytes32(bytes(t));
            // multiplier 1.0; float cap 1,000,000 tokens (frictions §9: float caps hedge inventory)
            registry.register(address(tok), pid, 1e18, 1_000_000e18);
            swapRouter.setOracleFeed(address(tok), address(oracle), pid, 1e18);
            swapRouter.setMintOnDemand(address(tok), true);

            ups[i] = _priceUpdate(pid, demoPrice[t]);
            sigs[i] = _signPrice(ups[i]);
            comps[i] = IStockTokenRegistry.IndexComponent({token: address(tok), weightBps: 2000});
            indexLevel += demoPrice[t] * 2000 / 10_000;
        }

        bytes32 rhx5 = bytes32("RHX5");
        registry.registerIndex(keccak256(bytes("BKRN.INDEX.RHX5")), rhx5, comps);
        ups[tickers.length] = _priceUpdate(rhx5, indexLevel);
        sigs[tickers.length] = _signPrice(ups[tickers.length]);
        oracle.pushMany(ups, sigs);

        // buybacks: 20 BKRN per USDC on the devnet router, funded from the liquidity allocation
        swapRouter.setPriceBoth(address(usdc), address(bkrn), 20e18);
        bkrn.transfer(address(swapRouter), 10_000_000e18);
    }

    function _priceUpdate(bytes32 pid, uint256 priceWad) internal view returns (IAttestedOracle.PriceUpdate memory u) {
        u = IAttestedOracle.PriceUpdate({
            underlying: pid,
            priceWad: priceWad,
            publishedAt: uint64(block.timestamp),
            held: false,
            sourceCount: 3,
            sourcesHash: keccak256("devnet-bootstrap")
        });
    }

    function _signPrice(IAttestedOracle.PriceUpdate memory u) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleSignerKey, oracle.hashPrice(u));
        return abi.encodePacked(r, s, v);
    }

    function _writeDeployment() internal {
        string memory c = "contracts";
        vm.serializeAddress(c, "config", address(config));
        vm.serializeAddress(c, "timelock", deployer);
        vm.serializeAddress(c, "usdc", address(usdc));
        vm.serializeAddress(c, "usdg", address(usdg));
        vm.serializeAddress(c, "bkrn", address(bkrn));
        vm.serializeAddress(c, "staking", address(staking));
        vm.serializeAddress(c, "feeRouter", address(feeRouter));
        vm.serializeAddress(c, "backstop", address(backstop));
        vm.serializeAddress(c, "markRegistry", address(markRegistry));
        vm.serializeAddress(c, "oracle", address(oracle));
        vm.serializeAddress(c, "stockRegistry", address(registry));
        vm.serializeAddress(c, "charter", address(charter));
        vm.serializeAddress(c, "committee", address(committee));
        vm.serializeAddress(c, "factory", address(factory));
        vm.serializeAddress(c, "poolEngine", address(poolEngine));
        vm.serializeAddress(c, "hedgeExecutor", address(hedgeExecutor));
        vm.serializeAddress(c, "orderlyVault", address(orderlyVault));
        address ep = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
        if (ep.code.length > 0) vm.serializeAddress(c, "entryPoint", ep);
        string memory contractsJson = vm.serializeAddress(c, "swapRouter", address(swapRouter));

        string memory st = "stockTokens";
        string memory stJson;
        for (uint256 i = 0; i < tickers.length; i++) {
            string memory t = tickers[i];
            string memory o = string.concat("st_", t);
            vm.serializeAddress(o, "token", address(stockToken[t]));
            vm.serializeBytes32(o, "priceId", bytes32(bytes(t)));
            string memory one = vm.serializeString(o, "multiplierWad", "1000000000000000000");
            stJson = vm.serializeString(st, t, one);
        }

        string memory root = "root";
        vm.serializeJson(root, "{\"books\":[]}");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "startBlock", startBlock);
        vm.serializeString(root, "contracts", contractsJson);
        string memory out = vm.serializeString(root, "stockTokens", stJson);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("deployment written:", path);
    }
}
