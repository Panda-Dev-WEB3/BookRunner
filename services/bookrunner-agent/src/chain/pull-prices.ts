// Pull-oracle price data for the agent and the trader-sim (docs/LOW_GAS.md §1). The oracle service never
// pushes on a timer: it publishes signed updates (Redis KEYS.oracleBundle, optionally GET /prices/signed,
// and the per-price OraclePriceMsg stream) and every consumer transaction carries them as `priceData`
// (desk.executeWithPrices, PoolEngine.trade/liquidate overloads), AttestedOracle.update first.
//
// Selection is per underlying: across every candidate source keep the signed update with the highest
// publishedAt (the freshest), drop ones older than the caller's bound, encode only what the transaction
// needs (each carried update costs a signature check + a storage write).

import {
  KEYS,
  type Logger,
  type OracleBundleMsg,
  type OraclePriceMsg,
  type PriceUpdate,
  decodePriceData,
  encodePriceData,
  priceUpdateFromMsg,
} from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { OraclePoint } from "./book-chain";
import { DESK_ACTION, type DeskActionKind } from "./desk-actions";

export interface SignedUpdate {
  update: PriceUpdate;
  sig: Hex;
  /** where it came from (logs / tests) */
  source: string;
}

/** EIP-712 domain the signatures must be bound to (bundles for another oracle are ignored). */
export interface PriceDomain {
  chainId: number;
  oracle: Address;
}

const SIG_RE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;
/** A 64/65-byte ECDSA signature (a chain-fallback OraclePriceMsg carries "0x"). */
export const isSignature = (s: unknown): s is Hex => typeof s === "string" && SIG_RE.test(s);

/** Signed updates of a bundle; [] when absent, malformed or bound to another (chainId, oracle). */
export function bundleUpdates(raw: unknown, domain: PriceDomain | null, source = "bundle"): SignedUpdate[] {
  if (!raw || typeof raw !== "object") return [];
  const b = raw as Partial<OracleBundleMsg>;
  if (typeof b.priceData !== "string" || !b.priceData.startsWith("0x")) return [];
  if (domain) {
    if (b.chainId !== undefined && Number(b.chainId) !== domain.chainId) return [];
    if (typeof b.oracle === "string" && b.oracle.toLowerCase() !== domain.oracle.toLowerCase()) return [];
  }
  try {
    const { updates, sigs } = decodePriceData(b.priceData as Hex);
    return updates.map((update, i) => ({ update, sig: sigs[i] as Hex, source })).filter((u) => isSignature(u.sig) && u.update.priceWad > 0n);
  } catch {
    return [];
  }
}

/** A per-price stream message as a signed update; null without a signature or a usable price. */
export function msgUpdate(m: OraclePriceMsg | null | undefined, source = "stream"): SignedUpdate | null {
  if (!m || !isSignature(m.signature)) return null;
  try {
    const update = priceUpdateFromMsg(m);
    return update.priceWad > 0n && update.publishedAt > 0n ? { update, sig: m.signature, source } : null;
  } catch {
    return null;
  }
}

/** The freshest usable bundle (highest publishedAt); foreign-domain / malformed ones are ignored. */
export function freshestBundle(bundles: ReadonlyArray<unknown>, domain: PriceDomain | null): OracleBundleMsg | null {
  let best: OracleBundleMsg | null = null;
  for (const raw of bundles) {
    if (bundleUpdates(raw, domain).length === 0) continue;
    const b = raw as OracleBundleMsg;
    const at = Number(b.publishedAt);
    if (!Number.isFinite(at)) continue;
    if (!best || at > best.publishedAt) best = b;
  }
  return best;
}

/**
 * Pure: for each wanted underlying (order kept, duplicates dropped) the candidate with the highest
 * publishedAt; on a tie the earlier candidate wins. Updates more than maxAgeSec older than nowSec are
 * dropped (a future publishedAt is kept: AttestedOracle accepts up to block.timestamp + 5).
 */
export function selectFreshest(
  candidates: readonly SignedUpdate[],
  want: readonly Hex[],
  o: { nowSec: number; maxAgeSec: number },
): SignedUpdate[] {
  const out: SignedUpdate[] = [];
  const done = new Set<string>();
  for (const w of want) {
    const key = w.toLowerCase();
    if (done.has(key)) continue;
    done.add(key);
    let best: SignedUpdate | null = null;
    for (const c of candidates) {
      if (c.update.underlying.toLowerCase() !== key) continue;
      if (o.nowSec - Number(c.update.publishedAt) > o.maxAgeSec) continue;
      if (!best || c.update.publishedAt > best.update.publishedAt) best = c;
    }
    if (best) out.push(best);
  }
  return out;
}

