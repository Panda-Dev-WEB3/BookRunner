// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test-only fixtures for the bookrunner-agent chain smoke test (BKRN_IT=1). They reproduce the
// frozen interface signatures the agent calls (IBookrunnerDesk.execute, IPoolEngineAdapter views,
// IPoolEngine state/config/positionOf/quotePrice/depositMargin/trade + Trade event, MockERC20) with
// deliberately simplified semantics. Never deployed outside the private test anvil.
// Low-gas entry points (docs/LOW_GAS.md §1, binding signatures): BookrunnerDesk.executeWithPrices(Action,
// priceData), PoolEngine.trade(..., priceData) with the maxTradePriceAge bound on every trade, closes
// included (reverting StalePrice / OffHours on a held price like the real engine, audit A2-01 / A2-03)
// and liquidate(..., priceData). Both relay to the REAL AttestedOracle
// (deployed by the IT from contracts/out) through IPullOracle, so the shared encodePriceData / the
// oracle service's signatures are verified by the production contract. Semantics simplified, signatures exact.

/// The AttestedOracle surface the fixtures consume (IAttestedOracle.update / latest).
interface IPullOracle {
    struct PriceData {
        uint256 priceWad;
        uint64 publishedAt;
        bool held;
        uint32 sourceCount;
    }

    function update(bytes calldata priceData) external;
    function latest(bytes32 underlying) external view returns (PriceData memory);
}

