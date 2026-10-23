// Trading page (2026-10, Plan B2): single-stock perpetual markets on the in-house PoolEngine, one per engine book
// (docs/ARCHITECTURE.md §2.8, "Trading on the in-house engine" in §5). Reads: the open markets (price and its age,
// session, funding, open interest, caps and room, fees, margins), one market, a wallet's position (liquidation
// price computed like the engine), a quote for a size. Mutations return prepared transactions (the wallet signs):
// [approve, depositMargin], withdrawMargin (with the oracle relay when a position is open), trade carrying the
// freshest signed price, close. Every input is checked against the engine's rules before anything is built, so a
// trade the engine would refuse is refused here with the reason.
import { bytes32ToStr } from "@bookrunner/shared/bytes32";
import { KEYS } from "@bookrunner/shared/queues";
import { VENUE } from "@bookrunner/shared/types";
import type { Address } from "viem";
import { z } from "zod";
import type { EngineMarketChainState, EngineTraderChainState } from "../chain/gateway";
import type { BookRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { usdInput } from "../domain/charter";
import { BPS, type EnginePosition, abs, acceptablePriceWad, isLiquidatable, liquidationPriceWad, notionalUsd, offHoursMarginBps, simulateTrade } from "../domain/engine";
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  type SessionState,
  type SignedPrice,
  type TradePrice,
  lev,
  marketView,
  mathOf,
  positionView,
  safeMaxWithdraw,
  sessionOf,
  signedPriceFor,
  signedUsd,
  tradeMaxAge,
  tradePrice,
  unitsStr,
  withdrawMaxAge,
} from "../domain/trade";
import { type PreparedTx, approveUsdcTx, engineDepositMarginTx, engineTradeTx, engineWithdrawMarginTx, oracleUpdateTx } from "../domain/txs";
import { parseUsd, usdStr, wadStr } from "../format";
import { cached, parseJson } from "../kv";
import { fail, hardChain, publicProcedure, requireChain, router } from "../trpc";
import { intLike, walletInput } from "./common";

const LIVE_STATES = new Set(["Live", "Retiring"]);
/** Two transactions (oracle relay, then withdrawMargin) must land within the 60 s bound: keep this much of it. */
const WITHDRAW_PRICE_HEADROOM_SEC = 20;

const marketIdInput = intLike(1);
const slippageInput = intLike(1, MAX_SLIPPAGE_BPS).default(DEFAULT_SLIPPAGE_BPS);
/** Signed size in 1e18 units of the underlying (positive: buy / long). */
const sizeDeltaInput = z
  .string()
  .regex(/^-?\d{1,40}$/, "expected a signed integer size in 1e18 units")
  .transform((s) => BigInt(s))
  .refine((v) => v !== 0n, "the size is zero");

interface LoadedMarket {
  book: BookRow;
  chain: EngineMarketChainState;
  meta: { bookId: number; name: string | null; bookSymbol: string; symbol: string; bookState: string };
  label: string;
}

const engineBooks = async (deps: ApiDeps) => (await deps.data.listBooks()).filter((b) => b.venue === VENUE.POOL_ENGINE && LIVE_STATES.has(b.state));

function loaded(book: BookRow, chain: EngineMarketChainState): LoadedMarket {
  const symbol = bytes32ToStr(chain.config.symbol) || book.symbol;
  const meta = { bookId: book.id, name: book.name, bookSymbol: book.symbol, symbol, bookState: book.state };
  return { book, chain, meta, label: book.name ?? symbol };
}

/** The signed prints the oracle publishes (one Redis read for the bundle, one scan for the per-key messages). */
/** Review I-7: the signed source is re-read at most once per SIGNED_SOURCE_TTL_MS per API process (the oracle signs every ~1 s). */
export const SIGNED_SOURCE_TTL_MS = 1_000;
const signedMemo = new WeakMap<ApiDeps, { at: number; v: Promise<{ bundle: unknown; messages: unknown[] }> }>();

