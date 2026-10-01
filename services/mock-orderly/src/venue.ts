// In-memory Orderly venue simulator: accounts, per-symbol order books holding the books' resting
// quotes, fills against a simulated taker flow (fills ONLY at quoted prices), positions/equity marked
// at the builder price, base taker fees with a 50% builder share settled per period, insurance fund
// balances per symbol, withdrawal requests (paid on-chain by ops-venue), and orderly-key registry.
// All cash amounts are integer micro-USD (µ) internally; REST responses render USD decimals.
import type { Side } from "@bookrunner/shared";
import { builderShareMicro, DEFAULT_FEES, type FeeKind, type FeeSchedule, feeMicro, fromMicro, settlementPeriodOf, toMicro } from "./fees";
import { DEFAULT_FLOW, type FlowParams, sampleArrivals, updateEma } from "./flow";
import { applyTrade, matchTaker, reducibleQty, type RestingOrder, roundQty, wouldCross } from "./matching";
import type { Rng } from "./rng";

// Orderly error codes (VERIFY against the Orderly error-code table).
export const ERR = {
  UNKNOWN: -1000,
  INVALID_SIGNATURE: -1001,
  UNAUTHORIZED: -1002,
  TOO_MANY_REQUEST: -1003,
  INVALID_PARAM: -1005,
  RESOURCE_NOT_FOUND: -1006,
  DUPLICATE_REQUEST: -1007,
  CAN_NOT_WITHDRAW: -1009,
  RISK_TOO_HIGH: -1101,
  MIN_NOTIONAL: -1102,
  PRICE_FILTER: -1103,
  SIZE_FILTER: -1104,
} as const;

export class VenueError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type AccountKind = "if" | "mm" | "builder" | "other";
export type SymbolStatus = "NEW" | "PENDING" | "ACTIVE" | "REDUCE_ONLY" | "DELISTED";
export type OrderType = "LIMIT" | "POST_ONLY" | "IOC" | "FOK" | "MARKET";
const ORDER_TYPES: readonly OrderType[] = ["LIMIT", "POST_ONLY", "IOC", "FOK", "MARKET"];

export interface PositionState {
  qty: number;
  avgOpenPx: number;
  realized: number; // µ cumulative
  fees: number; // µ cumulative (paid > 0)
  funding: number; // µ cumulative (received > 0)
  updatedAt: number;
}

export interface AccountState {
  accountId: string;
  kind: AccountKind;
  owner?: string; // owning address (adapter contract / EOA), lowercase
  delegateSigner?: string; // lowercase
  holding: number; // µ settled USDC
  positions: Record<string, PositionState>;
  withdrawNonce: number; // next nonce GET /v1/withdraw_nonce returns
  createdAt: number;
}

export interface OrderState {
  orderId: number;
  clientOrderId: string | null;
  accountId: string;
  keyId: string | null;
  symbol: string;
  side: Side;
  type: OrderType;
  price: number;
  qty: number; // remaining
  origQty: number;
  reduceOnly: boolean;
  status: "NEW" | "PARTIAL_FILLED";
  createdAt: number;
  updatedAt: number;
}

export interface TradeState {
  id: number;
  accountId: string;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  fee: number; // µ, paid > 0
  feeKind: FeeKind;
  isMaker: boolean;
  orderId: number;
  ts: number; // ms
  realizedPnl: number; // µ
}

export interface SymbolStats {
  fills: number;
  takerVolume: number; // µ notional
  takerFees: number; // µ base taker fees (all takers)
  makerFees: number; // µ
  liquidationFees: number; // µ
  funding: number; // µ |payments|
  builderAccrued: number; // µ cumulative builder share accrued
  builderSettled: number; // µ cumulative settled to the builder account
}

export interface SymbolState {
  symbol: string;
  baseAsset: string;
  priceSource: string;
  sessions?: string;
  ifAccountId?: string;
  autoCreated: boolean;
  everActive: boolean;
  forcedStatus?: "REDUCE_ONLY" | "DELISTED";
  createdAt: number;
  lastTradePx?: number;
  stats: SymbolStats;
  builderBuckets: Record<string, number>; // period label -> unsettled µ
}

export interface PriceState {
  px: number;
  held: boolean;
  ts: number; // ms
  ema: number;
}

export interface SettlementState {
  id: string;
  symbol: string;
  amount: number; // µ
  period: number; // unix s (bucket end)
  ts: number; // ms settled
  accountId: string; // builder account credited
}

export type WithdrawStatus = "NEW" | "COMPLETED" | "FAILED";

