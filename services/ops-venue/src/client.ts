// Orderly venue clients. One code path for ORDERLY_MODE=mock (services/mock-orderly) and live;
// only the base URL, auth strictness and the builder (Perp Anything) endpoints differ.
//   OrderlyVenue          implements QuotingVenue for ONE book account (the MM account + trade key).
//                         Used by bookrunner-agent and risk.
//   OrderlyBuilderClient  implements OrderlyBuilderApi (ops-venue): symbols, builder price, IF, fee
//                         settlements, withdrawals (EIP-712 via the delegate signer), key revocation.
import type { OrderlyBuilderApi, QuotingVenue, TwoSidedQuote, VenueAccount, VenueFill } from "@bookrunner/shared";
import type { Address, LocalAccount } from "viem";
import { KeyStore, resolveKeysDir } from "./keys";
import { type Ed25519Key, keyFromSecret, keyPrefix, signMessage } from "./orderly/auth";
import { type HoldingData, type PositionsData, quoteOrders, toVenueAccount, toVenueFill, usdRaw } from "./orderly/convert";
import { type AddKeyParams, ORDERLY_LEDGER_MAINNET, signAddKey, signWithdraw } from "./orderly/eip712";
import { type FetchLike, OrderlyHttp, OrderlyHttpError } from "./orderly/http";
import { BUILDER_PATHS, ORDERLY_ORACLE_WS, ORDERLY_PATHS } from "./orderly/paths";

export type OrderlyMode = "mock" | "live";

export interface OrderlyVenueOptions {
  baseUrl: string;
  /** Orderly account id of the book's MM account (adapter.accountId(MM)). */
  accountId: string;
  symbol: string;
  /** ed25519 trade key (scope read,trading): Ed25519Key, base58/0x seed, or raw seed bytes; `null` = unsigned. Omitted = resolve from env / key store. */
  tradeKey?: Ed25519Key | string | Uint8Array | null;
  mode: OrderlyMode;
  /** When no tradeKey is given: load the book's trade key from the ops-venue key store. */
  bookId?: number;
  env?: Record<string, string | undefined>;
  keysDir?: string;
  fetch?: FetchLike;
  /** Order type for quotes (default POST_ONLY: quotes never take liquidity). */
  quoteOrderType?: "LIMIT" | "POST_ONLY";
  /** Price / size ticks; default: GET /v1/public/info/{symbol} (quote_tick, base_tick), fallback 0.01 / 1e-8. */
  priceTick?: number;
  qtyTick?: number;
  log?: { warn: (o: object, m: string) => void; info?: (o: object, m: string) => void };
}

export class OrderlyQuoteError extends Error {
  constructor(readonly rejected: Array<{ side: string; error: string }>) {
    super(`quote legs rejected: ${rejected.map((r) => `${r.side}: ${r.error}`).join("; ")}`);
  }
}

/** QuotingVenue over Orderly REST v1 for one book account. */
export class OrderlyVenue implements QuotingVenue {
  readonly kind = "orderly" as const;
  private key: Ed25519Key | null | undefined; // undefined = not resolved yet
  private readonly http: OrderlyHttp;
  private seq = 0;
  private ticks: { price: number; qty: number } | null = null;

