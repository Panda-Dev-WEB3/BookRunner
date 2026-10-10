// Hono HTTP surface of the simulator. Paths follow packages/shared/src/orderly.ts (the mock contract)
// plus the Orderly REST v1 paths confirmed in the docs (see services/ops-venue/src/orderly/paths.ts)
// so the live-mode client can be exercised against the mock with MOCK_ORDERLY_AUTH=strict.
import type { Logger } from "@bookrunner/shared";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { Address, Hex } from "viem";
import { normalizeOrderlyKey, readAuthHeaders, timestampFresh, verifyOrderlySignature } from "./auth";
import { toMicro } from "./fees";
import {
  type AddKeyMessageJson,
  type DelegateSignerMessageJson,
  orderlyAccountId,
  recoverAddKeySigner,
  recoverDelegateSignerLink,
  recoverWithdrawSigner,
  type WithdrawMessageJson,
} from "./orderly712";
import type { Rng } from "./rng";
import { ERR, type MockVenue, normalizeAccountId, type OrderRequest, symbolOf, VenueError } from "./venue";

export type AuthMode = "strict" | "permissive";
export type Scope = "read" | "trading" | "asset";

export interface AppOptions {
  venue: MockVenue;
  authMode: AuthMode;
  brokerId: string;
  /** verifyingContract of the Withdraw domain (Orderly Ledger; devnet: any fixed address). */
  ledgerAddress: Address;
  /** Delegate signers accepted for contract-owned accounts that have no recorded delegate (lowercase). */
  delegateSigners: string[];
  rng: Rng;
  log?: Logger;
  /** Extra state merged into GET /mock/state (e.g. chain indexer status). */
  extraState?: () => Record<string, unknown>;
}

interface AuthCtx {
  accountId: string;
  keyId: string | null;
  body: string;
}

const PERMISSIVE_SCOPES = ["read", "trading", "asset"];
const DAY_MS = 86_400_000;

function num(v: unknown, name: string): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) throw new VenueError(400, ERR.INVALID_PARAM, `${name} must be a number`);
  return n;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new VenueError(400, ERR.INVALID_PARAM, `${name} is required`);
  return v;
}

function parseJson(body: string): Record<string, unknown> {
  if (!body) return {};
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  throw new VenueError(400, ERR.INVALID_PARAM, "body must be a JSON object");
}

/** Normalize a client timestamp in seconds or ms to ms. */
const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);