export interface WithdrawalState {
  id: number;
  accountId: string;
  amount: number; // µ
  receiver: string;
  token: string;
  chainId: number;
  withdrawNonce: number;
  clientRef?: string;
  delegateContract?: string;
  status: WithdrawStatus;
  txHash?: string;
  failReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface KeyState {
  orderlyKey: string;
  accountId: string;
  scope: string[];
  expiration: number; // ms
  status: "ACTIVE" | "REMOVED";
  createdAt: number;
  removedAt?: number;
}

export interface VenueConfig {
  fees: FeeSchedule;
  imrBps: number;
  mmrBps: number;
  ifRequirementUsd: number; // per effective symbol; balance must be STRICTLY greater (Orderly rule)
  ifLock: boolean; // IF withdrawals keep balance > requirement while symbols are effective
  settleIntervalSec: number;
  fundingIntervalSec: number;
  fundingRateBps: number; // per interval, longs pay shorts when > 0
  externalSpreadBps: number; // MARKET/IOC liquidity outside the book's quotes
  autoCreateSymbols: boolean;
  marginCheck: boolean;
  enforceWithdrawNonce: boolean;
  maxTradesPerAccount: number;
  maxOpenOrdersPerSymbol: number;
  quoteTick: number; // GET /v1/public/info/{symbol} quote_tick
  baseTick: number; // base_tick
  minNotionalUsd: number;
  enforceTicks: boolean; // reject off-tick prices / sizes (Orderly PRICE_FILTER / SIZE_FILTER)
  builderAccountId?: string;
  flow: FlowParams;
}

export const DEFAULT_VENUE_CONFIG: VenueConfig = {
  fees: DEFAULT_FEES,
  imrBps: 1000,
  mmrBps: 500,
  ifRequirementUsd: 100, // Orderly testnet value; mainnet is 25,000 per effective symbol (strictly greater)
  ifLock: true,
  settleIntervalSec: 300,
  fundingIntervalSec: 3600,
  fundingRateBps: 0,
  externalSpreadBps: 10,
  autoCreateSymbols: true,
  marginCheck: true,
  enforceWithdrawNonce: false,
  maxTradesPerAccount: 20_000,
  maxOpenOrdersPerSymbol: 100,
  quoteTick: 0.01,
  baseTick: 0.0001,
  minNotionalUsd: 1,
  enforceTicks: false,
  flow: DEFAULT_FLOW,
};

export interface OrderRequest {
  symbol?: string;
  order_type?: string;
  side?: string;
  order_price?: number | string;
  order_quantity?: number | string;
  order_amount?: number | string;
  client_order_id?: string | null;
  reduce_only?: boolean;
}

export interface OrderResult {
  order_id: number;
  client_order_id: string | null;
  order_type: OrderType;
  order_price: number | null;
  order_quantity: number;
  filled_quantity: number;
  status: "NEW" | "PARTIAL_FILLED" | "FILLED" | "CANCELLED";
}

export interface FillSummary {
  makerTradeId?: number;
  takerTradeId?: number;
  orderId: number | null; // resting order (null = external liquidity)
  makerAccountId: string | null;
  takerAccountId: string | null;
  takerSide: Side;
  price: number;
  qty: number;
  takerFee: number; // µ
  builderShare: number; // µ
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function normalizeAccountId(id: string): string {
  const t = id.trim();
  return /^0x[0-9a-fA-F]+$/.test(t) ? t.toLowerCase() : t;
}

export function baseAssetOf(symbolOrBase: string): string {
  const s = symbolOrBase.trim().toUpperCase();
  const m = /^PERP_(.+)_USDC$/.exec(s);
  return m?.[1] ?? s;
}

export function symbolOf(symbolOrBase: string): string {
  const s = symbolOrBase.trim().toUpperCase();
  return s.startsWith("PERP_") ? s : `PERP_${s}_USDC`;
}

const emptyStats = (): SymbolStats => ({
  fills: 0,
  takerVolume: 0,
  takerFees: 0,
  makerFees: 0,
  liquidationFees: 0,
  funding: 0,
  builderAccrued: 0,
  builderSettled: 0,
});

export class MockVenue {
  readonly cfg: VenueConfig;
  readonly now: () => number;
  accounts = new Map<string, AccountState>();
  symbols = new Map<string, SymbolState>();
  prices = new Map<string, PriceState>(); // by base asset
  orders = new Map<number, OrderState>(); // open orders
  trades = new Map<string, TradeState[]>(); // by account
  settlements: SettlementState[] = [];
  withdrawals = new Map<number, WithdrawalState>();
  keys = new Map<string, KeyState>();
  credits = new Set<string>();
  builderAccountId: string | undefined;
  seq = { order: 1, trade: 1, withdraw: 1, settlement: 1 };
  lastFundingBoundary = 0;
  dirty = false;
  private onChange: (() => void) | undefined;

  constructor(cfg: Partial<VenueConfig> = {}, now: () => number = Date.now) {
    this.cfg = { ...DEFAULT_VENUE_CONFIG, ...cfg, fees: { ...DEFAULT_FEES, ...cfg.fees }, flow: { ...DEFAULT_FLOW, ...cfg.flow } };
    this.now = now;
    this.builderAccountId = cfg.builderAccountId ? normalizeAccountId(cfg.builderAccountId) : undefined;
  }

  setChangeListener(fn: () => void) {
    this.onChange = fn;
  }

  private touch() {
    this.dirty = true;
    this.onChange?.();
  }

  // ------------------------------------------------------------------ accounts
  ensureAccount(accountId: string, opts: { kind?: AccountKind; owner?: string; delegateSigner?: string } = {}): AccountState {
    const id = normalizeAccountId(accountId);
    if (!id || id.length > 80) throw new VenueError(400, ERR.INVALID_PARAM, "invalid account id");
    let a = this.accounts.get(id);
    if (!a) {
      a = { accountId: id, kind: opts.kind ?? "other", holding: 0, positions: {}, withdrawNonce: 1, createdAt: this.now() };
      this.accounts.set(id, a);
      this.touch();
    }
    if (opts.kind && a.kind === "other") a.kind = opts.kind;
    if (opts.owner) a.owner = opts.owner.toLowerCase();
    if (opts.delegateSigner) a.delegateSigner = opts.delegateSigner.toLowerCase();
    return a;
  }

  getAccount(accountId: string): AccountState {
    const a = this.accounts.get(normalizeAccountId(accountId));
    if (!a) throw new VenueError(404, ERR.RESOURCE_NOT_FOUND, `account ${accountId} not found`);
    return a;
  }

  /** Credit USDC to an account (deposit). Idempotent per `ref` (e.g. `${txHash}:${logIndex}`). */
  credit(accountId: string, amountMicro: number, ref?: string): boolean {
    if (!Number.isInteger(amountMicro) || amountMicro <= 0) throw new VenueError(400, ERR.INVALID_PARAM, "amount must be a positive integer of µUSD");
    if (ref && this.credits.has(ref)) return false;
    const a = this.ensureAccount(accountId);
    a.holding += amountMicro;
    if (ref) this.credits.add(ref);
    this.touch();
    return true;
  }

  markPx(symbol: string): number {
    const sym = this.symbols.get(symbol);
    const base = sym?.baseAsset ?? baseAssetOf(symbol);
    return this.prices.get(base)?.px ?? sym?.lastTradePx ?? 0;
  }

  private posMark(symbol: string, pos: PositionState): number {
    return this.markPx(symbol) || pos.avgOpenPx;
  }

  upnlMicro(a: AccountState): number {
    let u = 0;
    for (const [s, p] of Object.entries(a.positions)) {
      if (p.qty === 0) continue;
      u += toMicro(p.qty * (this.posMark(s, p) - p.avgOpenPx));
    }
    return u;
  }

  equityMicro(a: AccountState): number {
    return a.holding + this.upnlMicro(a);
  }

  /** Initial margin of positions + open (non reduce-only) orders, µ. */
  imMicro(a: AccountState, extraOrderNotional = 0): number {
    let notional = extraOrderNotional;
    for (const [s, p] of Object.entries(a.positions)) notional += Math.abs(p.qty) * this.posMark(s, p);
    for (const o of this.orders.values()) if (o.accountId === a.accountId && !o.reduceOnly) notional += o.qty * o.price;
    return toMicro((notional * this.cfg.imrBps) / 1e4);
  }

  mmMicro(a: AccountState): number {
    let notional = 0;
    for (const [s, p] of Object.entries(a.positions)) notional += Math.abs(p.qty) * this.posMark(s, p);
    return toMicro((notional * this.cfg.mmrBps) / 1e4);
  }

  freeCollateralMicro(a: AccountState): number {
    return this.equityMicro(a) - this.imMicro(a);
  }

