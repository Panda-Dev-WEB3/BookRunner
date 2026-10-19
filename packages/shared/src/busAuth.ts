// Authenticated bus messages (audit 2026-10 lead "Redis is a shared trust domain", Task 7b fix round 1). Redis is not
// trusted: a message that can stop a book, revoke a key or make risk kill a book must be signed by a key whose role
// is on-chain.
//   - Kill orders (CHANNELS.kill, the revoke_key job): EIP-712 `KillOrder` signed by the risk service's RISK key,
//     domain (chainId, BookrunnerConfig). Verifiers check config.hasRole(RISK_ROLE, signer) (cached, RPC errors never
//     cached), the age (issuedAt within KILL_MAX_AGE_SEC, not in the future) and replays (nonce seen).
//   - Agent quotes (KEYS.agentQuote): EIP-712 `AgentQuote` signed by the book's desk session key, domain (chainId,
//     the book's MMMandate). Risk checks MMMandate.isActiveKey(signer); an unsigned or forged quote is no quote.
import { type Address, type Hex, type LocalAccount, getAddress, isAddress, keccak256, recoverTypedDataAddress, toHex } from "viem";
import type { KillMsg, QuoteMsg } from "./queues";

// ------------------------------------------------------------------ cached on-chain address checks

/** How long an on-chain role answer is reused. */
export const ROLE_CACHE_MS = 60_000;

/**
 * An address check: the pinned addresses when `pinned` is set (comma-separated; no RPC), else `onChain` cached
 * ROLE_CACHE_MS per address. An RPC error propagates (the caller treats it as "unavailable") and is never cached.
 */
export function cachedAddressCheck(o: { pinned?: string | undefined; pinnedEnv?: string; onChain: (a: Address) => Promise<boolean>; now?: () => number; ttlMs?: number }): (a: Address) => Promise<boolean> {
  const now = o.now ?? Date.now;
  if (o.pinned?.trim()) {
    const list = o.pinned.split(",").map((x) => x.trim()).filter(Boolean);
    for (const a of list) if (!isAddress(a)) throw new Error(`${o.pinnedEnv ?? "pinned signers"}: not an address: ${a}`);
    const set = new Set(list.map((a) => getAddress(a)));
    return async (a) => set.has(getAddress(a));
  }
  const ttl = o.ttlMs ?? ROLE_CACHE_MS;
  const cache = new Map<string, { ok: boolean; at: number }>();
  return async (a) => {
    const k = a.toLowerCase();
    const hit = cache.get(k);
    if (hit && now() - hit.at < ttl) return hit.ok;
    const ok = await o.onChain(a);
    if (cache.size >= 4_096) cache.delete(cache.keys().next().value as string);
    cache.set(k, { ok, at: now() });
    return ok;
  };
}

// ------------------------------------------------------------------ kill orders

/** A signed kill is refused when older than this (seconds) or more than KILL_FUTURE_SEC in the future. */
export const KILL_MAX_AGE_SEC = 120;
export const KILL_FUTURE_SEC = 30;

export const killDomain = (chainId: number, config: Address) => ({ name: "Bookrunner Kill", version: "1", chainId, verifyingContract: config }) as const;

