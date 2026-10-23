// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

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
import {InsurancePool} from "../src/InsurancePool.sol";
import {BRTypes} from "../src/interfaces/BRTypes.sol";
import {IStockTokenRegistry} from "../src/interfaces/IStockTokenRegistry.sol";
import {IBkrnV4Swapper} from "../src/interfaces/IBkrnV4Swapper.sol";
import {BkrnV4Swapper} from "../src/BkrnV4Swapper.sol";

interface IHasConfig {
    function config() external view returns (address);
}

interface IRoleEnumerable {
    function getRoleMemberCount(bytes32 role) external view returns (uint256);
    function getRoleMember(bytes32 role, uint256 index) external view returns (address);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title VerifyHandover — read-only check of every RUNBOOK mainnet post-condition.
/// @notice Reads the JSON input (DEPLOY_INPUT) and deployments/<chainId>.json (DEPLOY_OUT), queries the chain
///         and prints a PASS/FAIL table; reverts if any row fails. Never broadcasts. Post-conditions:
///         deployer holds no role anywhere (config roles, timelock roles, BKRN); no role holder beyond the input on
///         the config or the timelock (both enumerate their holders, audit 2026-10 D); config.timelock() == the
///         controller; controller roles = multisig (proposer / executor / canceller), self-administered, no
///         open executor, delay as input (>= 48h on mainnet); StockTokenRegistry admin == 0 (follows the
///         timelock); expense / slash recipients = treasury; service roles + guardian as input; every
///         component points at the config; factory implementations set (adapter hashes as input); params,
///         oracle signers, Stock Tokens, indexes, buyback / staking / backstop settings as input; Book
///         implementation linked to a deployed BookLogic; OrderlyAdapter v3 (OrderlyIFAccount accounts, 6-dp
///         settlement); HedgeExecutor v3 factory + one route per Stock Token; BkrnFeeRouter reference source
///         (+ TWAP params) and a reference that reads; StockTokenRegistry live uiMultiplier mode / anchors /
///         band; AttestedOracle measurement allow-list, attested signer digests, requireAttestations; input
///         Stock Tokens / feeds == the oracle's chain price config.
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
        _checkNoExtraRoleHolders();
        _checkComponents();
        _checkImplementations();
        _checkParams();
        _checkInsurancePool(deploymentJson);
        _checkEconomics();
        _checkBuybackV4();
        _checkOracleAndMarkets();
        _checkHedgeRoutes();
        _checkLiveMultipliers();
        _checkAttestation();
        _checkPriceConfig(deploymentJson);
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