export function createApp(opts: AppOptions) {
  const { venue, log } = opts;
  const app = new Hono();
  const ok = (c: Context, data: unknown) => c.json({ success: true, timestamp: venue.now(), data });
  // dashboards (apps/web dev server) read /mock/state and /health from the browser
  app.use("/mock/*", cors());
  app.use("/health", cors());

  app.onError((err, c) => {
    if (err instanceof VenueError) {
      return c.json({ success: false, code: err.code, message: err.message }, err.status as 400);
    }
    log?.error({ err }, "mock-orderly handler error");
    return c.json({ success: false, code: ERR.UNKNOWN, message: String((err as Error).message ?? err) }, 500);
  });

  async function auth(c: Context, need: Scope | null): Promise<AuthCtx> {
    const url = new URL(c.req.url);
    const body = c.req.method === "GET" || c.req.method === "HEAD" ? "" : await c.req.text();
    const h = readAuthHeaders((n) => c.req.header(n));
    const rawAccount = h.accountId ?? url.searchParams.get("account_id") ?? undefined;
    if (!rawAccount) throw new VenueError(401, ERR.UNAUTHORIZED, "orderly-account-id header is required");
    const accountId = normalizeAccountId(rawAccount);
    const now = venue.now();
    if (!h.orderlyKey) {
      if (opts.authMode === "strict") throw new VenueError(401, ERR.UNAUTHORIZED, "orderly-key header is required");
      venue.ensureAccount(accountId);
      return { accountId, keyId: null, body };
    }
    const key = normalizeOrderlyKey(h.orderlyKey);
    const rec = venue.keys.get(key);
    // Removed keys are rejected in every mode (key revocation must bite in dev too).
    if (rec?.status === "REMOVED") throw new VenueError(401, ERR.UNAUTHORIZED, "orderly key has been removed");
    if (rec && rec.accountId !== accountId) throw new VenueError(401, ERR.UNAUTHORIZED, "orderly key does not belong to this account");
    if (rec && rec.expiration < now) throw new VenueError(401, ERR.UNAUTHORIZED, "orderly key expired");
    const sigOk =
      !!h.signature &&
      !!h.timestamp &&
      (await verifyOrderlySignature({ orderlyKey: key, timestamp: h.timestamp, method: c.req.method, pathWithQuery: url.pathname + url.search, body, signature: h.signature }));
    const fresh = timestampFresh(h.timestamp, now);
    if (opts.authMode === "strict") {
      if (!rec) throw new VenueError(401, ERR.UNAUTHORIZED, "orderly key is not registered");
      if (!sigOk) throw new VenueError(401, ERR.INVALID_SIGNATURE, "invalid orderly signature");
      if (!fresh) throw new VenueError(401, ERR.UNAUTHORIZED, "orderly-timestamp outside the accepted window");
      if (need && !rec.scope.includes(need)) throw new VenueError(401, ERR.UNAUTHORIZED, `orderly key lacks '${need}' scope`);
    } else {
      if (!sigOk || !fresh) log?.warn({ accountId, path: url.pathname, sigOk, fresh }, "permissive auth: signature/timestamp check failed");
      if (!rec) venue.registerKey(accountId, key, PERMISSIVE_SCOPES, now + 365 * DAY_MS);
    }
    return { accountId, keyId: key, body };
  }

  /** Builder endpoints: the builder account only. The first WRITE in permissive mode claims the role. */
  function requireBuilder(a: AuthCtx, assign = true) {
    if (venue.builderAccountId && venue.builderAccountId !== a.accountId) {
      throw new VenueError(401, ERR.UNAUTHORIZED, "builder endpoints require the builder account");
    }
    if (!venue.builderAccountId) {
      if (assign) venue.setBuilder(a.accountId);
      else if (opts.authMode === "strict") throw new VenueError(401, ERR.UNAUTHORIZED, "no builder account registered");
    }
  }

  async function checkDelegateSigner(accountId: string, delegateContract: string | undefined, recovered: string, claimed: string | undefined) {
    if (claimed && recovered.toLowerCase() !== claimed.toLowerCase()) {
      if (opts.authMode === "strict") throw new VenueError(401, ERR.INVALID_SIGNATURE, "EIP-712 signer does not match userAddress");
      log?.warn({ accountId, recovered, claimed }, "permissive: EIP-712 signer mismatch");
    }
    if (opts.authMode !== "strict") return;
    const a = venue.getAccount(accountId);
    if (delegateContract && a.owner && a.owner !== delegateContract.toLowerCase()) {
      throw new VenueError(401, ERR.UNAUTHORIZED, "delegateContract does not own this account");
    }
    const allowed = a.delegateSigner ? [a.delegateSigner] : opts.delegateSigners;
    if (!allowed.includes(recovered.toLowerCase())) throw new VenueError(401, ERR.UNAUTHORIZED, "signer is not the account's delegate signer");
  }

  // ------------------------------------------------------------------ public
  app.get("/health", (c) => c.json({ ok: true, service: "mock-orderly", authMode: opts.authMode, now: venue.now() }));

  app.get("/v1/public/insurancefund", (c) => ok(c, { rows: [...venue.symbols.values()].map((s) => venue.insuranceView(s)) }));
  app.get("/v1/public/info/:symbol", (c) => ok(c, venue.infoView(c.req.param("symbol"))));

  // ------------------------------------------------------------------ keys
  app.post("/v1/orderly_key", async (c) => {
    const b = parseJson(await c.req.text());
    const msg = b.message as AddKeyMessageJson | undefined;
    if (!msg) throw new VenueError(400, ERR.INVALID_PARAM, "message is required");
    const userAddress = str(b.userAddress, "userAddress") as Address;
    const recovered = await recoverAddKeySigner(msg, str(b.signature, "signature") as Hex, false);
    if (recovered.toLowerCase() !== userAddress.toLowerCase() && opts.authMode === "strict") throw new VenueError(401, ERR.INVALID_SIGNATURE, "EIP-712 signer does not match userAddress");
    const accountId = normalizeAccountId(c.req.header("orderly-account-id") ?? orderlyAccountId(userAddress, msg.brokerId));
    venue.ensureAccount(accountId, { owner: userAddress });
    const k = venue.registerKey(accountId, normalizeOrderlyKey(msg.orderlyKey), msg.scope.split(","), toMs(Number(msg.expiration)));
    return ok(c, { id: accountId, orderly_key: k.orderlyKey });
  });

  app.post("/v1/delegate_orderly_key", async (c) => {
    const b = parseJson(await c.req.text());
    const msg = b.message as AddKeyMessageJson | undefined;
    if (!msg?.delegateContract) throw new VenueError(400, ERR.INVALID_PARAM, "message.delegateContract is required");
    const recovered = await recoverAddKeySigner(msg, str(b.signature, "signature") as Hex, true);
    const accountId = normalizeAccountId(c.req.header("orderly-account-id") ?? orderlyAccountId(msg.delegateContract as Address, msg.brokerId));
    venue.ensureAccount(accountId, { owner: msg.delegateContract });
    await checkDelegateSigner(accountId, msg.delegateContract, recovered, typeof b.userAddress === "string" ? b.userAddress : undefined);
    const k = venue.registerKey(accountId, normalizeOrderlyKey(msg.orderlyKey), msg.scope.split(","), toMs(Number(msg.expiration)));
    return ok(c, { id: accountId, orderly_key: k.orderlyKey });
  });

  // public: registration nonce for Registration / DelegateSigner messages (Orderly: string, single use, 2 min)
  app.get("/v1/registration_nonce", (c) => ok(c, { registration_nonce: String(100_000_000_000 + Math.floor(Math.random() * 899_999_999_999)) }));

  // public: account of (address, broker_id); 400 when the simulator has none (Orderly: "account not exist")
  app.get("/v1/get_account", (c) => {
    const q = new URL(c.req.url).searchParams;
    const id = orderlyAccountId(str(q.get("address"), "address") as Address, str(q.get("broker_id"), "broker_id")).toLowerCase();
    if (!venue.accounts.has(id)) throw new VenueError(400, ERR.INVALID_PARAM, "account not exist");
    return ok(c, { user_id: null, account_id: id });
  });

  app.post("/v1/delegate_signer", async (c) => {
    const b = parseJson(await c.req.text());
    const msg = b.message as DelegateSignerMessageJson | undefined;
    if (!msg?.delegateContract) throw new VenueError(400, ERR.INVALID_PARAM, "message.delegateContract is required");
    const recovered = await recoverDelegateSignerLink(msg, str(b.signature, "signature") as Hex);
    const claimed = typeof b.userAddress === "string" ? b.userAddress : recovered;
    if (recovered.toLowerCase() !== claimed.toLowerCase() && opts.authMode === "strict") throw new VenueError(401, ERR.INVALID_SIGNATURE, "EIP-712 signer does not match userAddress");
    const owner = msg.delegateContract.toLowerCase();
    const header = c.req.header("orderly-account-id");
    const ids = new Set<string>([...venue.accounts.values()].filter((a) => a.owner === owner).map((a) => a.accountId));
    if (header) ids.add(normalizeAccountId(header));
    // like Orderly: the contract's own account (keccak256(abi.encode(contract, brokerHash))) is created if missing
    const own = orderlyAccountId(msg.delegateContract as Address, msg.brokerId).toLowerCase();
    ids.add(own);
    for (const id of ids) venue.ensureAccount(id, { owner, delegateSigner: recovered });
    // Orderly's response: {user_id, account_id, valid_signer}; account_ids / delegate_signer kept for older callers
    return ok(c, { user_id: null, account_id: own, valid_signer: recovered.toLowerCase(), account_ids: [...ids], delegate_signer: recovered });
  });

  app.get("/v1/client/key_info", async (c) => {
    const a = await auth(c, "read");
    return ok(c, {
      rows: venue.keyInfo(a.accountId).map((k) => ({ orderly_key: k.orderlyKey, scope: k.scope.join(","), expiration: k.expiration, key_status: k.status, created_time: k.createdAt })),
    });
  });

  const removeKey = async (c: Context) => {
    const a = await auth(c, null);
    const url = new URL(c.req.url);
    const fromBody = a.body ? (parseJson(a.body).orderly_key as string | undefined) : undefined;
    const key = url.searchParams.get("orderly_key") ?? fromBody;
    if (!key) throw new VenueError(400, ERR.INVALID_PARAM, "orderly_key is required");
    const r = venue.removeKey(a.accountId, normalizeOrderlyKey(key));
    log?.info({ accountId: a.accountId, key: key.slice(0, 16), ...r }, "orderly key removed");
    return ok(c, r);
  };
  app.delete("/v1/orderly_key", removeKey); // shared mock contract
  app.post("/v1/client/remove_orderly_key", removeKey); // confirmed live path

  // ------------------------------------------------------------------ orders
  app.post("/v1/order", async (c) => {
    const a = await auth(c, "trading");
    return ok(c, venue.placeOrder(a, parseJson(a.body) as OrderRequest));
  });

  app.post("/v1/batch-order", async (c) => {
    const a = await auth(c, "trading");
    const b = parseJson(a.body);
    const orders = b.orders;
    if (!Array.isArray(orders)) throw new VenueError(400, ERR.INVALID_PARAM, "orders must be an array");
    if (orders.length > 10) throw new VenueError(400, ERR.INVALID_PARAM, "at most 10 orders per batch");
    const rows = orders.map((o) => {
      try {
        return { ...venue.placeOrder(a, o as OrderRequest), error_message: null };
      } catch (e) {
        if (!(e instanceof VenueError)) throw e;
        const req = o as OrderRequest;
        return { order_id: null, client_order_id: req.client_order_id ?? null, order_type: req.order_type ?? null, order_price: req.order_price ?? null, order_quantity: req.order_quantity ?? null, error_message: e.message };
      }
    });
    return ok(c, { rows });
  });

  app.delete("/v1/orders", async (c) => {
    const a = await auth(c, "trading");
    const symbol = new URL(c.req.url).searchParams.get("symbol") ?? undefined;
    const n = venue.cancelAll(a.accountId, symbol);
    return ok(c, { status: "CANCEL_ALL_SENT", cancelled: n });
  });

  app.delete("/v1/order", async (c) => {
    const a = await auth(c, "trading");
    const q = new URL(c.req.url).searchParams;
    const o = venue.cancelOrder(a.accountId, str(q.get("symbol") ?? undefined, "symbol"), { orderId: num(q.get("order_id"), "order_id") });
    return ok(c, { status: "CANCEL_SENT", order_id: o.orderId });
  });

  app.delete("/v1/client/order", async (c) => {
    const a = await auth(c, "trading");
    const q = new URL(c.req.url).searchParams;
    const o = venue.cancelOrder(a.accountId, str(q.get("symbol") ?? undefined, "symbol"), { clientOrderId: str(q.get("client_order_id") ?? undefined, "client_order_id") });
    return ok(c, { status: "CANCEL_SENT", order_id: o.orderId });
  });

  app.get("/v1/orders", async (c) => {
    const a = await auth(c, "read");
    const symbol = new URL(c.req.url).searchParams.get("symbol") ?? undefined;
    const rows = venue.openOrders(a.accountId, symbol).map((o) => venue.orderView(o));
    return ok(c, { meta: { total: rows.length, records_per_page: rows.length, current_page: 1 }, rows });
  });

  // ------------------------------------------------------------------ account
  app.get("/v1/positions", async (c) => {
    const a = await auth(c, "read");
    return ok(c, venue.positionsView(a.accountId));
  });

  app.get("/v1/client/holding", async (c) => {
    const a = await auth(c, "read");
    return ok(c, venue.holdingView(a.accountId));
  });

  app.get("/v1/trades", async (c) => {
    const a = await auth(c, "read");
    const q = new URL(c.req.url).searchParams;
    const optNum = (k: string) => (q.get(k) === null ? undefined : num(q.get(k), k));
    return ok(
      c,
      venue.tradesView(a.accountId, {
        ...(q.get("symbol") ? { symbol: q.get("symbol") as string } : {}),
        ...(optNum("start_t") !== undefined ? { startT: optNum("start_t") as number } : {}),
        ...(optNum("end_t") !== undefined ? { endT: optNum("end_t") as number } : {}),
        ...(optNum("page") !== undefined ? { page: optNum("page") as number } : {}),
        ...(optNum("size") !== undefined ? { size: optNum("size") as number } : {}),
      }),
    );
  });

  // ------------------------------------------------------------------ withdrawals
  app.get("/v1/withdraw_nonce", async (c) => {
    const a = await auth(c, "read");
    return ok(c, { withdraw_nonce: venue.nextWithdrawNonce(a.accountId) });
  });

  const withdraw = (delegate: boolean) => async (c: Context) => {
    const a = await auth(c, "asset");
    const b = parseJson(a.body);
    const msg = b.message as WithdrawMessageJson | undefined;
    if (!msg) throw new VenueError(400, ERR.INVALID_PARAM, "message is required");
    if (delegate && !msg.delegateContract) throw new VenueError(400, ERR.INVALID_PARAM, "message.delegateContract is required");
    const verifyingContract = (typeof b.verifyingContract === "string" ? b.verifyingContract : opts.ledgerAddress) as Address;
    const recovered = await recoverWithdrawSigner(msg, str(b.signature, "signature") as Hex, verifyingContract, delegate);
    const claimed = typeof b.userAddress === "string" ? b.userAddress : undefined;
    if (delegate) await checkDelegateSigner(a.accountId, msg.delegateContract, recovered, claimed);
    else {
      const acct = venue.getAccount(a.accountId);
      const owner = acct.owner ?? claimed?.toLowerCase();
      if (opts.authMode === "strict" && (!owner || owner !== recovered.toLowerCase())) throw new VenueError(401, ERR.INVALID_SIGNATURE, "withdraw must be signed by the account owner");
    }
    if (opts.authMode === "strict" && delegate && msg.receiver.toLowerCase() !== msg.delegateContract?.toLowerCase()) {
      throw new VenueError(400, ERR.INVALID_PARAM, "delegate withdrawals are paid to the delegate contract");
    }
    const w = venue.requestWithdraw(a.accountId, {
      amountMicro: num(msg.amount, "amount"), // USDC raw units (6 dp) — VERIFY live unit
      receiver: msg.receiver,
      token: msg.token,
      chainId: Number(msg.chainId),
      withdrawNonce: num(msg.withdrawNonce, "withdrawNonce"),
      ...(typeof b.client_ref === "string" ? { clientRef: b.client_ref } : {}),
      ...(msg.delegateContract ? { delegateContract: msg.delegateContract } : {}),
    });
    log?.info({ accountId: a.accountId, withdrawId: w.id, amount: w.amount, receiver: w.receiver }, "withdraw requested");
    return ok(c, { withdraw_id: w.id });
  };
  app.post("/v1/withdraw_request", withdraw(false));
  app.post("/v1/delegate_withdraw_request", withdraw(true)); // Orderly's path (docs, 2026-10)
  app.post("/v1/delegate_signer_withdraw_request", withdraw(true)); // legacy alias (earlier ops-venue builds)

  app.get("/v1/asset/history", async (c) => {
    const a = await auth(c, "read");
    const q = new URL(c.req.url).searchParams;
    const side = q.get("side");
    const rows = [...venue.withdrawals.values()]
      .filter((w) => w.accountId === a.accountId && (!side || side === "WITHDRAW"))
      .filter((w) => !q.get("start_t") || w.createdAt >= Number(q.get("start_t")))
      .sort((x, y) => y.createdAt - x.createdAt)
      .map((w) => venue.withdrawView(w));
    return ok(c, { meta: { total: rows.length, records_per_page: rows.length, current_page: 1 }, rows });
  });

  // ------------------------------------------------------------------ builder (mock contract paths)
  const createSymbol = async (c: Context, live: boolean) => {
    const a = await auth(c, null);
    requireBuilder(a);
    const b = parseJson(a.body);
    const base = typeof b.base_ccy === "string" ? b.base_ccy : typeof b.base_asset === "string" ? b.base_asset : undefined;
    const symbol = typeof b.symbol === "string" ? b.symbol : base ? symbolOf(base) : undefined;
    if (!symbol) throw new VenueError(400, ERR.INVALID_PARAM, "symbol (or base_ccy) is required");
    const s = venue.createSymbol({
      symbol,
      ...(base ? { baseAsset: base } : {}),
      priceSource: live ? "builder" : typeof b.price_source === "string" ? b.price_source : "builder",
      ...(typeof b.sessions === "string" ? { sessions: b.sessions } : typeof b.market_session === "string" ? { sessions: b.market_session } : {}),
      ...(typeof b.insurance_fund_account_id === "string" ? { ifAccountId: b.insurance_fund_account_id } : {}),
      builderAccountId: a.accountId,
    });
    log?.info({ symbol: s.symbol, ifAccountId: s.ifAccountId, status: venue.symbolStatus(s) }, "symbol created/updated");
    return ok(c, { symbol: s.symbol, status: venue.symbolStatus(s), insurance_fund_account_id: s.ifAccountId ?? null });
  };
  app.post("/v1/builder/symbol", (c) => createSymbol(c, false));
  app.post("/v1/broker/listing/submit", (c) => createSymbol(c, true)); // live alias (VERIFY body)

  app.post("/v1/broker/listing/oracle/feed", async (c) => {
    const a = await auth(c, null);
    requireBuilder(a);
    const b = parseJson(a.body);
    return ok(c, { base_ccy: str(b.base_ccy, "base_ccy"), visibility: b.visibility ?? "PRIVATE", status: b.status ?? "ACTIVE" });
  });

  app.post("/v1/builder/symbol/price_source", async (c) => {
    const a = await auth(c, null);
    requireBuilder(a);
    const b = parseJson(a.body);
    const s = venue.requireSymbol(str(b.symbol, "symbol"));
    s.priceSource = str(b.price_source, "price_source");
    return ok(c, { symbol: s.symbol, price_source: s.priceSource });
  });

  app.post("/v1/builder/symbol/status", async (c) => {
    const a = await auth(c, null);
    requireBuilder(a);
    const b = parseJson(a.body);
    const status = str(b.status, "status");
    if (status !== "ACTIVE" && status !== "REDUCE_ONLY" && status !== "DELISTED") throw new VenueError(400, ERR.INVALID_PARAM, "status must be ACTIVE | REDUCE_ONLY | DELISTED");
    venue.setSymbolStatus(str(b.symbol, "symbol"), status);
    const s = venue.requireSymbol(str(b.symbol, "symbol"));
    return ok(c, { symbol: s.symbol, status: venue.symbolStatus(s) });
  });

  app.get("/v1/builder/insurance_fund", async (c) => {
    const a = await auth(c, "read");
    requireBuilder(a, false);
    const symbol = new URL(c.req.url).searchParams.get("symbol");
    if (symbol) return ok(c, venue.insuranceView(venue.requireSymbol(symbol)));
    return ok(c, { rows: [...venue.symbols.values()].map((s) => venue.insuranceView(s)) });
  });

  app.post("/v1/builder/insurance_fund", async (c) => {
    const a = await auth(c, "asset");
    requireBuilder(a);
    const b = parseJson(a.body);
    const s = venue.requireSymbol(str(b.symbol, "symbol"));
    if (!s.ifAccountId) throw new VenueError(400, ERR.INVALID_PARAM, "symbol has no insurance fund account");
    const amount = toMicro(num(b.amount, "amount"));
    const builder = venue.getAccount(a.accountId);
    if (amount <= 0 || amount > venue.withdrawableMicro(builder)) throw new VenueError(400, ERR.CAN_NOT_WITHDRAW, "insufficient builder balance");
    builder.holding -= amount;
    venue.ensureAccount(s.ifAccountId).holding += amount;
    venue.dirty = true;
    return ok(c, venue.insuranceView(s));
  });

  app.post("/v1/internal_transfer", async (c) => {
    const a = await auth(c, "asset");
    const b = parseJson(a.body);
    const to = normalizeAccountId(str(b.receiver_account_id ?? b.to_account_id, "receiver_account_id"));
    const amount = toMicro(num(b.amount, "amount"));
    const from = venue.getAccount(a.accountId);
    if (amount <= 0 || amount > venue.withdrawableMicro(from)) throw new VenueError(400, ERR.CAN_NOT_WITHDRAW, "insufficient balance");
    from.holding -= amount;
    venue.ensureAccount(to).holding += amount;
    venue.dirty = true;
    return ok(c, { from: from.accountId, to, amount: amount / 1e6 });
  });

  app.get("/v1/builder/fee_settlements", async (c) => {
    const a = await auth(c, "read");
    requireBuilder(a, false);
    const q = new URL(c.req.url).searchParams;
    const start = Number(q.get("start_t") ?? 0);
    const end = q.get("end_t") ? Number(q.get("end_t")) : undefined;
    return ok(c, { rows: venue.settlementsSince(start, end).map((s) => venue.settlementView(s)) });
  });

  // live shape (confirmed, docs 2026-10): GET /v1/broker/daily_fee_revenue?start_date&end_date (YYYY-MM-DD, required,
  // <= 180 days) -> rows[{date, permissionless_listing_fee_share, distributor_fee_share, builder_fee_revenue,
  // cross_broker_fee, total_revenue}] newest first, broker-wide. `date` = settlement date = end of the revenue day
  // (here: the mock settlement's period label).
  app.get("/v1/broker/daily_fee_revenue", async (c) => {
    const a = await auth(c, "read");
    requireBuilder(a, false);
    const q = new URL(c.req.url).searchParams;
    const sd = q.get("start_date");
    const ed = q.get("end_date");
    if (!sd || !ed) throw new VenueError(400, ERR.INVALID_PARAM, "start_date and end_date can't be blank");
    const from = Date.parse(`${sd}T00:00:00Z`);
    const to = Date.parse(`${ed}T00:00:00Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new VenueError(400, ERR.INVALID_PARAM, "invalid date interval");
    if ((to - from) / 86_400_000 >= 180) throw new VenueError(400, ERR.INVALID_PARAM, "error date interval greater than 180 days");
    const byDate = new Map<string, number>();
    for (const st of venue.settlementsSince(0)) {
      const date = new Date(st.period * 1000).toISOString().slice(0, 10);
      const ms = Date.parse(`${date}T00:00:00Z`);
      if (ms < from || ms > to) continue;
      byDate.set(date, (byDate.get(date) ?? 0) + st.amount);
    }
    const rows = [...byDate.entries()]
      .sort((x, y) => (x[0] < y[0] ? 1 : -1))
      .map(([date, micro]) => ({ date, permissionless_listing_fee_share: micro / 1e6, distributor_fee_share: 0, builder_fee_revenue: 0, cross_broker_fee: 0, total_revenue: micro / 1e6 }));
    return ok(c, { rows });
  });

  // ------------------------------------------------------------------ mock admin
  app.post("/mock/credit", async (c) => {
    const b = parseJson(await c.req.text());
    const accountId = str(b.accountId ?? b.account_id, "accountId");
    const amount = b.amountRaw !== undefined ? Number(b.amountRaw) : toMicro(num(b.amount, "amount"));
    venue.credit(accountId, amount, typeof b.ref === "string" ? b.ref : undefined);
    if (typeof b.kind === "string") venue.ensureAccount(accountId, { kind: b.kind as "if" | "mm" | "builder" | "other" });
    return ok(c, { accountId: normalizeAccountId(accountId), holding: venue.getAccount(accountId).holding / 1e6 });
  });

  app.post("/mock/accounts", async (c) => {
    const b = parseJson(await c.req.text());
    const a = venue.ensureAccount(str(b.accountId ?? b.account_id, "accountId"), {
      ...(typeof b.kind === "string" ? { kind: b.kind as "if" | "mm" | "builder" | "other" } : {}),
      ...(typeof b.owner === "string" ? { owner: b.owner } : {}),
      ...(typeof b.delegateSigner === "string" ? { delegateSigner: b.delegateSigner } : {}),
    });
    if (b.builder === true) venue.setBuilder(a.accountId);
    return ok(c, { accountId: a.accountId, kind: a.kind, owner: a.owner ?? null, delegateSigner: a.delegateSigner ?? null });
  });

  app.post("/mock/keys", async (c) => {
    const b = parseJson(await c.req.text());
    const scope = typeof b.scope === "string" ? b.scope.split(",") : PERMISSIVE_SCOPES;
    const exp = b.expiration !== undefined ? toMs(num(b.expiration, "expiration")) : venue.now() + 365 * DAY_MS;
    const k = venue.registerKey(str(b.accountId ?? b.account_id, "accountId"), normalizeOrderlyKey(str(b.orderlyKey ?? b.orderly_key, "orderlyKey")), scope, exp);
    return ok(c, { orderly_key: k.orderlyKey, scope: k.scope.join(","), account_id: k.accountId });
  });

  app.post("/mock/price", async (c) => {
    const b = parseJson(await c.req.text());
    const ts = b.ts !== undefined ? toMs(num(b.ts, "ts")) : venue.now();
    const p = venue.setPrice(str(b.symbol, "symbol"), num(b.price, "price"), b.held === true, ts);
    return ok(c, { symbol: b.symbol, price: p.px, held: p.held, ts: p.ts });
  });

  app.post("/mock/taker", async (c) => {
    const b = parseJson(await c.req.text());
    const side = str(b.side, "side").toUpperCase();
    if (side !== "BUY" && side !== "SELL") throw new VenueError(400, ERR.INVALID_PARAM, "side must be BUY or SELL");
    const fills = venue.externalTaker(str(b.symbol, "symbol"), side, num(b.qty, "qty"), b.price === undefined ? undefined : num(b.price, "price"));
    return ok(c, { fills: fills.map((f) => ({ ...f, takerFee: f.takerFee / 1e6, builderShare: f.builderShare / 1e6 })) });
  });

  app.post("/mock/settle", async (c) => {
    const b = parseJson(await c.req.text());
    const rows = venue.settleNow(b.period === undefined ? undefined : num(b.period, "period"));
    return ok(c, { rows: rows.map((s) => venue.settlementView(s)) });
  });

  app.post("/mock/tick", async (c) => {
    const b = parseJson(await c.req.text());
    const fills = venue.tick(b.dtSec === undefined ? 1 : num(b.dtSec, "dtSec"), opts.rng);
    return ok(c, { fills: fills.length });
  });

  app.post("/mock/flow", async (c) => {
    const b = parseJson(await c.req.text());
    for (const [k, v] of Object.entries(b)) {
      if (k in venue.cfg.flow && typeof v === typeof (venue.cfg.flow as unknown as Record<string, unknown>)[k]) {
        (venue.cfg.flow as unknown as Record<string, unknown>)[k] = v;
      }
    }
    return ok(c, venue.cfg.flow);
  });

  app.post("/mock/withdrawals/:id/complete", async (c) => {
    const b = parseJson(await c.req.text());
    const w = venue.completeWithdraw(num(c.req.param("id"), "id"), str(b.txHash ?? b.tx_hash, "txHash"));
    return ok(c, venue.withdrawView(w));
  });

  app.post("/mock/withdrawals/:id/fail", async (c) => {
    const b = parseJson(await c.req.text());
    const w = venue.failWithdraw(num(c.req.param("id"), "id"), typeof b.reason === "string" ? b.reason : "failed");
    return ok(c, venue.withdrawView(w));
  });

  app.get("/mock/state", (c) => ok(c, { ...venue.state(), ...(opts.extraState?.() ?? {}) }));

  return app;
}