function signedSource(deps: ApiDeps): Promise<{ bundle: unknown; messages: unknown[] }> {
  const hit = signedMemo.get(deps);
  if (hit && deps.now() - hit.at < SIGNED_SOURCE_TTL_MS) return hit.v;
  const v = (async () => {
    const [bundleRaw, keys] = await Promise.all([deps.kv.get(KEYS.oracleBundle), deps.kv.scan(KEYS.oracleLast("*"), 500)]);
    const messages = keys.length ? (await deps.kv.mget(keys)).map((r) => parseJson(r)) : [];
    return { bundle: parseJson(bundleRaw), messages };
  })();
  signedMemo.set(deps, { at: deps.now(), v });
  v.catch(() => signedMemo.delete(deps));
  return v;
}

interface Priced {
  m: LoadedMarket;
  signed: SignedPrice | null;
  price: TradePrice | null;
  session: SessionState;
  nowSec: number;
}

async function price(deps: ApiDeps, m: LoadedMarket, src: { bundle: unknown; messages: unknown[] }, exactBasis: boolean): Promise<Priced> {
  const gw = requireChain(deps);
  const signed = signedPriceFor(src.bundle, src.messages, m.chain.config.underlying, { chainId: gw.chainId, oracle: gw.deployment.contracts.oracle });
  const p = tradePrice(m.chain, signed);
  const nowSec = Math.floor(deps.now() / 1000);
  // the split gate is read at the share basis of the price the trade uses (its publishedAt); the list rounds it
  // down to 30 s (one cached read per market and half-minute; conservative: an earlier basis can only open a window)
  const basis = p ? (exactBasis ? p.publishedAt : p.publishedAt - (p.publishedAt % 30)) : 0;
  const split = p ? await gw.splitGate(m.chain.config.underlying, basis) : { pending: false, window: false };
  const session = sessionOf({
    bookState: m.book.state,
    price: p,
    nowSec,
    maxAgeSec: tradeMaxAge(m.chain),
    reduceOnly: m.chain.state.reduceOnly,
    closeOutAfter: m.chain.closeOutAfter,
    lossBudgetBlocked: m.chain.lossBudgetBlocked,
    split,
  });
  return { m, signed, price: p, session, nowSec };
}

async function loadMarket(deps: ApiDeps, marketId: number): Promise<LoadedMarket> {
  requireChain(deps);
  const books = await engineBooks(deps);
  const chains = await hardChain(deps, "engine.markets", (g) => Promise.all(books.map((b) => g.engineMarket(b.adapterAddr as Address))));
  const i = chains.findIndex((c) => c?.marketId === marketId);
  const c = chains[i];
  const b = books[i];
  if (!c || !b) fail("NOT_FOUND", `No open in-house market #${marketId} on this deployment`);
  return loaded(b, c);
}

async function loadPriced(deps: ApiDeps, marketId: number, exactBasis = true): Promise<Priced> {
  const m = await loadMarket(deps, marketId);
  const src = await signedSource(deps);
  return hardChain(deps, "engine.splitGate", () => price(deps, m, src, exactBasis));
}

/** Fresh read of a wallet in a market: the prepared transactions (deposit / withdraw / order / close). */
const traderOf = (deps: ApiDeps, marketId: number, wallet: Address) => hardChain(deps, "engine.trader", (g) => g.engineTrader(marketId, wallet));

/**
 * The same read for the public queries (trade.quote / trade.position), cached per (market, wallet) for
 * TRADER_READ_CACHE_SECONDS (review I-7: random wallets must not drive paid RPC; the web polls these every few seconds).
 * The three views are one Multicall3 aggregate3 on mainnet (the public client batches parallel reads).
 */
export const TRADER_READ_CACHE_SECONDS = 2;
const traderOfCached = (deps: ApiDeps, marketId: number, wallet: Address) =>
  cached(deps.kv, `trade:trader:${deps.settings.chainId}:${marketId}:${wallet.toLowerCase()}`, TRADER_READ_CACHE_SECONDS, () => traderOf(deps, marketId, wallet));

const isoSec = (s: number) => new Date(s * 1000).toISOString();

