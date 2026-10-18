// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOrderlyVault} from "../../src/mocks/MockOrderlyVault.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";
import {OrderlyVaultAllowListMock} from "../mocks/OrderlyVaultAllowListMock.sol";

/// @dev Runs Deploy.s.sol's steps in-process (no broadcast, no file). The live-venue inputs are set directly (no
///      vm.setEnv: env is process-wide and would leak into tests running in parallel).
contract LiveVenueDeployHarness is Deploy {
    function configure(address vault, address token, string memory symbol, string memory broker) external {
        liveVault = vault;
        liveToken = token;
        tokenSymbol = symbol;
        TOKEN_HASH = keccak256(bytes(symbol));
        brokerId = broker;
        BROKER_HASH = keccak256(bytes(broker));
    }

    function setCharterFee(uint256 fee) external {
        charterFeeUsd = fee; // what DEPLOY_CHARTER_FEE_USD sets
    }

    /// @dev run() without the broadcast and the file write (the same _prepare / _deploySteps); returns the record JSON.
    function deployAll() external returns (string memory) {
        _prepare(vm.deriveKey(DEFAULT_MNEMONIC, 0), DEFAULT_MNEMONIC);
        vm.startPrank(deployer);
        _deploySteps(300);
        vm.stopPrank();
        return _deploymentJson();
    }

    function cfg() external view returns (BookrunnerConfig) {
        return config;
    }

    function router() external view returns (MockSwapRouter) {
        return swapRouter;
    }

    function orderlyImpl() external view returns (OrderlyAdapter) {
        return OrderlyAdapter(payable(factory.implementation(factory.ORDERLY_ADAPTER())));
    }
}

