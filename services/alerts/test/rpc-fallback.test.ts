// rpc_fallback_active (rules.ts) and the data behind it (collect.ts parseOracleHealth / parseRpcFallback).
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { parseOracleHealth, parseRpcFallback } from "../src/collect";
import { evaluate, rpcFallbackActive } from "../src/rules";
import { NOW, rules, snap as baseSnapshot } from "./fixtures";

const KEYED = "https://eth.g.alchemy.com/v2/SECRETKEYSECRETKEY1234";
const fb = (sinceAgoMs: number, message = "Alchemy monthly capacity limit reached: switch plan or key") => ({ service: "oracle", provider: "Alchemy", reason: "capacity", since: NOW - sinceAgoMs, message });

describe("rpc_fallback_active", () => {
  test("silent on the primary", () => {
    expect(rpcFallbackActive(baseSnapshot(), rules())).toEqual([]);
    expect(rpcFallbackActive({ ...baseSnapshot(), rpcFallback: [] }, rules())).toEqual([]);
  });

  test("a warning that names the provider and why, critical after 6 h", () => {
    const warn = rpcFallbackActive({ ...baseSnapshot(), rpcFallback: [fb(10 * 60_000)] }, rules());
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ key: "rpc_fallback_active", rule: "rpc_fallback_active", severity: "warning" });
    expect(warn[0]!.summary).toContain("Alchemy monthly capacity limit reached: switch plan or key");
    const crit = rpcFallbackActive({ ...baseSnapshot(), rpcFallback: [fb(6 * 3_600_000 + 1)] }, rules());
    expect(crit[0]!.severity).toBe("critical");
    expect(crit[0]!.summary).toContain("6 h");
    expect(rpcFallbackActive({ ...baseSnapshot(), rpcFallback: [fb(6 * 3_600_000 - 60_000)] }, rules())[0]!.severity).toBe("warning");
  });

  test("evaluate() includes it, and it can be disabled by name", () => {
    const s = { ...baseSnapshot(), rpcFallback: [fb(1000)] };
    expect(evaluate(s, rules()).some((c) => c.rule === "rpc_fallback_active")).toBe(true);
    expect(evaluate(s, rules({ disabled: new Set(["rpc_fallback_active"]) })).some((c) => c.rule === "rpc_fallback_active")).toBe(false);
  });

  test("the critical threshold is configurable (default 6 h)", () => {
    expect(loadConfig({ NETWORK: "mainnet", CHAIN_ID: "4663" }).rules.rpcFallbackCriticalSec).toBe(21_600);
    expect(loadConfig({ NETWORK: "mainnet", CHAIN_ID: "4663", ALERT_RPC_FALLBACK_CRITICAL_SECONDS: "3600" }).rules.rpcFallbackCriticalSec).toBe(3600);
  });
});

describe("oracle /health rpc.fallback", () => {
  test("parsed from the health body; absent or null = on the primary", () => {
    expect(parseOracleHealth({}).rpcFallback ?? null).toBeNull();
    expect(parseOracleHealth({ rpc: { fallback: null, usage: {} } }).rpcFallback ?? null).toBeNull();
    const p = parseOracleHealth({ rpc: { fallback: { provider: "Alchemy", reason: "capacity", status: 429, since: NOW - 5, retryAt: NOW, message: "Alchemy monthly capacity limit reached: switch plan or key" } } });
    expect(p.rpcFallback).toEqual({ service: "oracle", provider: "Alchemy", reason: "capacity", since: NOW - 5, message: "Alchemy monthly capacity limit reached: switch plan or key" });
  });

  test("a URL smuggled into a reported text is cut", () => {
    const p = parseRpcFallback("oracle", { provider: "Alchemy", reason: "server_error", since: NOW, message: `failed ${KEYED} badly` });
    expect(JSON.stringify(p)).not.toContain("SECRETKEY");
    expect(p?.message).toContain("<url>");
    expect(parseRpcFallback("oracle", { provider: "x", since: "nope" })).toBeNull();
  });
});
