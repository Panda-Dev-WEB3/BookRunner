// --source-check (read-only operator CLI): pass/fail table over every configured feed.
import { describe, expect, test } from "bun:test";
import { MULTIPLIER_VECTOR as V, WAD, loadChainPriceConfig } from "@bookrunner/shared";
import type { Address } from "viem";
import { parseArgs } from "../src/cli/source-check";
import { resolveFeeds } from "../src/config";
import type { PriceSource } from "../src/domain/types";
import { type CheckRow, type RegistryView, type SourceCheckReader, formatTable, runSourceCheck } from "../src/source-check";
import type { RoundData, TokenState } from "../src/sources/chainlink";

const CONFIG = loadChainPriceConfig(4663)!;
const FEEDS = resolveFeeds(CONFIG, {}, { defaultMaxAgeMs: 3_600_000, heartbeatGraceMs: 600_000 }).feeds;
// Thu 2026-10-01 15:00 UTC: 24/5 session open
const T0 = Date.parse("2026-10-01T15:00:00Z");
const T0S = BigInt(T0 / 1000);

class FakeCheckReader implements SourceCheckReader {
  chain = 4663;
  noCode = new Set<string>();
  dec = 8;
  desc = new Map<string, string>();
  rounds = new Map<string, RoundData>();
  tokens = new Map<string, TokenState>();
  tokenDec = 18;
  constructor() {
    for (const [id, f] of Object.entries(FEEDS)) {
      this.rounds.set(f.proxy.toLowerCase(), { answer: V.feedAnswer, startedAt: T0S - 120n, updatedAt: T0S - 120n });
      this.desc.set(f.proxy.toLowerCase(), `Robinhood ${id} / USD`);
      this.tokens.set(f.token!.toLowerCase(), { uiMultiplier: V.uiMultiplierWad, newUIMultiplier: V.uiMultiplierWad, effectiveAt: 0n, oraclePaused: false });
    }
  }
  async chainId() {
    return this.chain;
  }
  async hasCode(a: Address) {
    return !this.noCode.has(a.toLowerCase());
  }
  async description(feed: Address) {
    return this.desc.get(feed.toLowerCase()) ?? "";
  }
  async tokenDecimals() {
    return this.tokenDec;
  }
  async decimals() {
    return this.dec;
  }
  async latestRoundData(feed: Address) {
    const r = this.rounds.get(feed.toLowerCase());
    if (!r) throw new Error("execution reverted");
    return r;
  }
  async tokenState(token: Address) {
    const t = this.tokens.get(token.toLowerCase());
    if (!t) throw new Error("execution reverted");
    return t;
  }
}

const rowsFor = (rows: CheckRow[], subject: string) => rows.filter((r) => r.subject === subject);
const status = (rows: CheckRow[], subject: string, check: string) => rows.find((r) => r.subject === subject && r.check === check)?.status;