  constructor(readonly opts: OrderlyVenueOptions) {
    this.http = new OrderlyHttp({ baseUrl: opts.baseUrl, accountId: opts.accountId, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  get symbol() {
    return this.opts.symbol;
  }

  /** Resolve the trade key: explicit option > env ORDERLY_TRADE_KEY_SECRET[_<bookId>] > key store file. */
  private async resolveKey(force = false): Promise<Ed25519Key | null> {
    if (this.key !== undefined && !force) return this.key;
    const o = this.opts;
    let k: Ed25519Key | null = null;
    if (o.tradeKey === null) k = null; // explicitly unsigned (permissive mock / caller-managed)
    else if (o.tradeKey && typeof o.tradeKey === "object" && "orderlyKey" in o.tradeKey) k = o.tradeKey;
    else if (o.tradeKey) k = await keyFromSecret(o.tradeKey as string | Uint8Array);
    else {
      const env = o.env ?? process.env;
      const fromEnv = (o.bookId !== undefined ? env[`ORDERLY_TRADE_KEY_SECRET_${o.bookId}`] : undefined) ?? env.ORDERLY_TRADE_KEY_SECRET;
      if (fromEnv) k = await keyFromSecret(fromEnv);
      else if (o.bookId !== undefined) {
        const stored = await new KeyStore(o.keysDir ? resolveKeysDir(o.keysDir) : resolveKeysDir(env.OPS_KEYS_DIR)).tradeKey(o.bookId);
        if (stored && stored.accountId.toLowerCase() === o.accountId.toLowerCase()) k = stored.key;
      }
    }
    if (!k && o.mode === "live") throw new Error(`OrderlyVenue(${o.symbol}): no trade key available (live mode requires one)`);
    this.key = k;
    return k;
  }

  /** Signed request; on 401 re-resolve the key once (picks up a rotated key from the store). */
  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, query?: Record<string, string | number | undefined>, body?: unknown, retries?: number): Promise<T> {
    const key = await this.resolveKey();
    try {
      return await this.http.request<T>(method, path, { ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}), key, ...(retries !== undefined ? { retries } : {}) });
    } catch (err) {
      if (err instanceof OrderlyHttpError && err.unauthorized && this.opts.tradeKey === undefined) {
        const fresh = await this.resolveKey(true);
        if (fresh && fresh.orderlyKey !== key?.orderlyKey) return this.http.request<T>(method, path, { ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}), key: fresh });
      }
      throw err;
    }
  }

  private clientId(side: "BUY" | "SELL"): string {
    this.seq = (this.seq + 1) % 1e6;
    // <= 36 chars, must not start with '-'
    return `bk${this.opts.bookId ?? 0}-${side[0]}-${Date.now().toString(36)}-${this.seq.toString(36)}`.slice(0, 36);
  }

  /** Symbol ticks from the public info endpoint (cached; VERIFY field names), with safe fallbacks. */
  private async symbolTicks(): Promise<{ price: number; qty: number }> {
    if (this.opts.priceTick && this.opts.qtyTick) return { price: this.opts.priceTick, qty: this.opts.qtyTick };
    if (!this.ticks) {
      try {
        const info = await this.http.request<{ quote_tick?: number; base_tick?: number }>("GET", `${ORDERLY_PATHS.publicInfo}/${this.opts.symbol}`, { key: null, retries: 1 });
        this.ticks = { price: Number(info.quote_tick) > 0 ? Number(info.quote_tick) : 0.01, qty: Number(info.base_tick) > 0 ? Number(info.base_tick) : 1e-8 };
      } catch (err) {
        this.opts.log?.warn({ symbol: this.opts.symbol, err: String(err) }, "symbol info unavailable; using default ticks");
        return { price: this.opts.priceTick ?? 0.01, qty: this.opts.qtyTick ?? 1e-8 };
      }
    }
    return { price: this.opts.priceTick ?? this.ticks.price, qty: this.opts.qtyTick ?? this.ticks.qty };
  }

  async cancelAll(): Promise<void> {
    await this.call("DELETE", ORDERLY_PATHS.cancelAll, { symbol: this.opts.symbol });
  }

  /** Cancel-then-place. One leg -> POST /v1/order, two legs -> POST /v1/batch-order. Rejected legs throw OrderlyQuoteError. */
  async replaceQuote(q: TwoSidedQuote): Promise<void> {
    const ticks = await this.symbolTicks();
    await this.cancelAll();
    const orders = quoteOrders(q, {
      symbol: this.opts.symbol,
      orderType: this.opts.quoteOrderType ?? "POST_ONLY",
      priceTick: ticks.price,
      qtyTick: ticks.qty,
      clientId: (s) => this.clientId(s),
    });
    if (orders.length === 0) return;
    const rejected: Array<{ side: string; error: string }> = [];
    if (orders.length === 1) {
      const [o] = orders;
      if (!o) return;
      try {
        await this.call("POST", ORDERLY_PATHS.order, undefined, o, 0);
      } catch (err) {
        if (err instanceof OrderlyHttpError && err.status === 400) rejected.push({ side: o.side, error: err.message });
        else throw err;
      }
    } else {
      const res = await this.call<{ rows?: Array<{ error_message?: string | null; order_id?: number | null }> }>("POST", ORDERLY_PATHS.batchOrder, undefined, { orders }, 0);
      (res.rows ?? []).forEach((r, i) => {
        if (r.error_message) rejected.push({ side: orders[i]?.side ?? "?", error: r.error_message });
      });
    }
    if (rejected.length) throw new OrderlyQuoteError(rejected);
  }

  async account(): Promise<VenueAccount> {
    const [pos, hold] = await Promise.all([this.call<PositionsData>("GET", ORDERLY_PATHS.positions), this.call<HoldingData>("GET", ORDERLY_PATHS.holding)]);
    return toVenueAccount(this.opts.symbol, pos, hold);
  }

  /** All fills since `sinceMs` (inclusive), oldest first; pages through /v1/trades (size 500). */
  async fillsSince(sinceMs: number): Promise<VenueFill[]> {
    const out: VenueFill[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 50; page++) {
      const data = await this.call<{ rows?: Array<Record<string, unknown>>; meta?: { total?: number } }>("GET", ORDERLY_PATHS.trades, {
        symbol: this.opts.symbol,
        start_t: Math.max(0, Math.floor(sinceMs)),
        page,
        size: 500,
      });
      const rows = data.rows ?? [];
      for (const r of rows) {
        const f = toVenueFill(r, this.opts.symbol);
        if (f.ts >= sinceMs && f.qty > 0 && !seen.has(f.tradeId)) {
          seen.add(f.tradeId);
          out.push(f);
        }
      }
      if (rows.length < 500) break;
    }
    return out.sort((a, b) => a.ts - b.ts || Number(a.tradeId) - Number(b.tradeId));
  }
}