/// @notice VERIFY O17 / RUNBOOK "Testnet rehearsal on real Orderly": Deploy.s.sol with DEPLOY_ORDERLY_VAULT +
///         DEPLOY_SETTLEMENT_TOKEN binds to the real vault and settles everything in its token, with no MockOrderlyVault
///         and no mock settlement token; refused unless the vault allows that token (getAllowedToken) and our broker.
contract DeployLiveVenueTest is Test {
    using stdJson for string;

    MockERC20 internal usdg;
    OrderlyVaultAllowListMock internal vault;
    bytes32 internal constant USDG_HASH = keccak256("USDG");
    bytes32 internal constant BROKER = keccak256("bookrunner");

    function setUp() public {
        usdg = new MockERC20("Global Dollar (testnet stand-in)", "USDG", 6);
        vault = new OrderlyVaultAllowListMock();
        vault.changeTokenAddressAndAllow(USDG_HASH, address(usdg));
        vault.setAllowedBroker(BROKER, true);
    }

    function _harness(address v, address t, string memory sym) internal returns (LiveVenueDeployHarness h) {
        h = new LiveVenueDeployHarness();
        h.configure(v, t, sym, "bookrunner");
    }

    function test_liveVenue_bindsTheRealVaultAndToken_noMocks() public {
        LiveVenueDeployHarness h = _harness(address(vault), address(usdg), "USDG");
        string memory json = h.deployAll();
        BookrunnerConfig c = h.cfg();
        assertEq(c.usdc(), address(usdg), "config.usdc() = the venue's token (protocol-wide settlement)");
        assertEq(c.orderlyVault(), address(vault), "config.orderlyVault() = the real vault");
        assertEq(h.orderlyImpl().DEFAULT_TOKEN_HASH(), USDG_HASH, "adapter impl hashed from USDG");
        assertEq(h.orderlyImpl().DEFAULT_BROKER_HASH(), BROKER, "adapter impl hashed from bookrunner");
        assertFalse(h.router().mintOnDemand(address(usdg)), "the real token is never minted by the router");
        assertEq(h.router().usdPriceOf(address(usdg)), 1e18);
        // record: no mock settlement token / vault anywhere
        assertEq(json.readAddress(".contracts.usdc"), address(usdg));
        assertEq(json.readAddress(".contracts.usdg"), address(usdg));
        assertEq(json.readAddress(".contracts.orderlyVault"), address(vault));
        assertEq(json.readString(".orderly.venue"), "live");
        assertEq(json.readAddress(".orderly.vault"), address(vault));
        assertEq(json.readString(".orderly.brokerId"), "bookrunner");
        assertEq(json.readString(".orderly.token"), "USDG");
        assertEq(json.readAddress(".orderly.settlementToken"), address(usdg));
        // the vault the adapters will call is not a MockOrderlyVault (no operator / PnL mint path)
        (bool ok,) = address(vault).staticcall(abi.encodeWithSignature("isOperator(address)", address(this)));
        assertFalse(ok, "no MockOrderlyVault surface");
    }

    function test_mockVenue_isTheDefault_unchanged() public {
        LiveVenueDeployHarness h = new LiveVenueDeployHarness(); // no DEPLOY_ORDERLY_VAULT / DEPLOY_SETTLEMENT_TOKEN
        string memory json = h.deployAll();
        BookrunnerConfig c = h.cfg();
        MockOrderlyVault mv = MockOrderlyVault(c.orderlyVault());
        assertEq(address(mv.token()), c.usdc(), "mock vault takes the mock USDC");
        assertEq(mv.tokenHash(), keccak256("USDC"));
        assertTrue(h.router().mintOnDemand(c.usdc()), "mock USDC minted on demand");
        assertTrue(json.readAddress(".contracts.usdg") != c.usdc(), "separate mock USDG");
        assertEq(json.readString(".orderly.venue"), "mock");
        assertEq(json.readString(".orderly.token"), "USDC");
        assertEq(c.charterFeeUsd(), 5000e6, "charter fee default");
    }

    function test_refused_whenTheVaultAllowsNoToken() public {
        // RH testnet today: getAllowedToken(keccak256("USDG")) == 0x0
        vault.setAllowedToken(USDG_HASH, false);
        LiveVenueDeployHarness h = _harness(address(vault), address(usdg), "USDG");
        vm.expectRevert(
            bytes("Deploy.s.sol: vault.getAllowedToken(keccak256(DEPLOY_ORDERLY_TOKEN)) != DEPLOY_SETTLEMENT_TOKEN (VERIFY O3/O7)")
        );
        h.deployAll();
    }

    function test_refused_whenTheTokenSymbolOrAddressDiffers() public {
        LiveVenueDeployHarness h = _harness(address(vault), address(usdg), "USDC"); // hash of the wrong symbol
        vm.expectRevert(
            bytes("Deploy.s.sol: vault.getAllowedToken(keccak256(DEPLOY_ORDERLY_TOKEN)) != DEPLOY_SETTLEMENT_TOKEN (VERIFY O3/O7)")
        );
        h.deployAll();
        MockERC20 other = new MockERC20("Other", "USDG", 6);
        h = _harness(address(vault), address(other), "USDG"); // allowed token is another contract
        vm.expectRevert(
            bytes("Deploy.s.sol: vault.getAllowedToken(keccak256(DEPLOY_ORDERLY_TOKEN)) != DEPLOY_SETTLEMENT_TOKEN (VERIFY O3/O7)")
        );
        h.deployAll();
    }

    function test_refused_whenTheBrokerIsNotAllowed() public {
        vault.setAllowedBroker(BROKER, false);
        LiveVenueDeployHarness h = _harness(address(vault), address(usdg), "USDG");
        vm.expectRevert(bytes("Deploy.s.sol: vault.getAllowedBroker(keccak256(DEPLOY_ORDERLY_BROKER_ID)) is false (VERIFY O7)"));
        h.deployAll();
    }

    function test_refused_badTokenOrVaultOrPairing() public {
        MockERC20 eighteen = new MockERC20("USDG18", "USDG", 18);
        vault.changeTokenAddressAndAllow(USDG_HASH, address(eighteen));
        LiveVenueDeployHarness h = _harness(address(vault), address(eighteen), "USDG");
        vm.expectRevert(bytes("Deploy.s.sol: settlement token decimals != 6"));
        h.deployAll();

        h = _harness(address(0xBEEF), address(usdg), "USDG");
        vm.expectRevert(bytes("Deploy.s.sol: DEPLOY_ORDERLY_VAULT has no code"));
        h.deployAll();

        h = _harness(address(vault), address(0xBEEF), "USDG");
        vm.expectRevert(bytes("Deploy.s.sol: DEPLOY_SETTLEMENT_TOKEN has no code"));
        h.deployAll();

        h = _harness(address(vault), address(0), "USDG");
        vm.expectRevert(bytes("Deploy.s.sol: DEPLOY_ORDERLY_VAULT and DEPLOY_SETTLEMENT_TOKEN go together (VERIFY O17)"));
        h.deployAll();
        h = _harness(address(0), address(usdg), "USDG");
        vm.expectRevert(bytes("Deploy.s.sol: DEPLOY_ORDERLY_VAULT and DEPLOY_SETTLEMENT_TOKEN go together (VERIFY O17)"));
        h.deployAll();
    }

    function test_refused_onAnotherChain() public {
        vm.chainId(4663);
        LiveVenueDeployHarness h = _harness(address(vault), address(usdg), "USDG");
        vm.expectRevert(bytes("Deploy.s.sol: live venue on devnet / testnet only"));
        h.deployAll();
    }

    function test_charterFee_override() public {
        // DEPLOY_CHARTER_FEE_USD: the live-venue rehearsal pays its charter fee in real testnet USDG (deploy-testnet.sh: 10)
        LiveVenueDeployHarness h = _harness(address(vault), address(usdg), "USDG");
        h.setCharterFee(10e6);
        h.deployAll();
        assertEq(h.cfg().charterFeeUsd(), 10e6);
        LiveVenueDeployHarness m = new LiveVenueDeployHarness(); // mock venue: the override applies on any network
        m.setCharterFee(1e6);
        m.deployAll();
        assertEq(m.cfg().charterFeeUsd(), 1e6);
    }

    function test_testnet_liveVenue_keepsTheTestnetMinIf() public {
        vm.chainId(46630);
        LiveVenueDeployHarness h = _harness(address(vault), address(usdg), "USDG");
        h.deployAll();
        assertEq(h.cfg().venueMinIfUsd(0), 101e6, "> 100 USDG per market on Orderly testnet");
    }
}
