// Wallet connection decisions (wallet/connectFlow.ts) against wagmi's real injected connector and a
// fake EIP-1193 wallet: a declined network switch must leave a connected wallet on the wrong
// network (with wagmi's change listener attached), never a failed connect.
import { afterEach, describe, expect, test } from "bun:test";
import { defineChain, http, numberToHex } from "viem";
import { createConfig, createStorage, injected } from "wagmi";
import { connect, disconnect, getConnection, getConnections } from "wagmi/actions";
import { memoryStorage } from "../src/lib/safeStorage";
import { connectWallet, disconnectAll } from "../src/wallet/connectFlow";

const APP = 46630;
const app = defineChain({ id: APP, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } });
const A = "0x000000000000000000000000000000000000dEaD";

type Listener = (...args: unknown[]) => void;

/** A browser wallet sitting on `chainId`; `decline` rejects the matching prompts with 4001. */
function fakeWallet(opts: { chainId: number; account?: string; decline?: { switch?: boolean; connect?: boolean } }) {
  let chainId = opts.chainId;
  const account = opts.account ?? A;
  const listeners = new Map<string, Set<Listener>>();
  const calls: string[] = [];
  const reject = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
  const emit = (ev: string, ...args: unknown[]) => {
    for (const fn of listeners.get(ev) ?? []) fn(...args);
  };
  let known = new Set([opts.chainId]);
  return {
    calls,
    emit,
    get chainId() {
      return chainId;
    },
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push(method);
      switch (method) {
        case "wallet_requestPermissions":
          if (opts.decline?.connect) throw reject();
          return [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: [account] }] }];
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account];
        case "eth_chainId":
          return numberToHex(chainId);
        case "wallet_switchEthereumChain": {
          if (opts.decline?.switch) throw reject();
          const id = Number((params?.[0] as { chainId: string }).chainId);
          if (!known.has(id)) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
          chainId = id;
          emit("chainChanged", numberToHex(id));
          return null;
        }
        case "wallet_addEthereumChain": {
          // like MetaMask: adding a network also switches to it
          const id = Number((params?.[0] as { chainId: string }).chainId);
          known = new Set([...known, id]);
          chainId = id;
          emit("chainChanged", numberToHex(id));
          return null;
        }
        default:
          throw new Error(`unsupported ${method}`);
      }
    },
    on(ev: string, fn: Listener) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)?.add(fn);
    },
    removeListener(ev: string, fn: Listener) {
      listeners.get(ev)?.delete(fn);
    },
  };
}

const g = globalThis as { window?: unknown };
const had = "window" in g;
const saved = g.window;
afterEach(() => {
  if (had) g.window = saved;
  else delete g.window;
});

function setup(wallet: ReturnType<typeof fakeWallet>) {
  g.window = { ethereum: wallet };
  const config = createConfig({
    chains: [app],
    connectors: [injected({ shimDisconnect: true })],
    multiInjectedProviderDiscovery: false,
    storage: createStorage({ storage: memoryStorage() }),
    transports: { [APP]: http() },
  });
  const connector = config.connectors[0];
  if (!connector) throw new Error("no connector");
  return { config, connector };
}

const target = { chainId: APP, addChain: { chainName: app.name, nativeCurrency: app.nativeCurrency, rpcUrls: ["http://127.0.0.1:1"] } };

