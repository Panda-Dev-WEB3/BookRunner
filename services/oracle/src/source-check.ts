// Read-only pre-launch check of every configured price source (VERIFY C4 / T2 / T3): run by the operator
// against a mainnet RPC (`bun run source-check --chain 4663 --rpc <url>`, cli/source-check.ts). Pure over
// an injected reader so it is unit-tested with fakes; never sends a transaction.
import { type ChainPriceConfig, SESSIONS_24X5, type Sessions, WAD, isOpen } from "@bookrunner/shared";
import type { Address } from "viem";
import { exceedsBps } from "./domain/aggregate";
import type { PriceSource } from "./domain/types";
import { type AggregatorReader, ChainlinkSource, type ResolvedFeed } from "./sources/chainlink";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface CheckRow {
  subject: string;
  check: string;
  status: CheckStatus;
  detail: string;
}

export interface RegistryView {
  /** getToken(token) (reverts MultiplierOutOfBand in live mode outside the band: `error` carries it) */
  token(token: Address): Promise<{ registered: boolean; multiplierWad: bigint; decimals: number; active: boolean } | { error: string }>;
  multiplierFromToken(token: Address): Promise<boolean>;
}

export interface SourceCheckReader extends AggregatorReader {
  chainId(): Promise<number>;
  hasCode(addr: Address): Promise<boolean>;
  description(feed: Address): Promise<string>;
  tokenDecimals(token: Address): Promise<number>;
}

export interface SourceCheckInput {
  chainId: number;
  config: ChainPriceConfig;
  feeds: Record<string, ResolvedFeed>;
  reader: SourceCheckReader;
  now?: () => number;
  /** Session calendar of the feeds (Chainlink Robinhood feeds: us_equities_24/5). */
  sessions?: Sessions;
  sequencerFeed?: Address | null;
  sequencerGraceMs?: number;
  registry?: RegistryView | null;
  /** Other live sources (HTTP) compared with the Chainlink per-share price. */
  otherSources?: readonly PriceSource[];
  outlierBps?: number;
  /** Rows from the service-config production guard (production.ts). */
  configProblems?: readonly string[];
}

const errMsg = (e: unknown): string => (e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e));
const fmtWad = (x: bigint, dp = 6) => (Number(x) / 1e18).toFixed(dp);

