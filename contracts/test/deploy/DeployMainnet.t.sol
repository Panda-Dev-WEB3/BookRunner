// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployMainnet} from "../../script/DeployMainnet.s.sol";
import {VerifyHandover} from "../../script/VerifyHandover.s.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {BookFactory} from "../../src/BookFactory.sol";
import {StockTokenRegistry} from "../../src/StockTokenRegistry.sol";
import {BkrnToken} from "../../src/BkrnToken.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOrderlyVault} from "../../src/mocks/MockOrderlyVault.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";

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
}

/// @notice End-to-end (simulated) mainnet deploy: JSON input -> DeployMainnet (no mocks deployed by the script;
///         the externals are test stand-ins at the input's addresses) -> deployments JSON -> VerifyHandover.
contract DeployMainnetTest is Test {
    struct Opts {
        string network;
        uint256 chainId;
        uint256 delay;
        uint256 minIfOrderly;
        uint256 markInterval;
        address settlement;
        address bkrnToken;
        address extraKeeper;
        bytes32 attestation;
    }

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
    MockOrderlyVault internal vault;
    MockSwapRouter internal router;
    address internal entryPoint;
    address[5] internal stocks;
    address[5] internal feeds;
    string[5] internal syms = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"];

    function setUp() public {
        vm.chainId(4663);
        multisig = address(new CodeStub());
        entryPoint = address(new CodeStub());
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        vault = new MockOrderlyVault(address(this), address(usdg), keccak256("USDG"), keccak256("bookrunner"));
        router = new MockSwapRouter(address(this));
        for (uint256 i; i < 5; ++i) {
            stocks[i] = address(new MockERC20(string.concat(syms[i], " Stock Token"), syms[i], 18));
            feeds[i] = address(new FeedStub());
        }
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

    /// The real entry points: DeployMainnet.run() (input file -> dry-run record) then VerifyHandover.run().
    function test_run_entrypoints_from_files() public {
        string memory input = string.concat(vm.projectRoot(), "/deployments/test-run-input.json");
        string memory sim = string.concat(vm.projectRoot(), "/deployments/4663.simulation.json");
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        vm.writeFile(input, _json(_mainnetOpts()));
        vm.setEnv("DEPLOY_INPUT", "deployments/test-run-input.json");
        new DeployMainnet().run(); // test context = dry run: writes the .simulation.json record
        assertTrue(vm.exists(sim));
        vm.setEnv("DEPLOY_OUT", "deployments/4663.simulation.json");
        new VerifyHandover().run(); // reverts if any post-condition fails
        vm.setEnv("DEPLOY_INPUT", "");
        vm.setEnv("DEPLOY_OUT", "");
        vm.removeFile(input);
        vm.removeFile(sim);
    }

    function test_rehearsal_on_46630_same_path() public {
        vm.chainId(46630);
        Opts memory o = _mainnetOpts();
        o.network = "rehearsal";
        o.chainId = 46630;
        o.delay = 300; // a rehearsal may use a short delay; mainnet floors do not apply
        o.minIfOrderly = 100e6; // testnet IF requirement
        o.markInterval = 3600;
        (, uint256 failures) = _deployAndVerify(o, "rehearsal");
        assertEq(failures, 0);
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

    // ------------------------------------------------------------------------------------------- input gates

    function test_example_input_parses_and_is_refused_until_filled() public {
        DeployMainnetHarness s = new DeployMainnetHarness();
        s.loadInput(vm.readFile(string.concat(vm.projectRoot(), "/deploy-inputs/4663.example.json")));
        _assertExampleHead(s);
        _assertExampleMarkets(s);
        assertEq(s.brokerHash(), keccak256("bookrunner"));
        assertEq(s.tokenHash(), keccak256("USDG"));
        vm.expectRevert(bytes("input: deployer is still a placeholder"));
        s.validateInput();
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

    function test_chain_gate() public {
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
        o.attestation = bytes32(0);
        _expectValidateRevert(o, "input: oracle signer attestation is 0 (VERIFY E1)");
    }

    function test_refuses_mismatched_network() public {
        Opts memory o = _mainnetOpts();
        o.network = "rehearsal";
        _expectValidateRevert(o, "input: network/chainId must be mainnet/4663 or rehearsal/46630");
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

    // ------------------------------------------------------------------------------------------- helpers

    function _mainnetOpts() internal view returns (Opts memory o) {
        o.network = "mainnet";
        o.chainId = 4663;
        o.delay = 48 hours;
        o.minIfOrderly = 25_001e6;
        o.markInterval = 86_400;
        o.settlement = address(usdg);
        o.attestation = keccak256("tee-quote");
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
            ",\"governance\":{\"deployer\":\"",
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

    function _a(address a) internal pure returns (string memory) {
        return string.concat("\"", vm.toString(a), "\"");
    }

    function _json(Opts memory o) internal view returns (string memory) {
        return string.concat(
            "{",
            _jsonHead(o),
            _jsonRoles(o),
            _jsonExternals(o),
            _jsonBkrn(o),
            _jsonMarkets(),
            _jsonParams(o),
            "}"
        );
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
        string memory d = string.concat(
            "\"oracle\":{\"signers\":[{\"signer\":", _a(oracleSigner), ",\"attestation\":\"", vm.toString(o.attestation), "\"}]},"
        );
        return string.concat(a, b, c, d);
    }

    function _jsonExternals(Opts memory o) internal view returns (string memory) {
        string memory a = string.concat(
            "\"externals\":{\"settlementToken\":", _a(o.settlement), ",\"settlementSymbol\":\"USDG\",\"orderlyVault\":", _a(address(vault))
        );
        string memory b = string.concat(
            ",\"orderlyBrokerId\":\"bookrunner\",\"orderlyTokenSymbol\":\"USDG\",\"uniswapV3SwapRouter02\":", _a(address(router))
        );
        string memory c = string.concat(
            ",\"uniswapV4Router\":\"0x0000000000000000000000000000000000000000\",\"entryPoint\":", _a(entryPoint), ",\"chainlinkFeeds\":["
        );
        string memory f;
        for (uint256 i; i < 5; ++i) {
            f = string.concat(f, i == 0 ? "" : ",", "{\"symbol\":\"", syms[i], "\",\"feed\":", _a(feeds[i]), "}");
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

    function _jsonMarkets() internal view returns (string memory) {
        string memory s = "\"stockTokens\":[";
        string memory comps;
        for (uint256 i; i < 5; ++i) {
            s = string.concat(
                s,
                i == 0 ? "" : ",",
                string.concat("{\"symbol\":\"", syms[i], "\",\"token\":", _a(stocks[i]), ",\"priceId\":\"", syms[i], "\""),
                ",\"multiplierWad\":\"1000000000000000000\",\"floatCapRaw\":\"1000000000000000000000000\"}"
            );
            comps = string.concat(comps, i == 0 ? "" : ",", "{\"symbol\":\"", syms[i], "\",\"weightBps\":2000}");
        }
        return string.concat(
            s, "],\"indexes\":[{\"name\":\"BKRN.INDEX.RHX5\",\"priceId\":\"RHX5\",\"components\":[", comps, "]}],"
        );
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
        string memory e = string.concat(
            "\"backstopMaxCoverBps\":5000,\"stakingCooldown\":1209600,\"stakingRewardsDuration\":604800,\"oracleMinSources\":2},",
            "\"buyback\":{\"poolFee\":3000,\"refBkrnPerUsdcWad\":\"20000000000000000000\",\"maxSlippageBps\":500,",
            "\"maxPerCall\":\"250000000000\",\"bkrnPriceId\":\"BKRN\"}"
        );
        return string.concat(a, b, c, d, e);
    }
}
