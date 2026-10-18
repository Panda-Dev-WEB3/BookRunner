// Read-only pre-launch check of every configured price source (VERIFY C4 / C6 / T2 / T3): run by the operator
// against a mainnet RPC. Under primary-confirm (mainnet) it shows per ticker the Chainlink per-share price (the only
// signing source), the Uniswap v3 TWAP per share with its diff, pool depth and observation history (FAIL on mainnet
// when a pool is missing, below its liquidity floor or cannot serve the window; WARN beyond ORACLE_CONFIRM_BPS),
// and the optional confirm sources (Pyth Pro / HTTP: WARN only) (`bun run source-check --chain 4663 --rpc <url>`, cli/source-check.ts). Pure over
// an injected reader so it is unit-tested with fakes; never sends a transaction.
import { type ChainPriceConfig, MAINNET_CHAIN_ID, SESSIONS_24X5, type Sessions, WAD, isOpen } from "@bookrunner/shared";
import type { Address } from "viem";
import { deviationBps, exceedsBps } from "./domain/aggregate";
import type { OraclePolicy, PriceSource } from "./domain/types";
import { type PythSchedule, compareCalendars } from "./pyth-schedule";
import { type AggregatorReader, ChainlinkSource, type ResolvedFeed } from "./sources/chainlink";
import type { DexTwapSource } from "./sources/dex-twap";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

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
  /** Other live sources (Pyth Pro, HTTP) compared with the Chainlink per-share price. */
  otherSources?: readonly PriceSource[];
  /**
   * Aggregation policy checked against (default: primary-confirm on mainnet, median elsewhere). primary-confirm:
   * Chainlink must be live, the DEX TWAP must confirm every ticker on mainnet, other sources are optional confirmers
   * (WARN beyond confirmBps). median: every source within outlierBps of Chainlink and of each other.
   */
  policy?: OraclePolicy;
  /** The Uniswap v3 TWAP confirm source (chain config dexConfirm.pools); null / undefined = none configured. */
  dex?: DexTwapSource | null;
  /** primary-confirm divergence threshold (ORACLE_CONFIRM_BPS, default 200). */
  confirmBps?: number;
  /**
   * Whether a Pyth Pro access token (PYTH_API_KEY) is available; undefined = not evaluated. Without one the Pyth
   * row FAILs on mainnet under the median policy and is SKIPped otherwise (primary-confirm: an optional confirmer).
   */
  pythKey?: boolean;
  /** Minimum live sources (ORACLE_MIN_SOURCES): adds the "sources / live" summary row when set. */
  minSources?: number;
  /**
   * Pyth's published market-session schedules per ticker (`/v1/symbols`), or why they could not be read: compared
   * with the session calendar over the next `calendarDays` (default 30). A minute the calendar treats as open
   * while Pyth is closed leaves mainnet without its spare source and means the tables are out of date — FAIL on
   * 4663, WARN elsewhere.
   */
  pythCalendar?: { schedules: ReadonlyMap<string, readonly PythSchedule[]> } | { error: string };
  calendarDays?: number;
  outlierBps?: number;
  /** Rows from the service-config production guard (production.ts). */
  configProblems?: readonly string[];
}

const errMsg = (e: unknown): string => (e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e));
const fmtWad = (x: bigint, dp = 6) => (Number(x) / 1e18).toFixed(dp);

