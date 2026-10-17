// Per-source health (/health `sources`, services/alerts oracle_source_failing): in-session failures only,
// failure runs, error classes, rate-limited warnings without access tokens.
import { describe, expect, test } from "bun:test";
import { VENUE, encodeSessions, priceId, SESSIONS_24X7, SESSIONS_NYSE_RTH } from "@bookrunner/shared";
import { SourceHealth, type SourceOutcome, errorClass } from "../src/domain/source-health";
import { buildUniverse } from "../src/domain/universe";
import { FakeChain, ORACLE_ADDR, ScriptedSource, makeService } from "./fakes";

const T0 = Date.parse("2026-10-01T15:00:00Z"); // Thu 11:00 ET
const ok: SourceOutcome = { ok: true };
const fail = (error: string): SourceOutcome => ({ ok: false, error });
const tick = (by: Record<string, Record<string, SourceOutcome>>) => new Map(Object.entries(by).map(([t, m]) => [t, new Map(Object.entries(m))]));

describe("SourceHealth", () => {
  test("failure runs count in-session tickers only; the warning is rate limited and starts after 10 s", () => {
    const warns: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const h = new SourceHealth([{ name: "chainlink", kind: "chainlink" }, { name: "pyth", kind: "pyth" }], (fields, msg) => warns.push({ fields, msg }));
    const open = new Set(["NVDA", "TSLA"]);
    h.update(T0, tick({ NVDA: { chainlink: ok, pyth: fail("HTTP 401") }, TSLA: { chainlink: ok, pyth: fail("HTTP 401") } }), open);
    let pyth = h.view().find((s) => s.name === "pyth")!;
    expect(pyth).toMatchObject({ kind: "pyth", failingSince: T0, failingTickers: ["NVDA", "TSLA"], lastError: "HTTP 401", lastOkAt: null });
    expect(h.view().find((s) => s.name === "chainlink")).toMatchObject({ failingSince: null, lastOkAt: T0, failingTickers: [] });
    expect(warns).toHaveLength(0); // a single tick is not reported
    for (let i = 1; i <= 75; i++) h.update(T0 + i * 1000, tick({ NVDA: { chainlink: ok, pyth: fail("HTTP 401") } }), open);
    expect(warns.map((w) => w.fields.failingForMs)).toEqual([10_000, 70_000]); // after 10 s, then once a minute
    expect(warns[0]!.fields).toMatchObject({ source: "pyth", error: "HTTP 401", tickers: ["NVDA"] });
    // recovery clears the run
    h.update(T0 + 80_000, tick({ NVDA: { chainlink: ok, pyth: ok } }), open);
    pyth = h.view().find((s) => s.name === "pyth")!;
    expect(pyth).toMatchObject({ failingSince: null, failingTickers: [], lastOkAt: T0 + 80_000, lastError: "HTTP 401" });
  });

  test("a closed market is not a failure (Pyth `closed`, weekends) and resets the run", () => {
    const h = new SourceHealth([{ name: "pyth", kind: "pyth" }]);
    h.update(T0, tick({ NVDA: { pyth: fail("no observation") } }), new Set(["NVDA"]));
    expect(h.view()[0]!.failingSince).toBe(T0);
    h.update(T0 + 1000, tick({ NVDA: { pyth: fail("no observation") } }), new Set());
    expect(h.view()[0]).toMatchObject({ failingSince: null, failingTickers: [] });
  });

  test("error classes are short and key-free", () => {
    expect(errorClass("pyth: HTTP 401 (access token rejected or not entitled to these feeds)")).toBe("HTTP 401");
    expect(errorClass("timeout after 2000ms")).toBe("timeout");
    expect(errorClass("pyth NVDA: stale (30s old)")).toBe("pyth NVDA: stale (30s old)");
    expect(errorClass("pyth: connect failed: Authorization: Bearer ***")).toBe("connect failed: Authorization: Bearer ***");
  });
});

describe("OracleService /health sources", () => {
  test("per-source last ok / failing since / last error class, in-session only", async () => {
    let clock = T0;
    const now = () => clock;
    const chainlink = new ScriptedSource("chainlink", now);
    const pyth = new ScriptedSource("pyth", now);
    const { svc } = makeService({ sources: [chainlink, pyth], settings: { minSources: 2, sessionsMode: "charter" }, now });
    const chain = new FakeChain();
    await svc.setDeployment({ chainId: 31337, oracle: ORACLE_ADDR, chain });
    const RTH = encodeSessions(SESSIONS_NYSE_RTH);
    await svc.setUniverse(
      buildUniverse({
        equities: [{ priceId: "NVDA", underlying: priceId("NVDA") }],
        indexes: [],
        books: [{ bookId: 1, venue: VENUE.ORDERLY, symbol: "PERP_NVDA_USDC", oracleKey: "NVDA", sessions: RTH }],
        defaultSessions: encodeSessions(SESSIONS_24X7),
      }).entries,
    );
    chainlink.set("NVDA", { price: 190 });
    pyth.set("NVDA", new Error("pyth: HTTP 403 (access token rejected or not entitled to these feeds)"));
    chain.head = Math.floor(clock / 1000);
    const r = await svc.tick(clock);
    expect(r.published).toEqual([]); // 1 of 2 sources: nothing signed
    const sources = svc.health().sources;
    expect(sources.find((s) => s.name === "pyth")).toMatchObject({ failingSince: T0, failingTickers: ["NVDA"], lastError: "HTTP 403", lastOkAt: null });
    expect(sources.find((s) => s.name === "chainlink")).toMatchObject({ failingSince: null, lastOkAt: T0 });
    // Saturday: the RTH session is closed, a failing source is not "failing"
    clock = Date.parse("2026-10-03T15:00:00Z");
    chain.head = Math.floor(clock / 1000);
    await svc.tick(clock);
    expect(svc.health().sources.find((s) => s.name === "pyth")!.failingSince).toBeNull();
  });
});