    /// @dev Audit 2026-10 D: every role any contract consults has EXACTLY the expected holders. The checks above only
    ///      prove the expected holders have their roles; a stray admin, guardian or service-role holder (or an extra
    ///      timelock proposer / executor / canceller / admin) fails here. Both contracts enumerate their holders
    ///      (BookrunnerConfig and BookrunnerTimelock are AccessControlEnumerable); a non-enumerable one fails.
    function _checkNoExtraRoleHolders() internal {
        address[] memory one = new address[](1);
        bool ok = true;
        one[0] = tl;
        ok = _exactHolders(address(cfg), cfg.DEFAULT_ADMIN_ROLE(), one, "config DEFAULT_ADMIN") && ok;
        one[0] = gov.guardian;
        ok = _exactHolders(address(cfg), cfg.GUARDIAN_ROLE(), one, "config GUARDIAN") && ok;
        ok = _exactHolders(address(cfg), cfg.MARK_SIGNER_ROLE(), markSigners, "config MARK_SIGNER") && ok;
        ok = _exactHolders(address(cfg), cfg.RISK_ROLE(), riskHolders, "config RISK") && ok;
        ok = _exactHolders(address(cfg), cfg.OPS_VENUE_ROLE(), opsVenueHolders, "config OPS_VENUE") && ok;
        ok = _exactHolders(address(cfg), cfg.JURY_ROLE(), juryHolders, "config JURY") && ok;
        ok = _exactHolders(address(cfg), cfg.KEEPER_ROLE(), keeperHolders, "config KEEPER") && ok;
        _row(ok, "config: no role holder beyond the input (7 roles enumerated)");

        TimelockController t = TimelockController(payable(tl));
        bool tok = true;
        one[0] = tl;
        tok = _exactHolders(tl, t.DEFAULT_ADMIN_ROLE(), one, "timelock DEFAULT_ADMIN") && tok;
        one[0] = gov.multisig;
        tok = _exactHolders(tl, t.PROPOSER_ROLE(), one, "timelock PROPOSER") && tok;
        tok = _exactHolders(tl, t.EXECUTOR_ROLE(), one, "timelock EXECUTOR") && tok;
        tok = _exactHolders(tl, t.CANCELLER_ROLE(), one, "timelock CANCELLER") && tok;
        _row(tok, "timelock: no role holder beyond the multisig / itself (BookrunnerTimelock enumerated)");

        // review M-3: the other privileged sets. Lockers: charter, committee, and book mandates (factory components).
        bool lok = true;
        try BkrnStaking(cfg.staking()).lockers() returns (address[] memory ls) {
            BookFactory f = BookFactory(cfg.factory());
            for (uint256 i; i < ls.length; ++i) {
                if (ls[i] != cfg.charter() && ls[i] != cfg.committee() && !f.isComponent(ls[i])) {
                    lok = false;
                    console2.log("    staking: unexpected locker", ls[i]);
                }
            }
        } catch {
            lok = false;
            console2.log("    staking: lockers not enumerable");
        }
        _row(lok, "staking: no locker beyond charter, committee and book mandates");

        address[] memory expected = new address[](oracleSigners.length);
        for (uint256 i; i < oracleSigners.length; ++i) {
            expected[i] = oracleSigners[i].signer;
        }
        bool sok = true;
        try AttestedOracle(cfg.oracle()).signers() returns (address[] memory ss) {
            sok = ss.length == _distinct(expected);
            for (uint256 i; i < ss.length; ++i) {
                if (!_contains(expected, ss[i])) {
                    sok = false;
                    console2.log("    oracle: unexpected signer", ss[i]);
                }
            }
        } catch {
            sok = false;
            console2.log("    oracle: signers not enumerable");
        }
        _row(sok, "oracle: active signers == exactly the input's");
    }

    function _distinct(address[] memory xs) internal pure returns (uint256 n) {
        for (uint256 i; i < xs.length; ++i) {
            bool dup;
            for (uint256 j; j < i; ++j) {
                if (xs[j] == xs[i]) dup = true;
            }
            if (!dup) ++n;
        }
    }

    function _contains(address[] memory xs, address x) internal pure returns (bool) {
        for (uint256 i; i < xs.length; ++i) {
            if (xs[i] == x) return true;
        }
        return false;
    }

