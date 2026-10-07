// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {CoreFixture} from "./utils/CoreFixture.sol";
import {CoreMockBook} from "./utils/CoreMocks.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {BkrnFeeRouter} from "../../src/BkrnFeeRouter.sol";
import {Backstop} from "../../src/Backstop.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {IRevenueRouter} from "../../src/interfaces/IRevenueRouter.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../../src/mocks/MockSwapRouter.sol";

/// @notice Random fee flow: settlements (acknowledged and not), distributions, buybacks, backstop draws
///         and parameter changes.
contract FeeFlowHandler is Test {
    RevenueRouter internal router;
    BkrnFeeRouter internal feeRouter;
    Backstop internal backstop;
    BookrunnerConfig internal config;
    CoreMockBook internal book;
    MockERC20 internal usdc;
    MockSwapRouter internal swap;
    address internal keeper;
    address internal admin;

    uint256 public minted;
    uint256 public distributedGross;
    uint256 public distributedExpenses;
    uint256 public distributedCarry;
    uint256 public distributedToVault;
    uint256 public buybackUsdc;
    uint256 public covered;
    uint64 internal period;

    struct Deps {
        RevenueRouter router;
        BkrnFeeRouter feeRouter;
        Backstop backstop;
        BookrunnerConfig config;
        CoreMockBook book;
        MockERC20 usdc;
        MockSwapRouter swap;
        address keeper;
        address admin;
    }

    constructor(Deps memory d) {
        router = d.router;
        feeRouter = d.feeRouter;
        backstop = d.backstop;
        config = d.config;
        book = d.book;
        usdc = d.usdc;
        swap = d.swap;
        keeper = d.keeper;
        admin = d.admin;
    }

    function settle(uint256 amount, uint8 source) external {
        amount = bound(amount, 0, 1e12);
        usdc.mint(address(router), amount);
        minted += amount;
        router.notifySettlement(uint8(bound(source, 0, 4)), amount);
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 0, 1e12);
        usdc.mint(address(router), amount);
        minted += amount;
    }

    function distribute(uint256 expenses) external {
        vm.prank(keeper);
        IRevenueRouter.Amounts memory a = router.distribute(++period, bound(expenses, 0, 1e16));
        distributedGross += a.gross;
        distributedExpenses += a.expenses;
        distributedCarry += a.carry;
        distributedToVault += a.senior + a.junior;
    }

    function buyback(uint256 amountIn) external {
        uint256 pending = feeRouter.buybackPending();
        if (pending == 0) return;
        uint256 cap = feeRouter.maxBuybackPerCall();
        amountIn = bound(amountIn, 1, pending < cap ? pending : cap);
        uint256 q = swap.quote(address(usdc), address(feeRouter.bkrn()), amountIn);
        if (q == 0) return;
        vm.prank(keeper);
        feeRouter.executeBuyback(amountIn, q);
        buybackUsdc += amountIn;
    }

    function cover(uint256 shortfall) external {
        shortfall = bound(shortfall, 0, 1e15);
        covered += book.coverFrom(address(backstop), 1, shortfall);
    }

    function setParams(uint256 carry, uint256 cap, uint256 hurdle) external {
        vm.startPrank(admin);
        config.setParam("carryBps", bound(carry, 0, 10_000));
        config.setParam("expenseCapBps", bound(cap, 0, 10_000));
        vm.stopPrank();
        book.setHurdle(uint16(bound(hurdle, 0, 10_000)));
    }
}

contract FeeFlowInvariantTest is CoreFixture {
    FeeFlowHandler internal handler;

    function setUp() public override {
        super.setUp();
        senior.mint(address(senior), 700_000e6);
        junior.mint(address(junior), 300_000e6);
        _stake(alice, 1e18);
        // effectively unlimited BKRN liquidity for random buybacks
        vm.prank(community);
        bkrn.transfer(address(swapRouter), 700_000_000e18);
        handler = new FeeFlowHandler(
            FeeFlowHandler.Deps({
                router: router,
                feeRouter: feeRouter,
                backstop: backstop,
                config: config,
                book: book,
                usdc: usdc,
                swap: swapRouter,
                keeper: keeper,
                admin: admin
            })
        );
        targetContract(address(handler));
    }

    /// @dev Every USDC unit minted into the system is in exactly one place.
    function invariant_usdcConserved() public view {
        uint256 sum = usdc.balanceOf(address(router)) + usdc.balanceOf(address(feeRouter))
            + usdc.balanceOf(address(backstop)) + usdc.balanceOf(vault) + usdc.balanceOf(expenseRecipient)
            + usdc.balanceOf(address(swapRouter));
        assertEq(sum, handler.minted());
    }

    /// @dev Router: acknowledged-but-undistributed USDC is always held; each leg went where it should.
    function invariant_routerAccounting() public view {
        assertGe(usdc.balanceOf(address(router)), router.pendingGross());
        assertEq(
            handler.distributedGross(),
            handler.distributedExpenses() + handler.distributedCarry() + handler.distributedToVault()
        );
        assertEq(usdc.balanceOf(expenseRecipient), handler.distributedExpenses());
        assertEq(usdc.balanceOf(vault), handler.distributedToVault() + handler.covered());
        uint256[5] memory t = router.totals();
        assertEq(t[0], handler.distributedGross());
        assertEq(book.creditedSenior() + book.creditedJunior(), handler.distributedToVault());
    }

    /// @dev Fee router: carry split 50/50 (odd unit to backstop), pending always held.
    function invariant_carrySplit() public view {
        assertEq(feeRouter.totalCarryReceived(), handler.distributedCarry());
        uint256 toBuyback = feeRouter.totalCarryReceived() - feeRouter.totalToBackstop();
        assertLe(toBuyback, feeRouter.totalToBackstop());
        assertEq(feeRouter.buybackPending(), toBuyback - handler.buybackUsdc());
        assertEq(usdc.balanceOf(address(feeRouter)), feeRouter.buybackPending());
        assertEq(usdc.balanceOf(address(swapRouter)), handler.buybackUsdc());
    }

    /// @dev Backstop: pays only what it holds; balance == deposits - cover.
    function invariant_backstop() public view {
        assertEq(backstop.totalCovered(), handler.covered());
        assertEq(backstop.balance(), feeRouter.totalToBackstop() - handler.covered());
        assertLe(backstop.accountedBalance(), backstop.balance());
    }

    /// @dev Staking stays solvent with buyback rewards.
    function invariant_stakingSolvent() public view {
        assertGe(bkrn.balanceOf(address(staking)), staking.totalStaked() + staking.rewardReserve());
        assertLe(staking.earned(alice) + staking.queuedReward(), staking.rewardReserve());
    }
}