export async function runSourceCheck(p: SourceCheckInput): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const add = (subject: string, check: string, status: CheckStatus, detail: string) => rows.push({ subject, check, status, detail });
  const now = p.now ?? Date.now;
  const marketOpen = isOpen(p.sessions ?? SESSIONS_24X5, new Date(now()));

  // ---- chain ----
  try {
    const id = await p.reader.chainId();
    add("chain", "eth_chainId", id === p.chainId ? "PASS" : "FAIL", `${id}${id === p.chainId ? "" : ` (expected ${p.chainId})`}`);
  } catch (e) {
    add("chain", "eth_chainId", "FAIL", `RPC unreachable: ${errMsg(e)}`);
    return rows;
  }
  add("chain", "session", "PASS", marketOpen ? "24/5 equity session open: feeds must be fresh" : "off-hours: feeds may hold (no heartbeat off-hours)");

  if (p.sequencerFeed) {
    try {
      const s = await p.reader.latestRoundData(p.sequencerFeed);
      const upFor = now() - Number(s.startedAt) * 1000;
      if (s.answer !== 0n) add("chain", "L2 sequencer", "FAIL", "down (answer != 0)");
      else add("chain", "L2 sequencer", upFor >= (p.sequencerGraceMs ?? 3_600_000) ? "PASS" : "WARN", `up for ${Math.round(upFor / 1000)}s`);
    } catch (e) {
      add("chain", "L2 sequencer", "FAIL", errMsg(e));
    }
  } else {
    add("chain", "L2 sequencer", "WARN", "no sequencer uptime feed configured (none listed by Chainlink for Robinhood Chain: VERIFY C4)");
  }

  for (const msg of p.configProblems ?? []) add("service config", "production rule", "FAIL", msg);

  // ---- config coverage ----
  for (const id of Object.keys(p.config.stockTokens)) if (!p.feeds[id]) add(id, "coverage", "WARN", "Stock Token without a Chainlink feed");

  const source = new ChainlinkSource(p.feeds, p.reader, { now, sequencerFeed: null });
  for (const [id, f] of Object.entries(p.feeds)) {
    // ---- feed ----
    if (!(await safe(() => p.reader.hasCode(f.proxy), false))) {
      add(id, "feed code", "FAIL", `no contract at ${f.proxy}`);
      continue;
    }
    add(id, "feed code", "PASS", f.proxy);
    let dec: number | null = null;
    try {
      dec = await p.reader.decimals(f.proxy);
      add(id, "feed decimals", f.decimals === undefined || f.decimals === dec ? "PASS" : "FAIL", f.decimals === undefined ? `${dec} (not pinned in config)` : `${dec} (configured ${f.decimals})`);
    } catch (e) {
      add(id, "feed decimals", "FAIL", errMsg(e));
    }
    const desc = await safe(() => p.reader.description(f.proxy), null);
    if (desc === null) add(id, "feed description", "WARN", "description() not readable");
    else add(id, "feed description", !f.description || desc.includes(f.description) ? "PASS" : "WARN", `"${desc}"${f.description ? ` (expected "${f.description}")` : ""}`);

    // ---- Stock Token (per-token feeds) ----
    if (f.basis === "per-token") {
      if (!f.token) add(id, "token", "FAIL", "per-token feed without a Stock Token");
      else if (!(await safe(() => p.reader.hasCode(f.token as Address), false))) add(id, "token code", "FAIL", `no contract at ${f.token}`);
      else {
        add(id, "token code", "PASS", f.token);
        const expectedDec = p.config.stockTokens[id]?.decimals ?? 18;
        const tdec = await safe(() => p.reader.tokenDecimals(f.token as Address), null);
        add(id, "token decimals", tdec === expectedDec ? "PASS" : "FAIL", `${tdec ?? "unreadable"} (expected ${expectedDec})`);
        try {
          const ts = await p.reader.tokenState(f.token);
          const sane = ts.uiMultiplier >= WAD / 2n && ts.uiMultiplier <= 100n * WAD;
          add(id, "uiMultiplier", ts.uiMultiplier > 0n ? (sane ? "PASS" : "WARN") : "FAIL", `${fmtWad(ts.uiMultiplier, 18)} (WAD ${ts.uiMultiplier})`);
          if (ts.oraclePaused === null) add(id, "oraclePaused", "WARN", "oraclePaused() not readable");
          else add(id, "oraclePaused", ts.oraclePaused ? "FAIL" : "PASS", ts.oraclePaused ? "paused: corporate action in progress" : "false");
          const eff = ts.effectiveAt ?? 0n;
          if (ts.newUIMultiplier !== null && ts.newUIMultiplier !== ts.uiMultiplier && Number(eff) * 1000 > now()) {
            add(id, "pending multiplier", "WARN", `${fmtWad(ts.newUIMultiplier, 6)} effective at ${new Date(Number(eff) * 1000).toISOString()}: pre-approve with setNextMultiplierAnchor`);
          }
          if (p.registry) await checkRegistry(p.registry, id, f.token, p.config.stockTokens[id]?.multiplierSource ?? "uiMultiplier", add);
        } catch (e) {
          add(id, "uiMultiplier", "FAIL", `uiMultiplier() not readable: ${errMsg(e)}`);
        }
      }
    }

    // ---- observation (the exact path the service signs from) ----
    try {
      const o = await source.observe(id);
      if (!o.ok) add(id, "observation", "FAIL", o.reason);
      else {
        const age = `${Math.round(o.ageMs / 1000)}s old (max ${Math.round(o.maxAgeMs / 1000)}s in session)`;
        const status: CheckStatus = o.stale ? (marketOpen ? "FAIL" : "WARN") : "PASS";
        const basis = f.basis === "per-token" ? `per share = feed / uiMultiplier` : "per share";
        add(id, "observation", status, `$${o.price.toFixed(4)} ${basis}, ${age}${o.stale && !marketOpen ? ", held off-hours" : ""}`);
        for (const other of p.otherSources ?? []) await compare(other, id, o.price, p.outlierBps ?? 150, add);
      }
    } catch (e) {
      add(id, "observation", "FAIL", errMsg(e));
    }
  }
  return rows;
}

