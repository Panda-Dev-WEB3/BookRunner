// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployMainnet} from "../../script/DeployMainnet.s.sol";
import {VerifyHandover} from "../../script/VerifyHandover.s.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {BookFactory} from "../../src/BookFactory.sol";
import {StockTokenRegistry} from "../../src/StockTokenRegistry.sol";
import {BkrnToken} from "../../src/BkrnToken.sol";
import {BkrnFeeRouter} from "../../src/BkrnFeeRouter.sol";
import {HedgeExecutor} from "../../src/HedgeExecutor.sol";
import {AttestedOracle} from "../../src/AttestedOracle.sol";
import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {MockOrderlyVault} from "../../src/mocks/MockOrderlyVault.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";
import {UniV3MockFactory, UniV3MockPool} from "../mocks/UniswapV3Mocks.sol";

/// @dev Stand-ins for externals that only need code (a Safe, the EntryPoint) or one view (a Chainlink feed).
contract CodeStub {
    function ping() external pure returns (bool) {
        return true;
    }
}

contract FeedStub {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 190e8, block.timestamp, block.timestamp, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

/// @dev Exposes the parsed input to the tests (scripts keep it internal).
contract DeployMainnetHarness is DeployMainnet {
    function requireDeployChain() external view {
        _requireDeployChain();
    }

    function parsed()
        external
        view
        returns (uint256 chainId, address multisig, uint256 delay, uint256 markInterval, uint256 minIf, uint256 nStocks, uint256 nFeeds)
    {
        return (inChainId, gov.multisig, gov.timelockMinDelay, prm.markInterval, prm.venueMinIfOrderly, stocks.length, feeds.length);
    }

    function parsedIndex(uint256 i) external view returns (string memory name, bytes32 priceId, uint256 n, uint256 w0) {
        IndexIn storage x = indexes[i];
        return (x.name, x.priceId, x.symbols.length, x.weightsBps[0]);
    }

    function parsedBig() external view returns (uint256 sponsorBond, uint256 tierBond2, uint256 floatCap0, bytes32 pid0, bytes32 bkrnPriceId) {
        return (prm.sponsorBondBkrn, tierBonds[2], stocks[0].floatCapRaw, stocks[0].priceId, bb.bkrnPriceId);
    }

    function parsedMainnetPrep() external view returns (uint256 nRoutes, bool live0, uint8 refSource, address factory) {
        return (hedgeRoutes.length, stocks[0].liveMultiplier, bb.referenceSource, ext.univ3Factory);
    }

    function parsedOracleAndConfig() external view returns (bytes32 platform0, bool requireAtt, string memory priceConfig) {
        return (oracleSigners[0].platform, requireAttestations, ext.chainPriceConfig);
    }
}

/// @notice End-to-end (simulated) mainnet deploy: JSON input -> DeployMainnet (no mocks deployed by the script;
///         the externals are test stand-ins at the input's addresses — the Stock Tokens and Chainlink feeds at the
///         real addresses of config/chains/4663.json) -> deployments JSON -> VerifyHandover.
contract DeployMainnetTest is Test {
    using stdJson for string;

    struct Opts {
        string network;
        uint256 chainId;
        uint256 delay;
        uint256 minIfOrderly;
        uint256 markInterval;
        address settlement;
        address bkrnToken;
        address extraKeeper;
        // oracle: plain {signer, attestation} (rehearsal) or attested {platform, measurement, quoteHash}
        bool plainSigner;
        bytes32 attestation;
        bool requireAtt;
        // buyback reference
        string bkrnPriceId;
        string refSource; // "" = omitted (default from bkrnPriceId)
        address twapPool;
        // markets / hedging
        bool storedMultipliers;
        bool withPriceConfig;
        bool mismatchFeed;
        uint256 nRoutes;
        address univ3Factory;
    }

    string internal constant CHAIN_CFG = "../config/chains/4663.json";
    bytes32 internal constant MEASUREMENT = keccak256("oracle-enclave-build-1");
    bytes32 internal constant QUOTE_HASH = keccak256("tee-quote");

    address internal deployer = makeAddr("deployer");
    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal slashTreasury = makeAddr("slashTreasury");
    address internal markSigner = makeAddr("markSigner");
    address internal risk = makeAddr("risk");
    address internal opsVenue = makeAddr("opsVenue");
    address internal jury = makeAddr("jury");
    address internal keeper = makeAddr("keeper");
    address internal keeper2 = makeAddr("keeper2");
    address internal oracleSigner = makeAddr("oracleSigner");
    address internal c0 = makeAddr("committee0");
    address internal c1 = makeAddr("committee1");
    address internal c2 = makeAddr("committee2");
    address internal community = makeAddr("community");
    address internal studio = makeAddr("studio");
    address internal liquidity = makeAddr("liquidity");
    address internal contributors = makeAddr("contributors");

    address internal multisig;
    MockERC20 internal usdg;
    MockERC20 internal weth;
    MockOrderlyVault internal vault;
    MockSwapRouter internal router;
    UniV3MockFactory internal factory;
    address internal entryPoint;
    address[5] internal stocks;
    address[5] internal feeds;
    string[5] internal syms = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"];

    function setUp() public {
        vm.chainId(4663);
        multisig = address(new CodeStub());
        entryPoint = address(new CodeStub());
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        vault = new MockOrderlyVault(address(this), address(usdg), keccak256("USDG"), keccak256("bookrunner"));
        router = new MockSwapRouter(address(this));
        factory = new UniV3MockFactory();
        // Stock Tokens (ERC-8056 uiMultiplier) and feeds at the addresses the oracle's chain config lists
        string memory cfg = vm.readFile(string.concat(vm.projectRoot(), "/", CHAIN_CFG));
        for (uint256 i; i < 5; ++i) {
            stocks[i] = cfg.readAddress(string.concat(".stockTokens.", syms[i], ".token"));
            feeds[i] = cfg.readAddress(string.concat(".chainlink.feeds.", syms[i], ".proxy"));
            deployCodeTo(
                "MockStockToken.sol:MockStockToken",
                abi.encode(string.concat(syms[i], " Stock Token"), syms[i], uint256(1e18)),
                stocks[i]
            );
            deployCodeTo("DeployMainnet.t.sol:FeedStub", feeds[i]);
        }
        // hedge pools: USDG/<token> 0.3% for the first four, AMZN through WETH (USDG/WETH 0.05%, WETH/AMZN 0.3%)
        for (uint256 i; i < 4; ++i) factory.createPool(address(usdg), stocks[i], 3000, 0);
        factory.createPool(address(usdg), address(weth), 500, 0);
        factory.createPool(address(weth), stocks[4], 3000, 0);
    }

    // ------------------------------------------------------------------------------------------- happy path

    function test_mainnet_deploy_then_verify_passes() public {
        (DeployMainnet.Deployed memory d, uint256 failures) = _deployAndVerify(_mainnetOpts(), "happy");
        assertEq(failures, 0, "VerifyHandover must pass on a fresh deployment");

        BookrunnerConfig config = BookrunnerConfig(d.config);
        assertEq(config.timelock(), d.timelock);
        assertFalse(config.hasRole(config.DEFAULT_ADMIN_ROLE(), deployer));
        assertEq(config.usdc(), address(usdg));
        assertEq(config.markInterval(), 86_400);
        assertEq(config.venueMinIfUsd(0), 25_001e6);
        assertEq(BkrnToken(d.bkrn).balanceOf(deployer), 0);
        assertEq(BkrnToken(d.bkrn).balanceOf(community), 800_000_000e18);
        assertEq(TimelockController(payable(d.timelock)).getMinDelay(), 48 hours);
        assertTrue(d.bkrnDeployed);
    }

    /// Branches 2-4 wired from the input: hedge routes + v3 factory, buyback reference, live multipliers,
    /// attested oracle signers, OrderlyAdapter v3 hashes.
    function test_mainnet_wires_routes_reference_multipliers_attestation() public {
        (DeployMainnet.Deployed memory d, uint256 failures) = _deployAndVerify(_mainnetOpts(), "wiring");
        assertEq(failures, 0);

        HedgeExecutor he = HedgeExecutor(d.hedgeExecutor);
        assertEq(he.v3Factory(), address(factory));
        (uint24 fee, address hop, uint24 hopFee) = he.routeOf("UNIV3", stocks[0]);
        assertEq(fee, 3000);
        assertEq(hop, address(0));
        assertEq(hopFee, 0);
        (fee, hop, hopFee) = he.routeOf("UNIV3", stocks[4]);
        assertEq(fee, 500);
        assertEq(hop, address(weth));
        assertEq(hopFee, 3000);

        BkrnFeeRouter fr = BkrnFeeRouter(d.feeRouter);
        assertEq(fr.referenceSource(), fr.REF_ATTESTED()); // bkrnPriceId set, no explicit source
        assertEq(fr.bkrnPriceId(), bytes32("BKRN"));

        StockTokenRegistry reg = StockTokenRegistry(d.stockRegistry);
        for (uint256 i; i < 5; ++i) {
            assertTrue(reg.multiplierFromToken(stocks[i]));
            assertEq(reg.multiplierOf(stocks[i]), 1e18);
        }
        assertEq(reg.multiplierBandBps(), 300);
        assertEq(reg.nextMultiplierAnchor(stocks[1]), 2e18);

        AttestedOracle o = AttestedOracle(d.oracle);
        assertTrue(o.attestationRequired());
        assertTrue(o.measurementAllowed(MEASUREMENT));
        assertTrue(o.isSigner(oracleSigner));
        assertEq(o.measurementOf(oracleSigner), MEASUREMENT);
        assertEq(o.attestationOf(oracleSigner), o.attestationDigest(oracleSigner, bytes32("INTEL_TDX"), MEASUREMENT, QUOTE_HASH));

        BookFactory f = BookFactory(d.factory);
        OrderlyAdapter oa = OrderlyAdapter(payable(f.implementation(f.ORDERLY_ADAPTER())));
        assertEq(oa.DEFAULT_BROKER_HASH(), keccak256("bookrunner"));
        assertEq(oa.DEFAULT_TOKEN_HASH(), keccak256("USDG"));
        assertEq(oa.SETTLEMENT_DECIMALS(), 6);
    }

    /// Book delegates its state transitions to the external library BookLogic: the deployed implementation must
    /// carry the address of a deployed BookLogic (forge deploys + links it on `new Book()`, also on broadcast).
    function test_book_implementation_is_linked_to_BookLogic() public {
        DeployMainnetHarness s = new DeployMainnetHarness();
        s.loadInput(_json(_mainnetOpts()));
        s.validateInput();
        s.checkExternals();
        DeployMainnet.Deployed memory d = s.deploy();

        BookFactory f = BookFactory(d.factory);
        assertEq(f.implementation(f.BOOK()), d.bookImpl);
        assertTrue(d.bookLogic != address(0), "BookLogic linked");
        assertGt(d.bookLogic.code.length, 0);
        assertEq(s.linkedBookLogic(d.bookImpl), d.bookLogic);
        // the linked code is the BookLogic artifact (bytes after the library's PUSH20 self-address)
        bytes memory art = vm.getDeployedCode("BookLogic.sol:BookLogic");
        assertEq(d.bookLogic.code.length, art.length);
        assertEq(_tail(d.bookLogic.code), _tail(art));
        // an unlinked contract is not mistaken for one
        assertEq(s.linkedBookLogic(d.config), address(0));
    }

    function test_deployer_has_no_power_after_handover_and_timelock_does() public {
        (DeployMainnet.Deployed memory d,) = _deployAndVerify(_mainnetOpts(), "power");
        BookrunnerConfig config = BookrunnerConfig(d.config);

        bytes32 keeperRole = config.KEEPER_ROLE();
        vm.startPrank(deployer);
        vm.expectRevert();
        config.setParam("carryBps", 0);
        vm.expectRevert();
        config.grantRole(keeperRole, deployer);
        vm.expectRevert(BookFactory.NotTimelock.selector);
        BookFactory(d.factory).setImplementation(bytes32("BOOK"), d.config);
        vm.expectRevert();
        StockTokenRegistry(d.stockRegistry).setFloatCap(stocks[0], 0);
        vm.expectRevert();
        HedgeExecutor(d.hedgeExecutor).setRoute("UNIV3", stocks[0], 0, address(0), 0);
        vm.expectRevert();
        AttestedOracle(d.oracle).setSigner(deployer, true, bytes32(0));
        vm.stopPrank();

        // the multisig, through the 48h controller, still governs everything
        TimelockController t = TimelockController(payable(d.timelock));
        bytes memory call = abi.encodeCall(BookrunnerConfig.setParam, ("carryBps", 900));
        vm.prank(multisig);
        t.schedule(d.config, 0, call, bytes32(0), bytes32(0), 48 hours);
        vm.prank(multisig);
        vm.expectRevert();
        t.execute(d.config, 0, call, bytes32(0), bytes32(0)); // not ready yet
        vm.warp(block.timestamp + 48 hours);
        vm.prank(multisig);
        t.execute(d.config, 0, call, bytes32(0), bytes32(0));
        assertEq(config.carryBps(), 900);

        // registry follows the timelock (no separate admin)
        bytes memory cap = abi.encodeCall(StockTokenRegistry.setFloatCap, (stocks[0], 5));
        vm.startPrank(multisig);
        t.schedule(d.stockRegistry, 0, cap, bytes32(0), bytes32(uint256(1)), 48 hours);
        vm.warp(block.timestamp + 48 hours);
        t.execute(d.stockRegistry, 0, cap, bytes32(0), bytes32(uint256(1)));
        vm.stopPrank();
        assertEq(StockTokenRegistry(d.stockRegistry).getToken(stocks[0]).floatCapRaw, 5);
    }

    /// REHEARSAL (46630 + REHEARSAL=1): same code path, testnet-style relaxations (plain oracle signer, stored
    /// multipliers, no v3 factory, no chain price config); Book still linked to BookLogic.
    function test_rehearsal_on_46630_same_path() public {
        vm.chainId(46630);
        Opts memory o = _rehearsalOpts();
        (DeployMainnet.Deployed memory d, uint256 failures) = _deployAndVerify(o, "rehearsal");
        assertEq(failures, 0);
        assertTrue(d.bookLogic != address(0));
        assertFalse(AttestedOracle(d.oracle).attestationRequired());
        assertFalse(StockTokenRegistry(d.stockRegistry).multiplierFromToken(stocks[0]));
        assertEq(HedgeExecutor(d.hedgeExecutor).v3Factory(), address(0));
        (uint24 fee,,) = HedgeExecutor(d.hedgeExecutor).routeOf("UNIV3", stocks[2]);
        assertEq(fee, 3000);
    }

    function test_preexisting_bkrn_is_used_not_redeployed() public {
        BkrnToken existing = new BkrnToken(community, studio, liquidity, contributors);
        Opts memory o = _mainnetOpts();
        o.bkrnToken = address(existing);
        (DeployMainnet.Deployed memory d, uint256 failures) = _deployAndVerify(o, "bkrn");
        assertEq(failures, 0);
        assertEq(d.bkrn, address(existing));
        assertFalse(d.bkrnDeployed);
    }

    function test_twap_reference_with_preexisting_bkrn_pool() public {
        BkrnToken existing = new BkrnToken(community, studio, liquidity, contributors);
        // ~20 BKRN per USDG: raw ratio 2e13 -> |tick| ~ 306,000 (sign by token order)
        int24 tick = address(usdg) < address(existing) ? int24(306_283) : int24(-306_283);
        UniV3MockPool pool = factory.createPool(address(usdg), address(existing), 3000, tick);
        vm.warp(block.timestamp + 1 hours); // observations cover the 30 min window
        Opts memory o = _mainnetOpts();
        o.bkrnToken = address(existing);
        o.bkrnPriceId = "";
        o.refSource = "twap";
        o.twapPool = address(pool);
        (DeployMainnet.Deployed memory d, uint256 failures) = _deployAndVerify(o, "twap");
        assertEq(failures, 0);
        BkrnFeeRouter fr = BkrnFeeRouter(d.feeRouter);
        assertEq(fr.referenceSource(), fr.REF_TWAP());
        assertEq(fr.twapPool(), address(pool));
        assertEq(fr.twapWindow(), 1800);
        assertApproxEqRel(fr.referenceBkrnPerUsdc(), 20e18, 0.01e18);
    }

    function test_fixed_reference_source() public {
        Opts memory o = _mainnetOpts();
        o.bkrnPriceId = "";
        o.refSource = "fixed";
        (DeployMainnet.Deployed memory d, uint256 failures) = _deployAndVerify(o, "fixed");
        assertEq(failures, 0);
        assertEq(BkrnFeeRouter(d.feeRouter).referenceSource(), 0);
        assertEq(BkrnFeeRouter(d.feeRouter).referenceBkrnPerUsdc(), 20e18);
    }

    // ------------------------------------------------------------------------------------------- verify catches breaks

    function test_verify_flags_a_role_left_with_the_deployer() public {
        (DeployMainnet.Deployed memory d,) = _deployAndVerify(_mainnetOpts(), "role-left");
        BookrunnerConfig config = BookrunnerConfig(d.config);
        bytes32 keeperRole = config.KEEPER_ROLE();
        vm.prank(d.timelock);
        config.grantRole(keeperRole, deployer);
        assertGt(_verify(_mainnetOpts(), d), 0);
    }

    function test_verify_flags_registry_admin_and_param_drift() public {
        (DeployMainnet.Deployed memory d,) = _deployAndVerify(_mainnetOpts(), "drift");
        vm.prank(d.timelock);
        StockTokenRegistry(d.stockRegistry).setAdmin(makeAddr("someone"));
        assertEq(_verify(_mainnetOpts(), d), 1);
        vm.prank(d.timelock);
        BookrunnerConfig(d.config).setParam("maxPriceAge", 301);
        assertEq(_verify(_mainnetOpts(), d), 2);
    }

    function test_verify_flags_a_missing_service_role() public {
        (DeployMainnet.Deployed memory d,) = _deployAndVerify(_mainnetOpts(), "missing-role");
        Opts memory o = _mainnetOpts();
        o.extraKeeper = keeper2; // input claims a second keeper that was never granted
        assertEq(_verify(o, d), 1);
    }

    function test_verify_flags_route_and_reference_drift() public {
        (DeployMainnet.Deployed memory d,) = _deployAndVerify(_mainnetOpts(), "route-drift");
        vm.prank(d.timelock);
        HedgeExecutor(d.hedgeExecutor).setRoute("UNIV3", stocks[0], 0, address(0), 0);
        assertEq(_verify(_mainnetOpts(), d), 1);
        vm.prank(d.timelock);
        BkrnFeeRouter(d.feeRouter).setBkrnPriceId(bytes32(0)); // back to FIXED: price id + source rows
        assertEq(_verify(_mainnetOpts(), d), 3);
    }

    function test_verify_flags_multiplier_mode_and_signer_drift() public {
        (DeployMainnet.Deployed memory d,) = _deployAndVerify(_mainnetOpts(), "mult-drift");
        vm.prank(d.timelock);
        StockTokenRegistry(d.stockRegistry).setMultiplierSource(stocks[2], false);
        assertEq(_verify(_mainnetOpts(), d), 1);
        vm.prank(d.timelock);
        AttestedOracle(d.oracle).setSigner(oracleSigner, false, bytes32(0)); // signer row + measurement row
        assertEq(_verify(_mainnetOpts(), d), 3);
    }

    function test_verify_flags_live_multiplier_outside_band() public {
        (DeployMainnet.Deployed memory d,) = _deployAndVerify(_mainnetOpts(), "band");
        MockStockToken(stocks[3]).updateMultiplier(1.2e18); // 20% > the 3% band: valuation fails closed
        // the multiplier row and the registration row (getToken reports the effective multiplier: reverts)
        assertEq(_verify(_mainnetOpts(), d), 2);
    }

    // ------------------------------------------------------------------------------------------- input gates

    function test_example_input_parses_and_is_refused_until_filled() public {
        DeployMainnetHarness s = new DeployMainnetHarness();
        s.loadInput(vm.readFile(string.concat(vm.projectRoot(), "/deploy-inputs/4663.example.json")));
        _assertExampleHead(s);
        _assertExampleMarkets(s);
        assertEq(s.brokerHash(), keccak256("bookrunner"));
        assertEq(s.tokenHash(), keccak256("USDG"));
        _assertExampleMainnetPrep(s);
        vm.expectRevert(bytes("input: deployer is still a placeholder"));
        s.validateInput();
    }

    function _assertExampleMainnetPrep(DeployMainnetHarness s) internal view {
        (uint256 nRoutes, bool live0, uint8 src, address f) = s.parsedMainnetPrep();
        assertEq(nRoutes, 5);
        assertTrue(live0);
        assertEq(src, 0); // fixed
        assertEq(f, 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
        (bytes32 platform0, bool reqAtt, string memory pc) = s.parsedOracleAndConfig();
        assertEq(platform0, bytes32("INTEL_TDX"));
        assertTrue(reqAtt);
        assertEq(pc, CHAIN_CFG);
    }

    function _assertExampleHead(DeployMainnetHarness s) internal view {
        (uint256 chainId, address ms, uint256 delay, uint256 mi, uint256 minIf, uint256 nStocks, uint256 nFeeds) = s.parsed();
        assertEq(chainId, 4663);
        assertEq(ms, address(0xA001));
        assertEq(delay, 172_800);
        assertEq(mi, 86_400);
        assertEq(minIf, 25_001e6);
        assertEq(nStocks, 5);
        assertEq(nFeeds, 5);
    }

    function _assertExampleMarkets(DeployMainnetHarness s) internal view {
        {
            (string memory name, bytes32 pid, uint256 n, uint256 w0) = s.parsedIndex(0);
            assertEq(name, "BKRN.INDEX.RHX5");
            assertEq(pid, bytes32("RHX5"));
            assertEq(n, 5);
            assertEq(w0, 2000);
        }
        (uint256 sponsorBond, uint256 tierBond2, uint256 floatCap0, bytes32 pid0, bytes32 bbPid) = s.parsedBig();
        assertEq(sponsorBond, 100_000e18);
        assertEq(tierBond2, 400_000e18);
        assertEq(floatCap0, 1_000_000e18);
        assertEq(pid0, bytes32("NVDA"));
        assertEq(bbPid, bytes32(0));
    }

    /// Everything that reads process env (REHEARSAL / DEPLOY_INPUT / DEPLOY_OUT) runs in this ONE test, in
    /// sequence: forge runs tests in parallel and the environment is shared by all of them.
    /// 1) chain gate; 2) the real mainnet entry points DeployMainnet.run() (input file -> dry-run record) then
    /// VerifyHandover.run(); 3) the same with REHEARSAL=1 on 46630.
    function test_chain_gate_and_run_entrypoints() public {
        DeployMainnetHarness s = new DeployMainnetHarness();
        s.requireDeployChain(); // 4663
        vm.chainId(31337);
        vm.expectRevert(bytes("MainnetInput: chain 4663 only (46630 with REHEARSAL=1); devnet/testnet: Deploy.s.sol"));
        s.requireDeployChain();
        vm.chainId(46630);
        vm.setEnv("REHEARSAL", "0");
        vm.expectRevert(bytes("MainnetInput: chain 4663 only (46630 with REHEARSAL=1); devnet/testnet: Deploy.s.sol"));
        s.requireDeployChain();
        vm.setEnv("REHEARSAL", "1");
        s.requireDeployChain();
        vm.setEnv("REHEARSAL", "0");

        vm.chainId(4663);
        _runEntrypoints(_mainnetOpts(), "4663");
        vm.chainId(46630);
        vm.setEnv("REHEARSAL", "1");
        _runEntrypoints(_rehearsalOpts(), "46630");
        vm.setEnv("REHEARSAL", "0");
    }

    function _runEntrypoints(Opts memory o, string memory chain) internal {
        string memory input = string.concat(vm.projectRoot(), "/deployments/test-run-input-", chain, ".json");
        string memory sim = string.concat(vm.projectRoot(), "/deployments/", chain, ".simulation.json");
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        vm.writeFile(input, _json(o));
        vm.setEnv("DEPLOY_INPUT", string.concat("deployments/test-run-input-", chain, ".json"));
        new DeployMainnet().run(); // test context = dry run: writes the .simulation.json record
        assertTrue(vm.exists(sim));
        string memory rec = vm.readFile(sim);
        assertEq(rec.readString(".chainPriceConfig"), o.withPriceConfig ? CHAIN_CFG : "");
        assertTrue(rec.readAddress(".contracts.bookLogic") != address(0));
        assertEq(rec.readAddress(".contracts.uniswapV3Factory"), o.univ3Factory);
        assertEq(rec.readString(".stockTokens.NVDA.multiplierSource"), o.storedMultipliers ? "stored" : "uiMultiplier");
        vm.setEnv("DEPLOY_OUT", string.concat("deployments/", chain, ".simulation.json"));
        new VerifyHandover().run(); // reverts if any post-condition fails
        vm.setEnv("DEPLOY_INPUT", "");
        vm.setEnv("DEPLOY_OUT", "");
        vm.removeFile(input);
        vm.removeFile(sim);
    }

    function test_refuses_orderly_if_at_exactly_25k_on_mainnet() public {
        Opts memory o = _mainnetOpts();
        o.minIfOrderly = 25_000e6;
        _expectValidateRevert(o, "input: venueMinIfOrderly must be > 25,000e6 (VERIFY O10)");
    }

    function test_refuses_short_timelock_on_mainnet() public {
        Opts memory o = _mainnetOpts();
        o.delay = 48 hours - 1;
        _expectValidateRevert(o, "input: timelockMinDelay < 48h on mainnet");
    }

    function test_refuses_non_daily_marks_on_mainnet() public {
        Opts memory o = _mainnetOpts();
        o.markInterval = 3600;
        _expectValidateRevert(o, "input: mainnet markInterval must be 86400 (daily marks)");
    }

    function test_refuses_deployer_as_role_holder() public {
        Opts memory o = _mainnetOpts();
        o.extraKeeper = deployer;
        _expectValidateRevert(o, "input: roles.keeper is the deployer");
    }

    function test_refuses_unattested_oracle_signer_on_mainnet() public {
        Opts memory o = _mainnetOpts();
        o.plainSigner = true;
        o.attestation = keccak256("tee-quote");
        o.requireAtt = false;
        _expectValidateRevert(o, "input: oracle signer must be attested on mainnet (platform, measurement, quoteHash; VERIFY E1)");
    }

    function test_refuses_mainnet_without_required_attestations() public {
        Opts memory o = _mainnetOpts();
        o.requireAtt = false;
        _expectValidateRevert(o, "input: oracle.requireAttestations must be true on mainnet (VERIFY E1)");
    }

    function test_refuses_mismatched_network() public {
        Opts memory o = _mainnetOpts();
        o.network = "rehearsal";
        _expectValidateRevert(o, "input: network/chainId must be mainnet/4663 or rehearsal/46630");
    }

    function test_refuses_stored_multiplier_on_mainnet() public {
        Opts memory o = _mainnetOpts();
        o.storedMultipliers = true;
        _expectValidateRevert(o, "input: stockTokens.NVDA multiplierSource must be uiMultiplier on mainnet");
    }

    function test_refuses_a_stock_token_without_a_hedge_route() public {
        Opts memory o = _mainnetOpts();
        o.nRoutes = 4;
        _expectValidateRevert(o, "input: hedge.routes needs exactly one route per stock token");
    }

    function test_refuses_mainnet_without_v3_factory() public {
        Opts memory o = _mainnetOpts();
        o.univ3Factory = address(0);
        _expectValidateRevert(o, "input: externals.uniswapV3Factory is zero");
    }

    function test_refuses_twap_without_a_preexisting_bkrn() public {
        Opts memory o = _mainnetOpts();
        o.bkrnPriceId = "";
        o.refSource = "twap";
        o.twapPool = address(new CodeStub());
        _expectValidateRevert(o, "input: buyback twap needs a pre-existing bkrn.token (pool)");
    }

    function test_refuses_missing_chain_price_config_on_mainnet() public {
        Opts memory o = _mainnetOpts();
        o.withPriceConfig = false;
        _expectValidateRevert(o, "input: externals.chainPriceConfig is required on mainnet (config/chains/4663.json)");
    }

    function test_refuses_feed_that_differs_from_the_chain_price_config() public {
        Opts memory o = _mainnetOpts();
        o.mismatchFeed = true;
        _expectValidateRevert(o, "input: chainlinkFeeds.NVDA feed != chainPriceConfig");
    }

    function test_externals_settlement_must_have_6_decimals() public {
        Opts memory o = _mainnetOpts();
        o.settlement = address(new MockERC20("Eighteen", "E18", 18));
        DeployMainnet s = new DeployMainnet();
        s.loadInput(_json(o));
        s.validateInput();
        vm.expectRevert(bytes("externals: settlement token decimals != 6"));
        s.checkExternals();
    }

    function test_externals_orderly_vault_must_list_the_settlement_token() public {
        Opts memory o = _mainnetOpts();
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        o.settlement = address(other); // 6 decimals, but the vault lists USDG under keccak("USDG")
        DeployMainnet s = new DeployMainnet();
        s.loadInput(_json(o));
        s.validateInput();
        vm.expectRevert(bytes("externals: orderlyVault.getAllowedToken(tokenHash) != settlementToken (VERIFY O3/O7)"));
        s.checkExternals();
    }

    function test_externals_need_code() public {
        Opts memory o = _mainnetOpts();
        DeployMainnet s = new DeployMainnet();
        s.loadInput(_json(o));
        s.validateInput();
        vm.etch(address(router), "");
        vm.expectRevert(
            bytes(string.concat("externals: no code at uniswapV3SwapRouter02 ", vm.toString(address(router))))
        );
        s.checkExternals();
    }

    function test_externals_live_multiplier_must_match_the_anchor() public {
        MockStockToken(stocks[0]).updateMultiplier(1.05e18); // input anchor 1e18, band 3%
        DeployMainnet s = new DeployMainnet();
        s.loadInput(_json(_mainnetOpts()));
        s.validateInput();
        vm.expectRevert(bytes("externals: NVDA uiMultiplier() outside the band of multiplierWad (set it to the current value)"));
        s.checkExternals();
    }

    // ------------------------------------------------------------------------------------------- helpers

    function _mainnetOpts() internal view returns (Opts memory o) {
        o.network = "mainnet";
        o.chainId = 4663;
        o.delay = 48 hours;
        o.minIfOrderly = 25_001e6;
        o.markInterval = 86_400;
        o.settlement = address(usdg);
        o.requireAtt = true;
        o.bkrnPriceId = "BKRN";
        o.withPriceConfig = true;
        o.nRoutes = 5;
        o.univ3Factory = address(factory);
    }

    function _rehearsalOpts() internal view returns (Opts memory o) {
        o = _mainnetOpts();
        o.network = "rehearsal";
        o.chainId = 46630;
        o.delay = 300; // a rehearsal may use a short delay; mainnet floors do not apply
        o.minIfOrderly = 100e6; // testnet IF requirement
        o.markInterval = 3600;
        o.plainSigner = true;
        o.attestation = bytes32(0);
        o.requireAtt = false;
        o.storedMultipliers = true;
        o.withPriceConfig = false;
        o.univ3Factory = address(0);
    }

    function _deployAndVerify(Opts memory o, string memory tag)
        internal
        returns (DeployMainnet.Deployed memory d, uint256 failures)
    {
        DeployMainnet s = new DeployMainnet();
        s.loadInput(_json(o));
        s.validateInput();
        s.checkExternals();
        d = s.deploy();
        // unique per test: tests run in parallel and share the deployments/ directory
        string memory path = string.concat(vm.projectRoot(), "/deployments/test-mainnet-", tag, ".json");
        s.writeDeployment(path);
        VerifyHandover v = new VerifyHandover();
        v.loadInput(_json(o));
        failures = v.verify(vm.readFile(path));
        vm.removeFile(path);
    }

    function _verify(Opts memory o, DeployMainnet.Deployed memory d) internal returns (uint256) {
        // re-serialise through a fresh DeployMainnet-shaped file is not needed: verify reads only these keys
        string memory j = string.concat(
            "{\"chainId\":",
            vm.toString(block.chainid),
            ",\"chainPriceConfig\":\"",
            o.withPriceConfig ? CHAIN_CFG : "",
            "\",\"governance\":{\"deployer\":\"",
            vm.toString(deployer),
            "\",\"multisig\":\"",
            vm.toString(multisig),
            "\"},\"contracts\":{\"config\":\"",
            vm.toString(d.config),
            "\",\"timelock\":\"",
            string.concat(vm.toString(d.timelock), "\"}}")
        );
        VerifyHandover v = new VerifyHandover();
        v.loadInput(_json(o));
        return v.verify(j);
    }

    function _expectValidateRevert(Opts memory o, string memory reason) internal {
        DeployMainnet s = new DeployMainnet();
        s.loadInput(_json(o));
        vm.expectRevert(bytes(reason));
        s.validateInput();
    }

    function _tail(bytes memory b) internal pure returns (bytes32 h) {
        assembly {
            h := keccak256(add(b, 53), sub(mload(b), 21))
        }
    }

    function _a(address a) internal pure returns (string memory) {
        return string.concat("\"", vm.toString(a), "\"");
    }

    function _b(bytes32 x) internal pure returns (string memory) {
        return string.concat("\"", vm.toString(x), "\"");
    }

    function _json(Opts memory o) internal view returns (string memory) {
        string memory a = string.concat("{", _jsonHead(o), _jsonRoles(o), _jsonOracle(o), _jsonExternals(o));
        string memory b = string.concat(_jsonBkrn(o), _jsonMarkets(o), _jsonRoutes(o));
        return string.concat(a, b, _jsonParams(o), _jsonBuyback(o), "}");
    }

    function _jsonHead(Opts memory o) internal view returns (string memory) {
        string memory a = string.concat(
            "\"network\":\"", o.network, "\",\"chainId\":", vm.toString(o.chainId), ",\"deployer\":", _a(deployer)
        );
        string memory b = string.concat(
            ",\"governance\":{\"multisig\":", _a(multisig), ",\"timelockMinDelay\":", vm.toString(o.delay), ",\"guardian\":", _a(guardian), "}"
        );
        string memory c = string.concat(
            ",\"treasury\":{\"expenseRecipient\":", _a(treasury), ",\"slashRecipient\":", _a(slashTreasury), "},"
        );
        return string.concat(a, b, c);
    }

    function _jsonRoles(Opts memory o) internal view returns (string memory) {
        string memory keepers = o.extraKeeper == address(0) ? _a(keeper) : string.concat(_a(keeper), ",", _a(o.extraKeeper));
        string memory a = string.concat(
            "\"roles\":{\"markSigner\":[", _a(markSigner), "],\"risk\":[", _a(risk), "],\"opsVenue\":[", _a(opsVenue), "],"
        );
        string memory b = string.concat("\"jury\":[", _a(jury), "],\"keeper\":[", keepers, "]},");
        string memory c = string.concat("\"committee\":[", _a(c0), ",", _a(c1), ",", _a(c2), "],");
        return string.concat(a, b, c);
    }

    function _jsonOracle(Opts memory o) internal view returns (string memory) {
        string memory signer = o.plainSigner
            ? string.concat("{\"signer\":", _a(oracleSigner), ",\"attestation\":", _b(o.attestation), "}")
            : string.concat(
                "{\"signer\":", _a(oracleSigner), ",\"platform\":\"INTEL_TDX\",\"measurement\":", _b(MEASUREMENT),
                ",\"quoteHash\":", _b(QUOTE_HASH), "}"
            );
        return string.concat(
            "\"oracle\":{\"measurements\":[", _b(MEASUREMENT), "],\"requireAttestations\":", o.requireAtt ? "true" : "false",
            ",\"signers\":[", signer, "]},"
        );
    }

    function _jsonExternals(Opts memory o) internal view returns (string memory) {
        string memory a = string.concat(
            "\"externals\":{\"settlementToken\":", _a(o.settlement), ",\"settlementSymbol\":\"USDG\",\"orderlyVault\":", _a(address(vault))
        );
        string memory b = string.concat(
            ",\"orderlyBrokerId\":\"bookrunner\",\"orderlyTokenSymbol\":\"USDG\",\"uniswapV3SwapRouter02\":", _a(address(router)),
            ",\"uniswapV3Factory\":", _a(o.univ3Factory)
        );
        string memory c = string.concat(
            ",\"uniswapV4Router\":\"0x0000000000000000000000000000000000000000\",\"entryPoint\":", _a(entryPoint),
            ",\"chainPriceConfig\":\"", o.withPriceConfig ? CHAIN_CFG : "", "\",\"chainlinkFeeds\":["
        );
        string memory f;
        for (uint256 i; i < 5; ++i) {
            address feed = o.mismatchFeed && i == 0 ? feeds[1] : feeds[i];
            f = string.concat(f, i == 0 ? "" : ",", "{\"symbol\":\"", syms[i], "\",\"feed\":", _a(feed), "}");
        }
        return string.concat(a, b, c, f, "]},");
    }

    function _jsonBkrn(Opts memory o) internal view returns (string memory) {
        string memory a = string.concat("\"bkrn\":{\"token\":", _a(o.bkrnToken), ",\"community\":", _a(community));
        string memory b = string.concat(
            ",\"studio\":", _a(studio), ",\"liquidity\":", _a(liquidity), ",\"contributors\":", _a(contributors), "},"
        );
        return string.concat(a, b);
    }

    function _jsonMarkets(Opts memory o) internal view returns (string memory) {
        string memory s = "\"stockTokens\":[";
        string memory comps;
        string memory src = o.storedMultipliers ? "stored" : "uiMultiplier";
        for (uint256 i; i < 5; ++i) {
            // TSLA carries a pre-approved next anchor (staged split) in live mode
            string memory next = i == 1 && !o.storedMultipliers ? ",\"nextMultiplierAnchorWad\":\"2000000000000000000\"" : "";
            s = string.concat(
                s,
                i == 0 ? "" : ",",
                string.concat("{\"symbol\":\"", syms[i], "\",\"token\":", _a(stocks[i]), ",\"priceId\":\"", syms[i], "\""),
                string.concat(",\"multiplierSource\":\"", src, "\"", next),
                ",\"multiplierWad\":\"1000000000000000000\",\"floatCapRaw\":\"1000000000000000000000000\"}"
            );
            comps = string.concat(comps, i == 0 ? "" : ",", "{\"symbol\":\"", syms[i], "\",\"weightBps\":2000}");
        }
        return string.concat(
            s,
            "],\"stockRegistry\":{\"multiplierBandBps\":300},",
            "\"indexes\":[{\"name\":\"BKRN.INDEX.RHX5\",\"priceId\":\"RHX5\",\"components\":[",
            comps,
            "]}],"
        );
    }

    function _jsonRoutes(Opts memory o) internal view returns (string memory r) {
        r = "\"hedge\":{\"routes\":[";
        for (uint256 i; i < o.nRoutes; ++i) {
            string memory one = i == 4
                ? string.concat("{\"symbol\":\"AMZN\",\"fee\":500,\"hop\":", _a(address(weth)), ",\"hopFee\":3000}")
                : string.concat("{\"symbol\":\"", syms[i], "\",\"fee\":3000}");
            r = string.concat(r, i == 0 ? "" : ",", one);
        }
        r = string.concat(r, "]},");
    }

    function _jsonParams(Opts memory o) internal pure returns (string memory) {
        string memory a = string.concat(
            "\"params\":{\"markInterval\":", vm.toString(o.markInterval), ",\"maxMarkAge\":21600,\"maxPriceAge\":300,\"maxTradePriceAge\":15,"
        );
        string memory b = string.concat(
            "\"committeeWindow\":172800,\"carryBps\":1000,\"expenseCapBps\":2000,\"charterFeeUsd\":\"5000000000\",",
            "\"sponsorBondBkrn\":\"100000000000000000000000\",\"committeeBondBkrn\":\"250000000000000000000000\","
        );
        string memory c = string.concat(
            "\"venueMinIfOrderly\":\"", vm.toString(o.minIfOrderly), "\",\"venueMinIfPoolEngine\":\"10000000000\","
        );
        string memory d = string.concat(
            "\"tiers\":{\"thresholds\":[\"50000000000\",\"250000000000\",\"1000000000000\"],",
            "\"bonds\":[\"25000000000000000000000\",\"100000000000000000000000\",\"400000000000000000000000\"]},"
        );
        string memory e =
            "\"backstopMaxCoverBps\":5000,\"stakingCooldown\":1209600,\"stakingRewardsDuration\":604800,\"oracleMinSources\":2},";
        return string.concat(a, b, c, d, e);
    }

    function _jsonBuyback(Opts memory o) internal pure returns (string memory) {
        string memory a = string.concat(
            "\"buyback\":{\"poolFee\":3000,\"refBkrnPerUsdcWad\":\"20000000000000000000\",\"maxSlippageBps\":500,",
            "\"maxPerCall\":\"250000000000\",\"bkrnPriceId\":\"", o.bkrnPriceId, "\""
        );
        string memory b = bytes(o.refSource).length == 0 ? "" : string.concat(",\"referenceSource\":\"", o.refSource, "\"");
        string memory c = o.twapPool == address(0)
            ? ""
            : string.concat(",\"twap\":{\"pool\":", _a(o.twapPool), ",\"window\":1800,\"maxTickDeviation\":200}");
        return string.concat(a, b, c, "}");
    }
}
