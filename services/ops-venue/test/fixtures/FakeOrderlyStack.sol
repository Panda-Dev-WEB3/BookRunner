// SPDX-License-Identifier: MIT
// Test-only stand-ins for MockERC20 / MockOrderlyVault / OrderlyAdapter used by ops-venue's
// BKRN_IT chain test (private anvil). NOT the protocol contracts — just enough surface, with the
// frozen IOrderlyAdapter event signatures and OrderlyAdapter's attribution rules (principal-first,
// then earmarked fees, rest vault-bound; request statuses), to exercise the viem adapter end to end.
// Compiled bytecode: fake-orderly.json (see scripts in test/chain.it.test.ts header).
pragma solidity ^0.8.24;

contract FakeUSDC {
    mapping(address => uint256) public balanceOf;
    function decimals() external pure returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FakeVault {
    struct VaultDepositFE { bytes32 accountId; bytes32 brokerHash; bytes32 tokenHash; uint128 tokenAmount; }
    event AccountDeposit(bytes32 indexed accountId, address indexed userAddress, uint64 indexed depositNonce, bytes32 tokenHash, uint128 tokenAmount);
    FakeUSDC public immutable usdc;
    address public operator;
    mapping(bytes32 => uint256) public balanceOf;
    uint256 public totalLedger;
    uint64 public nonce;
    constructor(FakeUSDC u, address op) { usdc = u; operator = op; }
    /// every account "exists" (ops-venue's ensureMockAccount is then a no-op)
    function accountOwner(bytes32) external pure returns (address) { return address(1); }
    function deposit(VaultDepositFE calldata d) external payable {
        usdc.transferFrom(msg.sender, address(this), d.tokenAmount);
        balanceOf[d.accountId] += d.tokenAmount;
        totalLedger += d.tokenAmount;
        emit AccountDeposit(d.accountId, msg.sender, ++nonce, d.tokenHash, d.tokenAmount);
    }
    /// credits unallocated USDC only (mint it to the vault first), like MockOrderlyVault
    function creditFees(bytes32 accountId, uint256 amount) external {
        require(msg.sender == operator, "op");
        require(usdc.balanceOf(address(this)) >= totalLedger + amount, "InsufficientUnallocated");
        balanceOf[accountId] += amount;
        totalLedger += amount;
    }
    function operatorWithdraw(bytes32 accountId, address to, uint256 amount) external {
        require(msg.sender == operator, "op");
        require(balanceOf[accountId] >= amount, "ledger");
        balanceOf[accountId] -= amount;
        totalLedger -= amount;
        usdc.transfer(to, amount);
    }
}

contract FakeAdapter {
    event VenueDeposit(uint8 indexed account, uint256 amount);
    event WithdrawRequested(uint8 indexed account, uint256 amount, uint256 indexed requestNonce);
    event SweptToVault(uint256 amount);
    event FeesSwept(uint64 indexed period, uint256 amount);
    event FeesForwarded(uint256 amount, uint256 stillPending);

    // OrderlyAdapter.WithdrawStatus: 0 None, 1 Requested, 2 Confirmed, 3 Cancelled, 4 Failed
    struct WithdrawRequest { uint128 amount; uint128 venueFee; uint64 requestedAt; uint64 confirmedAt; uint8 account; uint8 status; }

    FakeUSDC public immutable usdc;
    FakeVault public immutable venueVault;
    address public immutable vault; // underwriting vault (sink)
    address public immutable router; // revenue router (sink)
    address public ops;
    uint256 public withdrawNonce;
    mapping(uint256 => WithdrawRequest) internal requests;
    uint256[2] internal pendingW;
    mapping(uint64 => uint256) public feeSweptForPeriod;
    uint256 public pendingFeesUsd;
    uint256 public inTransitUsd;
    uint64 public lastFlowAt;
    uint256 public insuranceEquityUsd;
    int256 public marginEquityUsd;
    int256 public netExposureUsd;
    uint64 public valuationAt;
    uint256 public maxFeeSweepPerPeriodUsd = 1_000_000_000_000;

    constructor(FakeUSDC u, FakeVault v, address vault_, address router_, address ops_) { usdc = u; venueVault = v; vault = vault_; router = router_; ops = ops_; }
    function accountId(uint8 account) public view returns (bytes32) { return keccak256(abi.encode(address(this), bytes32("bookrunner"), account)); }
    function venueKind() external pure returns (uint8) { return 0; }
    function withdrawRequest(uint256 n) external view returns (WithdrawRequest memory) { return requests[n]; }
    function pendingWithdrawUsd(uint8 account) external view returns (uint256) { return pendingW[account]; }

    function depositToVenue(uint8 account, uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        venueVault.deposit(FakeVault.VaultDepositFE(accountId(account), bytes32(0), bytes32(0), uint128(amount)));
        lastFlowAt = uint64(block.timestamp);
        emit VenueDeposit(account, amount);
    }
    function requestWithdraw(uint8 account, uint256 amount) external {
        uint256 n = ++withdrawNonce;
        requests[n] = WithdrawRequest(uint128(amount), 0, uint64(block.timestamp), 0, account, 1);
        pendingW[account] += amount;
        emit WithdrawRequested(account, amount, n);
    }
    function report(uint256 insuranceUsd, int256 marginUsd, int256 exposureUsd, uint64 asOf) external {
        require(msg.sender == ops, "ops");
        require(asOf > valuationAt, "stale");
        require(asOf >= lastFlowAt, "ReportPredatesFlow");
        insuranceEquityUsd = insuranceUsd; marginEquityUsd = marginUsd; netExposureUsd = exposureUsd; valuationAt = asOf;
    }
    function confirmWithdraw(uint256 n) external {
        require(msg.sender == ops, "ops");
        WithdrawRequest storage r = requests[n];
        require(r.status == 1, "RequestNotPending");
        r.status = 2;
        r.confirmedAt = uint64(block.timestamp);
        pendingW[r.account] -= r.amount;
        inTransitUsd += r.amount;
        lastFlowAt = uint64(block.timestamp);
    }
    function cancelWithdraw(uint256 n) external {
        require(msg.sender == ops, "ops");
        WithdrawRequest storage r = requests[n];
        require(r.status == 1, "RequestNotPending");
        r.status = 3;
        pendingW[r.account] -= r.amount;
    }
    function failWithdraw(uint256 n) external {
        require(msg.sender == ops, "ops");
        WithdrawRequest storage r = requests[n];
        require(r.status == 2, "RequestNotConfirmed");
        r.status = 4;
        inTransitUsd -= inTransitUsd < r.amount ? inTransitUsd : r.amount;
        lastFlowAt = uint64(block.timestamp);
    }
    function sweepToVault() external returns (uint256 amount) {
        uint256 bal = usdc.balanceOf(address(this));
        uint256 principal = bal < inTransitUsd ? bal : inTransitUsd;
        uint256 free = bal - principal;
        uint256 feeReserved = pendingFeesUsd < free ? pendingFeesUsd : free;
        amount = bal - feeReserved;
        if (amount == 0) return 0;
        inTransitUsd -= principal;
        usdc.transfer(vault, amount);
        emit SweptToVault(amount);
    }
    function sweepFees(uint64 period, uint256 amount) external returns (uint256) {
        require(msg.sender == ops, "ops");
        require(feeSweptForPeriod[period] == 0, "PeriodAlreadySwept");
        require(amount <= maxFeeSweepPerPeriodUsd, "cap");
        feeSweptForPeriod[period] = amount;
        pendingFeesUsd += amount;
        emit FeesSwept(period, amount);
        return _forward();
    }
    function forwardPendingFees() external returns (uint256) { return _forward(); }
    function forwardableFees() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        uint256 avail = bal - (bal < inTransitUsd ? bal : inTransitUsd);
        return pendingFeesUsd < avail ? pendingFeesUsd : avail;
    }
    function _forward() internal returns (uint256 amt) {
        amt = forwardableFees();
        if (amt == 0) return 0;
        pendingFeesUsd -= amt;
        usdc.transfer(router, amt);
        emit FeesForwarded(amt, pendingFeesUsd);
    }
}
