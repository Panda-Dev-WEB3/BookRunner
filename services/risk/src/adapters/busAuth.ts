// Authenticated bus messages for the risk service (audit 2026-10 lead "Redis is a shared trust domain"; shared
// definitions in packages/shared/src/busAuth.ts):
//   - the agent's quote (KEYS.agentQuote) is checked only when it carries an EIP-712 AgentQuote signature by an ACTIVE
//     desk session key of the book's mandate (MMMandate.isActiveKey, cached, RPC errors never cached). Unsigned,
//     forged or unverifiable quotes are no quote: they can never cause a SKEW / WIDTH breach, so a Redis writer cannot
//     make risk kill and flatten a book;
//   - kill orders (the kill channel and the revoke_key job) are signed with the RISK key: agents and ops-venue act only
//     on those.
import { type ForgedLog, type KillMsg, cachedAddressCheck, killNonce, recoverQuoteSigner, signKill } from "@bookrunner/shared";
import type { Address, LocalAccount } from "viem";
import type { QuoteAuth, RiskBusAuth } from "../ports";
import type { BookRef, QuoteObservation } from "../types";

export interface RiskBusAuthOptions {
  chainId: number;
  /** BookrunnerConfig of the deployment (KillOrder domain) */
  config: Address;
  /** the RISK role key (local or KMS) */
  account: Pick<LocalAccount, "signTypedData">;
  /** MMMandate(mandate).isActiveKey(key) on-chain; THROWS when the read fails */
  isActiveKey(mandate: Address, key: Address): Promise<boolean>;
  forged?: ForgedLog;
  now?: () => number;
}

export function riskBusAuth(o: RiskBusAuthOptions): RiskBusAuth {
  const checks = new Map<string, (a: Address) => Promise<boolean>>();
  const activeKey = (mandate: Address) => {
    const k = mandate.toLowerCase();
    let f = checks.get(k);
    if (!f) {
      f = cachedAddressCheck({ onChain: (a) => o.isActiveKey(mandate, a), ttlMs: 30_000, ...(o.now ? { now: o.now } : {}) });
      checks.set(k, f);
    }
    return f;
  };
  return {
    async quote(ref: BookRef, q: QuoteObservation): Promise<QuoteAuth> {
      if (!q.signature) return "unsigned";
      if (q.bookId !== undefined && q.bookId !== ref.bookId) return "forged";
      const signer = await recoverQuoteSigner(o.chainId, ref.components.mandate, { bookId: ref.bookId, ts: q.ts, bid: q.bid, ask: q.ask, size: q.size ?? 0, sides: q.sides, signature: q.signature });
      if (!signer) return "forged";
      try {
        return (await activeKey(ref.components.mandate)(signer)) ? "ok" : "forged";
      } catch {
        return "unavailable"; // RPC: not cached, asked again next tick
      }
    },
    signKill(k): Promise<KillMsg> {
      return signKill(o.account, o.chainId, o.config, { bookId: k.bookId, reason: k.reason, breaches: k.breaches, issuedAt: k.issuedAt, nonce: killNonce(k.bookId, k.episodeId) });
    },
    forged(kind, reason) {
      o.forged?.note(kind, reason);
    },
  };
}
