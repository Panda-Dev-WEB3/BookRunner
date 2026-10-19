import { describe, expect, test } from "bun:test";
import { type Address, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FORGED_WINDOW_SEC, ForgedLog, KILL_MAX_AGE_SEC, KillVerifier, RiskStateVerifier, cachedAddressCheck, killNonce, recoverQuoteSigner, signKill, signQuote, signRiskState } from "../src/busAuth";
import type { QuoteMsg } from "../src/queues";

const CHAIN = 31337;
const CONFIG = "0x00000000000000000000000000000000000c0f19" as Address;
const MANDATE = "0x00000000000000000000000000000000000a0a02" as Address;
const RISK = privateKeyToAccount(keccak256(toHex("risk")));
const OTHER = privateKeyToAccount(keccak256(toHex("other")));
const T = 1_800_000_000;

function verifier(o: { down?: () => boolean; nowSec?: () => number } = {}) {
  let calls = 0;
  const v = new KillVerifier({
    chainId: CHAIN,
    config: CONFIG,
    now: () => (o.nowSec?.() ?? T) * 1000,
    isRiskSigner: async (a) => {
      calls++;
      if (o.down?.()) throw new Error("rpc down");
      return a.toLowerCase() === RISK.address.toLowerCase();
    },
  });
  return { v, calls: () => calls };
}
const kill = (who = RISK, over: { issuedAt?: number; ep?: string; bookId?: number } = {}) =>
  signKill(who, CHAIN, CONFIG, { bookId: over.bookId ?? 3, reason: "DRAWDOWN", breaches: ["DRAWDOWN"], issuedAt: over.issuedAt ?? T, nonce: killNonce(over.bookId ?? 3, over.ep ?? "e1") });

describe("KillVerifier (RISK-signed kill orders)", () => {
  test("a RISK-signed order verifies once; a replay of its nonce is refused (not a forgery)", async () => {
    const { v } = verifier();
    const k = await kill();
    expect(await v.verify(JSON.stringify(k))).toMatchObject({ ok: true, signer: RISK.address, msg: { bookId: 3, reason: "DRAWDOWN", issuedAt: T } });
    expect(await v.verify(k)).toMatchObject({ ok: false, forged: false, replay: true });
  });

  test("unsigned, non-RISK, tampered, re-targeted, other-domain and future orders are forged; stale ones are refused", async () => {
    const { v } = verifier();
    const k = await kill();
    const cases: unknown[] = [
      { bookId: 3, ts: 1, reason: "X", breaches: [] },
      await kill(OTHER),
      { ...k, reason: "OTHER" },
      { ...k, bookId: 4 },
      await signKill(RISK, 1, CONFIG, { bookId: 3, reason: "DRAWDOWN", breaches: [], issuedAt: T, nonce: killNonce(3, "x") }),
      await kill(RISK, { issuedAt: T + 3_600, ep: "future" }),
      "garbage",
      { ...k, signature: "0x1234" },
    ];
    for (const c of cases) expect((await v.verify(c)) as { forged?: boolean }).toMatchObject({ ok: false, forged: true });
    expect(await v.verify(await kill(RISK, { issuedAt: T - KILL_MAX_AGE_SEC - 1, ep: "old" }))).toMatchObject({ ok: false, forged: false, replay: true });
  });

  test("an unavailable role check is reported (never cached as a no) and the nonce is not consumed", async () => {
    let down = true;
    const t = verifier({ down: () => down });
    const k = await kill();
    expect(await t.v.verify(k)).toMatchObject({ ok: false, unavailable: true, forged: false });
    down = false;
    expect(await t.v.verify(k)).toMatchObject({ ok: true });
  });
});

