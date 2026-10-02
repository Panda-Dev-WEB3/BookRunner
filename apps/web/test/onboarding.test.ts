import { describe, expect, test } from "bun:test";
import { MIN_GAS_WEI, ONBOARDING_ORDER, type OnboardingInput, deriveOnboarding } from "../src/lib/onboarding";

const APP = 46630;
const base: OnboardingInput = { connected: false, walletKind: null, walletChainId: null, appChainId: APP, ethWei: undefined, usdcRaw: undefined };
const statuses = (i: OnboardingInput) => deriveOnboarding(i).steps.map((s) => s.status);

describe("setup checklist state", () => {
  test("disconnected: connect is the only active step, nothing is checking", () => {
    const s = deriveOnboarding(base);
    expect(s.steps.map((x) => x.id)).toEqual([...ONBOARDING_ORDER]);
    expect(statuses(base)).toEqual(["active", "todo", "todo", "todo", "todo"]);
    expect(s.current).toBe("connect");
    expect(s.ready).toBe(false);
    expect(s.doneCount).toBe(0);
    expect(s.steps.every((x) => !x.checking)).toBe(true);
  });

  test("connected on another chain: network is active, balances still load", () => {
    const i = { ...base, connected: true, walletKind: "injected" as const, walletChainId: 1 };
    const s = deriveOnboarding(i);
    expect(statuses(i)).toEqual(["done", "active", "todo", "todo", "todo"]);
    expect(s.current).toBe("network");
    expect(s.steps.find((x) => x.id === "gas")?.checking).toBe(true);
    expect(s.steps.find((x) => x.id === "usdc")?.checking).toBe(true);
  });

  test("unknown wallet chain counts as not on the app chain", () => {
    expect(deriveOnboarding({ ...base, connected: true, walletKind: "injected", walletChainId: null }).current).toBe("network");
  });

  test("dev wallets satisfy the network step on their own", () => {
    const i = { ...base, connected: true, walletKind: "dev" as const, walletChainId: null, ethWei: 0n, usdcRaw: 0n };
    expect(statuses(i)).toEqual(["done", "done", "active", "todo", "todo"]);
  });

  test("gas below the threshold keeps the gas step active; at the threshold it is done", () => {
    const on = { ...base, connected: true, walletKind: "injected" as const, walletChainId: APP, usdcRaw: 0n };
    expect(deriveOnboarding({ ...on, ethWei: MIN_GAS_WEI - 1n }).current).toBe("gas");
    expect(deriveOnboarding({ ...on, ethWei: MIN_GAS_WEI }).current).toBe("usdc");
    // unreadable is not done, but it is unknown rather than "unfunded"
    const unread = deriveOnboarding({ ...on, ethWei: null });
    expect(unread.current).toBe("gas");
    expect(unread.steps.find((s) => s.id === "gas")).toMatchObject({ checking: false, unreadable: true });
    expect(unread.unsure).toBe(true);
  });

  test("a funded wallet is ready and the invest step becomes active", () => {
    const i = { ...base, connected: true, walletKind: "injected" as const, walletChainId: APP, ethWei: 10n ** 16n, usdcRaw: 10_000_000_000n };
    const s = deriveOnboarding(i);
    expect(statuses(i)).toEqual(["done", "done", "done", "done", "active"]);
    expect(s.ready).toBe(true);
    expect(s.current).toBe("invest");
    expect(s.progress).toBeCloseTo(0.8);
  });

  test("a USDC balance that could not be read is unknown, never 'mint test USDC' for a funded wallet", () => {
    const funded = { ...base, connected: true, walletKind: "injected" as const, walletChainId: APP, ethWei: 10n ** 16n };
    const s = deriveOnboarding({ ...funded, usdcRaw: null });
    expect(s.ready).toBe(false);
    expect(s.unsure).toBe(true); // the deposit flow then says it is retrying instead of showing the setup steps
    expect(s.steps.find((x) => x.id === "usdc")).toMatchObject({ status: "active", unreadable: true });
    const ok = deriveOnboarding({ ...funded, usdcRaw: 10_000_000_000n });
    expect(ok).toMatchObject({ ready: true, unsure: false });
    // loading is "checking", also unsure
    expect(deriveOnboarding({ ...funded, usdcRaw: undefined }).unsure).toBe(true);
    // disconnected: nothing is unsure
    expect(deriveOnboarding(base).unsure).toBe(false);
  });

  test("steps done out of order stay done; the first open step is the active one", () => {
    // funded on the app chain earlier, wallet now on another chain
    const i = { ...base, connected: true, walletKind: "injected" as const, walletChainId: 1, ethWei: 10n ** 16n, usdcRaw: 5n };
    expect(statuses(i)).toEqual(["done", "active", "done", "done", "todo"]);
    expect(deriveOnboarding(i).ready).toBe(false);
  });

  test("the invest step is never active before the wallet is ready", () => {
    const i = { ...base, connected: true, walletKind: "injected" as const, walletChainId: APP, ethWei: 10n ** 16n, usdcRaw: undefined };
    expect(statuses(i)).toEqual(["done", "done", "done", "active", "todo"]);
  });

  test("a custom USDC minimum is respected", () => {
    const i = { ...base, connected: true, walletKind: "injected" as const, walletChainId: APP, ethWei: 10n ** 16n, usdcRaw: 99n, minUsdcRaw: 100n };
    expect(deriveOnboarding(i).current).toBe("usdc");
  });
});
