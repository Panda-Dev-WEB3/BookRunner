// Storage that never throws (lib/safeStorage.ts), and the wagmi config built on it: Chrome's
// window.localStorage getter throws SecurityError when site data is blocked, and wagmi's default
// storage reads it unguarded inside createConfig (module scope in wallet/chains.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { defineChain, http } from "viem";
import { createConfig, createStorage } from "wagmi";
import { memoryStorage, safeLocalStorage } from "../src/lib/safeStorage";

const blocked = () => {
  const w = {};
  Object.defineProperty(w, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    },
  });
  return w as { localStorage?: never };
};

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

const chain = defineChain({ id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } });
const g = globalThis as { window?: unknown };
const hadWindow = "window" in g;
const savedWindow = g.window;

afterEach(() => {
  if (hadWindow) g.window = savedWindow;
  else delete g.window;
});

describe("safeLocalStorage", () => {
  test("falls back to memory when reading window.localStorage throws or it is missing", () => {
    for (const w of [blocked(), {}, undefined]) {
      const s = safeLocalStorage(w);
      expect(s.getItem("k")).toBeNull();
      s.setItem("k", "v");
      expect(s.getItem("k")).toBe("v");
      s.removeItem("k");
      expect(s.getItem("k")).toBeNull();
    }
  });

  test("a call that throws never escapes; the value is kept in memory instead", () => {
    const s = safeLocalStorage({ localStorage: throwing });
    expect(() => s.setItem("a", "1")).not.toThrow();
    expect(s.getItem("a")).toBe("1");
    expect(() => s.removeItem("a")).not.toThrow();
    expect(s.getItem("a")).toBeNull();
  });

  test("uses the real storage when it works", () => {
    const real = memoryStorage();
    const s = safeLocalStorage({ localStorage: real });
    s.setItem("bkrn.wallet", "{}");
    expect(real.getItem("bkrn.wallet")).toBe("{}");
    real.setItem("x", "y");
    expect(s.getItem("x")).toBe("y");
  });
});

describe("wagmi config with blocked site data", () => {
  const build = (storage?: ReturnType<typeof createStorage>) =>
    createConfig({ chains: [chain], connectors: [], multiInjectedProviderDiscovery: false, transports: { [chain.id]: http() }, ...(storage ? { storage } : {}) });

  test("wagmi's default storage throws at createConfig (the blank-page bug)", () => {
    g.window = blocked();
    expect(() => build()).toThrow();
  });

  test("the app's storage (as in wallet/chains.ts) does not", () => {
    g.window = blocked();
    expect(() => build(createStorage({ storage: safeLocalStorage() }))).not.toThrow();
  });
});
