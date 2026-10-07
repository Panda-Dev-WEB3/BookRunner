// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {BookrunnerConfig} from "../../../src/BookrunnerConfig.sol";
import {BkrnToken} from "../../../src/BkrnToken.sol";
import {BkrnStaking} from "../../../src/BkrnStaking.sol";
import {BkrnFeeRouter} from "../../../src/BkrnFeeRouter.sol";
import {Backstop} from "../../../src/Backstop.sol";
import {MarkRegistry} from "../../../src/MarkRegistry.sol";
import {RevenueRouter} from "../../../src/RevenueRouter.sol";
import {MockSwapRouter} from "../../../src/mocks/MockSwapRouter.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {CoreMockFactory, CoreMockBook} from "./CoreMocks.sol";

/// @notice Deploys the A-core contracts against a mock factory/book, with devnet-like roles.
abstract contract CoreFixture is Test {
    address internal admin = makeAddr("admin"); // timelock
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal risk = makeAddr("risk");
    address internal expenseRecipient = makeAddr("expenseRecipient");
    address internal slashRecipient = makeAddr("slashRecipient");
    address internal community = makeAddr("community");
    address internal studio = makeAddr("studio");
    address internal liquidity = makeAddr("liquidity");
    address internal contributors = makeAddr("contributors");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal locker = makeAddr("locker");
    address internal locker2 = makeAddr("locker2");

    uint256 internal markSignerPk = 0xA11CE;
    address internal markSigner;

    BookrunnerConfig internal config;
    MockERC20 internal usdc;
    BkrnToken internal bkrn;
    BkrnStaking internal staking;
    BkrnFeeRouter internal feeRouter;
    Backstop internal backstop;
    MarkRegistry internal registry;
    CoreMockFactory internal factory;
    MockSwapRouter internal swapRouter;
    RevenueRouter internal routerImpl;

    // book #1
    uint256 internal constant BOOK_ID = 1;
    CoreMockBook internal book;
    MockERC20 internal senior;
    MockERC20 internal junior;
    address internal vault = makeAddr("vault");
    RevenueRouter internal router;

    function setUp() public virtual {
        markSigner = vm.addr(markSignerPk);
        vm.warp(1_000_000_000);

        config = new BookrunnerConfig(admin);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        bkrn = new BkrnToken(community, studio, liquidity, contributors);
        factory = new CoreMockFactory();

        vm.startPrank(admin);
        config.setAddress("usdc", address(usdc));
        config.setAddress("bkrn", address(bkrn));
        config.setAddress("factory", address(factory));
        config.setAddress("expenseRecipient", expenseRecipient);
        config.setAddress("slashRecipient", slashRecipient);
        vm.stopPrank();

        staking = new BkrnStaking(address(config));
        feeRouter = new BkrnFeeRouter(address(config));
        backstop = new Backstop(address(config));
        registry = new MarkRegistry(address(config));
        swapRouter = new MockSwapRouter(admin);
        routerImpl = new RevenueRouter();

        vm.startPrank(admin);
        config.setAddress("staking", address(staking));
        config.setAddress("feeRouter", address(feeRouter));
        config.setAddress("backstop", address(backstop));
        config.setAddress("markRegistry", address(registry));
        config.grantRole(config.GUARDIAN_ROLE(), guardian);
        config.grantRole(config.KEEPER_ROLE(), keeper);
        config.grantRole(config.RISK_ROLE(), risk);
        config.grantRole(config.MARK_SIGNER_ROLE(), markSigner);
        feeRouter.setBuybackRouter(address(swapRouter));
        // pinned 0.3% tier; reference 20 BKRN per USDC, 5% max slippage, 10M USDC per call
        feeRouter.setBuybackParams(3000, 20e18, 500, 10_000_000e6);
        // 1 USDC buys 20 BKRN ($0.05 / BKRN)
        swapRouter.setPriceBoth(address(usdc), address(bkrn), 20e18);
        staking.setLocker(locker, true);
        staking.setLocker(locker2, true);
        vm.stopPrank();

        // BKRN liquidity for buybacks
        vm.prank(liquidity);
        bkrn.transfer(address(swapRouter), 10_000_000e18);

        (book, senior, junior, router) = _deployBook(BOOK_ID, 6000, vault);
    }

    function _deployBook(uint256 id, uint16 hurdle, address vault_)
        internal
        returns (CoreMockBook b, MockERC20 s, MockERC20 j, RevenueRouter r)
    {
        b = new CoreMockBook();
        s = new MockERC20("BKRN TEST Senior", "sTEST", 6);
        j = new MockERC20("BKRN TEST Junior", "jTEST", 6);
        r = RevenueRouter(Clones.clone(address(routerImpl)));
        r.initialize(address(config), id, address(b));
        BRTypes.BookComponents memory c = BRTypes.BookComponents({
            book: address(b),
            senior: address(s),
            junior: address(j),
            vault: vault_,
            mandate: address(0),
            router: address(r),
            desk: address(0),
            adapter: address(0)
        });
        b.setComponents(c);
        b.setHurdle(hurdle);
        factory.register(id, c);
    }

    function _giveBkrn(address to, uint256 amount) internal {
        vm.prank(community);
        bkrn.transfer(to, amount);
    }

    function _stake(address who, uint256 amount) internal {
        _giveBkrn(who, amount);
        vm.startPrank(who);
        bkrn.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    /// @dev Push `amount` USDC of fee flow into `r` and acknowledge it.
    function _settle(RevenueRouter r, uint256 amount) internal {
        usdc.mint(address(r), amount);
        r.notifySettlement(BRTypes.SRC_ENGINE_FEES, amount);
    }
}