  /** IF accounts keep balance > requirement × effective symbols while ifLock is on. */
  ifLockedMicro(a: AccountState): number {
    if (!this.cfg.ifLock) return 0;
    const n = [...this.symbols.values()].filter((s) => s.ifAccountId === a.accountId && this.effective(s)).length;
    return n > 0 ? toMicro(this.cfg.ifRequirementUsd * n) + 1 : 0;
  }

  withdrawableMicro(a: AccountState): number {
    return Math.max(0, Math.min(a.holding - this.ifLockedMicro(a), this.freeCollateralMicro(a)));
  }

  // ------------------------------------------------------------------ symbols & prices
  createSymbol(p: { symbol: string; baseAsset?: string; priceSource?: string; sessions?: string; ifAccountId?: string; builderAccountId?: string }): SymbolState {
    const symbol = symbolOf(p.symbol);
    if (!/^PERP_[A-Z0-9]{1,24}_USDC$/.test(symbol)) throw new VenueError(400, ERR.INVALID_PARAM, `invalid symbol ${p.symbol}`);
    if (p.builderAccountId) this.setBuilder(p.builderAccountId);
    let s = this.symbols.get(symbol);
    if (!s) {
      s = {
        symbol,
        baseAsset: (p.baseAsset ?? baseAssetOf(symbol)).toUpperCase(),
        priceSource: p.priceSource ?? "builder",
        autoCreated: false,
        everActive: false,
        createdAt: this.now(),
        stats: emptyStats(),
        builderBuckets: {},
      };
      this.symbols.set(symbol, s);
    }
    s.autoCreated = false;
    if (p.baseAsset) s.baseAsset = p.baseAsset.toUpperCase();
    if (p.priceSource) s.priceSource = p.priceSource;
    if (p.sessions) s.sessions = p.sessions;
    if (p.ifAccountId) {
      s.ifAccountId = normalizeAccountId(p.ifAccountId);
      this.ensureAccount(s.ifAccountId, { kind: "if" });
    }
    this.touch();
    return s;
  }

  setBuilder(accountId: string) {
    const id = normalizeAccountId(accountId);
    if (this.builderAccountId && this.builderAccountId !== id) {
      throw new VenueError(401, ERR.UNAUTHORIZED, `builder account is ${this.builderAccountId}`);
    }
    this.builderAccountId = id;
    this.ensureAccount(id, { kind: "builder" });
  }

  setSymbolStatus(symbol: string, status: "ACTIVE" | "REDUCE_ONLY" | "DELISTED") {
    const s = this.requireSymbol(symbol);
    if (s.forcedStatus === "DELISTED" && status !== "DELISTED") throw new VenueError(400, ERR.INVALID_PARAM, "DELISTED is terminal");
    s.forcedStatus = status === "ACTIVE" ? undefined : status;
    if (status === "DELISTED") for (const o of [...this.orders.values()]) if (o.symbol === s.symbol) this.orders.delete(o.orderId);
    this.touch();
  }

  requireSymbol(symbol: string): SymbolState {
    const s = this.symbols.get(symbolOf(symbol));
    if (!s) throw new VenueError(400, ERR.INVALID_PARAM, `unknown symbol ${symbol}`);
    return s;
  }

  private tradableSymbol(symbol: string): SymbolState {
    const id = symbolOf(symbol);
    let s = this.symbols.get(id);
    if (!s && this.cfg.autoCreateSymbols) {
      s = { symbol: id, baseAsset: baseAssetOf(id), priceSource: "builder", autoCreated: true, everActive: false, createdAt: this.now(), stats: emptyStats(), builderBuckets: {} };
      this.symbols.set(id, s);
      this.touch();
    }
    if (!s) throw new VenueError(400, ERR.INVALID_PARAM, `unknown symbol ${symbol}`);
    return s;
  }

  ifBalanceMicro(s: SymbolState): number {
    return s.ifAccountId ? (this.accounts.get(s.ifAccountId)?.holding ?? 0) : 0;
  }

  private effective(s: SymbolState): boolean {
    return s.forcedStatus !== "DELISTED";
  }

  symbolStatus(s: SymbolState): SymbolStatus {
    if (s.forcedStatus) return s.forcedStatus;
    if (!s.ifAccountId) return s.autoCreated ? "ACTIVE" : "NEW";
    const n = [...this.symbols.values()].filter((x) => x.ifAccountId === s.ifAccountId && this.effective(x)).length;
    if (this.ifBalanceMicro(s) > toMicro(this.cfg.ifRequirementUsd * n)) {
      s.everActive = true;
      return "ACTIVE";
    }
    return s.everActive ? "REDUCE_ONLY" : "PENDING";
  }

  setPrice(symbolOrBase: string, px: number, held: boolean, tsMs = this.now()): PriceState {
    if (!(px > 0) || !Number.isFinite(px)) throw new VenueError(400, ERR.INVALID_PARAM, "price must be > 0");
    const base = baseAssetOf(symbolOrBase);
    const prev = this.prices.get(base);
    const dt = prev ? (tsMs - prev.ts) / 1000 : 0;
    const st: PriceState = { px, held, ts: tsMs, ema: updateEma(prev?.ema, px, dt, this.cfg.flow.emaHalfLifeSec) };
    this.prices.set(base, st);
    for (const s of this.symbols.values()) if (s.baseAsset === base) this.checkLiquidations(s.symbol);
    this.touch();
    return st;
  }

  // ------------------------------------------------------------------ orders
  private restingFor(symbol: string): RestingOrder[] {
    return [...this.orders.values()].filter((o) => o.symbol === symbol);
  }

  openOrders(accountId: string, symbol?: string): OrderState[] {
    const id = normalizeAccountId(accountId);
    const sym = symbol ? symbolOf(symbol) : undefined;
    return [...this.orders.values()].filter((o) => o.accountId === id && (!sym || o.symbol === sym));
  }