describe("agent quote signatures", () => {
  const q: QuoteMsg = { bookId: 3, ts: T * 1000, bid: 189.91, ask: 190.09, size: 12.5, mid: 190, oracle: 190, inventoryUsd: 0, skewBps: 0, widthBps: 9.5, sides: { bid: true, ask: true } };
  test("recovers the desk key over the signed fields only; any change is another signer", async () => {
    const sig = await signQuote(OTHER, CHAIN, MANDATE, q);
    expect(await recoverQuoteSigner(CHAIN, MANDATE, { ...q, signature: sig })).toBe(OTHER.address);
    const unsignedChanged: QuoteMsg = { ...q, mid: 1, oracle: 1, signature: sig };
    expect(await recoverQuoteSigner(CHAIN, MANDATE, unsignedChanged)).toBe(OTHER.address); // unsigned fields
    expect(await recoverQuoteSigner(CHAIN, MANDATE, { ...q, bid: 190.5, signature: sig })).not.toBe(OTHER.address);
    expect(await recoverQuoteSigner(CHAIN, "0x00000000000000000000000000000000000a0a03", { ...q, signature: sig })).not.toBe(OTHER.address); // another book's mandate
    expect(await recoverQuoteSigner(CHAIN, MANDATE, q)).toBeNull();
    // the JSON round trip (Redis) keeps the signature valid
    const back = JSON.parse(JSON.stringify({ ...q, signature: sig })) as QuoteMsg;
    expect(await recoverQuoteSigner(CHAIN, MANDATE, back)).toBe(OTHER.address);
  });
});

describe("cachedAddressCheck and ForgedLog", () => {
  test("cache: 60 s, errors not cached, pinned list without RPC", async () => {
    let now = 0;
    let reads = 0;
    let fail = true;
    const c = cachedAddressCheck({ now: () => now, onChain: async () => (reads++, fail ? Promise.reject(new Error("x")) : true) });
    await expect(c(RISK.address)).rejects.toThrow("x");
    fail = false;
    expect(await c(RISK.address)).toBe(true);
    expect(await c(RISK.address)).toBe(true);
    expect(reads).toBe(2);
    now += 60_001;
    await c(RISK.address);
    expect(reads).toBe(3);
    const pinned = cachedAddressCheck({ pinned: RISK.address, onChain: async () => Promise.reject(new Error("no rpc")) });
    expect(await pinned(RISK.address)).toBe(true);
    expect(await pinned(OTHER.address)).toBe(false);
  });

  test("ForgedLog keeps the last hour and publishes it", async () => {
    let now = 0;
    const writes: unknown[] = [];
    const f = new ForgedLog("agent-3", async (m) => void writes.push(m), () => now);
    f.note("kill", "a");
    now += FORGED_WINDOW_SEC * 1000;
    f.note("kill", "b");
    expect(f.recent().map((e) => e.reason)).toEqual(["b"]);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ v: 1, source: "agent-3", events: [{ reason: "b", kind: "kill" }] });
  });
});

describe("RiskStateVerifier (RISK-signed risk state)", () => {
  const state = async (s: "ok" | "killed", tsMs: number, who = RISK, bookId = 3) => ({ state: s, stateSig: { tsMs, signature: await signRiskState(who, CHAIN, CONFIG, { bookId, state: s, tsMs }) } });
  test("valid once per tsMs (monotonic); unsigned, non-RISK, other-book and changed-state ones are forged; old ones stale", async () => {
    let now = T * 1000;
    const v = new RiskStateVerifier({ chainId: CHAIN, config: CONFIG, bookId: 3, isRiskSigner: async (a) => a.toLowerCase() === RISK.address.toLowerCase(), now: () => now });
    const ok = await state("ok", now);
    expect(await v.verify(JSON.stringify(ok))).toEqual({ ok: true, state: "ok", tsMs: now });
    expect(await v.verify(ok)).toMatchObject({ ok: false, replay: true, forged: false });
    now += 2_000;
    for (const bad of [{ state: "killed" }, await state("killed", now, OTHER), await state("killed", now, RISK, 4), { ...(await state("ok", now)), state: "killed" }]) {
      expect(await v.verify(bad)).toMatchObject({ ok: false, forged: true });
    }
    expect(await v.verify(await state("killed", now - 61_000))).toMatchObject({ ok: false, forged: false, replay: true });
    expect(await v.verify(await state("killed", now))).toMatchObject({ ok: true, state: "killed" });
  });
});
