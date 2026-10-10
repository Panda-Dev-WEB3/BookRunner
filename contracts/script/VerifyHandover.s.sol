// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {MainnetInput} from "./MainnetInput.sol";
import {BookrunnerConfig} from "../src/BookrunnerConfig.sol";
import {BkrnStaking} from "../src/BkrnStaking.sol";
import {BkrnFeeRouter} from "../src/BkrnFeeRouter.sol";
import {Backstop} from "../src/Backstop.sol";
import {BookFactory} from "../src/BookFactory.sol";
import {HedgeExecutor} from "../src/HedgeExecutor.sol";
import {StockTokenRegistry} from "../src/StockTokenRegistry.sol";
import {AttestedOracle} from "../src/AttestedOracle.sol";
import {RiskCommittee} from "../src/RiskCommittee.sol";
import {OrderlyAdapter} from "../src/OrderlyAdapter.sol";
import {PoolEngineAdapter} from "../src/PoolEngineAdapter.sol";
import {BRTypes} from "../src/interfaces/BRTypes.sol";
import {IStockTokenRegistry} from "../src/interfaces/IStockTokenRegistry.sol";

interface IHasConfig {
    function config() external view returns (address);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title VerifyHandover — read-only check of every RUNBOOK mainnet post-condition.
/// @notice Reads the JSON input (DEPLOY_INPUT) and deployments/<chainId>.json (DEPLOY_OUT), queries the chain
///         and prints a PASS/FAIL table; reverts if any row fails. Never broadcasts. Post-conditions:
///         deployer holds no role anywhere (config roles, timelock roles, BKRN); config.timelock() == the
///         controller; controller roles = multisig (proposer / executor / canceller), self-administered, no
///         open executor, delay as input (>= 48h on mainnet); StockTokenRegistry admin == 0 (follows the
///         timelock); expense / slash recipients = treasury; service roles + guardian as input; every
///         component points at the config; factory implementations set (adapter hashes as input); params,
///         oracle signers, Stock Tokens, indexes, buyback / staking / backstop settings as input.
///
///   DEPLOY_INPUT=deploy-inputs/4663.json bash scripts/forge.sh script script/VerifyHandover.s.sol:VerifyHandover \
///       --rpc-url $RHC_RPC_URL
contract VerifyHandover is MainnetInput {
    using stdJson for string;

    uint256 public passed;
    uint256 public failed;

    // deployment under test
    address internal tl;
    BookrunnerConfig internal cfg;
    address internal deployerAddr;

    function run() external {
        _requireDeployChain();
        loadInput(vm.readFile(_inputPath()));
        uint256 failures = verify(vm.readFile(_deploymentPath()));
        require(failures == 0, "VerifyHandover: post-conditions FAILED (see table)");
    }

    /// @notice Runs every check against `deploymentJson`; returns the number of failed rows (0 = handover ok).
    function verify(string memory deploymentJson) public returns (uint256) {
        require(inChainId != 0, "VerifyHandover: input not loaded");
        passed = 0;
        failed = 0;
        tl = deploymentJson.readAddress(".contracts.timelock");
        cfg = BookrunnerConfig(deploymentJson.readAddress(".contracts.config"));
        deployerAddr = gov.deployer;
        console2.log("==== VerifyHandover chain", block.chainid, inNetwork);
        console2.log("config", address(cfg), "timelock", tl);

        _checkDeploymentFile(deploymentJson);
        _checkConfigGovernance();
        _checkTimelock();
        _checkServiceRoles();
        _checkComponents();
        _checkImplementations();
        _checkParams();
        _checkEconomics();
        _checkOracleAndMarkets();
        console2.log("==== result: passed", passed, "failed", failed);
        return failed;
    }

    // ------------------------------------------------------------------------------------------- sections

    function _checkDeploymentFile(string memory j) internal {
        _row(j.readUint(".chainId") == block.chainid, "deployment file chainId == RPC chain");
        _row(j.readAddress(".governance.deployer") == deployerAddr, "deployment file deployer == input deployer");
        _row(j.readAddress(".governance.multisig") == gov.multisig, "deployment file multisig == input multisig");
        _row(tl.code.length > 0, "timelock controller has code");
        _row(address(cfg).code.length > 0, "config has code");
    }

    function _checkConfigGovernance() internal {
        bytes32 admin = cfg.DEFAULT_ADMIN_ROLE();
        _row(cfg.timelock() == tl, "config.timelock() == TimelockController");
        _row(cfg.hasRole(admin, tl), "config DEFAULT_ADMIN held by the timelock");
        _row(!cfg.hasRole(admin, gov.multisig), "multisig is not a direct config admin (acts via the timelock)");
        _row(!cfg.hasRole(admin, gov.guardian), "guardian is not a config admin");
        bytes32[7] memory roles = [
            admin,
            cfg.GUARDIAN_ROLE(),
            cfg.MARK_SIGNER_ROLE(),
            cfg.RISK_ROLE(),
            cfg.OPS_VENUE_ROLE(),
            cfg.JURY_ROLE(),
            cfg.KEEPER_ROLE()
        ];
        bool none = true;
        for (uint256 i; i < roles.length; ++i) {
            if (cfg.hasRole(roles[i], deployerAddr)) none = false;
        }
        _row(none, "deployer holds no BookrunnerConfig role");
        _row(cfg.expenseRecipient() == gov.expenseRecipient, "expenseRecipient == treasury (input)");
        _row(cfg.slashRecipient() == gov.slashRecipient, "slashRecipient == treasury (input)");
        _row(
            cfg.expenseRecipient() != deployerAddr && cfg.slashRecipient() != deployerAddr,
            "recipients are not the deployer"
        );
        _row(cfg.hasRole(cfg.GUARDIAN_ROLE(), gov.guardian), "GUARDIAN held by the guardian");
        _row(!cfg.newBooksPaused(), "newBooksPaused == false (launch-ready)");
    }

    function _checkTimelock() internal {
        TimelockController t = TimelockController(payable(tl));
        bytes32 admin = t.DEFAULT_ADMIN_ROLE();
        _row(t.getMinDelay() == gov.timelockMinDelay, "timelock minDelay == input");
        if (inChainId == MAINNET_CHAIN_ID) _row(t.getMinDelay() >= MIN_MAINNET_TIMELOCK_DELAY, "timelock minDelay >= 48h");
        _row(t.hasRole(t.PROPOSER_ROLE(), gov.multisig), "timelock PROPOSER = multisig");
        _row(t.hasRole(t.EXECUTOR_ROLE(), gov.multisig), "timelock EXECUTOR = multisig");
        _row(t.hasRole(t.CANCELLER_ROLE(), gov.multisig), "timelock CANCELLER = multisig");
        _row(!t.hasRole(t.EXECUTOR_ROLE(), address(0)), "timelock has no open executor");
        _row(t.hasRole(admin, tl), "timelock self-administered");
        _row(!t.hasRole(admin, gov.multisig), "timelock admin renounced (multisig not admin)");
        _row(
            !t.hasRole(admin, deployerAddr) && !t.hasRole(t.PROPOSER_ROLE(), deployerAddr)
                && !t.hasRole(t.EXECUTOR_ROLE(), deployerAddr) && !t.hasRole(t.CANCELLER_ROLE(), deployerAddr),
            "deployer holds no timelock role"
        );
    }

    function _checkServiceRoles() internal {
        _rowHolders(cfg.MARK_SIGNER_ROLE(), markSigners, "MARK_SIGNER granted to every input holder");
        _rowHolders(cfg.RISK_ROLE(), riskHolders, "RISK granted to every input holder");
        _rowHolders(cfg.OPS_VENUE_ROLE(), opsVenueHolders, "OPS_VENUE granted to every input holder");
        _rowHolders(cfg.JURY_ROLE(), juryHolders, "JURY granted to every input holder");
        _rowHolders(cfg.KEEPER_ROLE(), keeperHolders, "KEEPER granted to every input holder");
    }

    function _checkComponents() internal {
        _row(cfg.usdc() == ext.settlementToken, "config.usdc() == settlement token (input)");
        _row(IERC20Min(cfg.usdc()).decimals() == SETTLEMENT_DECIMALS, "settlement token decimals == 6");
        _row(cfg.orderlyVault() == ext.orderlyVault, "config.orderlyVault() == input");
        _row(cfg.entryPoint() == ext.entryPoint, "config.entryPoint() == input");
        if (bkrnIn.token != address(0)) _row(cfg.bkrn() == bkrnIn.token, "config.bkrn() == pre-existing BKRN");
        address[10] memory comps = [
            cfg.staking(),
            cfg.feeRouter(),
            cfg.backstop(),
            cfg.markRegistry(),
            cfg.oracle(),
            cfg.stockRegistry(),
            cfg.hedgeExecutor(),
            cfg.charter(),
            cfg.committee(),
            cfg.factory()
        ];
        bool allPoint = true;
        for (uint256 i; i < 10; ++i) {
            if (comps[i].code.length == 0 || IHasConfig(comps[i]).config() != address(cfg)) allPoint = false;
        }
        _row(allPoint, "every core component reads this config");
        (bool ok, bytes memory ret) = cfg.poolEngine().staticcall(abi.encodeWithSignature("protocolConfig()"));
        _row(ok && ret.length >= 32 && abi.decode(ret, (address)) == address(cfg), "poolEngine reads this config");
        StockTokenRegistry reg = StockTokenRegistry(cfg.stockRegistry());
        _row(reg.admin() == address(0), "StockTokenRegistry.admin() == 0 (follows config.timelock())");
        BkrnStaking staking = BkrnStaking(cfg.staking());
        _row(staking.isLocker(cfg.charter()) && staking.isLocker(cfg.committee()), "charter + committee are staking lockers");
        _row(IERC20Min(cfg.bkrn()).balanceOf(deployerAddr) == 0, "deployer holds no BKRN");
        address[3] memory m = RiskCommittee(cfg.committee()).members();
        _row(
            m[0] == committeeMembers[0] && m[1] == committeeMembers[1] && m[2] == committeeMembers[2],
            "committee seats == input"
        );
    }

    function _checkImplementations() internal {
        BookFactory f = BookFactory(cfg.factory());
        bytes32[8] memory kinds = [
            f.BOOK(), f.TRANCHE(), f.VAULT(), f.MANDATE(), f.ROUTER(), f.DESK(), f.ORDERLY_ADAPTER(), f.ENGINE_ADAPTER()
        ];
        bool all = true;
        for (uint256 i; i < kinds.length; ++i) {
            if (f.implementation(kinds[i]).code.length == 0) all = false;
        }
        _row(all, "factory: all 8 implementations set (with code)");
        OrderlyAdapter oa = OrderlyAdapter(payable(f.implementation(f.ORDERLY_ADAPTER())));
        _row(
            address(oa).code.length > 0 && oa.DEFAULT_BROKER_HASH() == brokerHash() && oa.DEFAULT_TOKEN_HASH() == tokenHash(),
            "OrderlyAdapter impl broker/token hashes == input"
        );
        address ea = f.implementation(f.ENGINE_ADAPTER());
        _row(
            ea.code.length > 0 && address(PoolEngineAdapter(ea).EXPECTED_CONFIG()) == address(cfg),
            "PoolEngineAdapter impl bound to this config"
        );
    }

    function _checkParams() internal {
        _row(cfg.markInterval() == prm.markInterval, "markInterval == input");
        _row(cfg.maxMarkAge() == prm.maxMarkAge, "maxMarkAge == input");
        _row(cfg.maxPriceAge() == prm.maxPriceAge, "maxPriceAge == input");
        _row(cfg.maxTradePriceAge() == prm.maxTradePriceAge, "maxTradePriceAge == input");
        _row(cfg.committeeWindow() == prm.committeeWindow, "committeeWindow == input");
        _row(cfg.carryBps() == prm.carryBps && cfg.expenseCapBps() == prm.expenseCapBps, "carryBps / expenseCapBps == input");
        _row(cfg.charterFeeUsd() == prm.charterFeeUsd, "charterFeeUsd == input");
        _row(
            cfg.sponsorBondBkrn() == prm.sponsorBondBkrn && cfg.committeeBondBkrn() == prm.committeeBondBkrn,
            "sponsor / committee bonds == input"
        );
        _row(cfg.venueMinIfUsd(BRTypes.VENUE_ORDERLY) == prm.venueMinIfOrderly, "venueMinIf[Orderly] == input");
        if (inChainId == MAINNET_CHAIN_ID) {
            _row(cfg.venueMinIfUsd(BRTypes.VENUE_ORDERLY) > ORDERLY_MAINNET_IF_REQUIREMENT, "venueMinIf[Orderly] > 25,000e6");
        }
        _row(cfg.venueMinIfUsd(BRTypes.VENUE_POOL_ENGINE) == prm.venueMinIfPoolEngine, "venueMinIf[PoolEngine] == input");
        (uint256[] memory th, uint256[] memory bo) = cfg.tiers();
        bool same = th.length == tierThresholds.length;
        for (uint256 i; same && i < th.length; ++i) {
            same = th[i] == tierThresholds[i] && bo[i] == tierBonds[i];
        }
        _row(same, "agent bond tiers == input");
    }

    function _checkEconomics() internal {
        BkrnFeeRouter fr = BkrnFeeRouter(cfg.feeRouter());
        _row(fr.buybackRouter() == ext.swapRouter02 && ext.swapRouter02.code.length > 0, "buybackRouter == SwapRouter02 (input)");
        _row(
            fr.buybackPoolFee() == bb.poolFee && fr.refBkrnPerUsdcWad() == bb.refBkrnPerUsdcWad
                && fr.maxSlippageBps() == bb.maxSlippageBps && fr.maxBuybackPerCall() == bb.maxPerCall,
            "buyback params == input"
        );
        _row(fr.bkrnPriceId() == bb.bkrnPriceId, "buyback bkrnPriceId == input");
        BkrnStaking st = BkrnStaking(cfg.staking());
        _row(st.cooldown() == prm.stakingCooldown && st.cooldown() >= 1 days, "staking cooldown == input (>= 1 day)");
        _row(st.rewardsDuration() == prm.stakingRewardsDuration, "staking rewardsDuration == input");
        _row(Backstop(cfg.backstop()).maxCoverBps() == prm.backstopMaxCoverBps, "backstop maxCoverBps == input");
        HedgeExecutor he = HedgeExecutor(cfg.hedgeExecutor());
        _row(he.routerOf("UNIV3") == ext.swapRouter02, "HedgeExecutor UNIV3 == SwapRouter02 (input)");
        _row(he.routerOf("UNIV4") == ext.univ4Router, "HedgeExecutor UNIV4 == input (0 = not configured)");
    }

    function _checkOracleAndMarkets() internal {
        AttestedOracle o = AttestedOracle(cfg.oracle());
        bool signersOk = true;
        for (uint256 i; i < oracleSigners.length; ++i) {
            if (!o.isSigner(oracleSigners[i].signer) || o.attestationOf(oracleSigners[i].signer) != oracleSigners[i].attestation) {
                signersOk = false;
            }
        }
        _row(signersOk, "oracle signers active with input attestations");
        _row(!o.isSigner(deployerAddr), "deployer is not an oracle signer");
        _row(o.minSources() == prm.oracleMinSources, "oracle minSources == input");
        StockTokenRegistry reg = StockTokenRegistry(cfg.stockRegistry());
        bool tokensOk = true;
        for (uint256 i; i < stocks.length; ++i) {
            IStockTokenRegistry.StockToken memory t = reg.getToken(stocks[i].token);
            if (
                !t.active || t.priceId != stocks[i].priceId || t.multiplierWad != stocks[i].multiplierWad
                    || t.floatCapRaw != stocks[i].floatCapRaw
            ) tokensOk = false;
        }
        _row(tokensOk, "Stock Tokens registered as input (priceId, multiplier, float cap)");
        bool idxOk = true;
        for (uint256 i; i < indexes.length; ++i) {
            (bytes32 pid, IStockTokenRegistry.IndexComponent[] memory comps) = reg.getIndex(keccak256(bytes(indexes[i].name)));
            if (pid != indexes[i].priceId || comps.length != indexes[i].symbols.length) {
                idxOk = false;
                continue;
            }
            for (uint256 j; j < comps.length; ++j) {
                if (comps[j].token != _stockToken(indexes[i].symbols[j]) || comps[j].weightBps != indexes[i].weightsBps[j]) {
                    idxOk = false;
                }
            }
        }
        _row(idxOk, "indexes registered as input");
    }

    // ------------------------------------------------------------------------------------------- table

    function _rowHolders(bytes32 role, address[] storage holders, string memory what) internal {
        bool ok = holders.length > 0;
        for (uint256 i; i < holders.length; ++i) {
            if (!cfg.hasRole(role, holders[i])) ok = false;
        }
        _row(ok, what);
    }

    function _row(bool ok, string memory what) internal {
        if (ok) {
            ++passed;
            console2.log(string.concat("  PASS  ", what));
        } else {
            ++failed;
            console2.log(string.concat("  FAIL  ", what));
        }
    }
}