  placeOrder(ctx: { accountId: string; keyId: string | null }, req: OrderRequest): OrderResult {
    const acct = this.ensureAccount(ctx.accountId);
    if (!req.symbol) throw new VenueError(400, ERR.INVALID_PARAM, "symbol is required");
    const sym = this.tradableSymbol(req.symbol);
    const status = this.symbolStatus(sym);
    const type = String(req.order_type ?? "").toUpperCase() as OrderType;
    if (!ORDER_TYPES.includes(type)) throw new VenueError(400, ERR.INVALID_PARAM, `unsupported order_type ${req.order_type}`);
    const side = String(req.side ?? "").toUpperCase() as Side;
    if (side !== "BUY" && side !== "SELL") throw new VenueError(400, ERR.INVALID_PARAM, "side must be BUY or SELL");
    const reduceOnly = req.reduce_only === true;
    if (status === "NEW" || status === "PENDING" || status === "DELISTED") throw new VenueError(400, ERR.INVALID_PARAM, `symbol ${sym.symbol} is ${status}`);
    if (status === "REDUCE_ONLY" && !reduceOnly) throw new VenueError(400, ERR.INVALID_PARAM, `symbol ${sym.symbol} is REDUCE_ONLY`);

    const cid = req.client_order_id ?? null;
    if (cid !== null) {
      if (typeof cid !== "string" || cid.length === 0 || cid.length > 36 || cid.startsWith("-")) {
        throw new VenueError(400, ERR.INVALID_PARAM, "client_order_id: up to 36 chars, must not start with '-'");
      }
      if (this.openOrders(acct.accountId).some((o) => o.clientOrderId === cid)) throw new VenueError(400, ERR.DUPLICATE_REQUEST, `duplicate client_order_id ${cid}`);
    }
    const mark = this.markPx(sym.symbol);
    const price = req.order_price === undefined || req.order_price === null ? undefined : Number(req.order_price);
    if (type !== "MARKET" && !(price !== undefined && price > 0 && Number.isFinite(price))) throw new VenueError(400, ERR.INVALID_PARAM, "order_price must be > 0");
    let qty: number;
    if (req.order_quantity !== undefined && req.order_quantity !== null) qty = roundQty(Number(req.order_quantity));
    else if (type === "MARKET" && req.order_amount !== undefined && mark > 0) qty = roundQty(Number(req.order_amount) / mark);
    else qty = 0;
    if (!(qty > 0) || !Number.isFinite(qty)) throw new VenueError(400, ERR.INVALID_PARAM, "order_quantity must be > 0");
    if (this.openOrders(acct.accountId, sym.symbol).length >= this.cfg.maxOpenOrdersPerSymbol) throw new VenueError(400, ERR.INVALID_PARAM, "too many open orders");
    if (this.cfg.enforceTicks) {
      const off = (x: number, tick: number) => Math.abs(x / tick - Math.round(x / tick)) > 1e-6;
      if (price !== undefined && off(price, this.cfg.quoteTick)) throw new VenueError(400, ERR.PRICE_FILTER, `price ${price} is not a multiple of quote_tick ${this.cfg.quoteTick}`);
      if (off(qty, this.cfg.baseTick)) throw new VenueError(400, ERR.SIZE_FILTER, `quantity ${qty} is not a multiple of base_tick ${this.cfg.baseTick}`);
      if (qty * (price ?? mark) < this.cfg.minNotionalUsd) throw new VenueError(400, ERR.MIN_NOTIONAL, `notional below min_notional ${this.cfg.minNotionalUsd}`);
    }

    const pos = acct.positions[sym.symbol];
    if (reduceOnly) {
      const pendingSameSide = this.openOrders(acct.accountId, sym.symbol)
        .filter((o) => o.reduceOnly && o.side === side)
        .reduce((x, o) => x + o.qty, 0);
      const reducible = roundQty(reducibleQty(pos?.qty ?? 0, side) - pendingSameSide);
      if (reducible <= 0) throw new VenueError(400, ERR.INVALID_PARAM, "reduce_only order would increase the position");
      qty = Math.min(qty, reducible);
    } else if (this.cfg.marginCheck) {
      const notional = qty * (price ?? mark);
      if (this.imMicro(acct, notional) > this.equityMicro(acct)) throw new VenueError(400, ERR.RISK_TOO_HIGH, "insufficient margin for order");
    }

    const resting = this.restingFor(sym.symbol);
    const others = resting.filter((o) => o.accountId !== acct.accountId);
    const own = resting.filter((o) => o.accountId === acct.accountId);
    if (type === "POST_ONLY" && price !== undefined && wouldCross(resting, side, price)) {
      throw new VenueError(400, ERR.INVALID_PARAM, "POST_ONLY order would take liquidity");
    }
    if (type !== "POST_ONLY" && price !== undefined && wouldCross(own, side, price)) {
      throw new VenueError(400, ERR.INVALID_PARAM, "order would self-trade");
    }

    const now = this.now();
    const orderId = this.seq.order++;
    let remaining = qty;
    // 1) cross other accounts' resting quotes as taker (LIMIT/IOC/FOK/MARKET)
    if (type !== "POST_ONLY") {
      const limit = type === "MARKET" ? undefined : price;
      const m = matchTaker(others, side, remaining, limit, (o) => this.makerCap(o));
      const external = type === "MARKET" || type === "IOC" || type === "FOK" ? this.externalFillPx(sym, side, price) : undefined;
      const externalQty = external !== undefined ? m.remaining : 0;
      if (type === "FOK" && m.remaining > 0 && external === undefined) throw new VenueError(400, ERR.INVALID_PARAM, "FOK order cannot be fully filled");
      for (const f of m.fills) {
        const maker = this.orders.get(f.orderId);
        if (maker) this.executeFill(sym, maker, acct, side, f.qty, f.price, orderId, now);
      }
      remaining = m.remaining;
      if (externalQty > 0 && external !== undefined) {
        this.executeFill(sym, null, acct, side, externalQty, external, orderId, now);
        remaining = 0;
      }
    }
    const filled = roundQty(qty - remaining);
    let outStatus: OrderResult["status"] = filled >= qty ? "FILLED" : filled > 0 ? "PARTIAL_FILLED" : "NEW";
    // 2) rest the remainder (LIMIT / POST_ONLY); IOC/FOK/MARKET remainders are cancelled
    if (remaining > 0 && (type === "LIMIT" || type === "POST_ONLY") && price !== undefined) {
      this.orders.set(orderId, {
        orderId,
        clientOrderId: cid,
        accountId: acct.accountId,
        keyId: ctx.keyId,
        symbol: sym.symbol,
        side,
        type,
        price,
        qty: remaining,
        origQty: qty,
        reduceOnly,
        status: filled > 0 ? "PARTIAL_FILLED" : "NEW",
        createdAt: now,
        updatedAt: now,
      });
    } else if (remaining > 0) {
      outStatus = filled > 0 ? "PARTIAL_FILLED" : "CANCELLED";
    }
    this.checkLiquidations(sym.symbol);
    this.touch();
    return { order_id: orderId, client_order_id: cid, order_type: type, order_price: price ?? null, order_quantity: qty, filled_quantity: filled, status: outStatus };
  }

  /** External (non-book) liquidity for MARKET/IOC/FOK: builder price +/- half the external spread, within the limit. */
  private externalFillPx(sym: SymbolState, side: Side, limit: number | undefined): number | undefined {
    const mark = this.markPx(sym.symbol);
    if (!(mark > 0)) return undefined;
    const px = side === "BUY" ? mark * (1 + this.cfg.externalSpreadBps / 2e4) : mark * (1 - this.cfg.externalSpreadBps / 2e4);
    if (limit !== undefined && (side === "BUY" ? px > limit : px < limit)) return undefined;
    return px;
  }