export const killTypes = {
  KillOrder: [
    { name: "bookId", type: "uint256" },
    { name: "reasonHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface KillOrder {
  bookId: bigint;
  reasonHash: Hex;
  issuedAt: bigint;
  nonce: Hex;
}

/** The nonce of a kill episode (one per book and episode: re-signing the same episode keeps it). */
export const killNonce = (bookId: number, episodeId: string): Hex => keccak256(toHex(`bookrunner-kill:${bookId}:${episodeId}`));

const killOrderOf = (m: { bookId: number; reason: string; issuedAt: number; nonce: Hex }): KillOrder => ({
  bookId: BigInt(m.bookId),
  reasonHash: keccak256(toHex(m.reason)),
  issuedAt: BigInt(m.issuedAt),
  nonce: m.nonce,
});

/** A KillMsg signed with the RISK key (local or KMS account). */
export async function signKill(account: Pick<LocalAccount, "signTypedData">, chainId: number, config: Address, k: { bookId: number; reason: string; breaches: string[]; issuedAt: number; nonce: Hex }): Promise<KillMsg> {
  const signature = await account.signTypedData({ domain: killDomain(chainId, config), types: killTypes, primaryType: "KillOrder", message: killOrderOf(k) });
  return { bookId: k.bookId, ts: k.issuedAt * 1000, reason: k.reason, breaches: k.breaches, issuedAt: k.issuedAt, nonce: k.nonce, signature };
}

export type KillVerdict =
  | { ok: true; msg: KillMsg; signer: Address }
  /** forged: unsigned, malformed or signed by a non-RISK key. unavailable: the role check could not run (RPC). */
  | { ok: false; reason: string; forged: boolean; unavailable?: boolean; replay?: boolean };

const SIG_RE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;

/** Verifies kill orders from the bus. One instance per input (a nonce is consumed once per verifier). */
export class KillVerifier {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly o: { chainId: number; config: Address; isRiskSigner: (a: Address) => Promise<boolean>; now?: () => number; maxAgeSec?: number },
  ) {
    this.now = o.now ?? Date.now;
  }

  async verify(raw: unknown): Promise<KillVerdict> {
    let m: unknown = raw;
    if (typeof raw === "string") {
      try {
        m = JSON.parse(raw);
      } catch {
        return { ok: false, reason: "unreadable kill message", forged: true };
      }
    }
    if (!m || typeof m !== "object") return { ok: false, reason: "unreadable kill message", forged: true };
    const k = m as Partial<KillMsg>;
    const bookId = Number(k.bookId);
    if (!Number.isSafeInteger(bookId) || bookId <= 0 || typeof k.reason !== "string") return { ok: false, reason: "malformed kill message", forged: true };
    if (typeof k.signature !== "string" || !SIG_RE.test(k.signature) || typeof k.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k.nonce) || typeof k.issuedAt !== "number" || !Number.isSafeInteger(k.issuedAt)) {
      return { ok: false, reason: "unsigned kill message (no RISK signature)", forged: true };
    }
    const nowSec = this.now() / 1000;
    if (k.issuedAt > nowSec + KILL_FUTURE_SEC) return { ok: false, reason: `kill issued in the future (${k.issuedAt})`, forged: true };
    if (nowSec - k.issuedAt > (this.o.maxAgeSec ?? KILL_MAX_AGE_SEC)) return { ok: false, reason: `stale kill (issued ${Math.round(nowSec - k.issuedAt)} s ago)`, forged: false, replay: true };
    if (this.seen.has(k.nonce.toLowerCase())) return { ok: false, reason: "replayed kill (nonce already used)", forged: false, replay: true };
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        domain: killDomain(this.o.chainId, this.o.config),
        types: killTypes,
        primaryType: "KillOrder",
        message: killOrderOf({ bookId, reason: k.reason, issuedAt: k.issuedAt, nonce: k.nonce as Hex }),
        signature: k.signature as Hex,
      });
    } catch {
      return { ok: false, reason: "malformed kill signature", forged: true };
    }
    let isRisk: boolean;
    try {
      isRisk = await this.o.isRiskSigner(signer);
    } catch (err) {
      return { ok: false, reason: `RISK role check unavailable for ${signer}: ${err instanceof Error ? err.message : String(err)}`, forged: false, unavailable: true };
    }
    if (!isRisk) return { ok: false, reason: `kill signed by ${signer}, which does not hold RISK_ROLE`, forged: true };
    this.seen.set(k.nonce.toLowerCase(), k.issuedAt);
    if (this.seen.size > 1_024) {
      for (const [n, at] of this.seen) if (nowSec - at > (this.o.maxAgeSec ?? KILL_MAX_AGE_SEC)) this.seen.delete(n);
    }
    return { ok: true, msg: { bookId, ts: k.issuedAt * 1000, reason: k.reason, breaches: Array.isArray(k.breaches) ? k.breaches.map(String) : [], issuedAt: k.issuedAt, nonce: k.nonce as Hex, signature: k.signature as Hex }, signer };
  }
}

