// Kill orders from Redis (CHANNELS.kill) reach the BookAgent only when RISK-signed (audit 2026-10 lead "Redis is a
// shared trust domain"; shared KillVerifier in packages/shared/src/busAuth.ts): EIP-712 KillOrder under (CHAIN_ID,
// BookrunnerConfig), signer holding RISK_ROLE on-chain (or pinned AGENT_RISK_SIGNERS), fresh and not replayed.
//   - verified, for this book: cancel-all + halt (BookAgent.onKill);
//   - unsigned / forged: ignored, logged and counted (alerts bus_forged_message): a Redis writer cannot halt the agent;
//   - the RISK role check could not run (RPC): ignored with an error log. A genuine kill also lands on-chain
//     (MMMandate.kill): the agent's state refresh halts on mandate.killed(), and risk cancels at the venue directly.
import type { ForgedLog, KillMsg, KillVerifier, LimitState, Logger, RiskStateVerifier } from "@bookrunner/shared";

export class AgentKillGate {
  constructor(
    private readonly bookId: number,
    private readonly verifier: KillVerifier,
    private readonly forged: ForgedLog,
    private readonly log: Logger,
  ) {}

  /** The verified kill order for this book, or null (ignored; see the header). */
  async accept(raw: unknown): Promise<KillMsg | null> {
    const v = await this.verifier.verify(raw);
    if (v.ok) {
      if (v.msg.bookId !== this.bookId) {
        this.log.warn({ bookId: v.msg.bookId }, "RISK-signed kill for another book on this book's channel ignored");
        return null;
      }
      return v.msg;
    }
    if (v.forged) {
      this.forged.note("kill", v.reason);
      this.log.warn({ reason: v.reason }, "FORGED kill message ignored (no valid RISK signature): not halting");
    } else if (v.unavailable) {
      this.log.error({ reason: v.reason }, "kill message could not be verified (RPC): ignored; the on-chain kill (mandate.killed) still halts the agent");
    } else {
      this.log.info({ reason: v.reason }, "kill message ignored (stale or replayed)");
    }
    return null;
  }
}

/**
 * Risk states from Redis (KEYS.riskState / CHANNELS.riskState) reach the BookAgent only when RISK-signed, fresh and
 * newer than the last accepted (shared RiskStateVerifier). Unsigned / forged ones are ignored and counted (alerts
 * bus_forged_message); replays and stale ones are ignored silently. Without a verified state for its timeout the agent
 * goes reduce-only (never halts).
 */
export class AgentRiskStateGate {
  private lastLog = 0;

  constructor(
    private readonly verifier: RiskStateVerifier,
    private readonly forged: ForgedLog,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async accept(raw: unknown): Promise<LimitState | null> {
    const v = await this.verifier.verify(raw);
    if (v.ok) return v.state;
    if (v.forged) {
      this.forged.note("state", v.reason);
      if (this.now() - this.lastLog > 60_000) {
        this.lastLog = this.now();
        this.log.warn({ reason: v.reason }, "FORGED risk state ignored (no valid RISK signature)");
      }
    } else if (v.unavailable) {
      this.log.warn({ reason: v.reason }, "risk state could not be verified (RPC): ignored");
    }
    return null;
  }
}