  private makerCap(o: RestingOrder): number {
    const full = this.orders.get(o.orderId);
    if (!full || !full.reduceOnly) return o.qty;
    const pos = this.accounts.get(full.accountId)?.positions[full.symbol];
    return Math.min(o.qty, reducibleQty(pos?.qty ?? 0, full.side));
  }

  cancelAll(accountId: string, symbol?: string): number {
    const list = this.openOrders(accountId, symbol);
    for (const o of list) this.orders.delete(o.orderId);
    if (list.length) this.touch();
    return list.length;
  }

  cancelOrder(accountId: string, symbol: string, by: { orderId?: number; clientOrderId?: string }): OrderState {
    const o = this.openOrders(accountId, symbol).find((x) => (by.orderId !== undefined ? x.orderId === by.orderId : x.clientOrderId === by.clientOrderId));
    if (!o) throw new VenueError(400, ERR.RESOURCE_NOT_FOUND, "order not found");
    this.orders.delete(o.orderId);
    this.touch();
    return o;
  }

  // ------------------------------------------------------------------ fills
  private applyToAccount(acct: AccountState, symbol: string, side: Side, qty: number, px: number, fee: number, feeKind: FeeKind, isMaker: boolean, orderId: number, ts: number): TradeState {
    const pos = acct.positions[symbol] ?? { qty: 0, avgOpenPx: 0, realized: 0, fees: 0, funding: 0, updatedAt: ts };
    const eff = applyTrade(pos, side, qty, px);
    const realized = toMicro(eff.realizedPnl);
    acct.holding += realized - fee;
    pos.qty = eff.qty;
    pos.avgOpenPx = eff.avgOpenPx;
    pos.realized += realized;
    pos.fees += fee;
    pos.updatedAt = ts;
    acct.positions[symbol] = pos;
    const t: TradeState = { id: this.seq.trade++, accountId: acct.accountId, symbol, side, price: px, qty, fee, feeKind, isMaker, orderId, ts, realizedPnl: realized };
    const list = this.trades.get(acct.accountId) ?? [];
    list.push(t);
    if (list.length > this.cfg.maxTradesPerAccount) list.splice(0, list.length - this.cfg.maxTradesPerAccount);
    this.trades.set(acct.accountId, list);
    return t;
  }

  private accrueBuilder(sym: SymbolState, amount: number, tsMs: number) {
    if (amount <= 0) return;
    const period = settlementPeriodOf(Math.floor(tsMs / 1000), this.cfg.settleIntervalSec);
    sym.builderBuckets[String(period)] = (sym.builderBuckets[String(period)] ?? 0) + amount;
    sym.stats.builderAccrued += amount;
  }

  /** One fill between a resting order (or external liquidity when null) and a taker (account or simulated when null). */
  private executeFill(sym: SymbolState, maker: OrderState | null, taker: AccountState | null, takerSide: Side, qty: number, px: number, takerOrderId: number | null, ts: number): FillSummary {
    const notional = qty * px;
    const takerFee = feeMicro(notional, this.cfg.fees.takerFeeBps);
    const share = builderShareMicro("taker", takerFee, this.cfg.fees.builderShareBps);
    const out: FillSummary = {
      orderId: maker?.orderId ?? null,
      makerAccountId: maker?.accountId ?? null,
      takerAccountId: taker?.accountId ?? null,
      takerSide,
      price: px,
      qty,
      takerFee,
      builderShare: share,
    };
    if (maker) {
      const mAcct = this.ensureAccount(maker.accountId);
      const makerFee = feeMicro(notional, this.cfg.fees.makerFeeBps);
      const mt = this.applyToAccount(mAcct, sym.symbol, maker.side, qty, px, makerFee, "maker", true, maker.orderId, ts);
      out.makerTradeId = mt.id;
      sym.stats.makerFees += makerFee;
      maker.qty = roundQty(maker.qty - qty);
      maker.updatedAt = ts;
      if (maker.qty <= 0) this.orders.delete(maker.orderId);
      else maker.status = "PARTIAL_FILLED";
    }
    if (taker) {
      const tt = this.applyToAccount(taker, sym.symbol, takerSide, qty, px, takerFee, "taker", false, takerOrderId ?? 0, ts);
      out.takerTradeId = tt.id;
    }
    sym.stats.fills++;
    sym.stats.takerVolume += toMicro(notional);
    sym.stats.takerFees += takerFee;
    this.accrueBuilder(sym, share, ts);
    sym.lastTradePx = px;
    return out;
  }

  /** A simulated (external) taker crossing the books' resting quotes at the quoted prices only. */
  externalTaker(symbol: string, side: Side, qty: number, limitPx?: number): FillSummary[] {
    const sym = this.requireSymbol(symbol);
    const status = this.symbolStatus(sym);
    if (status !== "ACTIVE" && status !== "REDUCE_ONLY") return [];
    const ts = this.now();
    const m = matchTaker(this.restingFor(sym.symbol), side, qty, limitPx, (o) => this.makerCap(o));
    const fills: FillSummary[] = [];
    for (const f of m.fills) {
      const maker = this.orders.get(f.orderId);
      if (maker) fills.push(this.executeFill(sym, maker, null, side, f.qty, f.price, null, ts));
    }
    if (fills.length) {
      this.checkLiquidations(sym.symbol);
      this.touch();
    }
    return fills;
  }

  // ------------------------------------------------------------------ liquidation & funding
  checkLiquidations(symbol: string) {
    const sym = this.symbols.get(symbol);
    if (!sym) return;
    for (const a of this.accounts.values()) {
      const pos = a.positions[sym.symbol];
      if (!pos || pos.qty === 0) continue;
      if (this.equityMicro(a) >= this.mmMicro(a)) continue;
      this.liquidate(a);
    }
  }

  private liquidate(a: AccountState) {
    const ts = this.now();
    for (const o of this.openOrders(a.accountId)) this.orders.delete(o.orderId);
    for (const [s, pos] of Object.entries(a.positions)) {
      if (pos.qty === 0) continue;
      const sym = this.symbols.get(s);
      const px = this.posMark(s, pos);
      const notional = Math.abs(pos.qty) * px;
      const fee = feeMicro(notional, this.cfg.fees.liquidationFeeBps);
      this.applyToAccount(a, s, pos.qty > 0 ? "SELL" : "BUY", Math.abs(pos.qty), px, fee, "liquidation", false, 0, ts);
      if (sym) {
        sym.stats.liquidationFees += fee;
        // liquidation fees are NOT part of the builder share; a share goes to the symbol's IF
        const ifShare = Math.floor((fee * this.cfg.fees.liquidationIfShareBps) / 1e4);
        const ifAcct = sym.ifAccountId ? this.accounts.get(sym.ifAccountId) : undefined;
        if (ifAcct && ifShare > 0) ifAcct.holding += ifShare;
        if (a.holding < 0 && ifAcct) {
          const cover = Math.min(-a.holding, Math.max(0, ifAcct.holding));
          ifAcct.holding -= cover;
          a.holding += cover;
        }
      }
    }
    if (a.holding < 0) a.holding = 0; // residual bad debt socialised (outside the simulator)
    this.touch();
  }

