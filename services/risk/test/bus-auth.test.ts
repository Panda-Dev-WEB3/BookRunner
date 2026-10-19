// Audit 2026-10 lead "Redis is a shared trust domain" (Task 7b fix rounds 1-2): a Redis writer must not be able to make
// risk kill a book through a forged or replayed agent quote; risk's kill orders and published states are RISK-signed.
import { describe, expect, test } from "bun:test";
import { type BusForgedMsg, ForgedLog, type KillMsg, KillVerifier, type PriceUpdate, type QuoteMsg, RiskStateVerifier, VENUE, priceTypedData, signMonitorState, signQuote } from "@bookrunner/shared";
import { type Address, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { riskBusAuth } from "../src/adapters/busAuth";
import type { QuoteAuth } from "../src/ports";
import { BookMonitor } from "../src/monitor";
import { newKillJournal } from "../src/domain/transitions";
import { type RiskStatePayload, initialMonitorState } from "../src/types";
import { T0, type World, makeRef, makeWorld, settings, silentLog } from "./fakes";

const CHAIN = 31337;
const CONFIG = "0x00000000000000000000000000000000000c0f19" as Address;
const ORACLE = "0x00000000000000000000000000000000000000aa" as Address;
const RISK = privateKeyToAccount(keccak256(toHex("risk-key")));
const DESK = privateKeyToAccount(keccak256(toHex("desk-session-key")));
const OLD_DESK = privateKeyToAccount(keccak256(toHex("expired-desk-key")));
const WRITER = privateKeyToAccount(keccak256(toHex("redis-writer")));
const ORACLE_KEY = privateKeyToAccount(keccak256(toHex("oracle-signer")));
const REF = makeRef(1, VENUE.ORDERLY);
const MANDATE = REF.components.mandate;
const wad = (px: number) => BigInt(Math.round(px * 1e6)) * 10n ** 12n;

function setup(o: { keyCheckDown?: () => boolean } = {}) {
  const w = makeWorld();
  const auth = riskBusAuth({
    chainId: CHAIN,
    config: CONFIG,
    account: RISK,
    deskKeyStatus: async (_m, key) => {
      if (o.keyCheckDown?.()) throw new Error("rpc down");
      if (key.toLowerCase() === DESK.address.toLowerCase()) return "active";
      return key.toLowerCase() === OLD_DESK.address.toLowerCase() ? "inactive" : "unknown";
    },
    oracle: { chainId: CHAIN, oracle: ORACLE, isOracleSigner: async (a) => a.toLowerCase() === ORACLE_KEY.address.toLowerCase() },
    now: () => w.clock.t,
  });
  const m = new BookMonitor(REF, { chain: w.chain, store: w.store, bus: w.bus, queue: w.queue, venues: w.venues, clock: w.clock, settings: settings(), log: silentLog, sleep: async () => {}, auth });
  return { w, m };
}

/** The oracle's signed print at `px`, published at the world's clock (the agent's quote reference). */
async function print(w: World, px: number): Promise<NonNullable<QuoteMsg["ref"]>> {
  const u: PriceUpdate = { underlying: REF.priceId, priceWad: wad(px), publishedAt: BigInt(Math.floor(w.clock.t / 1000)), held: false, sourceCount: 3, sourcesHash: keccak256(toHex(`s${px}`)) };
  const signature = await ORACLE_KEY.signTypedData(priceTypedData(CHAIN, ORACLE, u));
  return { underlying: u.underlying, priceWad: u.priceWad.toString(), publishedAt: Number(u.publishedAt), held: false, sourceCount: 3, sourcesHash: u.sourcesHash, signature };
}

/** A two-sided quote [bid, ask] at the world's clock, priced on `ref`, signed by `who` (null: unsigned). */
async function quote(w: World, bid: number, ask: number, ref: NonNullable<QuoteMsg["ref"]>, who: typeof DESK | null = DESK): Promise<QuoteMsg> {
  const q: QuoteMsg = { bookId: 1, ts: w.clock.t, bid, ask, size: 10, mid: (bid + ask) / 2, oracle: Number(BigInt(ref.priceWad)) / 1e18, inventoryUsd: 0, skewBps: 0, widthBps: 10, sides: { bid: true, ask: true }, ref };
  return who ? { ...q, signature: await signQuote(who, CHAIN, MANDATE, q) } : q;
}

/** Sets the attested (on-chain) price fresh at the world's clock. */
function attest(w: World, px: number) {
  const o = w.chain.state.obs.oracle!;
  w.chain.state.obs = { ...w.chain.state.obs, oracle: { ...o, priceWad: wad(px), publishedAt: Math.floor(w.clock.t / 1000) } };
}

async function tick(t: ReturnType<typeof setup>, q: QuoteMsg | null, px = 190) {
  attest(t.w, px);
  if (q) t.w.bus.kv.set("quote:1", JSON.stringify(q));
  await t.m.tick();
  t.w.clock.t += 2_000;
}

const riskState = (w: World) => JSON.parse(w.bus.kv.get("risk:1") ?? "null") as RiskStatePayload;
const killed = (w: World) => w.calls.filter((c) => c === "bus.publishKill" || c.startsWith("chain.mandateKill"));

describe("forged agent quotes never cause a breach", () => {
  const forgeries: Array<[string, (w: World) => Promise<QuoteMsg>, QuoteAuth]> = [
    ["unsigned", async (w) => quote(w, 190.6, 190.8, await print(w, 190), null), "unsigned"],
    ["signed by a key that was never a desk key", async (w) => quote(w, 190.6, 190.8, await print(w, 190), WRITER), "forged"],
    ["genuine signature, prices changed", async (w) => ({ ...(await quote(w, 189.92, 190.08, await print(w, 190))), bid: 190.6, ask: 190.8 }), "forged"],
    ["genuine signature, reference print swapped", async (w) => ({ ...(await quote(w, 190.6, 190.8, await print(w, 190.7))), ref: await print(w, 190) }), "forged"],
  ];
  for (const [name, forge, status] of forgeries) {
    test(`a skewed quote ${name}, rewritten for 20 ticks: never a breach, never a kill`, async () => {
      const t = setup();
      for (let i = 0; i < 20; i++) await tick(t, await forge(t.w));
      expect(killed(t.w)).toEqual([]);
      expect(riskState(t.w).breaches).toEqual([]);
      expect(riskState(t.w).meta.quoteAuth).toBe(status);
    });
  }

  test("replaying a 10 s-old signed quote after a 9 bps move never breaches", async () => {
    const t = setup();
    const old = await quote(t.w, 189.92, 190.08, await print(t.w, 190)); // genuine, centred on 190
    await tick(t, old, 190);
    // the price moves 9 bps; the agent requotes around it (genuine quotes), then a Redis writer replays the old one
    for (let i = 0; i < 2; i++) await tick(t, await quote(t.w, 190.09, 190.25, await print(t.w, 190.171)), 190.171);
    for (let i = 0; i < 6; i++) await tick(t, old, 190.171); // 4..14 s old: stale (> 5 s) or not newer -> no new quote
    expect(killed(t.w)).toEqual([]);
    expect(riskState(t.w).breaches).toEqual([]);
    // the replay alone (risk never saw a newer quote): judged against its own print, never against the moved price
    const t2 = setup();
    const old2 = await quote(t2.w, 189.92, 190.08, await print(t2.w, 190));
    await tick(t2, old2, 190);
    for (let i = 0; i < 6; i++) await tick(t2, old2, 190.171);
    expect(killed(t2.w)).toEqual([]);
    expect(riskState(t2.w).breaches).toEqual([]);
  });

  test("an expired / revoked desk key is no_key (not a forgery); an unverifiable one is ignored too", async () => {
    const t = setup();
    for (let i = 0; i < 6; i++) await tick(t, await quote(t.w, 190.6, 190.8, await print(t.w, 190), OLD_DESK));
    expect(riskState(t.w).meta.quoteAuth).toBe("no_key");
    expect(killed(t.w)).toEqual([]);
    const down = setup({ keyCheckDown: () => true });
    for (let i = 0; i < 6; i++) await tick(down, await quote(down.w, 190.6, 190.8, await print(down.w, 190)));
    expect(riskState(down.w).meta.quoteAuth).toBe("unavailable");
    expect(killed(down.w)).toEqual([]);
  });
});

describe("genuine quotes are still checked; kills and states are RISK-signed", () => {
  test("a fresh desk-key-signed skewed quote -> SKEW breach -> kill; kill message, revoke_key job and state verify", async () => {
    const t = setup();
    for (let i = 0; i < 4; i++) await tick(t, await quote(t.w, 190.6, 190.8, await print(t.w, 190)));
    expect(riskState(t.w).meta.quoteAuth).toBe("ok");
    expect(t.w.calls).toContain("bus.publishKill");
    const isRiskSigner = async (a: Address) => a.toLowerCase() === RISK.address.toLowerCase();
    const kill = t.w.bus.published.find((p) => p.channel === "kill:1")!.msg as KillMsg;
    expect(await new KillVerifier({ chainId: CHAIN, config: CONFIG, isRiskSigner, now: () => t.w.clock.t }).verify(JSON.stringify(kill))).toMatchObject({ ok: true, signer: RISK.address });
    const job = [...t.w.queue.jobs.values()].find((j) => j.kind === "revoke_key")!;
    expect(job.kill?.nonce).toBe(kill.nonce);
    expect((await new KillVerifier({ chainId: CHAIN, config: CONFIG, isRiskSigner, now: () => t.w.clock.t }).verify(job.kill)).ok).toBe(true);
    const st = await new RiskStateVerifier({ chainId: CHAIN, config: CONFIG, bookId: 1, isRiskSigner, now: () => t.w.clock.t }).verify(t.w.bus.kv.get("risk:1"));
    expect(st).toMatchObject({ ok: true, state: riskState(t.w).state });
  });

  test("the state signature is reused while the state is unchanged and refreshed after RISK_STATE_RESIGN_MS", async () => {
    const t = setup();
    const sigs: number[] = [];
    for (let i = 0; i < 8; i++) {
      await tick(t, null);
      sigs.push(riskState(t.w).stateSig!.tsMs);
    }
    expect(new Set(sigs).size).toBe(2); // 16 s of ticks every 2 s: one re-sign after 10 s
  });
});

describe("N-3: risk restores only its own signed state, and resumes a kill only when corroborated", () => {
  function restart(w: World, o: { forged?: BusForgedMsg[] } = {}) {
    const auth = riskBusAuth({
      chainId: CHAIN,
      config: CONFIG,
      account: RISK,
      deskKeyStatus: async (_m, key) => (key.toLowerCase() === DESK.address.toLowerCase() ? "active" : "unknown"),
      oracle: { chainId: CHAIN, oracle: ORACLE, isOracleSigner: async (a) => a.toLowerCase() === ORACLE_KEY.address.toLowerCase() },
      forged: new ForgedLog("risk", async (m) => void o.forged?.push(m), () => w.clock.t),
      now: () => w.clock.t,
    });
    return { w, m: new BookMonitor(REF, { chain: w.chain, store: w.store, bus: w.bus, queue: w.queue, venues: w.venues, clock: w.clock, settings: settings(), log: silentLog, sleep: async () => {}, auth }) };
  }
  const plantedJournal = (episodeId = "1-1") => ({ ...newKillJournal({ id: episodeId, breaches: ["SKEW"] }, {}, T0 - 60) });
  const payload = (monitor: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ state: "ok", breaches: [], meta: { mandate: MANDATE, monitor }, ...extra });
  const healthy = async (t: { w: World; m: BookMonitor }, n = 4) => {
    for (let i = 0; i < n; i++) await tick(t, await quote(t.w, 189.92, 190.08, await print(t.w, 190)));
  };

  test("a planted unsigned kill record does nothing at restart (counted as forged)", async () => {
    const w = makeWorld();
    w.bus.kv.set("risk:1", payload({ ...initialMonitorState(), kill: plantedJournal() }));
    const forged: BusForgedMsg[] = [];
    await healthy(restart(w, { forged }));
    expect(killed(w)).toEqual([]);
    expect(w.calls.filter((c) => c.startsWith("chain.flatten") || c === "chain.setReduceOnly")).toEqual([]);
    expect(forged.at(-1)?.events.map((e) => e.kind)).toEqual(["state"]);
  });

  test("a validly signed but stale kill record, no on-chain corroboration, limits OK: no kill", async () => {
    for (const ageMs of [3_600_000, 0]) {
      const w = makeWorld();
      const monitor = { ...initialMonitorState(), kill: plantedJournal() }; // no signed KillOrder in it
      const tsMs = w.clock.t - ageMs;
      const signature = await signMonitorState(RISK, CHAIN, CONFIG, { bookId: 1, monitor, tsMs });
      w.bus.kv.set("risk:1", payload(monitor, { monitorSig: { tsMs, monitor, signature } }));
      await healthy(restart(w));
      expect(killed(w)).toEqual([]);
    }
  });

  test("a copy signed by another key is refused (forged) even with a KillOrder in it", async () => {
    const w = makeWorld();
    const monitor = { ...initialMonitorState(), kill: plantedJournal() };
    const signature = await signMonitorState(WRITER, CHAIN, CONFIG, { bookId: 1, monitor, tsMs: w.clock.t });
    w.bus.kv.set("risk:1", payload(monitor, { monitorSig: { tsMs: w.clock.t, monitor, signature } }));
    const forged: BusForgedMsg[] = [];
    await healthy(restart(w, { forged }));
    expect(killed(w)).toEqual([]);
    expect(forged.at(-1)?.events).toHaveLength(1);
  });

  test("a genuine kill interrupted by a restart still completes (its own signed KillOrder corroborates it)", async () => {
    const t = setup();
    t.w.chain.state.failMandateKill = 1_000; // the on-chain kill keeps failing: the run stops with the journal open
    for (let i = 0; i < 4; i++) await tick(t, await quote(t.w, 190.6, 190.8, await print(t.w, 190)));
    expect(t.w.calls).toContain("bus.publishKill");
    expect(t.w.chain.state.killed).toBe(false);
    const persisted = JSON.parse(t.w.bus.kv.get("risk:1")!) as RiskStatePayload;
    expect(persisted.monitorSig?.monitor.kill?.killOrder?.signature).toBeDefined();
    // restart: a new monitor, the market is fine now, the chain accepts the kill
    t.w.chain.state.failMandateKill = 0;
    const r = restart(t.w);
    await healthy(r, 2);
    expect(t.w.calls.some((c) => c.startsWith("chain.mandateKill"))).toBe(true);
    expect(t.w.chain.state.killed).toBe(true);
  });
});
