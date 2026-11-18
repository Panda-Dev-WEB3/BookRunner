// Protocol keeper duty (tech update #9): keeps the BuybackGuard's on-chain ETH reference fresh. BuybackGuard.pokeEthReference
// is permissionless and every bound (liquidity floor, spot-vs-mean deviation, per-update clamp, minimum interval) is the
// contract's: a poke that the pool refuses reverts and changes nothing, so a manipulated or thin pool can only make the
// reference go stale (the guard then falls back to the governance value until it expires, and services/alerts raises
// eth_reference_stale), never move it. The same read feeds the liquidation keeper's gas policy (its ETH/USD), so no env
// price is needed once the guard is deployed.
import type { Logger } from "@bookrunner/shared";
import { buybackGuardAbi } from "@bookrunner/shared/abi";
import type { Hex } from "viem";
import { type EthRefState, planEthPoke } from "./domain/ethReference";
import type { Cooldowns } from "./domain/keeper";
import { describeRevert } from "./kit/tx";

export interface EthReferenceChain {
  /** The guard's reference at the latest block; null when the deployment has no BuybackGuard. */
  ethReferenceState(): Promise<EthRefState | null>;
  /** BuybackGuard.pokeEthReference() (permissionless; the KEEPER wallet pays the gas). */
  pokeEthReference(): Promise<Hex>;
}

export interface EthReferenceDeps {
  chain: EthReferenceChain;
  cooldowns: Cooldowns;
  /** Hold after a failed read or poke. */
  cooldownMs: number;
  /** Poke when the stored value is at least this old (seconds; the contract refuses sooner than 300). */
  everySec: number;
  log: Logger;
}

export type EthReferenceOutcome = { state: EthRefState | null; poked?: string; error?: string };

const KEY = "protocol:eth-reference";

export class EthReferenceRunner {
  private last: EthRefState | null = null;
  /** the last source logged ("<source>"): a change of regime (TWAP / fallback / none) is logged once */
  private loggedSource: number | null = null;

  constructor(private readonly d: EthReferenceDeps) {}

  /** The reference in force at the last read (WAD USDG per ETH); null when none or no guard: callers keep their own fallback. */
  get valueWad(): bigint | null {
    return this.last && this.last.source !== 0 && this.last.valueWad > 0n ? this.last.valueWad : null;
  }

  async tick(): Promise<EthReferenceOutcome> {
    if (!this.d.cooldowns.ready(KEY)) return { state: this.last };
    const log = this.d.log.child({ duty: "eth-reference" });
    let state: EthRefState | null;
    try {
      state = await this.d.chain.ethReferenceState();
    } catch (err) {
      return this.fail(log, err, "ETH reference read failed; retrying after the cooldown");
    }
    this.last = state;
    if (!state) return { state };
    if (this.loggedSource !== state.source) {
      this.loggedSource = state.source;
      const what = state.source === 1 ? "the on-chain WETH / USDG TWAP" : state.source === 2 ? "the governance FALLBACK (the TWAP value is missing or stale)" : "NOTHING (no TWAP value and no unexpired fallback): via-ETH buybacks wait";
      const fields = { source: state.source, valueWad: state.valueWad.toString(), fallbackExpiry: state.fallbackExpiry };
      if (state.source === 1) log.info(fields, `the ETH reference in force is ${what}`);
      else log.warn(fields, `the ETH reference in force is ${what}`);
    }
    const plan = planEthPoke(state, this.d.everySec);
    if (plan.kind === "wait") return { state };
    try {
      const tx = await this.d.chain.pokeEthReference();
      log.info({ tx }, "ETH reference updated from the pool TWAP");
      return { state, poked: tx };
    } catch (err) {
      // EthPoolThin / TwapDeviation / "OLD" / TooSoon (someone else poked first) / ReferenceOutOfRange: the contract refused
      return this.fail(log, err, "pokeEthReference refused or failed; retrying after the cooldown", state);
    }
  }

  private fail(log: Logger, err: unknown, msg: string, state: EthRefState | null = this.last): EthReferenceOutcome {
    this.d.cooldowns.hold(KEY, this.d.cooldownMs);
    const info = describeRevert(err, buybackGuardAbi);
    // TooSoon is a race with another caller, not a fault
    if (info.errorName === "TooSoon") log.debug({ revert: info }, msg);
    else log.warn({ revert: info }, msg);
    return { state, error: info.errorName ?? info.reason ?? info.message };
  }
}