  /** Apply funding at each funding boundary (not part of the builder share). */
  fundingTick(nowSec = Math.floor(this.now() / 1000)) {
    const b = Math.floor(nowSec / this.cfg.fundingIntervalSec) * this.cfg.fundingIntervalSec;
    if (b <= this.lastFundingBoundary) return;
    const first = this.lastFundingBoundary === 0;
    this.lastFundingBoundary = b;
    if (first || this.cfg.fundingRateBps === 0) return;
    for (const a of this.accounts.values()) {
      for (const [s, pos] of Object.entries(a.positions)) {
        if (pos.qty === 0) continue;
        const pay = toMicro((pos.qty * this.posMark(s, pos) * this.cfg.fundingRateBps) / 1e4);
        a.holding -= pay;
        pos.funding -= pay;
        const sym = this.symbols.get(s);
        if (sym) sym.stats.funding += Math.abs(pay);
      }
    }
    this.touch();
  }

  // ------------------------------------------------------------------ builder fee settlement
  /** Settle completed buckets (period <= now) to the builder account. */
  settleDue(nowSec = Math.floor(this.now() / 1000)): SettlementState[] {
    return this.settle((period) => period <= nowSec);
  }

  /** Settle everything accrued so far (POST /mock/settle). `periodOverride` relabels the rows. */
  settleNow(periodOverride?: number): SettlementState[] {
    return this.settle(() => true, periodOverride);
  }

  private settle(due: (period: number) => boolean, periodOverride?: number): SettlementState[] {
    if (!this.builderAccountId) return [];
    const builder = this.ensureAccount(this.builderAccountId, { kind: "builder" });
    const out: SettlementState[] = [];
    const ts = this.now();
    for (const s of this.symbols.values()) {
      for (const [label, amount] of Object.entries(s.builderBuckets)) {
        const period = Number(label);
        if (!due(period)) continue;
        delete s.builderBuckets[label];
        if (amount <= 0) continue;
        const row: SettlementState = {
          id: `fs-${this.seq.settlement++}`,
          symbol: s.symbol,
          amount,
          period: periodOverride ?? period,
          ts,
          accountId: builder.accountId,
        };
        builder.holding += amount;
        s.stats.builderSettled += amount;
        this.settlements.push(row);
        out.push(row);
      }
    }
    if (out.length) this.touch();
    return out;
  }

  settlementsSince(startMs: number, endMs = Number.MAX_SAFE_INTEGER): SettlementState[] {
    return this.settlements.filter((s) => s.ts >= startMs && s.ts <= endMs);
  }

  // ------------------------------------------------------------------ withdrawals
  nextWithdrawNonce(accountId: string): number {
    return this.ensureAccount(accountId).withdrawNonce;
  }

  requestWithdraw(accountId: string, p: { amountMicro: number; receiver: string; token: string; chainId: number; withdrawNonce: number; clientRef?: string; delegateContract?: string }): WithdrawalState {
    const a = this.getAccount(accountId);
    if (p.clientRef) {
      const existing = [...this.withdrawals.values()].find((w) => w.accountId === a.accountId && w.clientRef === p.clientRef);
      if (existing) return existing;
    }
    if (p.token.toUpperCase() !== "USDC") throw new VenueError(400, ERR.INVALID_PARAM, `unsupported token ${p.token}`);
    if (!Number.isInteger(p.amountMicro) || p.amountMicro <= 0) throw new VenueError(400, ERR.INVALID_PARAM, "amount must be > 0");
    if (this.cfg.enforceWithdrawNonce && p.withdrawNonce !== a.withdrawNonce) {
      throw new VenueError(400, ERR.INVALID_PARAM, `withdrawNonce ${p.withdrawNonce} != expected ${a.withdrawNonce}`);
    }
    const avail = this.withdrawableMicro(a);
    if (p.amountMicro > avail) throw new VenueError(400, ERR.CAN_NOT_WITHDRAW, `withdraw ${fromMicro(p.amountMicro)} exceeds withdrawable ${fromMicro(avail)}`);
    a.withdrawNonce = Math.max(a.withdrawNonce, p.withdrawNonce) + 1;
    a.holding -= p.amountMicro;
    const now = this.now();
    const w: WithdrawalState = {
      id: this.seq.withdraw++,
      accountId: a.accountId,
      amount: p.amountMicro,
      receiver: p.receiver.toLowerCase(),
      token: "USDC",
      chainId: p.chainId,
      withdrawNonce: p.withdrawNonce,
      ...(p.clientRef ? { clientRef: p.clientRef } : {}),
      ...(p.delegateContract ? { delegateContract: p.delegateContract.toLowerCase() } : {}),
      status: "NEW",
      createdAt: now,
      updatedAt: now,
    };
    this.withdrawals.set(w.id, w);
    this.touch();
    return w;
  }

  /** ops-venue reports the on-chain payment (MockOrderlyVault.operatorWithdraw tx). Idempotent. */
  completeWithdraw(id: number, txHash: string): WithdrawalState {
    const w = this.withdrawals.get(id);
    if (!w) throw new VenueError(404, ERR.RESOURCE_NOT_FOUND, `withdrawal ${id} not found`);
    if (w.status === "FAILED") throw new VenueError(400, ERR.INVALID_PARAM, `withdrawal ${id} failed`);
    if (w.status !== "COMPLETED") {
      w.status = "COMPLETED";
      w.txHash = txHash;
      w.updatedAt = this.now();
      this.touch();
    }
    return w;
  }

  /** Failed withdrawal: funds return to the account. */
  failWithdraw(id: number, reason: string): WithdrawalState {
    const w = this.withdrawals.get(id);
    if (!w) throw new VenueError(404, ERR.RESOURCE_NOT_FOUND, `withdrawal ${id} not found`);
    if (w.status === "COMPLETED") throw new VenueError(400, ERR.INVALID_PARAM, `withdrawal ${id} already completed`);
    if (w.status === "NEW") {
      w.status = "FAILED";
      w.failReason = reason;
      w.updatedAt = this.now();
      this.getAccount(w.accountId).holding += w.amount;
      this.touch();
    }
    return w;
  }