/** Quote of a trade of `sizeDelta` for a position (flat without a wallet), with its refusal (if any) and warnings. */
function quoteOf(pr: Priced, pos: EnginePosition | null, sizeDelta: bigint, slippageBps: number, refuseUnholdable = false) {
  const m = pr.m.chain;
  const math = mathOf(m);
  const px = pr.price?.priceWad ?? 0n;
  const base: EnginePosition = pos ?? { size: 0n, entryPriceWad: 0n, marginUsd: 0n, fundingIndexAtEntry: m.state.fundingIndex };
  const sim = simulateTrade(math, base, px, sizeDelta, pos !== null);
  const s = pr.session;
  const ohBps = offHoursMarginBps(m.config.initialMarginBps);
  const after: EnginePosition = { size: sim.newSize, entryPriceWad: sim.newEntryWad, marginUsd: sim.marginAfterUsd, fundingIndexAtEntry: m.state.fundingIndex };
  // a position that would be liquidatable at the closing price of the next session close (equity < 2 x initial margin)
  const unholdable = sim.newRisk && sim.newSize !== 0n && pos !== null && isLiquidatable(after, px, m.state.fundingIndex, ohBps);
  const holdable = (10_000 / ohBps).toFixed(1).replace(/\.0$/, "");
  const refusal = !pr.price
    ? { code: "NO_PRICE", message: s.reasons[0] ?? "The market has no price." }
    : !s.canTrade
      ? { code: s.session.toUpperCase(), message: s.reasons[0] ?? "Trading is paused." }
      : sim.newRisk && !s.newRisk
        ? { code: s.session.toUpperCase(), message: `${s.reasons.join(" ")} This order adds risk.` }
        : sim.refusal
          ? { code: sim.refusal.code, message: sim.refusal.message }
          : unholdable && refuseUnholdable
            ? {
                code: "UNHOLDABLE_LEVERAGE",
                message: `Above ${holdable}x on this deployment: the position must be able to stay open through a session close, when the requirement is ${ohBps / 100}% of notional (2x initial margin). Add margin or trade a smaller size.`,
              }
            : null;
  const warnings: string[] = [];
  if (unholdable && !refuseUnholdable)
    warnings.push(
      `Above ${holdable}x, a position cannot be held through a session close: while the stock's session is closed the requirement is ${ohBps / 100}% of notional (2x initial margin), so this one would be liquidated at the closing price unless you add margin or reduce before the close.`,
    );
  if (pos === null && sim.newSize !== 0n) warnings.push(`Connect a wallet to check your margin: this position needs at least ${usdStr(sim.requiredInitialUsd)} of equity (initial margin).`);
  const liq = (bps: number) => {
    if (sim.newSize === 0n) return null;
    const r = liquidationPriceWad(after, m.state.fundingIndex, bps);
    return r.always ? "any" : r.priceWad === null ? null : wadStr(r.priceWad);
  };
  const impact = px > 0n ? Number(((sim.fillPriceWad - px) * 1_000_000n) / px) / 100 : null;
  const maxAge = tradeMaxAge(m);
  return {
    marketId: m.marketId,
    sizeDelta: sizeDelta.toString(),
    side: sizeDelta > 0n ? ("buy" as const) : ("sell" as const),
    units: unitsStr(abs(sizeDelta)),
    oraclePrice: px > 0n ? wadStr(px) : null,
    priceSource: pr.price?.source ?? null,
    priceAgeSeconds: pr.price ? Math.max(0, pr.nowSec - pr.price.publishedAt) : null,
    tradableUntil: pr.price ? isoSec(pr.price.publishedAt + maxAge) : null,
    fillPrice: wadStr(sim.fillPriceWad),
    fillPriceWad: sim.fillPriceWad.toString(),
    /** (fill - oracle) / oracle in bps: positive above the oracle (a buy pays it), negative below (a sell receives less) */
    priceImpactBps: impact,
    notionalUsd: usdStr(notionalUsd(sizeDelta, sim.fillPriceWad)),
    feeUsd: usdStr(sim.feeUsd),
    slippageBps,
    acceptablePrice: wadStr(acceptablePriceWad(sim.fillPriceWad, sizeDelta, slippageBps)),
    acceptablePriceWad: acceptablePriceWad(sim.fillPriceWad, sizeDelta, slippageBps).toString(),
    newRisk: sim.newRisk,
    realisedPnlUsd: signedUsd(sim.realisedPnlUsd),
    fundingSettledUsd: signedUsd(sim.fundingUsd),
    after: {
      side: sim.newSize === 0n ? ("flat" as const) : sim.newSize > 0n ? ("long" as const) : ("short" as const),
      size: unitsStr(sim.newSize),
      entryPrice: sim.newSize === 0n ? null : wadStr(sim.newEntryWad),
      marginUsd: usdStr(sim.marginAfterUsd),
      equityUsd: signedUsd(sim.equityAfterUsd),
      notionalUsd: usdStr(sim.notionalAfterUsd),
      requiredInitialUsd: usdStr(sim.requiredInitialUsd),
      marginRatioBps: sim.newSize === 0n || sim.notionalAfterUsd === 0n ? null : sim.equityAfterUsd <= 0n ? 0 : Number((sim.equityAfterUsd * BPS) / sim.notionalAfterUsd),
      leverage: lev(sim.notionalAfterUsd, sim.equityAfterUsd),
      liquidationPrice: pos === null ? null : liq(m.config.maintenanceMarginBps),
      liquidationPriceOffHours: pos === null ? null : liq(ohBps),
    },
    refusal,
    warnings,
  };
}