// ------------------------------------------------------------------ agent quotes

export const quoteDomain = (chainId: number, mandate: Address) => ({ name: "Bookrunner AgentQuote", version: "1", chainId, verifyingContract: mandate }) as const;

export const quoteTypes = {
  AgentQuote: [
    { name: "bookId", type: "uint256" },
    { name: "ts", type: "uint64" },
    { name: "bidE8", type: "uint256" },
    { name: "askE8", type: "uint256" },
    { name: "sizeE8", type: "uint256" },
    { name: "sides", type: "uint8" },
  ],
} as const;

const e8 = (x: number): bigint => (Number.isFinite(x) && x > 0 ? BigInt(Math.round(x * 1e8)) : 0n);

/** The signed fields of a QuoteMsg (prices and size at 1e-8, sides bit 0 = bid, bit 1 = ask). */
export function quoteFields(q: Pick<QuoteMsg, "bookId" | "ts" | "bid" | "ask" | "size" | "sides">) {
  return {
    bookId: BigInt(q.bookId),
    ts: BigInt(Math.trunc(q.ts)),
    bidE8: e8(q.bid),
    askE8: e8(q.ask),
    sizeE8: e8(q.size),
    sides: (q.sides?.bid ? 1 : 0) | (q.sides?.ask ? 2 : 0),
  };
}

/** The agent's signature over its published quote (desk session key). */
export function signQuote(account: Pick<LocalAccount, "signTypedData">, chainId: number, mandate: Address, q: QuoteMsg): Promise<Hex> {
  return account.signTypedData({ domain: quoteDomain(chainId, mandate), types: quoteTypes, primaryType: "AgentQuote", message: quoteFields(q) });
}

/** The signer of a published quote; null when unsigned or malformed. */
export async function recoverQuoteSigner(chainId: number, mandate: Address, q: Pick<QuoteMsg, "bookId" | "ts" | "bid" | "ask" | "size" | "sides"> & { signature?: unknown }): Promise<Address | null> {
  if (typeof q.signature !== "string" || !SIG_RE.test(q.signature)) return null;
  try {
    return await recoverTypedDataAddress({ domain: quoteDomain(chainId, mandate), types: quoteTypes, primaryType: "AgentQuote", message: quoteFields(q), signature: q.signature as Hex });
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ forged messages (alerts bus_forged_message)

/** Forged bus messages are kept for the last hour (KEYS.busForged(source)); services/alerts rates them. */
export const FORGED_WINDOW_SEC = 3_600;

export interface BusForgedMsg {
  v: 1;
  /** who saw them: "agent-<bookId>", "ops-venue", "risk" */
  source: string;
  ts: number; // unix ms of the write
  /** oldest first, within FORGED_WINDOW_SEC */
  events: Array<{ at: number; kind: "kill" | "quote"; reason: string }>;
}

/** Records forged messages a service refused and publishes the last hour of them (best effort). */
export class ForgedLog {
  private events: BusForgedMsg["events"] = [];

  constructor(
    readonly source: string,
    private readonly write: (msg: BusForgedMsg) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  note(kind: "kill" | "quote", reason: string): void {
    const now = this.now();
    this.events = [...this.events.filter((e) => now - e.at < FORGED_WINDOW_SEC * 1000), { at: now, kind, reason: reason.slice(0, 160) }].slice(-200);
    void this.write({ v: 1, source: this.source, ts: now, events: this.events }).catch(() => undefined);
  }

  recent(): BusForgedMsg["events"] {
    const now = this.now();
    return this.events.filter((e) => now - e.at < FORGED_WINDOW_SEC * 1000);
  }
}