contract FixtureUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public constant decimals = 6;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FixtureEngine {
    struct MarketConfig {
        bytes32 underlying;
        bytes32 symbol;
        uint16 takerFeeBps;
        uint16 makerFeeBps;
        uint16 initialMarginBps;
        uint16 maintenanceMarginBps;
        uint16 liquidationFeeBps;
        uint32 fundingVelocityBps;
        uint128 maxNetExposureUsd;
    }

    struct MarketState {
        uint16 spreadBps;
        int16 skewBps;
        bool reduceOnly;
        int256 longSize;
        int256 shortSize;
        uint256 poolCashUsd;
        uint256 insuranceUsd;
        uint256 feesAccruedUsd;
        int256 fundingIndex;
    }

    struct Position {
        int256 size;
        uint256 entryPriceWad;
        uint256 marginUsd;
        int256 fundingIndexAtEntry;
    }

    event Trade(uint256 indexed marketId, address indexed trader, int256 sizeDelta, uint256 fillPriceWad, uint256 feeUsd, int256 realizedPnlUsd, int256 newSize);
    event Liquidated(uint256 indexed marketId, address indexed trader, address indexed liquidator, int256 size, uint256 priceWad);

    error MaxNetExposure(uint256 attemptedUsd, uint256 maxUsd);
    error WorsePrice(uint256 fill, uint256 acceptable);
    error StalePrice(bytes32 underlying, uint64 publishedAt);
    error OffHours(uint256 marketId);
    error NoPosition(address trader);
    error NotLiquidatable(address trader);

    FixtureUSDC public immutable usdc;
    uint256 public priceWad = 100e18;
    MarketConfig internal cfg;
    MarketState internal st;
    mapping(address => Position) internal pos;
    /// pull-oracle mode (set by setOracle): trades / liquidations price from the oracle after the in-tx update
    IPullOracle public oracle;
    uint64 internal pricePublishedAt;
    bool internal priceHeld;
    /// BookrunnerConfig.maxTradePriceAge default: every trade needs a price at most this old
    uint256 public constant MAX_TRADE_PRICE_AGE = 15;

    constructor(FixtureUSDC usdc_) {
        usdc = usdc_;
        cfg.takerFeeBps = 5;
        cfg.maintenanceMarginBps = 500;
        cfg.maxNetExposureUsd = 75_000e6;
        st.spreadBps = 10;
        st.poolCashUsd = 100_000e6;
    }

    function setOracle(IPullOracle o, bytes32 underlying) external {
        oracle = o;
        cfg.underlying = underlying;
    }

    /// pull: oracle.update(priceData) first (when non-empty), then price from the stored oracle value
    function _pullPrice(bytes calldata priceData) internal {
        if (address(oracle) == address(0)) return;
        if (priceData.length > 0) oracle.update(priceData);
        _storedPrice();
    }

    function _storedPrice() internal {
        if (address(oracle) == address(0)) return;
        IPullOracle.PriceData memory d = oracle.latest(cfg.underlying);
        priceWad = d.priceWad;
        pricePublishedAt = d.publishedAt;
        priceHeld = d.held;
    }

    function trade(uint256 marketId, int256 sizeDelta, uint256 acceptablePriceWad, bytes calldata priceData)
        external
        returns (uint256 fill, uint256 fee)
    {
        _pullPrice(priceData);
        return _trade(marketId, sizeDelta, acceptablePriceWad);
    }

    function liquidate(uint256 marketId, address trader, bytes calldata priceData) external returns (uint256) {
        _pullPrice(priceData);
        return _liquidate(marketId, trader);
    }

    function liquidate(uint256 marketId, address trader) external returns (uint256) {
        _storedPrice();
        return _liquidate(marketId, trader);
    }

    function _liquidate(uint256 marketId, address trader) internal returns (uint256) {
        Position storage p = pos[trader];
        if (p.size == 0) revert NoPosition(trader);
        int256 equity = int256(p.marginUsd) + (p.size * (int256(priceWad) - int256(p.entryPriceWad))) / 1e30;
        uint256 required = (uint256(_abs(p.size)) * priceWad / 1e30) * cfg.maintenanceMarginBps / 10_000;
        if (equity >= int256(required)) revert NotLiquidatable(trader);
        if (p.size > 0) st.longSize -= p.size;
        else st.shortSize -= p.size;
        emit Liquidated(marketId, trader, msg.sender, p.size, priceWad);
        p.size = 0;
        p.marginUsd = equity > 0 ? uint256(equity) : 0;
        return 0;
    }

    function setQuote(uint256, uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd) external {
        st.spreadBps = spreadBps;
        st.skewBps = skewBps;
        cfg.maxNetExposureUsd = maxNetExposureUsd;
    }

    function config(uint256) external view returns (MarketConfig memory) {
        return cfg;
    }

    function state(uint256) external view returns (MarketState memory) {
        return st;
    }

    function positionOf(uint256, address trader) external view returns (Position memory) {
        return pos[trader];
    }

    function netSize() public view returns (int256) {
        return -(st.longSize + st.shortSize);
    }

    function netExposureUsd(uint256) public view returns (int256) {
        return (netSize() * int256(priceWad)) / 1e30;
    }

    function poolEquityUsd(uint256) external view returns (int256) {
        return int256(st.poolCashUsd);
    }

    function quotePrice(uint256, int256 sizeDelta) public view returns (uint256) {
        int256 bps = int256(10_000) + int256(st.skewBps) + (sizeDelta > 0 ? int256(uint256(st.spreadBps)) / 2 : -int256(uint256(st.spreadBps)) / 2);
        return (priceWad * uint256(bps)) / 10_000;
    }

    function depositMargin(uint256, uint256 amount) external {
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer");
        pos[msg.sender].marginUsd += amount;
    }

    function trade(uint256 marketId, int256 sizeDelta, uint256 acceptablePriceWad) external returns (uint256 fill, uint256 fee) {
        _storedPrice();
        return _trade(marketId, sizeDelta, acceptablePriceWad);
    }

    function _trade(uint256 marketId, int256 sizeDelta, uint256 acceptablePriceWad) internal returns (uint256 fill, uint256 fee) {
        Position storage p = pos[msg.sender];
        int256 newSize = p.size + sizeDelta;
        bool newRisk = _abs(newSize) > _abs(p.size);
        // the latency-arbitrage bound (both trade entry points): every trade on a recent, live price
        if (address(oracle) != address(0)) {
            if (priceHeld) revert OffHours(marketId);
            if (uint256(pricePublishedAt) + MAX_TRADE_PRICE_AGE < block.timestamp) {
                revert StalePrice(cfg.underlying, pricePublishedAt);
            }
        }
        fill = quotePrice(marketId, sizeDelta);
        if (sizeDelta > 0 ? fill > acceptablePriceWad : fill < acceptablePriceWad) revert WorsePrice(fill, acceptablePriceWad);
        if (sizeDelta > 0) st.longSize += sizeDelta;
        else st.shortSize += sizeDelta;
        uint256 exposure = uint256(_abs(netExposureUsd(marketId)));
        if (newRisk && exposure > cfg.maxNetExposureUsd) revert MaxNetExposure(exposure, cfg.maxNetExposureUsd);
        p.size = newSize;
        p.entryPriceWad = fill;
        fee = (uint256(_abs(sizeDelta)) * fill / 1e30) * cfg.takerFeeBps / 10_000;
        st.feesAccruedUsd += fee;
        emit Trade(marketId, msg.sender, sizeDelta, fill, fee, 0, newSize);
    }

    function _abs(int256 x) internal pure returns (int256) {
        return x < 0 ? -x : x;
    }
}