function orderWarnings(pr: Priced, q: ReturnType<typeof quoteOf>): string[] {
  const w = [...q.warnings];
  if (pr.price) {
    const until = pr.price.publishedAt + tradeMaxAge(pr.m.chain);
    w.push(
      `The trade carries the signed price published at ${isoSec(pr.price.publishedAt)}: it must be mined before ${isoSec(until)} (${tradeMaxAge(pr.m.chain)} s after it), otherwise it reverts and only gas is spent. Sign promptly, or prepare it again.`,
    );
  }
  w.push(`It fills at ${q.fillPrice} per unit at the price above, and never at a ${q.side === "buy" ? "price above" : "price below"} ${q.acceptablePrice} (slippage ${q.slippageBps / 100}%).`);
  return w;
}

const position = (t: EngineTraderChainState): EnginePosition => t.position;

export const tradeRouter = router({
  /** The open in-house engine markets of the deployment (Live / Retiring engine books). */
  markets: publicProcedure.query(async ({ ctx: { deps } }) => {
    const gw = deps.chain();
    if (!gw) return { asOf: new Date(deps.now()).toISOString(), chainReadable: false, markets: [] };
    try {
      const books = await engineBooks(deps);
      const chains = await Promise.all(books.map((b) => gw.engineMarket(b.adapterAddr as Address)));
      const src = await signedSource(deps);
      const markets = await Promise.all(
        books.flatMap((b, i) => {
          const c = chains[i];
          return c ? [price(deps, loaded(b, c), src, false).then((pr) => marketView(pr.m.meta, c, pr.price, pr.session, pr.nowSec, !!deps.settings.tradeRefuseUnholdable))] : [];
        }),
      );
      return { asOf: new Date(deps.now()).toISOString(), chainReadable: true, markets: markets.sort((a, b) => a.marketId - b.marketId) };
    } catch (err) {
      deps.log.warn({ err, what: "trade.markets" }, "chain read failed");
      return { asOf: new Date(deps.now()).toISOString(), chainReadable: false, markets: [] };
    }
  }),

  /** One market. */
  market: publicProcedure.input(z.object({ marketId: marketIdInput })).query(async ({ ctx: { deps }, input }) => {
    const pr = await loadPriced(deps, input.marketId, false);
    return marketView(pr.m.meta, pr.m.chain, pr.price, pr.session, pr.nowSec, !!deps.settings.tradeRefuseUnholdable);
  }),

  /** A wallet's position at the freshest price: size, entry, margin, equity, margin ratio, liquidation prices, PnL. */
  position: publicProcedure.input(z.object({ marketId: marketIdInput, wallet: walletInput })).query(async ({ ctx: { deps }, input }) => {
    const pr = await loadPriced(deps, input.marketId, false);
    const t = await traderOfCached(deps, input.marketId, input.wallet);
    const px = pr.price?.priceWad ?? 0n;
    return { wallet: input.wallet, priceSource: pr.price?.source ?? null, ...positionView(pr.m.chain, t, px, px > 0n ? safeMaxWithdraw(pr.m.chain, t, px, !!deps.settings.tradeRefuseUnholdable) : t.position.size === 0n ? t.position.marginUsd : 0n) };
  }),

  /** Fill price (spread / skew), price impact, fee and the resulting position for a signed size. */
  quote: publicProcedure
    .input(z.object({ marketId: marketIdInput, sizeDelta: sizeDeltaInput, wallet: walletInput.optional(), slippageBps: slippageInput }))
    .query(async ({ ctx: { deps }, input }) => {
      const pr = await loadPriced(deps, input.marketId);
      const t = input.wallet ? await traderOfCached(deps, input.marketId, input.wallet) : null;
      return quoteOf(pr, t ? position(t) : null, input.sizeDelta, input.slippageBps, !!deps.settings.tradeRefuseUnholdable);
    }),

  /** Prepared [settlement-token approve (if needed), depositMargin]: always allowed, off-hours and reduce-only too. */
  deposit: publicProcedure.input(z.object({ marketId: marketIdInput, wallet: walletInput, amountUsd: usdInput })).mutation(async ({ ctx: { deps }, input }) => {
    const gw = requireChain(deps);
    const amount = parseUsd(input.amountUsd);
    if (amount <= 0n) fail("BAD_REQUEST", "Amount must be above 0");
    const m = await loadMarket(deps, input.marketId);
    const t = await traderOf(deps, input.marketId, input.wallet);
    const txs: PreparedTx[] = [];
    if (t.usdcAllowance < amount) txs.push(approveUsdcTx(gw.chainId, gw.deployment.contracts.usdc, m.chain.engine, amount, `margin in the ${m.label} market`));
    txs.push(engineDepositMarginTx(gw.chainId, m.chain.engine, input.marketId, amount, m.label));
    const warnings: string[] = [];
    if (t.usdcBalance < amount) warnings.push(`Wallet balance ${usdStr(t.usdcBalance)} is below the amount`);
    warnings.push("Margin is isolated: it backs only your position in this market, and a liquidation can take all of it.");
    return { txs, warnings };
  }),

  /** Prepared withdrawMargin, at most the safe maximum; with an open position, the oracle relay first. */
  withdraw: publicProcedure.input(z.object({ marketId: marketIdInput, wallet: walletInput, amountUsd: usdInput })).mutation(async ({ ctx: { deps }, input }) => {
    const gw = requireChain(deps);
    const amount = parseUsd(input.amountUsd);
    if (amount <= 0n) fail("BAD_REQUEST", "Amount must be above 0");
    const pr = await loadPriced(deps, input.marketId);
    const m = pr.m;
    const t = await traderOf(deps, input.marketId, input.wallet);
    const p = t.position;
    if (amount > p.marginUsd) fail("PRECONDITION_FAILED", `This wallet has ${usdStr(p.marginUsd)} of margin in this market`);
    const txs: PreparedTx[] = [];
    const warnings: string[] = [];
    if (p.size !== 0n) {
      // PoolEngine.withdrawMargin with a position: a live price at most min(maxPriceAge, 60 s) old, the split gate
      // (pending or window), funding settled first, then equity >= initial margin
      const px = pr.price;
      if (!px) fail("PRECONDITION_FAILED", "The market has no price yet");
      if (px.held) fail("PRECONDITION_FAILED", "The stock's session is closed: with an open position, margin cannot be withdrawn until it reopens (close the position first, after the reopen)");
      if (pr.nowSec - px.publishedAt > withdrawMaxAge(m.chain) - WITHDRAW_PRICE_HEADROOM_SEC) fail("PRECONDITION_FAILED", "No signed price fresh enough to withdraw with an open position; retry in a few seconds");
      const split = await hardChain(deps, "engine.splitGate", (g) => g.splitGate(m.chain.config.underlying, px.publishedAt));
      if (split.window || split.pending) fail("PRECONDITION_FAILED", "A stock split is pending or in progress: margin cannot be withdrawn while a position is open (close it first)");
      const max = safeMaxWithdraw(m.chain, t, px.priceWad, !!deps.settings.tradeRefuseUnholdable);
      if (amount > max)
        fail("PRECONDITION_FAILED", `At most ${usdStr(max)} can be withdrawn with this position open: the rest must stay as margin (${deps.settings.tradeRefuseUnholdable ? `the off-hours requirement: the position stays at or below the leverage an order may reach here` : "initial margin"}, with room for a 1% move). Reduce the position to free more.`);
      if (px.source === "signed") {
        txs.push(oracleUpdateTx(gw.chainId, gw.deployment.contracts.oracle, px.priceData, m.label));
        warnings.push(
          `With a position open the engine values it at the price on chain, which must be at most ${withdrawMaxAge(m.chain)} s old: step 1 brings the signed price of ${isoSec(px.publishedAt)} on chain, step 2 must be mined before ${isoSec(px.publishedAt + withdrawMaxAge(m.chain))}.`,
        );
      }
    }
    txs.push(engineWithdrawMarginTx(gw.chainId, m.chain.engine, input.marketId, amount, m.label));
    return { txs, warnings, maxWithdrawUsd: usdStr(p.size === 0n ? p.marginUsd : pr.price ? safeMaxWithdraw(m.chain, t, pr.price.priceWad, !!deps.settings.tradeRefuseUnholdable) : 0n) };
  }),

  /** Prepared trade(marketId, sizeDelta, acceptablePrice, priceData) after every engine rule is checked. */
  order: publicProcedure
    .input(z.object({ marketId: marketIdInput, wallet: walletInput, sizeDelta: sizeDeltaInput, slippageBps: slippageInput }))
    .mutation(async ({ ctx: { deps }, input }) => {
      const gw = requireChain(deps);
      const pr = await loadPriced(deps, input.marketId);
      const t = await traderOf(deps, input.marketId, input.wallet);
      const q = quoteOf(pr, position(t), input.sizeDelta, input.slippageBps, !!deps.settings.tradeRefuseUnholdable);
      if (q.refusal || !pr.price) fail("PRECONDITION_FAILED", q.refusal?.message ?? "The market has no price yet");
      const what = q.newRisk ? (t.position.size === 0n ? "open" : "increase or flip") : q.after.side === "flat" ? "close" : "reduce";
      const tx = engineTradeTx(gw.chainId, pr.m.chain.engine, input.marketId, input.sizeDelta, BigInt(q.acceptablePriceWad), pr.price.priceData, pr.m.label, what);
      return { txs: [tx], warnings: orderWarnings(pr, q), quote: q };
    }),

  /** Prepared close (trade of -size, or a portion of it: portionBps 1..10000), allowed reduce-only. */
  close: publicProcedure
    .input(z.object({ marketId: marketIdInput, wallet: walletInput, slippageBps: slippageInput, portionBps: intLike(1, 10_000).default(10_000) }))
    .mutation(async ({ ctx: { deps }, input }) => {
      const gw = requireChain(deps);
      const pr = await loadPriced(deps, input.marketId);
      const t = await traderOf(deps, input.marketId, input.wallet);
      const size = t.position.size;
      if (size === 0n) fail("PRECONDITION_FAILED", "This wallet has no position in this market");
      const sizeDelta = input.portionBps === 10_000 ? -size : -((size * BigInt(input.portionBps)) / BPS);
      if (sizeDelta === 0n) fail("BAD_REQUEST", "The portion is too small to trade");
      const q = quoteOf(pr, position(t), sizeDelta, input.slippageBps, !!deps.settings.tradeRefuseUnholdable);
      if (q.refusal || !pr.price) fail("PRECONDITION_FAILED", q.refusal?.message ?? "The market has no price yet");
      const tx = engineTradeTx(gw.chainId, pr.m.chain.engine, input.marketId, sizeDelta, BigInt(q.acceptablePriceWad), pr.price.priceData, pr.m.label, input.portionBps === 10_000 ? "close" : "reduce");
      return { txs: [tx], warnings: orderWarnings(pr, q), quote: q };
    }),
});

