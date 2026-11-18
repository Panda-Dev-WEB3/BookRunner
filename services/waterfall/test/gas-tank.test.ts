// 2026-11 GasTank keeper duty: planTankPass mirrors GasTank.topUpQuote's reason codes; GasTankRunner sends topUp only for
// the wallets the tank would pay, cools a failed wallet down, never throws, and does nothing without a tank.
import { describe, expect, test } from "bun:test";
import { createLogger } from "@bookrunner/shared";
import type { Hex } from "viem";
import { Cooldowns, GasTankRunner, type GasTankChain, type TankSnapshot, planTankPass } from "../src/index";
import { fakeHash } from "./fakes";

const log = createLogger("gas-tank-test", "silent");
const TANK = "0x00000000000000000000000000000000000000a1" as const;
const A = "0x00000000000000000000000000000000000000b1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const C = "0x00000000000000000000000000000000000000b3" as const;
const ETH = 10n ** 18n;

const snap = (o: Partial<TankSnapshot> = {}): TankSnapshot => ({
  tank: TANK,
  paused: false,
  balanceWei: ETH,
  services: [
    { service: A, amountWei: ETH / 100n, reason: 0 },
    { service: B, amountWei: 0n, reason: 2 },
    { service: C, amountWei: 0n, reason: 3 },
  ],
  ...o,
});

describe("planTankPass", () => {
  test("tops up what the tank would pay; a wallet above its floor needs nothing; a used cap is reported", () => {
    expect(planTankPass(snap())).toEqual([
      { kind: "topup", service: A, amountWei: ETH / 100n },
      { kind: "capped", service: C, scope: "service" },
    ]);
  });

  test("global cap, paused tank, empty tank, unlisted wallet", () => {
    const s = (reason: 1 | 4, o: Partial<TankSnapshot> = {}) => snap({ services: [{ service: A, amountWei: 0n, reason }], ...o });
    expect(planTankPass(s(4))).toEqual([{ kind: "capped", service: A, scope: "global" }]);
    expect(planTankPass(s(1, { paused: true }))).toEqual([{ kind: "blocked", service: A, why: "paused" }]);
    expect(planTankPass(s(1, { balanceWei: 0n }))).toEqual([{ kind: "blocked", service: A, why: "empty" }]);
    expect(planTankPass(s(1))).toEqual([{ kind: "blocked", service: A, why: "unlisted" }]);
  });
});

class FakeTank implements GasTankChain {
  state: TankSnapshot | null = snap();
  sent: string[] = [];
  failFor = new Set<string>();
  failRead = false;
  async gasTankState() {
    if (this.failRead) throw new Error("rpc down");
    return this.state;
  }
  async topUp(service: `0x${string}`): Promise<Hex> {
    if (this.failFor.has(service)) throw new Error("execution reverted: AboveFloor");
    this.sent.push(service);
    return fakeHash();
  }
}

describe("GasTankRunner", () => {
  test("sends topUp for the wallets the tank would pay and for no other", async () => {
    const chain = new FakeTank();
    chain.state = snap({
      services: [
        { service: A, amountWei: ETH / 100n, reason: 0 },
        { service: B, amountWei: 0n, reason: 2 },
        { service: C, amountWei: ETH / 200n, reason: 0 },
      ],
    });
    const r = await new GasTankRunner({ chain, cooldowns: new Cooldowns(), cooldownMs: 1000, log }).tick();
    expect(chain.sent).toEqual([A, C]);
    expect(r.toppedUp.map((t) => t.service)).toEqual([A, C]);
    expect(r.error).toBeUndefined();
  });

  test("no tank in the deployment, or nothing below a floor: no transaction", async () => {
    const chain = new FakeTank();
    chain.state = null;
    expect((await new GasTankRunner({ chain, cooldowns: new Cooldowns(), cooldownMs: 1000, log }).tick()).toppedUp).toEqual([]);
    chain.state = snap({ services: [{ service: B, amountWei: 0n, reason: 2 }] });
    await new GasTankRunner({ chain, cooldowns: new Cooldowns(), cooldownMs: 1000, log }).tick();
    expect(chain.sent).toEqual([]);
  });

  test("a failed topUp cools that wallet down (others still go), then retries", async () => {
    const chain = new FakeTank();
    chain.state = snap({
      services: [
        { service: A, amountWei: ETH / 100n, reason: 0 },
        { service: C, amountWei: ETH / 100n, reason: 0 },
      ],
    });
    chain.failFor.add(A);
    let now = 0;
    const runner = new GasTankRunner({ chain, cooldowns: new Cooldowns(() => now), cooldownMs: 1000, log, now: () => now });
    const first = await runner.tick();
    expect(first.error).toContain("AboveFloor");
    expect(chain.sent).toEqual([C]);
    chain.failFor.clear();
    await runner.tick(); // A is cooling down
    expect(chain.sent).toEqual([C, C]);
    now += 1000;
    await runner.tick();
    expect(chain.sent).toContain(A);
  });

  test("a failed read never throws and cools the whole duty down", async () => {
    const chain = new FakeTank();
    chain.failRead = true;
    let now = 0;
    const runner = new GasTankRunner({ chain, cooldowns: new Cooldowns(() => now), cooldownMs: 1000, log });
    expect((await runner.tick()).error).toBe("rpc down");
    chain.failRead = false;
    expect((await runner.tick()).actions).toEqual([]); // cooling down: no read
    now += 1000;
    expect((await runner.tick()).toppedUp).toHaveLength(1);
  });

  test("maxPerPass bounds the transactions of one pass", async () => {
    const chain = new FakeTank();
    chain.state = snap({
      services: [
        { service: A, amountWei: 1n, reason: 0 },
        { service: B, amountWei: 1n, reason: 0 },
        { service: C, amountWei: 1n, reason: 0 },
      ],
    });
    await new GasTankRunner({ chain, cooldowns: new Cooldowns(), cooldownMs: 1000, log, maxPerPass: 2 }).tick();
    expect(chain.sent).toEqual([A, B]);
  });
});