describe("connectWallet", () => {
  test("old flow: connect({ chainId }) turns a declined switch into a failed connect (the bug)", async () => {
    const w = fakeWallet({ chainId: 1, decline: { switch: true } });
    const { config, connector } = setup(w);
    await expect(connect(config, { connector, chainId: APP })).rejects.toThrow();
    expect(getConnection(config).isConnected).toBe(false);
    expect(w.calls).toContain("wallet_requestPermissions"); // yet the wallet granted the account
  });

  test("a declined switch leaves the wallet connected on its own chain, with the decline as a network error", async () => {
    const w = fakeWallet({ chainId: 1, decline: { switch: true } });
    const { config, connector } = setup(w);
    const r = await connectWallet(config, connector, target);
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect((r.switchError as { code?: number } | null)?.code).toBe(4001);
    expect(getConnection(config)).toMatchObject({ isConnected: true, chainId: 1, address: A });
    // wagmi's change handler is attached: switching in the wallet later clears the wrong network
    w.emit("chainChanged", numberToHex(APP));
    expect(getConnection(config).chainId).toBe(APP);
  });

  test("an accepted switch (adding the chain when the wallet lacks it) ends on the app chain", async () => {
    const w = fakeWallet({ chainId: 1 });
    const { config, connector } = setup(w);
    const r = await connectWallet(config, connector, target);
    expect(r).toEqual({ ok: true, error: null, switchError: null });
    expect(w.calls).toContain("wallet_addEthereumChain");
    expect(getConnection(config).chainId).toBe(APP);
  });

  test("already on the app chain: no switch prompt", async () => {
    const w = fakeWallet({ chainId: APP });
    const { config, connector } = setup(w);
    expect(await connectWallet(config, connector, target)).toEqual({ ok: true, error: null, switchError: null });
    expect(w.calls).not.toContain("wallet_switchEthereumChain");
  });

  test("a declined connection is a failure", async () => {
    const w = fakeWallet({ chainId: APP, decline: { connect: true } });
    const { config, connector } = setup(w);
    const r = await connectWallet(config, connector, target);
    expect(r.ok).toBe(false);
    expect(r.error).not.toBeNull();
    expect(getConnection(config).isConnected).toBe(false);
  });
});

const B = "0x000000000000000000000000000000000000bEEF";

/** Two EIP-6963-style wallets, each its own injected connector. */
function setupTwo(a: ReturnType<typeof fakeWallet>, b: ReturnType<typeof fakeWallet>) {
  g.window = { walletA: a, walletB: b };
  const target = (id: string, key: "walletA" | "walletB") => ({ id, name: id, provider: (w?: unknown) => (w as Record<string, never> | undefined)?.[key] });
  const config = createConfig({
    chains: [app],
    connectors: [injected({ shimDisconnect: true, target: target("Wallet A", "walletA") }), injected({ shimDisconnect: true, target: target("Wallet B", "walletB") })],
    multiInjectedProviderDiscovery: false,
    storage: createStorage({ storage: memoryStorage() }),
    transports: { [APP]: http() },
  });
  const [ca, cb] = config.connectors;
  if (!ca || !cb) throw new Error("no connectors");
  return { config, ca, cb };
}

describe("two wallets: Change, then Disconnect", () => {
  test("old flow: wagmi's disconnect() drops only the current wallet and switches over to the first (the bug)", async () => {
    const { config, ca, cb } = setupTwo(fakeWallet({ chainId: APP, account: A }), fakeWallet({ chainId: APP, account: B }));
    await connect(config, { connector: ca });
    await connect(config, { connector: cb });
    expect(getConnection(config).address).toBe(B);
    await disconnect(config);
    expect(getConnection(config)).toMatchObject({ isConnected: true, address: A });
  });

  test("connectWallet keeps one connection, and disconnectAll leaves none", async () => {
    const { config, ca, cb } = setupTwo(fakeWallet({ chainId: APP, account: A }), fakeWallet({ chainId: APP, account: B }));
    expect((await connectWallet(config, ca, target)).ok).toBe(true);
    expect((await connectWallet(config, cb, target)).ok).toBe(true); // 'Change' to the second wallet
    expect(getConnections(config).map((c) => c.connector.uid)).toEqual([cb.uid]);
    expect(getConnection(config).address).toBe(B);
    await disconnectAll(config);
    expect(getConnections(config)).toEqual([]);
    expect(getConnection(config).isConnected).toBe(false);
  });

  test("a decline in the second wallet is a failure, even while the first stays connected", async () => {
    const { config, ca, cb } = setupTwo(fakeWallet({ chainId: APP, account: A }), fakeWallet({ chainId: APP, account: B, decline: { connect: true } }));
    await connectWallet(config, ca, target);
    const r = await connectWallet(config, cb, target);
    expect(r.ok).toBe(false);
    expect(getConnection(config).address).toBe(A);
  });

  test("asking for the wallet that is already current is a success", async () => {
    const { config, ca } = setupTwo(fakeWallet({ chainId: APP, account: A }), fakeWallet({ chainId: APP, account: B }));
    await connectWallet(config, ca, target);
    expect(await connectWallet(config, ca, target)).toEqual({ ok: true, error: null, switchError: null });
  });
});