describe("runSourceCheck", () => {
  test("healthy mainnet config: every row passes except the documented sequencer warning", async () => {
    const rows = await runSourceCheck({ chainId: 4663, config: CONFIG, feeds: FEEDS, reader: new FakeCheckReader(), now: () => T0 });
    const bad = rows.filter((r) => r.status !== "PASS");
    expect(bad.map((r) => `${r.subject}/${r.check}`)).toEqual(["chain/L2 sequencer"]);
    for (const id of ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"]) {
      expect(rowsFor(rows, id).map((r) => r.check)).toEqual([
        "feed code",
        "feed decimals",
        "feed description",
        "token code",
        "token decimals",
        "uiMultiplier",
        "oraclePaused",
        "observation",
      ]);
    }
    const obs = rows.find((r) => r.subject === "NVDA" && r.check === "observation")!;
    expect(obs.detail).toContain(`$${V.perSharePrice.toFixed(4)} per share = feed / uiMultiplier`);
    expect(formatTable(rows)).toContain("0 fail -> OK");
  });

  test("wrong chain stops early; a dead RPC fails", async () => {
    const r = new FakeCheckReader();
    r.chain = 1;
    const rows = await runSourceCheck({ chainId: 4663, config: CONFIG, feeds: FEEDS, reader: r, now: () => T0 });
    expect(status(rows, "chain", "eth_chainId")).toBe("FAIL");
    r.chainId = async () => {
      throw new Error("fetch failed");
    };
    const dead = await runSourceCheck({ chainId: 4663, config: CONFIG, feeds: FEEDS, reader: r, now: () => T0 });
    expect(dead).toEqual([{ subject: "chain", check: "eth_chainId", status: "FAIL", detail: "RPC unreachable: fetch failed" }]);
  });

  test("failures: no code, decimals mismatch, paused token, stale in session, token decimals", async () => {
    const r = new FakeCheckReader();
    r.noCode.add(FEEDS.TSLA!.proxy.toLowerCase());
    r.dec = 18;
    r.tokens.set(FEEDS.AAPL!.token!.toLowerCase(), { uiMultiplier: WAD, newUIMultiplier: WAD, effectiveAt: 0n, oraclePaused: true });
    r.rounds.set(FEEDS.MSFT!.proxy.toLowerCase(), { answer: V.feedAnswer, startedAt: T0S - 200_000n, updatedAt: T0S - 200_000n });
    const rows = await runSourceCheck({ chainId: 4663, config: CONFIG, feeds: FEEDS, reader: r, now: () => T0 });
    expect(status(rows, "TSLA", "feed code")).toBe("FAIL");
    expect(rowsFor(rows, "TSLA")).toHaveLength(1);
    expect(status(rows, "NVDA", "feed decimals")).toBe("FAIL");
    expect(status(rows, "NVDA", "observation")).toBe("FAIL"); // the service refuses it too
    expect(status(rows, "AAPL", "oraclePaused")).toBe("FAIL");
    expect(formatTable(rows)).toContain("NOT READY");
  });

  test("off-hours: a feed past its heartbeat is a warning (held), not a failure; pending multiplier warns", async () => {
    const sat = Date.parse("2026-10-03T15:00:00Z");
    const r = new FakeCheckReader();
    r.rounds.set(FEEDS.NVDA!.proxy.toLowerCase(), { answer: V.feedAnswer, startedAt: BigInt(sat / 1000) - 150_000n, updatedAt: BigInt(sat / 1000) - 150_000n });
    r.tokens.set(FEEDS.TSLA!.token!.toLowerCase(), { uiMultiplier: WAD, newUIMultiplier: 10n * WAD, effectiveAt: BigInt(sat / 1000) + 86_400n, oraclePaused: false });
    for (const f of Object.values(FEEDS)) {
      if (f.proxy !== FEEDS.NVDA!.proxy) r.rounds.set(f.proxy.toLowerCase(), { answer: V.feedAnswer, startedAt: BigInt(sat / 1000) - 60n, updatedAt: BigInt(sat / 1000) - 60n });
    }
    const rows = await runSourceCheck({ chainId: 4663, config: CONFIG, feeds: FEEDS, reader: r, now: () => sat });
    expect(status(rows, "NVDA", "observation")).toBe("WARN");
    expect(rows.find((x) => x.subject === "NVDA" && x.check === "observation")!.detail).toContain("held off-hours");
    expect(status(rows, "TSLA", "pending multiplier")).toBe("WARN");
  });

  test("registry: must be registered and in live uiMultiplier mode; out-of-band surfaces the revert", async () => {
    const reg: RegistryView & { live: boolean; out: boolean } = {
      live: false,
      out: false,
      async token() {
        if (this.out) return { error: "live uiMultiplier 2 outside the band of anchor 1" };
        return { registered: true, multiplierWad: WAD, decimals: 18, active: true };
      },
      async multiplierFromToken() {
        return this.live;
      },
    };
    let rows = await runSourceCheck({ chainId: 4663, config: CONFIG, feeds: FEEDS, reader: new FakeCheckReader(), now: () => T0, registry: reg });
    expect(status(rows, "NVDA", "registry")).toBe("FAIL");
    reg.live = true;
    rows = await runSourceCheck({ chainId: 4663, config: CONFIG, feeds: FEEDS, reader: new FakeCheckReader(), now: () => T0, registry: reg });
    expect(status(rows, "NVDA", "registry")).toBe("PASS");
    reg.out = true;
    rows = await runSourceCheck({ chainId: 4663, config: CONFIG, feeds: FEEDS, reader: new FakeCheckReader(), now: () => T0, registry: reg });
    expect(rows.find((x) => x.subject === "NVDA" && x.check === "registry")!.detail).toContain("outside the band");
  });

  test("other live sources are compared with the Chainlink per-share price; config problems are listed", async () => {
    const near: PriceSource = { name: "http-a", kind: "http", fetch: async () => ({ price: V.perSharePrice * 1.001, ts: T0 }) };
    const far: PriceSource = { name: "http-b", kind: "http", fetch: async () => ({ price: V.perSharePrice * 1.05, ts: T0 }) };
    const rows = await runSourceCheck({
      chainId: 4663,
      config: CONFIG,
      feeds: { NVDA: FEEDS.NVDA! },
      reader: new FakeCheckReader(),
      now: () => T0,
      otherSources: [near, far],
      configProblems: ["SESSIONS_MODE=24x7 is a demo override"],
    });
    expect(status(rows, "NVDA", "vs http-a")).toBe("PASS");
    expect(status(rows, "NVDA", "vs http-b")).toBe("FAIL");
    expect(status(rows, "service config", "production rule")).toBe("FAIL");
    expect(status(rows, "TSLA", "coverage")).toBe("WARN");
  });
});

describe("CLI args", () => {
  test("defaults and flags", () => {
    expect(parseArgs([], {})).toMatchObject({ chain: 4663, rpc: undefined, registry: null, serviceConfig: true, json: false });
    const a = parseArgs(["--chain", "4663", "--rpc", "https://rpc.example", "--registry", "0x00000000000000000000000000000000000000aa", "--json", "--no-service-config"], {
      RHC_RPC_URL: "https://ignored",
    });
    expect(a).toMatchObject({ chain: 4663, rpc: "https://rpc.example", registry: "0x00000000000000000000000000000000000000AA", serviceConfig: false, json: true });
    expect(parseArgs([], { RHC_RPC_URL: "https://rhc" }).rpc).toBe("https://rhc");
    expect(() => parseArgs(["--chain", "x"], {})).toThrow("--chain");
  });
});
