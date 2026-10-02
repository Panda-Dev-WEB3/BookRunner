// REST mirror (/v1/*) of the tRPC procedures. Each route maps path/query/body onto the procedure
// input; validation, errors and outputs are the procedure's own (JSON, bigint-free).
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiDeps } from "./deps";
import { toJsonValue } from "./format";
import { createCaller } from "./router";
import { webhookRoutes } from "./webhooks/routes";

type Caller = ReturnType<typeof createCaller>;

/** Procedure inputs are validated by zod inside the procedure; REST passes raw values through. */
const raw = (v: unknown) => v as never;

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function restError(c: Context, e: unknown, deps: ApiDeps) {
  if (e instanceof TRPCError) {
    const status = getHTTPStatusCodeFromError(e) as ContentfulStatusCode;
    const cause = e.cause as { issues?: unknown } | undefined;
    const internal = e.code === "INTERNAL_SERVER_ERROR";
    if (internal) deps.log.error({ err: e.cause ?? e }, "REST procedure failed");
    return c.json(
      { error: { code: e.code, message: internal ? "internal error" : e.message, ...(cause?.issues ? { issues: cause.issues } : {}) } },
      status,
    );
  }
  deps.log.error({ err: e }, "REST route failed");
  return c.json({ error: { code: "INTERNAL_SERVER_ERROR", message: "internal error" } }, 500);
}

export function restRoutes(deps: ApiDeps, opts: { origins?: readonly string[] } = {}): Hono {
  const r = new Hono();
  const run = async (c: Context, fn: (k: Caller) => Promise<unknown>, status: ContentfulStatusCode = 200) => {
    try {
      return c.json(toJsonValue(await fn(createCaller({ deps }))) as Record<string, unknown>, status);
    } catch (e) {
      return restError(c, e, deps);
    }
  };
  const q = (c: Context) => c.req.query();
  const id = (c: Context) => c.req.param("id");

  // charters
  r.get("/charters", (c) => run(c, (k) => k.charter.list(raw(q(c)))));
  r.post("/charters", async (c) => {
    const b = await body(c);
    return run(c, (k) => k.charter.file(raw(b)));
  });
  r.get("/charters/:id", (c) => run(c, (k) => k.charter.get(raw({ charterId: id(c) }))));
  r.post("/charters/:id/votes", async (c) => {
    const b = await body(c);
    return run(c, (k) => k.charter.decide(raw({ ...b, charterId: id(c) })));
  });

  // books
  r.get("/books", (c) => run(c, async (k) => ({ items: await k.book.list() })));
  r.get("/books/:id", (c) => run(c, (k) => k.book.get(raw({ bookId: id(c) }))));
  r.get("/books/:id/nav", (c) => run(c, (k) => k.book.nav(raw({ ...q(c), bookId: id(c) }))));
  r.get("/books/:id/limits", (c) => run(c, (k) => k.book.limits(raw({ ...q(c), bookId: id(c) }))));
  r.get("/books/:id/marks", (c) => run(c, (k) => k.book.marks(raw({ ...q(c), bookId: id(c) }))));
  r.get("/books/:id/risk", (c) => run(c, (k) => k.risk.state(raw({ bookId: id(c) }))));
  r.get("/books/:id/settlements", (c) => run(c, (k) => k.settlements.list(raw({ ...q(c), bookId: id(c) }))));
  // ops-venue's latest signed venue report (LOW_GAS §2; relayed in the book's mark tx)
  r.get("/books/:id/venue-report", (c) => run(c, (k) => k.book.venueReport(raw({ bookId: id(c) }))));

  // tranches
  r.post("/books/:id/tranches/:tranche/subscribe", async (c) => {
    const b = await body(c);
    return run(c, (k) => k.tranche.subscribe(raw({ ...b, bookId: id(c), tranche: c.req.param("tranche") })));
  });
  r.post("/books/:id/tranches/:tranche/redeem", async (c) => {
    const b = await body(c);
    return run(c, (k) => k.tranche.redeem(raw({ ...b, bookId: id(c), tranche: c.req.param("tranche") })));
  });
  r.get("/books/:id/positions/:wallet", (c) => run(c, (k) => k.tranche.position(raw({ bookId: id(c), wallet: c.req.param("wallet") }))));
  r.post("/books/:id/claims", async (c) => {
    const b = await body(c);
    return run(c, (k) => k.tranche.claim(raw({ ...b, bookId: id(c) })));
  });

  // agents (desk session keys)
  r.get("/books/:id/agents", (c) => run(c, (k) => k.agent.list(raw({ bookId: id(c) }))));
  r.post("/books/:id/agents", async (c) => {
    const b = await body(c);
    return run(c, (k) => k.agent.register(raw({ ...b, bookId: id(c) })));
  });
  r.post("/books/:id/agents/:key/revoke", async (c) => {
    const b = await body(c);
    return run(c, (k) => k.agent.revoke(raw({ ...b, bookId: id(c), key: c.req.param("key") })));
  });

  // receipts
  r.get("/receipts/root", (c) => run(c, (k) => k.receipts.root(raw(q(c)))));
  r.get("/receipts/:id/proof", (c) => run(c, (k) => k.receipts.proof(raw({ receiptId: id(c) }))));

  // oracle + events
  r.get("/oracle/prices", (c) => {
    const ids = c.req.query("priceIds") ?? c.req.query("ids");
    return run(c, (k) => k.oracle.prices(raw(ids ? { priceIds: ids.split(",").map((s) => s.trim()).filter(Boolean) } : {})));
  });
  // the oracle's latest signed bundle (pull oracle, LOW_GAS §1): the `priceData` a consumer tx carries
  r.get("/oracle/signed", (c) => run(c, (k) => k.oracle.signed()));
  r.get("/events", (c) => run(c, (k) => k.events.recent(raw(q(c)))));

  // webhooks management
  r.route("/webhooks", webhookRoutes(deps, { origins: opts.origins }));

  return r;
}
