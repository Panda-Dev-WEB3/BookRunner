// HTTP API (Hono) with injected deps: draft offline path, verdict content addressing, health.
import { describe, expect, test } from "bun:test";
import { createLogger } from "@bookrunner/shared";
import type { CharterStore, VerdictRow } from "../src/adapters/store";
import { filedCharterIdFrom } from "../src/jury/scheduler";
import { deadlineNotices } from "../src/committee/upkeep";
import { cidOfJson } from "../src/domain/cid";
import { type AppDeps, createApp } from "../src/http/app";
import { handleDraft } from "../src/http/draftService";
import { lookupVerdict } from "../src/http/queries";
import { NVDA_TOKEN, SPONSOR } from "./fixtures";

const logger = createLogger("charter-test", "silent");

function fakeVerdictStore(rows: VerdictRow[]): CharterStore {
  return { verdictByCid: async (cid: string) => rows.find((r) => r.cid === cid) ?? null } as unknown as CharterStore;
}

function app(rows: VerdictRow[] = []) {
  const store = fakeVerdictStore(rows);
  const deps: AppDeps = {
    logger,
    draft: (body) => handleDraft(body, { chain: null, chainId: 31337, tickers: { NVDA: { token: NVDA_TOKEN } }, logger }),
    getCharter: async (id) => (id === 1 ? { id: 1, status: "Filed" } : null),
    listCharters: async () => [],
    getVerdict: (cid) => lookupVerdict(cid, store),
    health: async () => ({ ok: true, deployment: false }),
  };
  return createApp(deps);
}

const DRAFT = {
  sponsor: SPONSOR,
  underlying: { ticker: "NVDA" },
  venue: "orderly",
  ifTargetUsd: "30000",
  mmInventoryUsd: "75000",
  mandate: { maxInventoryUsd: "50000", maxSkewBps: 25, minQuoteWidthBps: 8, hedgeRatioMinBps: 5000, hedgeRatioMaxBps: 12000, killAtDrawdownBps: -800 },
  seniorHurdleBps: 6000,
  seniorCapBps: 7000,
  subscriptionWindow: 600,
  symbol: "PERP_NVDA_USDC",
};

async function verdictRow(verdict: Record<string, unknown>): Promise<VerdictRow> {
  const id = await cidOfJson(verdict);
  return { id: 1, charterId: 1, cid: id.cid, digest: id.digest, recommendApprove: true, verdict, postedTx: null, createdAt: new Date() };
}

describe("charter HTTP API", () => {
  test("GET /health", async () => {
    const res = await app().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ service: "charter", ok: true });
  });

  test("POST /charters/draft without a deployment validates with defaults", async () => {
    const res = await app().request("/charters/draft", { method: "POST", body: JSON.stringify(DRAFT), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.reason).toBeNull();
    expect(body.chainChecked).toBe(false);
    expect(body.transactions).toEqual([]);
    expect(String(body.encoded)).toMatch(/^0x[0-9a-f]+$/);
    expect((body.charter as Record<string, unknown>).ifTargetUsd).toBe("30000000000");
  });

  test("POST /charters/draft reports on-chain reason codes for rule violations", async () => {
    const res = await app().request("/charters/draft", { method: "POST", body: JSON.stringify({ ...DRAFT, ifTargetUsd: "1000", subscriptionWindow: 30 }) });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("IF_BELOW_VENUE_MIN");
    expect(body.reasons).toEqual(["IF_BELOW_VENUE_MIN", "BAD_WINDOW"]);
  });

  test("POST /charters/draft rejects malformed input with 400", async () => {
    expect((await app().request("/charters/draft", { method: "POST", body: "{nope" })).status).toBe(400);
    const res = await app().request("/charters/draft", { method: "POST", body: JSON.stringify({ ...DRAFT, sponsor: "bob" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: Array<{ path: string }> }).issues[0]!.path).toBe("sponsor");
  });

  test("GET /charters/:id", async () => {
    expect((await app().request("/charters/1")).status).toBe(200);
    expect((await app().request("/charters/2")).status).toBe(404);
    expect((await app().request("/charters/abc")).status).toBe(400);
  });

  test("GET /verdicts/:cid serves bytes that hash to the CID", async () => {
    const row = await verdictRow({ charterId: 1, summary: "ok", models: [], createdAt: "2026-10-02T00:00:00.000Z" });
    const res = await app([row]).request(`/verdicts/${row.cid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-cid")).toBe(row.cid);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { cidOfBytes } = await import("../src/domain/cid");
    expect((await cidOfBytes(bytes)).cid).toBe(row.cid);
  });

  test("GET /verdicts/:cid detects tampered content", async () => {
    const row = await verdictRow({ charterId: 1, summary: "ok" });
    const tampered = { ...row, verdict: { charterId: 1, summary: "changed" } };
    expect((await app([tampered]).request(`/verdicts/${row.cid}`)).status).toBe(500);
  });

  test("GET /verdicts/:cid 404 for unknown / placeholder, 400 for invalid CIDs", async () => {
    const row = await verdictRow({ placeholder: true });
    expect((await app([row]).request(`/verdicts/${row.cid}`)).status).toBe(404);
    expect((await app().request(`/verdicts/${row.cid}`)).status).toBe(404);
    expect((await app().request("/verdicts/not-a-cid")).status).toBe(400);
  });
});

describe("scheduler + committee helpers", () => {
  test("charter.filed domain events trigger jury jobs", () => {
    expect(filedCharterIdFrom(JSON.stringify({ id: 1, type: "charter.filed", createdAt: "x", data: { charterId: 4 } }))).toBe(4);
    expect(filedCharterIdFrom(JSON.stringify({ type: "book.created", data: { bookId: 4 } }))).toBeNull();
    expect(filedCharterIdFrom("garbage")).toBeNull();
  });

  test("deadline notices inside the warning window and after expiry", () => {
    const now = new Date("2026-10-03T00:00:00Z");
    const filed = [
      { id: 1, filedAt: new Date("2026-10-01T06:00:00Z") }, // deadline 10-03T06 -> 6h left
      { id: 2, filedAt: new Date("2026-10-02T23:00:00Z") }, // 47h left
      { id: 3, filedAt: new Date("2026-09-30T00:00:00Z") }, // elapsed
    ];
    const n = deadlineNotices(filed, 172_800, 12 * 3600, now);
    expect(n.map((x) => [x.charterId, x.kind])).toEqual([
      [1, "deadline_approaching"],
      [3, "window_elapsed"],
    ]);
  });
});
