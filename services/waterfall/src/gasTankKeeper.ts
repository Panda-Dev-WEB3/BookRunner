// Protocol keeper duty, every WATERFALL_GAS_TANK_INTERVAL_SECONDS (2026-11 GasTank): tops up the protocol's service
// wallets (mark signer, risk, ops-venue, jury, keeper, oracle signer) from the treasury-funded GasTank when one runs
// below its floor. topUp(address) is permissionless and capped on chain (per wallet and per day, and globally), so this
// job carries no policy of its own: it reads the tank's quote for every wallet (one batched read) and sends topUp for
// each wallet the tank would pay. Failure-tolerant: a failed read or tx is logged and retried after the cooldown; a
// wallet whose cap is used or a tank that is paused / empty is logged once per UTC day (services/alerts raises the
// gas_tank_* alerts from the chain itself, not from this log).
import type { Logger } from "@bookrunner/shared";
import { gasTankAbi } from "@bookrunner/shared/abi";
import type { Hex } from "viem";
import { type TankAction, type TankSnapshot, planTankPass } from "./domain/gasTank";
import type { Cooldowns } from "./domain/keeper";
import { describeRevert } from "./kit/tx";

export interface GasTankChain {
  /** The tank's state at the latest block; null when the deployment has no GasTank. */
  gasTankState(): Promise<TankSnapshot | null>;
  /** GasTank.topUp(service) (permissionless; the KEEPER wallet pays the gas). */
  topUp(service: `0x${string}`): Promise<Hex>;
}

export interface GasTankDeps {
  chain: GasTankChain;
  cooldowns: Cooldowns;
  /** Hold after a failed read or tx, per wallet. */
  cooldownMs: number;
  log: Logger;
  /** Wallets topped up per pass at most (default 32 = the tank's own limit). */
  maxPerPass?: number;
  now?: () => number;
}

export type GasTankOutcome = { toppedUp: Array<{ service: string; amountWei: bigint; tx: string }>; actions: TankAction[]; error?: string };

const READ_KEY = "protocol:gas-tank";

export class GasTankRunner {
  /** attention items already logged today ("<utc day>:<service>:<kind>"): logged once, not every pass */
  private logged = new Set<string>();

  constructor(private readonly d: GasTankDeps) {}

  async tick(): Promise<GasTankOutcome> {
    const out: GasTankOutcome = { toppedUp: [], actions: [] };
    if (!this.d.cooldowns.ready(READ_KEY)) return out;
    const log = this.d.log.child({ duty: "gas-tank" });
    let snap: TankSnapshot | null;
    try {
      snap = await this.d.chain.gasTankState();
    } catch (err) {
      return this.failRead(out, log, err);
    }
    if (!snap) return out;
    const actions = planTankPass(snap);
    out.actions = actions;
    const day = Math.floor((this.d.now?.() ?? Date.now()) / 86_400_000);
    let sent = 0;
    for (const a of actions) {
      if (a.kind !== "topup") {
        const k = `${day}:${a.service}:${a.kind}`;
        if (!this.logged.has(k)) {
          this.logged.add(k);
          if (a.kind === "capped")
            log.warn({ service: a.service, cap: a.scope }, `gas tank: a wallet is below its floor but its ${a.scope === "global" ? "global" : "own"} daily top-up cap is used up; it waits for the next UTC day, or governance raises the cap`);
          else log.warn({ service: a.service, why: a.why, tankWei: snap.balanceWei.toString() }, "gas tank cannot top up a wallet below its floor");
        }
        continue;
      }
      const key = `${READ_KEY}:${a.service}`;
      if (!this.d.cooldowns.ready(key) || sent >= (this.d.maxPerPass ?? 32)) continue;
      try {
        const tx = await this.d.chain.topUp(a.service);
        sent++;
        out.toppedUp.push({ service: a.service, amountWei: a.amountWei, tx });
        log.info({ service: a.service, quotedWei: a.amountWei.toString(), tx }, "gas tank topped up a service wallet");
      } catch (err) {
        // another caller may have topped it up first (AboveFloor), a cap was used in between, or the tx failed
        this.d.cooldowns.hold(key, this.d.cooldownMs);
        const info = describeRevert(err, gasTankAbi);
        log.warn({ service: a.service, revert: info }, "gas tank topUp failed; retrying after the cooldown");
        out.error = info.errorName ?? info.reason ?? info.message;
      }
    }
    // forget yesterday's log keys
    for (const k of this.logged) if (!k.startsWith(`${day}:`)) this.logged.delete(k);
    return out;
  }

  private failRead(out: GasTankOutcome, log: Logger, err: unknown): GasTankOutcome {
    this.d.cooldowns.hold(READ_KEY, this.d.cooldownMs);
    const info = describeRevert(err);
    log.warn({ revert: info }, "gas tank read failed; retrying after the cooldown");
    return { ...out, error: info.reason ?? info.errorName ?? info.message };
  }
}