export async function runSourceCheck(p: SourceCheckInput): Promise<CheckRow[]> {
  const policy: OraclePolicy = p.policy ?? (p.chainId === MAINNET_CHAIN_ID ? "primary-confirm" : "median");
  const mainnet = p.chainId === MAINNET_CHAIN_ID;
  const confirmBps = p.confirmBps ?? 200;
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
  if (p.pythKey === false) {
    const required = mainnet && policy === "median";
    add(
      "pyth",
      "access token",
      required ? "FAIL" : "SKIP",
      `PYTH_API_KEY not set${required ? ": Pyth Pro is required by the median policy on mainnet" : policy === "primary-confirm" ? " (optional confirm source under primary-confirm)" : ""}`,
    );
  }
  if (p.pythCalendar) checkPythCalendar(p, now(), mainnet && policy === "median" ? "FAIL" : "WARN", add);

  // sources that produced a fresh observation for at least one feed
  const live = new Set<string>();

  // ---- config coverage ----
  for (const id of Object.keys(p.config.stockTokens)) if (!p.feeds[id]) add(id, "coverage", "WARN", "Stock Token without a Chainlink feed");
  const confirmsLive = new Set<string>();

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
        if (!o.stale) live.add(source.name);
        if (policy === "primary-confirm") {
          if (await checkDex(p.dex ?? null, id, o.price, confirmBps, mainnet, marketOpen, add)) confirmsLive.add("dex-twap");
          for (const other of p.otherSources ?? []) {
            if ((await confirmCompare(other, id, o.price, confirmBps, marketOpen, add)) !== null) confirmsLive.add(other.name);
          }
          continue;
        }
        const seen: Array<{ name: string; price: number }> = [];
        for (const other of p.otherSources ?? []) {
          const price = await compare(other, id, o.price, p.outlierBps ?? 150, marketOpen, add);
          if (price !== null) {
            live.add(other.name);
            seen.push({ name: other.name, price });
          }
        }
        // pairwise agreement of the other sources (the runtime refuses a 2-source price beyond the band)
        for (let i = 0; i < seen.length; i++) {
          for (let j = i + 1; j < seen.length; j++) {
            const a = seen[i]!;
            const b = seen[j]!;
            const gap = (Math.abs(a.price - b.price) / ((a.price + b.price) / 2)) * 1e4;
            const limit = p.outlierBps ?? 150;
            add(id, `${a.name} vs ${b.name}`, gap > limit + 1e-9 ? "FAIL" : "PASS", `${gap.toFixed(1)} bps apart (limit ${limit}, of their midpoint)`);
          }
        }
      }
    } catch (e) {
      add(id, "observation", "FAIL", errMsg(e));
    }
  }
  if (policy === "primary-confirm") {
    const feeds = Object.keys(p.feeds).length;
    add(
      "sources",
      "primary",
      live.has("chainlink") ? "PASS" : marketOpen ? "FAIL" : "WARN",
      `chainlink ${live.has("chainlink") ? "live" : "not live"} (${feeds} feed${feeds === 1 ? "" : "s"}; the only signing source, sourceCount 1)`,
    );
    const configured = [...(p.dex ? ["dex-twap"] : []), ...(p.otherSources ?? []).map((x) => x.name)];
    add(
      "sources",
      "confirm",
      confirmsLive.size > 0 ? "PASS" : mainnet ? "FAIL" : "WARN",
      `${confirmsLive.size > 0 ? [...confirmsLive].sort().join(", ") : "none"} live (configured: ${configured.join(", ") || "none"}; threshold ${confirmBps} bps)`,
    );
    return rows;
  }
  if (p.minSources !== undefined) {
    const configured = ["chainlink", ...(p.otherSources ?? []).map((s) => s.name)];
    const names = [...live].sort();
    const enough = names.length >= p.minSources;
    add(
      "sources",
      "live",
      enough ? "PASS" : marketOpen ? "FAIL" : "WARN",
      `${names.length > 0 ? names.join(", ") : "none"} (${names.length} of ORACLE_MIN_SOURCES=${p.minSources}; configured: ${configured.join(", ")})`,
    );
  }
  return rows;
}