/** priceData for the selection; null when there is nothing to carry (the caller takes its legacy path). */
export function toPriceData(sel: readonly SignedUpdate[]): Hex | null {
  if (sel.length === 0) return null;
  return encodePriceData(
    sel.map((s) => s.update),
    sel.map((s) => s.sig),
  );
}

export function pointOf(u: PriceUpdate): OraclePoint {
  return { priceWad: u.priceWad, publishedAt: Number(u.publishedAt), held: u.held, sourceCount: u.sourceCount };
}

/** The more recent of two oracle points (null-safe; the first wins a tie). */
export function newerPoint(a: OraclePoint | null, b: OraclePoint | null): OraclePoint | null {
  if (!a) return b;
  if (!b) return a;
  return b.publishedAt > a.publishedAt ? b : a;
}

// ---------------------------------------------------------------- sources

export interface BundleSource {
  readonly name: string;
  /** a raw OracleBundleMsg (validated by the caller) or null */
  get(): Promise<unknown>;
}

/** Redis KEYS.oracleBundle through any JSON getter (agent bus, trader-sim client). */
export function redisBundleSource(getJson: (key: string) => Promise<unknown>): BundleSource {
  return { name: "redis", get: () => getJson(KEYS.oracleBundle) };
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Oracle service GET {baseUrl}/prices/signed (503 before its first tick -> null). */
export function httpBundleSource(baseUrl: string, fetchFn: FetchLike = fetch as unknown as FetchLike): BundleSource {
  const url = `${baseUrl.replace(/\/+$/, "")}/prices/signed`;
  return {
    name: "http",
    async get() {
      const res = await fetchFn(url, { headers: { accept: "application/json" } });
      if (!res.ok) return null;
      return res.json();
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => t && clearTimeout(t)),
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    }),
  ]);
}

export interface PullPricesDeps {
  sources: BundleSource[];
  /** signed per-price messages already in hand (agent price feed); unsigned ones are ignored */
  stream?: () => ReadonlyArray<OraclePriceMsg | null>;
  domain: PriceDomain | null;
  /** per-source fetch bound */
  timeoutMs?: number;
  /** reuse one fetch for calls this close together (a hedge snapshot asks per component) */
  memoMs?: number;
  now?: () => number;
  log?: Logger;
}

/** Fetches every source in parallel (bounded), merges with the stream, selects the freshest per underlying. */
export class PullPrices {
  private readonly now: () => number;
  private memo: { atMs: number; p: Promise<SignedUpdate[]> } | null = null;
  private lastWarn = 0;

  constructor(private readonly d: PullPricesDeps) {
    this.now = d.now ?? Date.now;
  }

  /** The clock selections are aged against (unix seconds). */
  nowSec(): number {
    return this.now() / 1000;
  }

  /** Every signed update currently obtainable (memoized for memoMs). */
  candidates(): Promise<SignedUpdate[]> {
    const now = this.now();
    if (this.memo && now - this.memo.atMs < (this.d.memoMs ?? 500)) return this.memo.p;
    const p = this.fetchAll();
    this.memo = { atMs: now, p };
    return p;
  }

  private async fetchAll(): Promise<SignedUpdate[]> {
    const timeout = this.d.timeoutMs ?? 1_500;
    const fetched = await Promise.all(
      this.d.sources.map(async (s) => {
        try {
          return bundleUpdates(await withTimeout(s.get(), timeout), this.d.domain, s.name);
        } catch (err) {
          if (this.now() - this.lastWarn > 60_000) {
            this.lastWarn = this.now();
            this.d.log?.debug({ source: s.name, err: err instanceof Error ? err.message : String(err) }, "signed price source unavailable");
          }
          return [];
        }
      }),
    );
    const stream = (this.d.stream?.() ?? []).map((m) => msgUpdate(m)).filter((u): u is SignedUpdate => u !== null);
    return [...fetched.flat(), ...stream];
  }

  async select(want: readonly Hex[], maxAgeSec: number): Promise<SignedUpdate[]> {
    if (want.length === 0) return [];
    return selectFreshest(await this.candidates(), want, { nowSec: this.now() / 1000, maxAgeSec });
  }