/** Integration contract used by bookrunner-agent / risk (they pass {bookId, symbol, accountId, baseUrl, mode, env}). */
export function createOrderlyVenue(opts: OrderlyVenueOptions): OrderlyVenue {
  return new OrderlyVenue(opts);
}

// ====================================================================== builder / ops client

export interface FeeSettlement {
  id: string;
  symbol: string;
  amountUsd: bigint;
  period: number; // unix s (period end label)
  ts: number; // ms
}

export interface WithdrawRecordView {
  id: number;
  status: string; // NEW | PROCESSING | COMPLETED | FAILED (VERIFY live values)
  txHash: string | null;
  amountUsd: bigint;
  clientRef: string | null;
  receiver: string | null; // VERIFY: present in Orderly asset history?
  createdAt: number | null; // ms (created_time)
}

export interface OrderlyBuilderClientOptions {
  baseUrl: string;
  mode: OrderlyMode;
  brokerId: string;
  /** chainId used in Orderly EIP-712 messages (chain the funds are withdrawn to). */
  chainId: number;
  builderAccountId: string;
  builderKey: Ed25519Key | null;
  /** ops keys (scope read,asset) of book accounts, by Orderly account id. */
  keyFor?: (accountId: string) => Promise<Ed25519Key | null> | Ed25519Key | null;
  /** EIP-712 signer: delegate signer of the adapters' accounts and owner of the builder account. */
  signer: LocalAccount;
  ledgerAddress?: Address;
  oracleWsUrl?: string;
  /** Live: earliest day queried for builder fee revenue (cumulative sweep accounting starts here). */
  feeHistoryStartMs?: number;
  fetch?: FetchLike;
  now?: () => number;
}

export class OrderlyBuilderClient implements OrderlyBuilderApi {
  private readonly http: OrderlyHttp;
  private readonly now: () => number;
  private ws: WebSocket | null = null;