const fmtEt = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function checkPythCalendar(p: SourceCheckInput, nowMs: number, bad: CheckStatus, add: (s: string, c: string, st: CheckStatus, d: string) => void): void {
  const cal = p.pythCalendar;
  if (!cal) return;
  if ("error" in cal) {
    add("pyth", "calendar", bad, `Pyth market-session schedules not readable: ${cal.error}`);
    return;
  }
  const days = p.calendarDays ?? 30;
  for (const [ticker, schedules] of cal.schedules) {
    if (schedules.length === 0) {
      add(ticker, "pyth calendar", bad, "no market_session_schedule for this feed");
      continue;
    }
    const d = compareCalendars({ ours: p.sessions ?? SESSIONS_24X5, pyth: schedules, fromMs: nowMs, days });
    if (d.oursOpenPythClosed.length > 0) {
      const w = d.oursOpenPythClosed.slice(0, 3).map((x) => `${fmtEt(x.from)} -> ${fmtEt(x.to)} ET`);
      add(ticker, "pyth calendar", bad, `calendar open while Pyth is closed: ${w.join("; ")}${d.oursOpenPythClosed.length > 3 ? ` (+${d.oursOpenPythClosed.length - 3})` : ""} — extend NYSE_HOLIDAYS / NYSE_EARLY_CLOSES`);
    } else {
      add(ticker, "pyth calendar", "PASS", `next ${days} d: calendar closed wherever Pyth is (${d.pythOpenOursClosed.length} window(s) held while Pyth quotes)`);
    }
  }
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

/** Compares one other source with Chainlink per share; its price when it produced an observation, else null. */
async function compare(
  other: PriceSource,
  id: string,
  chainlinkPerShare: number,
  outlierBps: number,
  marketOpen: boolean,
  add: (s: string, c: string, st: CheckStatus, d: string) => void,
): Promise<number | null> {
  try {
    const r = await other.fetch(id);
    if (!r) {
      // off-hours a source may have no fresh price (Pyth: session closed / feedUpdateTimestamp too old)
      add(id, `vs ${other.name}`, marketOpen ? "FAIL" : "WARN", marketOpen ? "no observation" : "no fresh observation (off-hours)");
      return null;
    }
    const bps = (Math.abs(r.price - chainlinkPerShare) / chainlinkPerShare) * 1e4;
    // a source quoting per TOKEN would sit ~uiMultiplier away: still inside the band today (~0.1%), so it is
    // the operator's job to confirm the basis of every HTTP source (VERIFY C2)
    add(id, `vs ${other.name}`, exceedsBps(r.price, chainlinkPerShare, outlierBps) ? "FAIL" : "PASS", `$${r.price.toFixed(4)} (${bps.toFixed(1)} bps from Chainlink per share)`);
    return r.price;
  } catch (e) {
    add(id, `vs ${other.name}`, "FAIL", errMsg(e));
    return null;
  }
}

const usd = (x: number, dp = 4) => `$${x.toFixed(dp)}`;
const usd0 = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

/**
 * primary-confirm: the DEX TWAP vs the Chainlink per-share price for one ticker. Structural problems (no pool,
 * below the liquidity floor, history shorter than the window, unreadable) FAIL on mainnet (the DEX confirm is
 * required there) and WARN elsewhere; a diff beyond confirmBps WARNs (it alerts at runtime, the price stays
 * Chainlink). Returns whether the TWAP produced an observation.
 */
async function checkDex(
  dex: DexTwapSource | null,
  id: string,
  chainlinkPerShare: number,
  confirmBps: number,
  mainnet: boolean,
  marketOpen: boolean,
  add: (s: string, c: string, st: CheckStatus, d: string) => void,
): Promise<boolean> {
  const bad: CheckStatus = mainnet ? "FAIL" : "WARN";
  const pool = dex?.pool(id);
  if (!dex || !pool) {
    if (mainnet || dex) add(id, "dex confirm", bad, "no DEX confirm pool (config/chains/<chain>.json dexConfirm.pools)");
    return false;
  }
  const o = await dex.observe(id);
  const where = `pool ${pool.pool}${pool.fee !== undefined ? ` (fee ${pool.fee})` : ""}`;
  if (!o.ok) {
    const extra = [
      o.quoteLiquidity !== undefined ? `depth ${usd0(o.quoteLiquidity)} (floor ${usd0(pool.minQuoteLiquidity)})` : null,
      o.cardinality !== undefined ? `cardinality ${o.cardinality}` : null,
      o.historySec !== undefined ? `history ${o.historySec}s` : null,
    ].filter(Boolean);
    add(id, "dex confirm", bad, `${o.reason}; ${where}${extra.length > 0 ? `, ${extra.join(", ")}` : ""}`);
    return false;
  }
  const bps = deviationBps(o.price, chainlinkPerShare);
  const diverged = exceedsBps(o.price, chainlinkPerShare, confirmBps);
  add(
    id,
    "dex confirm",
    diverged ? "WARN" : "PASS",
    `TWAP ${o.twapSec}s ${usd(o.price)}/share vs Chainlink ${usd(chainlinkPerShare)}: ${bps.toFixed(1)} bps (threshold ${confirmBps}${diverged && !marketOpen ? "; off-hours Chainlink holds" : ""}); token ${usd(o.tokenPrice)} TWAP / ${usd(o.spotTokenPrice)} spot; depth ${usd0(o.quoteLiquidity)} quote (floor ${usd0(pool.minQuoteLiquidity)}); cardinality ${o.cardinality}, history ${o.historySec}s; ${where}`,
  );
  return true;
}

/** primary-confirm: an optional confirm source (Pyth Pro, HTTP) vs Chainlink per share: WARN only. */
async function confirmCompare(
  other: PriceSource,
  id: string,
  chainlinkPerShare: number,
  confirmBps: number,
  marketOpen: boolean,
  add: (s: string, c: string, st: CheckStatus, d: string) => void,
): Promise<number | null> {
  try {
    const r = await other.fetch(id);
    if (!r) {
      add(id, `vs ${other.name}`, "WARN", marketOpen ? "no observation (optional confirm source)" : "no fresh observation (off-hours)");
      return null;
    }
    const bps = deviationBps(r.price, chainlinkPerShare);
    add(id, `vs ${other.name}`, exceedsBps(r.price, chainlinkPerShare, confirmBps) ? "WARN" : "PASS", `${usd(r.price)} (${bps.toFixed(1)} bps from Chainlink per share; confirm threshold ${confirmBps})`);
    return r.price;
  } catch (e) {
    add(id, `vs ${other.name}`, "WARN", `${errMsg(e)} (optional confirm source)`);
    return null;
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
  out.push("", `${n("PASS")} pass, ${n("WARN")} warn, ${n("SKIP")} skip, ${n("FAIL")} fail -> ${n("FAIL") === 0 ? "OK" : "NOT READY"}`);
  return out.join("\n");
}
