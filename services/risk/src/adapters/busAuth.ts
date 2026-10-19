// Authenticated bus messages for the risk service (audit 2026-10 lead "Redis is a shared trust domain"; shared
// definitions in packages/shared/src/busAuth.ts):
//   - the agent's quote (KEYS.agentQuote) is accepted only when (a) it carries an EIP-712 AgentQuote signature by an
//     ACTIVE desk session key of the book's mandate (MMMandate.isActiveKey, cached, RPC errors never cached), (b) it is
//     at most QUOTE_SIGNED_MAX_AGE_MS old and strictly newer than the last quote accepted for the book, and (c) the
//     oracle print it was priced on (signed into the quote) verifies (oracle signature, or equal to the attested price
//     risk read) and is within the quote-price bound of the quote's ts. Risk then judges the quote against THAT
//     print: a replayed genuine quote is judged against its own price, so it cannot fake a breach. Anything else is
//     no new quote (never a breach). A registered desk key that expired or was revoked is "no_key", not a forgery;
//   - kill orders (the kill channel and the revoke_key job) and the published risk state are signed with the RISK key:
//     agents and ops-venue act only on those.
import {
  type ForgedLog,
  type KillMsg,
  type LimitState,
  OraclePriceVerifier,
  type PriceSignerCheck,
  QUOTE_SIGNED_MAX_AGE_MS,
  killNonce,
  recoverKillOrderSigner,
  recoverMonitorStateSigner,
  recoverQuoteSigner,
  signKill,
  signMonitorState,
  signRiskState,
} from "@bookrunner/shared";
import type { Address, Hex, LocalAccount } from "viem";
import type { QuoteAuthResult, QuoteCheckContext, RiskBusAuth } from "../ports";
import type { BookRef, QuoteObservation } from "../types";

export type DeskKeyStatus = "active" | "inactive" | "unknown";

export interface RiskBusAuthOptions {
  chainId: number;
  /** BookrunnerConfig of the deployment (KillOrder / RiskState domain) */
  config: Address;
  /** the RISK role key (local or KMS) */
  account: Pick<LocalAccount, "signTypedData" | "address">;
  /**
   * The desk-key status of `key` on `mandate`: active (isActiveKey), inactive (registered once: getKey().validUntil > 0,
   * now expired / revoked / mandate killed) or unknown (never a key). THROWS when the read fails.
   */
  deskKeyStatus(mandate: Address, key: Address): Promise<DeskKeyStatus>;
  /** who signs oracle prints (AttestedOracle.isSigner, shared oracleSignerCheck) */
  oracle: PriceSignerCheck;
  forged?: ForgedLog;
  now?: () => number;
}

const SIG_RE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;
const FUTURE_TOLERANCE_MS = 5_000;

export function riskBusAuth(o: RiskBusAuthOptions): RiskBusAuth {
  const checks = new Map<string, (a: Address) => Promise<DeskKeyStatus>>();
  const keyStatus = (mandate: Address) => {
    const k = mandate.toLowerCase();
    let f = checks.get(k);
    if (!f) {
      const cache = new Map<string, { s: DeskKeyStatus; at: number }>();
      const now = o.now ?? Date.now;
      f = async (a) => {
        const hit = cache.get(a.toLowerCase());
        if (hit && now() - hit.at < 30_000) return hit.s;
        const s = await o.deskKeyStatus(mandate, a); // an RPC error propagates: never cached
        if (cache.size >= 1_024) cache.delete(cache.keys().next().value as string);
        cache.set(a.toLowerCase(), { s, at: now() });
        return s;
      };
      checks.set(k, f);
    }
    return f;
  };
  const prints = new OraclePriceVerifier(o.oracle);

  return {
    async quote(ref: BookRef, q: QuoteObservation, ctx: QuoteCheckContext): Promise<QuoteAuthResult> {
      if (!q.signature) return { status: "unsigned" };
      if (q.bookId !== undefined && q.bookId !== ref.bookId) return { status: "forged" };
      // freshness and monotonic ts first: a replay is no new quote (and costs no RPC)
      if (ctx.nowMs - q.ts > QUOTE_SIGNED_MAX_AGE_MS || q.ts > ctx.nowMs + FUTURE_TOLERANCE_MS || q.ts <= ctx.lastAcceptedTs) return { status: "stale" };
      const r = q.ref;
      const signer = await recoverQuoteSigner(o.chainId, ref.components.mandate, { bookId: ref.bookId, ts: q.ts, bid: q.bid, ask: q.ask, size: q.size ?? 0, sides: q.sides, ref: r, signature: q.signature });
      if (!signer) return { status: "forged" };
      let ks: DeskKeyStatus;
      try {
        ks = await keyStatus(ref.components.mandate)(signer);
      } catch {
        return { status: "unavailable" }; // RPC: asked again next tick
      }
      if (ks === "unknown") return { status: "forged" };
      if (ks === "inactive") return { status: "no_key" };
      // the oracle print the quote was priced on
      if (!r || r.underlying?.toLowerCase() !== ref.priceId.toLowerCase()) return { status: "bad_ref" };
      let priceWad: bigint;
      try {
        priceWad = BigInt(r.priceWad);
      } catch {
        return { status: "bad_ref" };
      }
      if (!(priceWad > 0n) || r.publishedAt * 1000 < q.ts - ctx.priceMaxAgeMs) return { status: "bad_ref" };
      if (typeof r.signature === "string" && SIG_RE.test(r.signature)) {
        const v = await prints.verify({ underlying: r.underlying, priceWad, publishedAt: BigInt(r.publishedAt), held: r.held, sourceCount: r.sourceCount, sourcesHash: r.sourcesHash }, r.signature as Hex);
        if (!v.ok) return v.reason.startsWith("signer check unavailable") ? { status: "unavailable" } : { status: "forged" };
      } else {
        // the AttestedOracle fallback (unsigned in the message): only the attested price risk read itself
        const a = ctx.attested;
        if (!a || a.priceWad !== priceWad || a.publishedAt !== r.publishedAt) return { status: "bad_ref" };
      }
      return { status: "ok", refPx: Number(priceWad) / 1e18 };
    },
    signKill(k): Promise<KillMsg> {
      return signKill(o.account, o.chainId, o.config, { bookId: k.bookId, reason: k.reason, breaches: k.breaches, issuedAt: k.issuedAt, nonce: killNonce(k.bookId, k.episodeId) });
    },
    signState(k: { bookId: number; state: LimitState; tsMs: number }): Promise<Hex> {
      return signRiskState(o.account, o.chainId, o.config, k);
    },
    forged(kind, reason) {
      o.forged?.note(kind, reason);
    },
    signMonitor(k): Promise<Hex> {
      return signMonitorState(o.account, o.chainId, o.config, k);
    },
    async isOwnMonitor(k): Promise<boolean> {
      const signer = await recoverMonitorStateSigner(o.chainId, o.config, k);
      return !!signer && signer.toLowerCase() === o.account.address.toLowerCase();
    },
    async isOwnKillOrder(bookId, episodeId, msg): Promise<boolean> {
      if (!msg || typeof msg !== "object") return false;
      const m = msg as Partial<KillMsg>;
      if (Number(m.bookId) !== bookId || typeof m.nonce !== "string" || m.nonce.toLowerCase() !== killNonce(bookId, episodeId).toLowerCase()) return false;
      const signer = await recoverKillOrderSigner(o.chainId, o.config, m);
      return !!signer && signer.toLowerCase() === o.account.address.toLowerCase();
    },
  };
}