  constructor(readonly o: OrderlyBuilderClientOptions) {
    this.http = new OrderlyHttp({ baseUrl: o.baseUrl, accountId: o.builderAccountId, key: o.builderKey, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.now ? { now: o.now } : {}) });
    this.now = o.now ?? Date.now;
  }

  private async keyOf(accountId: string): Promise<Ed25519Key | null> {
    if (accountId.toLowerCase() === this.o.builderAccountId.toLowerCase()) return this.o.builderKey;
    const k = this.o.keyFor ? await this.o.keyFor(accountId) : null;
    if (!k && this.o.mode === "live") throw new Error(`no ops key for Orderly account ${accountId}`);
    return k ?? null;
  }

  private async asAccount<T>(accountId: string, method: "GET" | "POST" | "DELETE", path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; retries?: number } = {}): Promise<T> {
    return this.http.request<T>(method, path, { ...opts, accountId, key: await this.keyOf(accountId) });
  }

  // ---------------------------------------------------------------- symbols
  async createSymbol(p: { symbol: string; baseAsset: string; priceSource: "builder" | "chainlink"; sessions: `0x${string}`; ifAccountId?: string }): Promise<{ symbol: string; status?: string }> {
    if (this.o.mode === "mock") {
      const r = await this.http.request<{ symbol: string; status: string }>("POST", BUILDER_PATHS.mock.createSymbol, {
        body: { symbol: p.symbol, base_asset: p.baseAsset, price_source: p.priceSource, sessions: p.sessions, ...(p.ifAccountId ? { insurance_fund_account_id: p.ifAccountId } : {}) },
      });
      return { symbol: r.symbol, status: r.status };
    }
    // live (VERIFY): register the builder feed for base_ccy, then submit the listing with the builder
    // oracle as the single source; RWA listings also need market_session (GET /v1/public/rwa/market_sessions).
    await this.http.request("POST", BUILDER_PATHS.live.oracleFeed, { body: { base_ccy: p.baseAsset, visibility: "PRIVATE", status: "ACTIVE" } });
    const r = await this.http.request<{ symbol?: string; status?: string }>("POST", BUILDER_PATHS.live.submitListing, {
      body: {
        symbol: p.symbol,
        base_ccy: p.baseAsset,
        sources: [{ source: p.priceSource === "builder" ? `ORACLE_${this.o.brokerId}` : `CHAINLINK_${this.o.brokerId}`, weight: 100 }],
        market_session: p.sessions,
        ...(p.ifAccountId ? { insurance_fund_account_id: p.ifAccountId } : {}),
      },
    });
    return { symbol: r.symbol ?? p.symbol, ...(r.status ? { status: r.status } : {}) };
  }

  /** Delist / reduce-only a symbol (retirement). Mock contract path; live VERIFY (Orderly One admin). */
  async setSymbolStatus(symbol: string, status: "ACTIVE" | "REDUCE_ONLY" | "DELISTED"): Promise<{ symbol: string; status: string }> {
    return this.http.request("POST", this.o.mode === "mock" ? BUILDER_PATHS.mock.symbolStatus : BUILDER_PATHS.live.symbolStatus, { body: { symbol, status } });
  }

  async setBuilderPrice(p: { symbol: string; price: number; held: boolean; ts: number }): Promise<void> {
    if (this.o.mode === "mock") {
      await this.http.request("POST", "/mock/price", { body: { symbol: p.symbol, price: p.price, held: p.held, ts: p.ts }, key: null });
      return;
    }
    // live: Builder Oracle WebSocket push (docs: user-flows/builder-oracle). Held sessions: Orderly
    // freezes the index while OFF_MARKET, so we simply stop publishing while held.
    if (p.held) return;
    const ws = await this.oracleSocket();
    const base = p.symbol.replace(/^PERP_/, "").replace(/_USDC$/, "");
    ws.send(JSON.stringify({ id: `px_${base}_${p.ts}`, event: "publish", topic: ORDERLY_ORACLE_WS.topic, ts: p.ts, data: { base_ccy: base, price: p.price } }));
  }

  private async oracleSocket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (!this.o.builderKey) throw new Error("builder key required for the builder oracle feed");
    const ts = this.now();
    const sign = (await signMessage(this.o.builderKey, String(ts))).replace(/=+$/, ""); // unpadded base64url (VERIFY)
    const url = `${this.o.oracleWsUrl ?? ORDERLY_ORACLE_WS.mainnet}${ORDERLY_ORACLE_WS.path(this.o.builderAccountId)}?orderly_key=${encodeURIComponent(this.o.builderKey.orderlyKey)}&timestamp=${ts}&sign=${sign}`;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("builder oracle websocket error")), { once: true });
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
    });
    this.ws = ws;
    return ws;
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }

  // ---------------------------------------------------------------- insurance fund
  async insuranceFund(symbol: string): Promise<{ balanceUsd: bigint; status?: string; accountId?: string | null }> {
    if (this.o.mode === "mock") {
      const r = await this.http.request<{ balance: number; status: string; account_id: string | null }>("GET", BUILDER_PATHS.mock.insuranceFund, { query: { symbol } });
      return { balanceUsd: usdRaw(r.balance), status: r.status, accountId: r.account_id };
    }
    const r = await this.http.request<{ rows?: Array<{ symbol?: string; balance?: number }> }>("GET", ORDERLY_PATHS.publicInsuranceFund, { key: null });
    const row = (r.rows ?? []).find((x) => x.symbol === symbol);
    return { balanceUsd: usdRaw(row?.balance ?? 0) };
  }

  /** Move USDC from the builder account into the symbol's IF account. Live: internal transfer (VERIFY). */
  async fundInsurance(p: { symbol: string; amountUsd: bigint; ifAccountId?: string }): Promise<void> {
    const amount = Number(p.amountUsd) / 1e6;
    if (this.o.mode === "mock") {
      await this.http.request("POST", BUILDER_PATHS.mock.insuranceFund, { body: { symbol: p.symbol, amount }, retries: 0 });
      return;
    }
    if (!p.ifAccountId) throw new Error("live fundInsurance needs the IF account id");
    await this.http.request("POST", ORDERLY_PATHS.internalTransfer, { body: { token: "USDC", amount, receiver_account_id: p.ifAccountId }, retries: 0 });
  }

  // ---------------------------------------------------------------- fee settlements
  async feeSettlements(sinceMs: number): Promise<FeeSettlement[]> {
    if (this.o.mode === "mock") {
      const r = await this.http.request<{ rows?: Array<{ id: string; symbol: string; amount: number; period: number; timestamp: number }> }>("GET", BUILDER_PATHS.mock.feeSettlements, {
        query: { start_t: Math.floor(sinceMs) },
      });
      return (r.rows ?? []).map((x) => ({ id: String(x.id), symbol: x.symbol, amountUsd: usdRaw(x.amount), period: Number(x.period), ts: Number(x.timestamp) }));
    }
    // live (VERIFY shape): daily rows with permissionless_listing_fee_share; period = end of the UTC day.
    const start = Math.max(sinceMs, this.o.feeHistoryStartMs ?? Date.UTC(2026, 0, 1));
    const r = await this.http.request<{ rows?: Array<Record<string, unknown>> }>("GET", BUILDER_PATHS.live.dailyFeeRevenue, {
      query: { start_date: new Date(start).toISOString().slice(0, 10), end_date: new Date(this.now()).toISOString().slice(0, 10) },
    });
    return (r.rows ?? []).map((x, i) => {
      const day = Date.parse(String(x.date ?? x.day ?? ""));
      const periodEnd = Number.isFinite(day) ? Math.floor(day / 1000) + 86_400 : Number(x.period ?? 0);
      return {
        id: String(x.id ?? `${x.date ?? i}:${x.symbol ?? ""}`),
        symbol: String(x.symbol ?? ""),
        amountUsd: usdRaw(x.permissionless_listing_fee_share ?? x.amount ?? 0),
        period: periodEnd,
        ts: Number(x.timestamp ?? periodEnd * 1000),
      };
    });
  }

  // ---------------------------------------------------------------- keys
  /** Register an orderly key: delegate flow for contract-owned accounts, AddOrderlyKey for the builder EOA. */
  async addKey(p: { accountId: string; orderlyKey: string; scope: string; expirationMs: number; delegateContract?: Address }): Promise<void> {
    const params: AddKeyParams = {
      brokerId: this.o.brokerId,
      chainId: this.o.chainId,
      orderlyKey: p.orderlyKey,
      scope: p.scope,
      timestamp: BigInt(this.now()),
      expiration: BigInt(p.expirationMs),
      ...(p.delegateContract ? { delegateContract: p.delegateContract } : {}),
    };
    const { message, signature } = await signAddKey(this.o.signer, params);
    await this.http.request("POST", p.delegateContract ? ORDERLY_PATHS.addDelegateKey : ORDERLY_PATHS.addKey, {
      body: { message, signature, userAddress: this.o.signer.address },
      accountId: p.accountId,
      key: null,
      retries: 1,
    });
  }

  async keyInfo(accountId: string): Promise<Array<{ orderlyKey: string; scope: string; status: string }>> {
    const r = await this.asAccount<{ rows?: Array<{ orderly_key: string; scope: string; key_status: string }> }>(accountId, "GET", ORDERLY_PATHS.keyInfo);
    return (r.rows ?? []).map((k) => ({ orderlyKey: k.orderly_key, scope: k.scope, status: k.key_status }));
  }

  /** Remove the trade key whose prefix matches (authenticated with the account's ops key). Idempotent. */
  async revokeTradeKey(p: { accountId: string; keyPrefix: string; orderlyKey?: string }): Promise<void> {
    let full = p.orderlyKey;
    if (!full) {
      const keys = await this.keyInfo(p.accountId);
      const match = keys.find((k) => keyPrefix(k.orderlyKey, p.keyPrefix.length) === p.keyPrefix);
      if (!match) return; // not on the venue (already removed or never registered)
      if (match.status === "REMOVED") return;
      full = match.orderlyKey;
    }
    try {
      await this.asAccount(p.accountId, "POST", ORDERLY_PATHS.removeKey, { body: { orderly_key: full }, retries: 2 });
    } catch (err) {
      if (err instanceof OrderlyHttpError && (err.code === -1006 || /not found/i.test(err.message))) return;
      throw err;
    }
  }

  // ---------------------------------------------------------------- withdrawals
  /**
   * Request a withdrawal from `accountId` to `to`. Contract-owned accounts (adapter IF/MM) use the
   * delegate flow (`delegateContract` = the adapter); the builder EOA account uses Withdraw.
   * `nonce` is our idempotency reference (the adapter's request nonce / fee period), sent as
   * client_ref in mock mode; the Orderly withdrawNonce comes from GET /v1/withdraw_nonce.
   */
  async requestWithdraw(p: { accountId: string; amountUsd: bigint; to: `0x${string}`; nonce: string; delegateContract?: Address }): Promise<{ withdrawId: string }> {
    if (this.o.mode === "mock") {
      const existing = (await this.withdrawals(p.accountId)).find((w) => w.clientRef === p.nonce && w.status !== "FAILED");
      if (existing) return { withdrawId: String(existing.id) };
    }
    const n = await this.asAccount<{ withdraw_nonce: number | string }>(p.accountId, "GET", ORDERLY_PATHS.withdrawNonce);
    const verifyingContract = this.o.ledgerAddress ?? ORDERLY_LEDGER_MAINNET;
    const { message, signature } = await signWithdraw(
      this.o.signer,
      {
        brokerId: this.o.brokerId,
        chainId: this.o.chainId,
        receiver: p.to,
        token: "USDC",
        amount: p.amountUsd,
        withdrawNonce: BigInt(n.withdraw_nonce),
        timestamp: BigInt(this.now()),
        ...(p.delegateContract ? { delegateContract: p.delegateContract } : {}),
      },
      verifyingContract,
    );
    const r = await this.asAccount<{ withdraw_id: number | string }>(p.accountId, "POST", p.delegateContract ? ORDERLY_PATHS.delegateWithdraw : ORDERLY_PATHS.withdraw, {
      body: { message, signature, userAddress: this.o.signer.address, verifyingContract, ...(this.o.mode === "mock" ? { client_ref: p.nonce } : {}) },
      retries: 0,
    });
    return { withdrawId: String(r.withdraw_id) };
  }

  async withdrawals(accountId: string): Promise<WithdrawRecordView[]> {
    const r = await this.asAccount<{ rows?: Array<Record<string, unknown>> }>(accountId, "GET", ORDERLY_PATHS.assetHistory, { query: { side: "WITHDRAW" } });
    return (r.rows ?? []).map((w) => ({
      id: Number(w.id),
      status: String(w.trans_status ?? ""),
      txHash: w.tx_id ? String(w.tx_id) : null,
      amountUsd: usdRaw(w.amount),
      clientRef: w.client_ref ? String(w.client_ref) : null,
      receiver: w.receiver ? String(w.receiver) : null,
      createdAt: w.created_time == null || !Number.isFinite(Number(w.created_time)) ? null : Number(w.created_time),
    }));
  }

  async withdrawal(accountId: string, withdrawId: string): Promise<WithdrawRecordView | null> {
    return (await this.withdrawals(accountId)).find((w) => String(w.id) === withdrawId) ?? null;
  }

  // ---------------------------------------------------------------- mock-only helpers
  async mockCompleteWithdraw(withdrawId: string, txHash: string): Promise<void> {
    if (this.o.mode !== "mock") throw new Error("mockCompleteWithdraw is mock-only");
    await this.http.request("POST", `/mock/withdrawals/${withdrawId}/complete`, { body: { txHash }, key: null });
  }

  async mockRegisterAccount(p: { accountId: string; owner?: string; kind?: "if" | "mm" | "builder"; delegateSigner?: string; builder?: boolean }): Promise<void> {
    if (this.o.mode !== "mock") throw new Error("mockRegisterAccount is mock-only");
    await this.http.request("POST", "/mock/accounts", { body: p, key: null });
  }
}