async function checkRegistry(
  reg: RegistryView,
  id: string,
  token: Address,
  wanted: "uiMultiplier" | "stored",
  add: (s: string, c: string, st: CheckStatus, d: string) => void,
): Promise<void> {
  const t = await safe(() => reg.token(token), { error: "getToken not readable" } as const);
  if ("error" in t) {
    add(id, "registry", "FAIL", t.error);
    return;
  }
  if (!t.registered) {
    add(id, "registry", "FAIL", "token not registered in StockTokenRegistry");
    return;
  }
  const live = await safe(() => reg.multiplierFromToken(token), false);
  if (wanted === "uiMultiplier" && !live) add(id, "registry", "FAIL", `stored multiplier ${fmtWad(t.multiplierWad)}: enable setMultiplierSource(token, true)`);
  else add(id, "registry", t.active ? "PASS" : "WARN", `${live ? "live uiMultiplier" : "stored"} ${fmtWad(t.multiplierWad)}${t.active ? "" : " (inactive)"}`);
}

async function compare(
  other: PriceSource,
  id: string,
  chainlinkPerShare: number,
  outlierBps: number,
  add: (s: string, c: string, st: CheckStatus, d: string) => void,
): Promise<void> {
  try {
    const r = await other.fetch(id);
    if (!r) {
      add(id, `vs ${other.name}`, "FAIL", "no observation");
      return;
    }
    const bps = (Math.abs(r.price - chainlinkPerShare) / chainlinkPerShare) * 1e4;
    // a source quoting per TOKEN would sit ~uiMultiplier away: still inside the band today (~0.1%), so it is
    // the operator's job to confirm the basis of every HTTP source (VERIFY C2)
    add(id, `vs ${other.name}`, exceedsBps(r.price, chainlinkPerShare, outlierBps) ? "FAIL" : "PASS", `$${r.price.toFixed(4)} (${bps.toFixed(1)} bps from Chainlink per share)`);
  } catch (e) {
    add(id, `vs ${other.name}`, "FAIL", errMsg(e));
  }
}

async function safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch {
    return fallback;
  }
}

/** Fixed-width table for the terminal. */
export function formatTable(rows: readonly CheckRow[]): string {
  const head: CheckRow = { subject: "SOURCE", check: "CHECK", status: "PASS", detail: "DETAIL" };
  const w = (k: keyof CheckRow) => Math.max(...[head, ...rows].map((r) => (k === "status" && r === head ? 6 : r[k].length)));
  const ws = { subject: w("subject"), check: w("check"), status: 6 };
  const line = (r: CheckRow, st: string) => `${r.subject.padEnd(ws.subject)}  ${r.check.padEnd(ws.check)}  ${st.padEnd(ws.status)}  ${r.detail}`;
  const out = [line(head, "STATUS"), ...rows.map((r) => line(r, r.status))];
  const n = (s: CheckStatus) => rows.filter((r) => r.status === s).length;
  out.push("", `${n("PASS")} pass, ${n("WARN")} warn, ${n("FAIL")} fail -> ${n("FAIL") === 0 ? "OK" : "NOT READY"}`);
  return out.join("\n");
}