  async priceData(want: readonly Hex[], maxAgeSec: number): Promise<Hex | null> {
    return toPriceData(await this.select(want, maxAgeSec));
  }

  /** The freshest signed price of one underlying as an OraclePoint (null when none within maxAgeSec). */
  async point(underlying: Hex, maxAgeSec: number): Promise<OraclePoint | null> {
    const [s] = await this.select([underlying], maxAgeSec);
    return s ? pointOf(s.update) : null;
  }
}

/**
 * oracleLatest(priceId) that prefers the freshest signed price over the stored on-chain one (pull mode:
 * the stored value is whatever the last consumer tx carried). The stored read failing is not fatal.
 */
export function freshestOracleLatest(
  prices: Pick<PullPrices, "point">,
  stored: (priceId: Hex) => Promise<OraclePoint>,
  maxAgeSec: number,
): (priceId: Hex) => Promise<OraclePoint> {
  return async (priceId) => {
    const [signed, onchain] = await Promise.all([prices.point(priceId, maxAgeSec).catch(() => null), stored(priceId).catch(() => null)]);
    const best = newerPoint(onchain, signed);
    if (!best) throw new Error(`no price for ${priceId}: no signed update and the on-chain read failed`);
    return best;
  };
}

/** AGENT_PULL_PRICES / TRADER_SIM_PULL_PRICES: auto = detect the entry point on the deployed contract. */
export async function resolvePullMode(mode: "auto" | "on" | "off", detect: () => Promise<boolean>): Promise<boolean> {
  if (mode === "off") return false;
  if (mode === "on") return true;
  return detect().catch(() => false);
}

// ---------------------------------------------------------------- desk actions

/** priceData for one desk action kind (null = plain execute). */
export interface DeskPriceData {
  forAction(kind: DeskActionKind): Promise<Hex | null>;
}

/**
 * Which prices a desk action needs (each carried entry costs a signature check + a storage write, so
 * nothing more): ReturnToVault none (always allowed, no valuation); SetQuote, InventoryToVenue and
 * InventoryToVault only the book's (mandate off-hours checks; the engine-side liquidity move needs a
 * fresh market price with open interest); Hedge, Flatten and FundDesk the book's plus every hedge
 * component's (mandate off-hours, registry valuations of the legs / desk.valueUsd).
 */
export function deskWant(kind: DeskActionKind, bookPriceId: Hex, componentPriceIds: readonly Hex[]): Hex[] {
  if (kind === DESK_ACTION.ReturnToVault) return [];
  if (!needsComponents(kind)) return [bookPriceId];
  return [bookPriceId, ...componentPriceIds];
}

const needsComponents = (kind: DeskActionKind) => kind === DESK_ACTION.Hedge || kind === DESK_ACTION.Flatten || kind === DESK_ACTION.FundDesk;

export interface DeskPriceDataOptions {
  bookPriceId: Hex;
  componentPriceIds: () => Promise<readonly Hex[]>;
  /** signed prices older than this are not carried */
  maxAgeSec: number;
  /** the stored on-chain price of an underlying (AttestedOracle.latest) */
  stored?: (priceId: Hex) => Promise<OraclePoint>;
  /**
   * Skip empty work (docs/LOW_GAS.md §4): an action that needs only the book price (SetQuote, inventory
   * moves) carries nothing while the STORED book price is in-hours and younger than this — someone
   * (a trader, the mark keeper) already landed it, and the mandate / engine judge on it. 0 = always carry.
   * Swaps and FundDesk always carry (their oracle-slippage and valuation checks want the latest print).
   */
  storedFreshSec?: number;
}

export function deskPriceData(prices: PullPrices, o: DeskPriceDataOptions): DeskPriceData {
  return {
    async forAction(kind) {
      if (kind === DESK_ACTION.ReturnToVault) return null;
      if (!needsComponents(kind) && o.stored && (o.storedFreshSec ?? 0) > 0) {
        const s = await o.stored(o.bookPriceId).catch(() => null);
        if (s && !s.held && s.publishedAt > 0 && prices.nowSec() - s.publishedAt < (o.storedFreshSec ?? 0)) return null;
      }
      const comps = needsComponents(kind) ? await o.componentPriceIds() : [];
      return prices.priceData(deskWant(kind, o.bookPriceId, comps), o.maxAgeSec);
    },
  };
}
