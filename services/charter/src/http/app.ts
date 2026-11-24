// Charter intake HTTP API (Hono on Bun.serve):
//   GET  /health
//   POST /charters/draft      validate a draft (human units) -> encoded struct + prepared txs
//   GET  /charters            ?status=Filed&limit=50
//   GET  /charters/:id
//   GET  /verdicts/:cid       content-addressed verdict JSON (hash verified on read)
import { type Logger, bigintReplacer } from "@bookrunner/shared";
import { Hono } from "hono";
import { DraftError } from "../domain/draft";
import type { DraftResponse } from "./draftService";

export type VerdictLookup =
  | { kind: "ok"; cid: string; bytes: Uint8Array }
  | { kind: "not_found" }
  | { kind: "bad_cid"; error: string }
  | { kind: "integrity_error"; expected: string; actual: string };

export interface AppDeps {
  logger: Logger;
  draft(body: unknown): Promise<DraftResponse>;
  getCharter(id: number): Promise<unknown | null>;
  listCharters(status: string | undefined, limit: number): Promise<unknown[]>;
  getVerdict(cid: string): Promise<VerdictLookup>;
  health(): Promise<{ ok: boolean } & Record<string, unknown>>;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, bigintReplacer), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    deps.logger.error({ err, path: c.req.path }, "request failed");
    return json({ error: "internal_error" }, 500);
  });
  app.notFound(() => json({ error: "not_found" }, 404));

  app.get("/health", async () => {
    const h = await deps.health();
    return json({ service: "charter", ...h }, h.ok ? 200 : 503);
  });

  app.post("/charters/draft", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    try {
      return json(await deps.draft(body));
    } catch (err) {
      if (err instanceof DraftError) return json({ error: "invalid_draft", issues: err.issues }, 400);
      throw err;
    }
  });

  app.get("/charters", async (c) => {
    const status = c.req.query("status") || undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
    return json({ charters: await deps.listCharters(status, limit) });
  });

  app.get("/charters/:id", async (c) => {
    const raw = c.req.param("id");
    if (!/^\d+$/.test(raw)) return json({ error: "invalid_id" }, 400);
    const found = await deps.getCharter(Number(raw));
    return found ? json(found) : json({ error: "not_found" }, 404);
  });

  app.get("/verdicts/:cid", async (c) => {
    const cid = c.req.param("cid");
    const r = await deps.getVerdict(cid);
    switch (r.kind) {
      case "ok":
        return new Response(r.bytes, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-content-cid": r.cid,
            etag: `"${r.cid}"`,
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      case "bad_cid":
        return json({ error: "invalid_cid", detail: r.error }, 400);
      case "integrity_error":
        deps.logger.error({ expected: r.expected, actual: r.actual }, "stored verdict does not hash to its CID");
        return json({ error: "integrity_error" }, 500);
      default:
        return json({ error: "not_found" }, 404);
    }
  });

  return app;
}