  // ------------------------------------------------------------------ keys
  registerKey(accountId: string, orderlyKey: string, scope: string[], expirationMs: number): KeyState {
    const id = normalizeAccountId(accountId);
    this.ensureAccount(id);
    const existing = this.keys.get(orderlyKey);
    if (existing && existing.accountId !== id) throw new VenueError(400, ERR.INVALID_PARAM, "orderly key belongs to another account");
    if (existing?.status === "REMOVED") throw new VenueError(400, ERR.INVALID_PARAM, "orderly key was removed; generate a new key");
    const k: KeyState = { orderlyKey, accountId: id, scope: [...new Set(scope)], expiration: expirationMs, status: "ACTIVE", createdAt: existing?.createdAt ?? this.now() };
    this.keys.set(orderlyKey, k);
    this.touch();
    return k;
  }

  /** Remove a key: it can no longer authenticate; its resting orders are cancelled (VERIFY live behaviour). */
  removeKey(accountId: string, orderlyKey: string): { removed: boolean; cancelled: number } {
    const k = this.keys.get(orderlyKey);
    if (!k || k.accountId !== normalizeAccountId(accountId)) throw new VenueError(400, ERR.RESOURCE_NOT_FOUND, "orderly key not found for account");
    if (k.status === "REMOVED") return { removed: false, cancelled: 0 };
    k.status = "REMOVED";
    k.removedAt = this.now();
    let cancelled = 0;
    for (const o of [...this.orders.values()]) {
      if (o.keyId === orderlyKey) {
        this.orders.delete(o.orderId);
        cancelled++;
      }
    }
    this.touch();
    return { removed: true, cancelled };
  }

  keyInfo(accountId: string): KeyState[] {
    const id = normalizeAccountId(accountId);
    return [...this.keys.values()].filter((k) => k.accountId === id);
  }

  // ------------------------------------------------------------------ simulation tick
  /** Advance the stochastic taker flow by `dtSec` for every tradable symbol; settles due fees and funding. */
  tick(dtSec: number, rng: Rng): FillSummary[] {
    const fills: FillSummary[] = [];
    for (const s of this.symbols.values()) {
      const status = this.symbolStatus(s);
      if (status !== "ACTIVE" && status !== "REDUCE_ONLY") continue;
      const price = this.prices.get(s.baseAsset);
      if (!price) continue;
      const resting = this.restingFor(s.symbol);
      if (resting.length === 0) continue;
      const bids = resting.filter((o) => o.side === "BUY").map((o) => o.price);
      const asks = resting.filter((o) => o.side === "SELL").map((o) => o.price);
      const arrivals = sampleArrivals(
        rng,
        {
          price: price.px,
          emaPrice: price.ema,
          held: price.held,
          ...(bids.length ? { bestBid: Math.max(...bids) } : {}),
          ...(asks.length ? { bestAsk: Math.min(...asks) } : {}),
        },
        this.cfg.flow,
        dtSec,
      );
      for (const a of arrivals) fills.push(...this.externalTaker(s.symbol, a.side, a.qty, a.limitPx));
    }
    this.settleDue();
    this.fundingTick();
    return fills;
  }

  // ------------------------------------------------------------------ views
  positionsView(accountId: string) {
    const a = this.ensureAccount(accountId);
    const now = this.now();
    const rows = Object.entries(a.positions)
      .filter(([, p]) => p.qty !== 0)
      .map(([symbol, p]) => {
        const mark = this.posMark(symbol, p);
        const upnl = fromMicro(toMicro(p.qty * (mark - p.avgOpenPx)));
        const pending = this.openOrders(a.accountId, symbol);
        return {
          symbol,
          position_qty: p.qty,
          cost_position: r6(p.qty * p.avgOpenPx),
          average_open_price: r6(p.avgOpenPx),
          mark_price: r6(mark),
          settle_price: r6(p.avgOpenPx),
          est_liq_price: 0,
          unsettled_pnl: upnl,
          last_sum_unitary_funding: 0,
          accrued_funding_fee: fromMicro(-p.funding),
          fee_24_h: fromMicro(p.fees),
          pnl_24_h: fromMicro(p.realized),
          pending_long_qty: roundQty(pending.filter((o) => o.side === "BUY").reduce((x, o) => x + o.qty, 0)),
          pending_short_qty: roundQty(pending.filter((o) => o.side === "SELL").reduce((x, o) => x + o.qty, 0)),
          leverage: Math.round(1e4 / this.cfg.imrBps),
          margin_mode: "CROSS",
          imr: this.cfg.imrBps / 1e4,
          mmr: this.cfg.mmrBps / 1e4,
          timestamp: p.updatedAt,
          updated_time: p.updatedAt,
        };
      });
    const equity = this.equityMicro(a);
    const notional = rows.reduce((x, r) => x + Math.abs(r.position_qty) * r.mark_price, 0);
    return {
      current_margin_ratio_with_orders: notional > 0 ? r6(fromMicro(equity) / notional) : 0,
      free_collateral: fromMicro(this.freeCollateralMicro(a)),
      initial_margin_ratio: this.cfg.imrBps / 1e4,
      maintenance_margin_ratio: this.cfg.mmrBps / 1e4,
      margin_ratio: notional > 0 ? r6(fromMicro(equity) / notional) : 10,
      open_margin_ratio: notional > 0 ? r6(fromMicro(equity) / notional) : 10,
      total_collateral_value: fromMicro(a.holding),
      total_pnl_24_h: fromMicro(Object.values(a.positions).reduce((x, p) => x + p.realized, 0)),
      account_value: fromMicro(equity),
      timestamp: now,
      rows,
    };
  }

  holdingView(accountId: string) {
    const a = this.ensureAccount(accountId);
    const pendingShort = this.openOrders(a.accountId)
      .filter((o) => o.side === "SELL")
      .reduce((x, o) => x + o.qty * o.price, 0);
    return {
      holding: [{ token: "USDC", holding: fromMicro(a.holding), frozen: 0, pending_short: -r6(pendingShort), updated_time: this.now() }],
    };
  }

  tradesView(accountId: string, q: { symbol?: string; startT?: number; endT?: number; page?: number; size?: number }) {
    const size = Math.min(500, Math.max(1, q.size ?? 25));
    const page = Math.max(1, q.page ?? 1);
    const sym = q.symbol ? symbolOf(q.symbol) : undefined;
    const all = (this.trades.get(normalizeAccountId(accountId)) ?? [])
      .filter((t) => (!sym || t.symbol === sym) && (q.startT === undefined || t.ts >= q.startT) && (q.endT === undefined || t.ts <= q.endT))
      .sort((a, b) => b.ts - a.ts || b.id - a.id); // newest first (VERIFY live ordering)
    const rows = all.slice((page - 1) * size, page * size).map((t) => ({
      id: t.id,
      symbol: t.symbol,
      fee: fromMicro(t.fee),
      fee_asset: "USDC",
      side: t.side,
      order_id: t.orderId,
      executed_price: t.price,
      executed_quantity: t.qty,
      executed_timestamp: t.ts,
      is_maker: t.isMaker ? 1 : 0,
      realized_pnl: fromMicro(t.realizedPnl),
    }));
    return { meta: { total: all.length, records_per_page: size, current_page: page }, rows };
  }

