// Audit 2026-10 lead "Redis is a shared trust domain" (Task 7b fix round 1): a Redis writer must not be able to make
// risk kill a book through a forged agent quote, and risk's kill orders are RISK-signed.
import { describe, expect, test } from "bun:test";
import { type KillMsg, KillVerifier, type QuoteMsg, VENUE, signQuote } from "@bookrunner/shared";
import { type Address, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { riskBusAuth } from "../src/adapters/busAuth";
import { BookMonitor } from "../src/monitor";
import type { BookRef, RiskStatePayload } from "../src/types";
import { type World, makeRef, makeWorld, settings, silentLog } from "./fakes";

const CHAIN = 31337;
const CONFIG = "0x00000000000000000000000000000000000c0f19" as Address;
const RISK = privateKeyToAccount(keccak256(toHex("risk-key")));
const DESK = privateKeyToAccount(keccak256(toHex("desk-session-key")));
const WRITER = privateKeyToAccount(keccak256(toHex("redis-writer")));

function setup(o: { keyCheckDown?: () => boolean } = {}) {
  const w = makeWorld();
  const ref = makeRef(1, VENUE.ORDERLY);
  const auth = riskBusAuth({
    chainId: CHAIN,
    config: CONFIG,
    account: RISK,
    isActiveKey: async (_m, key) => {
      if (o.keyCheckDown?.()) throw new Error("rpc down");
      return key.toLowerCase() === DESK.address.toLowerCase();
    },
    now: () => w.clock.t,
  });
  const m = new BookMonitor(ref, { chain: w.chain, store: w.store, bus: w.bus, queue: w.queue, venues: w.venues, clock: w.clock, settings: settings(), log: silentLog, sleep: async () => {}, auth });
  return { w, ref, m };
}

/** A two-sided quote entirely above the oracle (190): a SKEW / one-sided breach when checked. */
function skewedQuote(w: World): QuoteMsg {
  return { bookId: 1, ts: w.clock.t, bid: 190.6, ask: 190.8, size: 10, mid: 190.7, oracle: 190, inventoryUsd: 0, skewBps: 36, widthBps: 10, sides: { bid: true, ask: true } };
}

async function tickWith(t: ReturnType<typeof setup>, quote: (q: QuoteMsg) => Promise<QuoteMsg>) {
  const o = t.w.chain.state.obs.oracle!;
  t.w.chain.state.obs = { ...t.w.chain.state.obs, oracle: { ...o, publishedAt: Math.floor(t.w.clock.t / 1000) } }; // fresh attested price
  t.w.bus.kv.set("quote:1", JSON.stringify(await quote(skewedQuote(t.w))));
  await t.m.tick();
  t.w.clock.t += 2_000;
}

const riskState = (w: World) => JSON.parse(w.bus.kv.get("risk:1") ?? "null") as RiskStatePayload;

describe("forged agent quotes never cause a breach", () => {
  for (const [name, forge] of [
    ["unsigned", async (q: QuoteMsg) => q],
    ["signed by a key that is not an active desk key", async (q: QuoteMsg) => ({ ...q, signature: await signQuote(WRITER, CHAIN, makeRef().components.mandate, q) })],
    ["genuine signature, fields changed", async (q: QuoteMsg) => ({ ...q, signature: await signQuote(DESK, CHAIN, makeRef().components.mandate, { ...q, bid: 189.9, ask: 190.1 }) })],
  ] as const) {
    test(`a skewed quote ${name}, held for 20 ticks: never a breach, never a kill`, async () => {
      const t = setup();
      for (let i = 0; i < 20; i++) await tickWith(t, forge);
      expect(t.w.calls.filter((c) => c === "bus.publishKill" || c.startsWith("chain.mandateKill"))).toEqual([]);
      const s = riskState(t.w);
      expect(s.breaches).toEqual([]);
      expect(s.meta.quoteAuth).toBe(name === "unsigned" ? "unsigned" : "forged");
      expect(s.meta.killed).toBe(false);
    });
  }

  test("an unverifiable quote (RPC down for isActiveKey) is ignored too", async () => {
    const t = setup({ keyCheckDown: () => true });
    for (let i = 0; i < 6; i++) await tickWith(t, async (q) => ({ ...q, signature: await signQuote(DESK, CHAIN, makeRef().components.mandate, q) }));
    expect(riskState(t.w).meta.quoteAuth).toBe("unavailable");
    expect(t.w.calls).not.toContain("bus.publishKill");
  });
});

describe("a quote signed by the active desk key is still checked; the kill is RISK-signed", () => {
  test("SKEW breach -> kill; the kill message and the revoke_key job carry a valid RISK signature", async () => {
    const t = setup();
    const mandate = (t.ref as BookRef).components.mandate;
    for (let i = 0; i < 4; i++) await tickWith(t, async (q) => ({ ...q, signature: await signQuote(DESK, CHAIN, mandate, q) }));
    expect(riskState(t.w).meta.quoteAuth).toBe("ok");
    expect(t.w.calls).toContain("bus.publishKill");
    const kill = t.w.bus.published.find((p) => p.channel === "kill:1")!.msg as KillMsg;
    const v = await new KillVerifier({ chainId: CHAIN, config: CONFIG, isRiskSigner: async (a) => a.toLowerCase() === RISK.address.toLowerCase(), now: () => t.w.clock.t }).verify(JSON.stringify(kill));
    expect(v).toMatchObject({ ok: true, signer: RISK.address });
    const job = [...t.w.queue.jobs.values()].find((j) => j.kind === "revoke_key")!;
    expect(job.kill?.nonce).toBe(kill.nonce); // same episode, same nonce
    const vj = await new KillVerifier({ chainId: CHAIN, config: CONFIG, isRiskSigner: async (a) => a.toLowerCase() === RISK.address.toLowerCase(), now: () => t.w.clock.t }).verify(job.kill);
    expect(vj.ok).toBe(true);
  });
});