contract FixtureAdapter {
    FixtureEngine public immutable engine;
    address public desk;

    constructor(FixtureEngine engine_) {
        engine = engine_;
    }

    function setDesk(address d) external {
        desk = d;
    }

    function marketId() external pure returns (uint256) {
        return 1;
    }

    function netExposureUsd() external view returns (int256) {
        return engine.netExposureUsd(1);
    }

    function marginEquityUsd() external view returns (int256) {
        return engine.poolEquityUsd(1);
    }

    function insuranceEquityUsd() external pure returns (uint256) {
        return 25_000e6;
    }

    function valuationAt() external view returns (uint64) {
        return uint64(block.timestamp);
    }

    function setQuote(uint16 spreadBps, int16 skewBps, uint128 maxNetExposureUsd) external {
        require(msg.sender == desk, "only desk");
        engine.setQuote(1, spreadBps, skewBps, maxNetExposureUsd);
    }
}

contract FixtureDesk {
    enum ActionKind {
        Hedge,
        InventoryToVenue,
        InventoryToVault,
        FundDesk,
        ReturnToVault,
        SetQuote,
        Flatten
    }

    struct Action {
        ActionKind kind;
        bytes data;
        bytes32[] proof;
    }

    event ActionExecuted(address indexed key, ActionKind indexed kind, bytes data);

    error NotDeskKey(address key);
    error QuoteWidthTooNarrow(uint16 widthBps, uint16 minBps);
    error SkewTooWide(int16 skewBps, int16 maxBps);
    error InventoryLimit(uint256 attemptedUsd, uint256 maxUsd);
    error OffHoursNewRisk();

    FixtureAdapter public immutable adapter;
    address public immutable key;
    uint16 public constant MIN_WIDTH = 10;
    int16 public constant MAX_SKEW = 25;
    uint128 public constant MAX_INVENTORY = 75_000e6;
    /// config.maxPriceAge: the mandate's off-hours rule (stored price held / older than this)
    uint256 public constant MAX_PRICE_AGE = 300;
    /// pull-oracle mode (set by setOracle): a SetQuote needs an in-hours stored price, like mandate.checkQuote
    IPullOracle public oracle;
    bytes32 public underlying;

    constructor(FixtureAdapter adapter_, address key_) {
        adapter = adapter_;
        key = key_;
    }

    function setOracle(IPullOracle o, bytes32 underlying_) external {
        oracle = o;
        underlying = underlying_;
    }

    /// LOW_GAS.md §1: relays the signed bundle to the oracle, then exactly the execute path.
    function executeWithPrices(Action calldata a, bytes calldata priceData) external returns (bytes memory) {
        if (msg.sender != key) revert NotDeskKey(msg.sender);
        if (priceData.length != 0) oracle.update(priceData);
        return _execute(a);
    }

    function execute(Action calldata a) external returns (bytes memory) {
        if (msg.sender != key) revert NotDeskKey(msg.sender);
        return _execute(a);
    }

    function _execute(Action calldata a) internal returns (bytes memory) {
        if (a.kind == ActionKind.SetQuote) {
            if (address(oracle) != address(0)) {
                IPullOracle.PriceData memory d = oracle.latest(underlying);
                if (d.held || d.publishedAt == 0 || uint256(d.publishedAt) + MAX_PRICE_AGE < block.timestamp) revert OffHoursNewRisk();
            }
            (uint16 s, int16 k, uint128 m) = abi.decode(a.data, (uint16, int16, uint128));
            if (s < MIN_WIDTH) revert QuoteWidthTooNarrow(s, MIN_WIDTH);
            if (k > MAX_SKEW || k < -MAX_SKEW) revert SkewTooWide(k, MAX_SKEW);
            if (m > MAX_INVENTORY) revert InventoryLimit(m, MAX_INVENTORY);
            adapter.setQuote(s, k, m);
        }
        emit ActionExecuted(msg.sender, a.kind, a.data);
        return "";
    }
}