    /// @dev True when `ac` enumerates `role` and its holders are exactly the distinct addresses of `expected`.
    function _exactHolders(address ac, bytes32 role, address[] memory expected, string memory what)
        internal
        view
        returns (bool ok)
    {
        uint256 n;
        try IRoleEnumerable(ac).getRoleMemberCount(role) returns (uint256 c) {
            n = c;
        } catch {
            console2.log(string.concat("    ", what, ": holders not enumerable"));
            return false;
        }
        uint256 distinct;
        for (uint256 i; i < expected.length; ++i) {
            bool dup;
            for (uint256 j; j < i; ++j) {
                if (expected[j] == expected[i]) dup = true;
            }
            if (!dup) ++distinct;
        }
        ok = n == distinct;
        for (uint256 i; i < n; ++i) {
            address h = IRoleEnumerable(ac).getRoleMember(role, i);
            bool known;
            for (uint256 j; j < expected.length; ++j) {
                if (expected[j] == h) known = true;
            }
            if (!known) {
                ok = false;
                console2.log(string.concat("    ", what, ": unexpected holder"), h);
            }
        }
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
        address bookImpl = f.implementation(f.BOOK());
        address logic = bookImpl.code.length > 0 ? linkedBookLogic(bookImpl) : address(0);
        _row(logic != address(0), "Book implementation linked to a deployed BookLogic library");
        OrderlyAdapter oa = OrderlyAdapter(payable(f.implementation(f.ORDERLY_ADAPTER())));
        _row(
            address(oa).code.length > 0 && oa.DEFAULT_BROKER_HASH() == brokerHash() && oa.DEFAULT_TOKEN_HASH() == tokenHash(),
            "OrderlyAdapter impl broker/token hashes == input"
        );
        // v3: real Orderly accounts (MM = adapter, IF = per-book OrderlyIFAccount); v2 has no ifAccount()
        (bool v3, bytes memory r) = address(oa).staticcall(abi.encodeWithSignature("ifAccount()"));
        _row(
            v3 && r.length == 32 && oa.SETTLEMENT_DECIMALS() == SETTLEMENT_DECIMALS,
            "OrderlyAdapter impl is v3 (OrderlyIFAccount IF account, 6-dp settlement)"
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

    /// @dev 2026-10 InsurancePool: registered, an ERC1967 proxy on a deployed implementation, bound to this config
    ///      and the settlement token, parameters as input, not paused (upgrades and parameters follow config.timelock()).
    function _checkInsurancePool(string memory j) internal {
        address p = cfg.insurancePool();
        _row(p.code.length > 0, "config.insurancePool() set (with code)");
        if (p.code.length == 0) return;
        _row(j.readAddressOr(".contracts.insurancePool", address(0)) == p, "insurance pool == deployment record");
        InsurancePool ip = InsurancePool(p);
        address impl = address(
            uint160(uint256(vm.load(p, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)))
        );
        _row(
            impl.code.length > 0 && impl == j.readAddressOr(".contracts.insurancePoolImplementation", address(0)),
            "insurance pool: ERC1967 proxy on the recorded implementation"
        );
        _row(ip.config() == address(cfg), "insurance pool reads this config");
        _row(ip.asset() == ext.settlementToken, "insurance pool asset == settlement token (input)");
        (
            uint16 floor,
            uint16 cap,
            uint16 buffer,
            uint16 flTarget,
            uint32 cooldown,
            uint32 len,
            uint32 grace,
            uint32 pendingLen
        ) = ip.params();
        _row(
            floor == poolIn.premiumFloorBps && cap == poolIn.marketCapBps && buffer == poolIn.bufferBps
                && flTarget == poolIn.firstLossTargetBps && cooldown == poolIn.cooldown
                && (pendingLen != 0 ? pendingLen : len) == poolIn.epochLength && grace == poolIn.processGrace,
            "insurance pool params == input"
        );
        (bool dp, bool ap) = ip.paused();
        _row(!dp && !ap, "insurance pool not paused (launch-ready)");
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
        _row(fr.referenceSource() == bb.referenceSource, "buyback referenceSource == input");
        if (bb.referenceSource == REF_TWAP) {
            _row(
                fr.twapPool() == bb.twapPool && fr.twapWindow() == bb.twapWindow
                    && fr.twapMaxTickDeviation() == bb.twapMaxTickDeviation,
                "buyback TWAP pool / window / max tick deviation == input"
            );
        }
        if (bb.referenceSource != REF_ATTESTED) {
            // ATTESTED reads the oracle's BKRN price, which only exists once the oracle publishes it
            bool reads;
            try fr.referenceBkrnPerUsdc() returns (uint256 ref) {
                reads = ref > 0;
            } catch {}
            _row(reads, "buyback referenceBkrnPerUsdc() reads (> 0)");
        }
        BkrnStaking st = BkrnStaking(cfg.staking());
        _row(st.cooldown() == prm.stakingCooldown && st.cooldown() >= 1 days, "staking cooldown == input (>= 1 day)");
        _row(st.rewardsDuration() == prm.stakingRewardsDuration, "staking rewardsDuration == input");
        _row(Backstop(cfg.backstop()).maxCoverBps() == prm.backstopMaxCoverBps, "backstop maxCoverBps == input");
        HedgeExecutor he = HedgeExecutor(cfg.hedgeExecutor());
        _row(he.routerOf("UNIV3") == ext.swapRouter02, "HedgeExecutor UNIV3 == SwapRouter02 (input)");
        _row(he.routerOf("UNIV4") == ext.univ4Router, "HedgeExecutor UNIV4 == input (0 = not configured)");
        _row(he.v3Factory() == ext.univ3Factory, "HedgeExecutor v3Factory == input");
    }

    function _checkOracleAndMarkets() internal {
        AttestedOracle o = AttestedOracle(cfg.oracle());
        bool signersOk = true;
        for (uint256 i; i < oracleSigners.length; ++i) {
            if (!o.isSigner(oracleSigners[i].signer) || o.attestationOf(oracleSigners[i].signer) != _expectedAttestation(o, oracleSigners[i])) {
                signersOk = false;
            }
        }
        _row(signersOk, "oracle signers active with input attestations (attested: setAttestedSigner digest)");
        _row(!o.isSigner(deployerAddr), "deployer is not an oracle signer");
        _row(o.minSources() == prm.oracleMinSources, "oracle minSources == input");
        if (inChainId == MAINNET_CHAIN_ID) {
            _row(
                o.minSources() == MAINNET_ORACLE_MIN_SOURCES,
                "oracle minSources == 1 (mainnet primary-confirm)"
            );
        }
        StockTokenRegistry reg = StockTokenRegistry(cfg.stockRegistry());
        bool tokensOk = true;
        for (uint256 i; i < stocks.length; ++i) {
            // getToken reports the effective multiplier: the live uiMultiplier() in live mode (may drift from the
            // anchor within the band — checked by its own row), the stored value otherwise
            try reg.getToken(stocks[i].token) returns (IStockTokenRegistry.StockToken memory t) {
                if (
                    !t.active || t.priceId != stocks[i].priceId || t.floatCapRaw != stocks[i].floatCapRaw
                        || (!stocks[i].liveMultiplier && t.multiplierWad != stocks[i].multiplierWad)
                ) tokensOk = false;
            } catch {
                tokensOk = false;
            }
        }
        _row(tokensOk, "Stock Tokens registered as input (priceId, stored multiplier, float cap)");
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

    function _expectedAttestation(AttestedOracle o, OracleSignerIn storage s) internal view returns (bytes32) {
        if (!_attested(s)) return s.attestation;
        return o.attestationDigest(s.signer, s.platform, s.measurement, s.quoteHash);
    }

    function _checkHedgeRoutes() internal {
        HedgeExecutor he = HedgeExecutor(cfg.hedgeExecutor());
        bool ok = hedgeRoutes.length == stocks.length;
        for (uint256 i; i < stocks.length; ++i) {
            (uint24 fee, address hop, uint24 hopFee) = he.routeOf("UNIV3", stocks[i].token);
            if (fee == 0) {
                ok = false;
                continue;
            }
            HedgeRouteIn storage r = hedgeRoutes[_routeIndex(stocks[i].symbol)];
            if (fee != r.fee || hop != r.hop || hopFee != r.hopFee) ok = false;
        }
        _row(ok, "HedgeExecutor UNIV3 route per Stock Token == input");
    }

    function _checkLiveMultipliers() internal {
        StockTokenRegistry reg = StockTokenRegistry(cfg.stockRegistry());
        uint256 band = multiplierBandBps == 0 ? reg.DEFAULT_MULTIPLIER_BAND_BPS() : multiplierBandBps;
        _row(reg.multiplierBandBps() == band, "StockTokenRegistry multiplierBandBps == input (default 500)");
        bool modeOk = true;
        bool valueOk = true;
        for (uint256 i; i < stocks.length; ++i) {
            StockTokenIn storage s = stocks[i];
            if (reg.multiplierFromToken(s.token) != s.liveMultiplier || reg.nextMultiplierAnchor(s.token) != s.nextMultiplierAnchor) {
                modeOk = false;
            }
            try reg.multiplierOf(s.token) returns (uint256 m) {
                if (m == 0) valueOk = false;
            } catch {
                valueOk = false; // live multiplier outside the band of its anchor (fails closed)
            }
        }
        _row(modeOk, "Stock Token multiplier source (uiMultiplier / stored) + next anchors == input");
        _row(valueOk, "every Stock Token multiplier reads (live value within the band)");
    }

    function _checkAttestation() internal {
        AttestedOracle o = AttestedOracle(cfg.oracle());
        bool allowed = true;
        for (uint256 i; i < oracleMeasurements.length; ++i) {
            if (!o.measurementAllowed(oracleMeasurements[i])) allowed = false;
        }
        _row(allowed, "oracle enclave measurements allow-listed == input");
        bool measured = true;
        for (uint256 i; i < oracleSigners.length; ++i) {
            if (o.measurementOf(oracleSigners[i].signer) != oracleSigners[i].measurement) measured = false;
        }
        _row(measured, "oracle signer measurements == input");
        _row(o.attestationRequired() == requireAttestations, "oracle requireAttestations == input");
        // guarded launch (input oracle.attestLater): attestations are switched on later by governance; until then the
        // row only reports it (the one-way requireAttestations() stays a launch-gate item, RUNBOOK checklist A)
        if (inChainId == MAINNET_CHAIN_ID && !attestLater) _row(o.attestationRequired(), "oracle requires attestations (mainnet)");
        if (inChainId == MAINNET_CHAIN_ID && attestLater) {
            console2.log("    NOTE  oracle attestations NOT yet required (input oracle.attestLater: guarded launch)");
        }
    }

    function _checkPriceConfig(string memory j) internal {
        if (bytes(ext.chainPriceConfig).length == 0) return;
        bool sameTokens = true;
        string memory c = vm.readFile(_resolve(ext.chainPriceConfig));
        for (uint256 i; i < stocks.length; ++i) {
            string memory k = string.concat(".stockTokens.", stocks[i].symbol, ".token");
            if (!vm.keyExistsJson(c, k) || c.readAddress(k) != stocks[i].token) sameTokens = false;
        }
        for (uint256 i; i < feeds.length; ++i) {
            string memory k = string.concat(".chainlink.feeds.", feeds[i].symbol, ".proxy");
            if (!vm.keyExistsJson(c, k) || c.readAddress(k) != feeds[i].feed) sameTokens = false;
        }
        _row(sameTokens, "Stock Tokens / Chainlink feeds == chain price config (oracle service)");
        _row(
            vm.keyExistsJson(j, ".chainPriceConfig") && _eq(j.readString(".chainPriceConfig"), ext.chainPriceConfig),
            "deployment record names the chain price config"
        );
    }

    // ------------------------------------------------------------------------------------------- table

    function _rowHolders(bytes32 role, address[] storage holders, string memory what) internal {
        bool ok = holders.length > 0;
        for (uint256 i; i < holders.length; ++i) {
            if (!cfg.hasRole(role, holders[i])) ok = false;
        }
        _row(ok, what);
    }

    /// @dev BkrnFeeRouter Uniswap v4 venue as input (Pons BKRN): venue, PoolManager (code), hooks, ETH references,
    ///      route (or none), the swapper bound to this router; the BKRN token's decimals / supply (supply only warns).
    function _checkBuybackV4() internal {
        BkrnFeeRouter fr = BkrnFeeRouter(cfg.feeRouter());
        _row(fr.buybackVenue() == bb.venue, "buyback venue == input (0 univ3, 1 univ4)");
        _row(
            fr.v4PoolManager() == ext.univ4PoolManager
                && (ext.univ4PoolManager == address(0) || ext.univ4PoolManager.code.length > 0),
            "buyback v4PoolManager == input (has code)"
        );
        bool hooksOk = true;
        for (uint256 i; i < bb.v4Hooks.length; ++i) {
            if (!fr.v4HookAllowed(bb.v4Hooks[i])) hooksOk = false;
        }
        _row(hooksOk, "buyback v4 hooks allow-listed as input");
        _row(
            fr.refUsdcPerEthWad() == bb.usdcPerEthWad && fr.refBkrnPerEthWad() == bb.bkrnPerEthWad,
            "buyback ETH references == input"
        );
        bytes32 want = bb.v4RouteSet ? keccak256(abi.encode(bb.v4Route)) : keccak256(abi.encode(_noRoute()));
        _row(keccak256(abi.encode(fr.v4Route())) == want, "buyback v4 route == input (none before graduation)");
        if (bb.v4RouteSet) _row(fr.v4BuybackReady(), "buyback v4 route live (pools initialized)");
        BkrnV4Swapper sw = BkrnV4Swapper(payable(address(fr.v4Swapper())));
        _row(sw.feeRouter() == address(fr) && address(sw.config()) == address(cfg), "BkrnV4Swapper bound to this fee router + config");
        _row(
            fr.v4HookFeeBps() == bb.v4HookFeeBps && fr.v4EthToleranceBps() == bb.v4EthToleranceBps
                && fr.v4SwapGas() == bb.v4SwapGas,
            "buyback v4 hook fee allowance / ETH tolerance / swap gas == input"
        );
        if (bb.v4Hooks.length > 0 && fr.maxSlippageBps() < fr.v4HookFeeBps() + 200) {
            console2.log("  WARN  maxSlippageBps is not comfortably above the hook fee allowance (+200 bps)");
        }
        _row(IERC20Min(cfg.bkrn()).decimals() == 18, "BKRN decimals == 18");
        (bool ok, bytes memory ret) = cfg.bkrn().staticcall(abi.encodeWithSignature("totalSupply()"));
        uint256 supply = ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
        if (supply == PONS_TOTAL_SUPPLY) console2.log("  PASS  BKRN totalSupply == 1e9 x 1e18");
        else console2.log("  WARN  BKRN totalSupply != 1e9 x 1e18 (not a failure):", supply);
    }

    function _noRoute() internal pure returns (IBkrnV4Swapper.V4Route memory r) {}

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
