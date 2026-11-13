// Guarded launch (VITE_GUARDED_LAUNCH): the deposit gate, the banner copy and storage, and where the app uses them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkCopy } from "@bookrunner/shared/copy";
import { BANNER_DISMISSED_KEY, GUARDED_COPY, OFFICIAL_LINKS_URL, investGate } from "../src/lib/guardedLaunch";
import { safeSessionStorage } from "../src/lib/safeStorage";

const WEB = resolve(import.meta.dir, "..");
const src = (p: string) => readFileSync(resolve(WEB, p), "utf8");

describe("investGate", () => {
  test("outside a guarded launch deposits are never gated (each book's window decides)", () => {
    expect(investGate(false, undefined)).toEqual({ status: "open" });
    expect(investGate(false, [])).toEqual({ status: "open" });
    expect(investGate(false, ["Retired"])).toEqual({ status: "open" });
  });

  test("guarded: closed while no book is in Subscription or Live; loading until the list answers", () => {
    expect(investGate(true, undefined)).toEqual({ status: "loading" });
    expect(investGate(true, [])).toEqual({ status: "closed" });
    expect(investGate(true, ["Cancelled", "Retiring", "Retired"])).toEqual({ status: "closed" });
    expect(investGate(true, ["Retired", "Subscription"])).toEqual({ status: "open" });
    expect(investGate(true, ["Live"])).toEqual({ status: "open" });
  });
});

describe("copy and storage", () => {
  test("the banner and gate copy pass the copy rules and say exits stay open", () => {
    for (const line of Object.values(GUARDED_COPY)) expect(checkCopy(line)).toEqual([]);
    expect(GUARDED_COPY.gateBody).toContain("Withdrawals and claims are never blocked");
    expect(GUARDED_COPY.banner).toContain("no public market is open yet");
    expect(OFFICIAL_LINKS_URL).toBe("/official-links/");
  });

  test("dismissal lives in sessionStorage (per browser session), and a blocked storage never throws", () => {
    const store = new Map<string, string>();
    const session = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const s = safeSessionStorage({ sessionStorage: session, localStorage: null });
    s.setItem(BANNER_DISMISSED_KEY, "1");
    expect(store.get(BANNER_DISMISSED_KEY)).toBe("1");
    const blocked = {};
    Object.defineProperty(blocked, "sessionStorage", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const b = safeSessionStorage(blocked as never);
    b.setItem(BANNER_DISMISSED_KEY, "1");
    expect(b.getItem(BANNER_DISMISSED_KEY)).toBe("1"); // remembered in memory for this page only
  });
});

describe("wiring", () => {
  test("mainnet builds turn it on; testnet builds do not", () => {
    expect(src(".env.mainnet")).toMatch(/^VITE_GUARDED_LAUNCH=true$/m);
    expect(src(".env.testnet")).not.toContain("VITE_GUARDED_LAUNCH=true");
    expect(src("src/lib/features.ts")).toContain('String(import.meta.env.VITE_GUARDED_LAUNCH ?? "false") === "true"');
  });

  test("the banner sits under the header; the footer links the official-links page", () => {
    const layout = src("src/components/Layout.tsx");
    expect(layout.indexOf("<GuardedLaunchBanner />")).toBeGreaterThan(layout.indexOf("<Header />"));
    expect(layout).toContain('{ label: "Official links", href: OFFICIAL_LINKS_URL, sameTab: true }');
  });

  test("the Invest page and the book's deposit flow honour the gate; the Withdraw tab does not use it", () => {
    const invest = src("src/pages/Invest.tsx");
    expect(invest).toContain("useInvestGate()");
    expect(invest).toContain("depositsClosed={gate.status !== \"open\"}");
    const panel = src("src/pages/book/InvestPanel.tsx");
    expect(panel).toContain('const effectiveStep: FlowStep = depositsClosed ? "tranche"');
    expect(panel).toContain('windows[tranche].status === "open" && !depositsClosed');
    expect(src("src/components/invest/WithdrawPanel.tsx")).not.toContain("useInvestGate");
    // the trading page keeps its own empty state
    expect(src("src/pages/Trade.tsx")).toContain("No market open yet");
  });
});
