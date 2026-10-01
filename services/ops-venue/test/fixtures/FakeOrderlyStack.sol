// SPDX-License-Identifier: MIT
// Test-only stand-ins for MockERC20 / MockOrderlyVault / OrderlyAdapter used by ops-venue's
// BKRN_IT chain test (private anvil). NOT the protocol contracts — just enough surface, with the
// frozen IOrderlyAdapter event signatures, to exercise the viem adapter end to end.
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
    uint64 public nonce;
    constructor(FakeUSDC u, address op) { usdc = u; operator = op; }
    function deposit(VaultDepositFE calldata d) external payable {
        usdc.transferFrom(msg.sender, address(this), d.tokenAmount);
        balanceOf[d.accountId] += d.tokenAmount;
        emit AccountDeposit(d.accountId, msg.sender, ++nonce, d.tokenHash, d.tokenAmount);
    }
    function creditFees(bytes32 accountId, uint256 amount) external {
        require(msg.sender == operator, "op");
        usdc.mint(address(this), amount);
        balanceOf[accountId] += amount;
    }
    function operatorWithdraw(bytes32 accountId, address to, uint256 amount) external {
        require(msg.sender == operator, "op");
        require(balanceOf[accountId] >= amount, "ledger");
        balanceOf[accountId] -= amount;
        usdc.transfer(to, amount);
    }
}

contract FakeAdapter {
    event VenueDeposit(uint8 indexed account, uint256 amount);
    event WithdrawRequested(uint8 indexed account, uint256 amount, uint256 indexed requestNonce);
    event SweptToVault(uint256 amount);
    event FeesSwept(uint64 indexed period, uint256 amount);
    FakeUSDC public immutable usdc;
    FakeVault public immutable venueVault;
    address public immutable vault; // underwriting vault (sink)
    address public immutable router; // revenue router (sink)
    address public ops;
    uint256 public requestNonce;
    mapping(uint256 => bool) public pending;
    mapping(uint64 => bool) public swept;
    uint256 public inTransitUsd;
    uint256 public insuranceEquityUsd;
    int256 public marginEquityUsd;
    int256 public netExposureUsd;
    uint64 public valuationAt;
    uint256 public maxFeeSweepPerPeriodUsd = 1_000_000_000_000;

    constructor(FakeUSDC u, FakeVault v, address vault_, address router_, address ops_) { usdc = u; venueVault = v; vault = vault_; router = router_; ops = ops_; }
    function accountId(uint8 account) public view returns (bytes32) { return keccak256(abi.encode(address(this), bytes32("bookrunner"), account)); }
    function venueKind() external pure returns (uint8) { return 0; }
    function depositToVenue(uint8 account, uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        venueVault.deposit(FakeVault.VaultDepositFE(accountId(account), bytes32(0), bytes32(0), uint128(amount)));
        emit VenueDeposit(account, amount);
    }
    function requestWithdraw(uint8 account, uint256 amount) external {
        uint256 n = ++requestNonce;
        pending[n] = true;
        inTransitUsd += amount;
        emit WithdrawRequested(account, amount, n);
    }
    function report(uint256 insuranceUsd, int256 marginUsd, int256 exposureUsd, uint64 asOf) external {
        require(msg.sender == ops, "ops");
        require(asOf > valuationAt, "stale");
        insuranceEquityUsd = insuranceUsd; marginEquityUsd = marginUsd; netExposureUsd = exposureUsd; valuationAt = asOf;
    }
    function confirmWithdraw(uint256 n) external {
        require(msg.sender == ops, "ops");
        require(pending[n], "AlreadyConfirmedOrUnknownNonce");
        pending[n] = false;
    }
    function sweepToVault() external returns (uint256 amount) {
        amount = usdc.balanceOf(address(this));
        inTransitUsd = inTransitUsd > amount ? inTransitUsd - amount : 0;
        usdc.transfer(vault, amount);
        emit SweptToVault(amount);
    }
    function sweepFees(uint64 period, uint256 amount) external returns (uint256) {
        require(msg.sender == ops, "ops");
        require(!swept[period], "PeriodAlreadySwept");
        require(amount <= maxFeeSweepPerPeriodUsd, "cap");
        swept[period] = true;
        usdc.transfer(router, amount);
        emit FeesSwept(period, amount);
        return amount;
    }
}