  orderView(o: OrderState) {
    return {
      order_id: o.orderId,
      client_order_id: o.clientOrderId,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      price: o.price,
      quantity: o.origQty,
      executed: roundQty(o.origQty - o.qty),
      reduce_only: o.reduceOnly,
      status: o.status,
      created_time: o.createdAt,
      updated_time: o.updatedAt,
    };
  }

  withdrawView(w: WithdrawalState) {
    return {
      id: w.id,
      tx_id: w.txHash ?? null,
      side: "WITHDRAW",
      token: w.token,
      amount: fromMicro(w.amount),
      fee: 0,
      trans_status: w.status,
      receiver: w.receiver,
      chain_id: w.chainId,
      withdraw_nonce: w.withdrawNonce,
      client_ref: w.clientRef ?? null,
      created_time: w.createdAt,
      updated_time: w.updatedAt,
    };
  }

  settlementView(s: SettlementState) {
    return { id: s.id, symbol: s.symbol, amount: fromMicro(s.amount), period: s.period, timestamp: s.ts, account_id: s.accountId };
  }

  infoView(symbol: string) {
    const id = symbolOf(symbol);
    const s = this.symbols.get(id);
    return {
      symbol: id,
      quote_min: 0,
      quote_max: 1e9,
      quote_tick: this.cfg.quoteTick,
      base_min: this.cfg.baseTick,
      base_max: 1e9,
      base_tick: this.cfg.baseTick,
      min_notional: this.cfg.minNotionalUsd,
      price_range: 0.03,
      status: s ? this.symbolStatus(s) : "NEW",
    };
  }

  insuranceView(s: SymbolState) {
    return {
      symbol: s.symbol,
      account_id: s.ifAccountId ?? null,
      balance: fromMicro(this.ifBalanceMicro(s)),
      requirement: this.cfg.ifRequirementUsd,
      status: this.symbolStatus(s),
    };
  }

  state() {
    const accounts = [...this.accounts.values()].map((a) => ({
      accountId: a.accountId,
      kind: a.kind,
      owner: a.owner ?? null,
      holding: fromMicro(a.holding),
      equity: fromMicro(this.equityMicro(a)),
      freeCollateral: fromMicro(this.freeCollateralMicro(a)),
      withdrawable: fromMicro(this.withdrawableMicro(a)),
      positions: Object.entries(a.positions)
        .filter(([, p]) => p.qty !== 0)
        .map(([symbol, p]) => ({ symbol, qty: p.qty, avgOpenPx: p.avgOpenPx, markPx: this.posMark(symbol, p), upnl: fromMicro(toMicro(p.qty * (this.posMark(symbol, p) - p.avgOpenPx))) })),
      openOrders: this.openOrders(a.accountId).length,
    }));
    const symbols = [...this.symbols.values()].map((s) => {
      const book = this.restingFor(s.symbol);
      const bids = book.filter((o) => o.side === "BUY").sort((a, b) => b.price - a.price);
      const asks = book.filter((o) => o.side === "SELL").sort((a, b) => a.price - b.price);
      return {
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        status: this.symbolStatus(s),
        priceSource: s.priceSource,
        price: this.prices.get(s.baseAsset) ?? null,
        insuranceFund: this.insuranceView(s),
        book: {
          bids: bids.map((o) => ({ px: o.price, qty: o.qty, accountId: o.accountId })),
          asks: asks.map((o) => ({ px: o.price, qty: o.qty, accountId: o.accountId })),
        },
        stats: Object.fromEntries(Object.entries(s.stats).map(([k, v]) => [k, k === "fills" ? v : fromMicro(v)])),
        builderUnsettled: fromMicro(Object.values(s.builderBuckets).reduce((x, v) => x + v, 0)),
      };
    });
    return {
      now: this.now(),
      config: this.cfg,
      builderAccountId: this.builderAccountId ?? null,
      accounts,
      symbols,
      settlements: this.settlements.slice(-100).map((s) => this.settlementView(s)),
      withdrawals: [...this.withdrawals.values()].slice(-100).map((w) => ({ ...this.withdrawView(w), account_id: w.accountId })),
      keys: [...this.keys.values()].map((k) => ({ orderlyKey: k.orderlyKey, accountId: k.accountId, scope: k.scope.join(","), status: k.status })),
    };
  }

  // ------------------------------------------------------------------ snapshot
  toSnapshot(): VenueSnapshot {
    return {
      version: 1,
      accounts: [...this.accounts.values()],
      symbols: [...this.symbols.values()],
      prices: [...this.prices.entries()],
      orders: [...this.orders.values()],
      trades: [...this.trades.entries()],
      settlements: this.settlements,
      withdrawals: [...this.withdrawals.values()],
      keys: [...this.keys.values()],
      credits: [...this.credits],
      builderAccountId: this.builderAccountId ?? null,
      seq: this.seq,
      lastFundingBoundary: this.lastFundingBoundary,
    };
  }

  loadSnapshot(s: VenueSnapshot) {
    if (s.version !== 1) throw new Error(`unsupported snapshot version ${String(s.version)}`);
    this.accounts = new Map(s.accounts.map((a) => [a.accountId, a]));
    this.symbols = new Map(s.symbols.map((x) => [x.symbol, x]));
    this.prices = new Map(s.prices);
    this.orders = new Map(s.orders.map((o) => [o.orderId, o]));
    this.trades = new Map(s.trades);
    this.settlements = s.settlements;
    this.withdrawals = new Map(s.withdrawals.map((w) => [w.id, w]));
    this.keys = new Map(s.keys.map((k) => [k.orderlyKey, k]));
    this.credits = new Set(s.credits);
    this.builderAccountId = s.builderAccountId ?? this.builderAccountId;
    this.seq = s.seq;
    this.lastFundingBoundary = s.lastFundingBoundary;
    this.dirty = false;
  }
}

export interface VenueSnapshot {
  version: number;
  accounts: AccountState[];
  symbols: SymbolState[];
  prices: Array<[string, PriceState]>;
  orders: OrderState[];
  trades: Array<[string, TradeState[]]>;
  settlements: SettlementState[];
  withdrawals: WithdrawalState[];
  keys: KeyState[];
  credits: string[];
  builderAccountId: string | null;
  seq: { order: number; trade: number; withdraw: number; settlement: number };
  lastFundingBoundary: number;
}
