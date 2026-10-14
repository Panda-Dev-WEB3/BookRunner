// Page side of the demo wallet (added with page.addInitScript by wallet-node.mjs installDemoWallet): an EIP-1193
// provider announced through EIP-6963 as "Demo wallet". It holds no key: every request goes to Node through
// window.__demoWalletRequest (page.exposeFunction), which answers { result, events } or { error }.
(() => {
  if (window.__demoWalletProvider) return;
  const listeners = new Map();
  const emit = (event, payload) => {
    for (const fn of [...(listeners.get(event) ?? [])]) {
      try {
        fn(payload);
      } catch (e) {
        console.error("demo wallet listener", e);
      }
    }
  };
  const off = (event, fn) => {
    listeners.get(event)?.delete(fn);
    return provider;
  };
  const provider = {
    isDemoWallet: true,
    async request(args) {
      if (!args || typeof args.method !== "string") throw Object.assign(new Error("invalid request"), { code: -32600 });
      if (typeof window.__demoWalletRequest !== "function") throw Object.assign(new Error("demo wallet is not attached"), { code: 4900 });
      const res = await window.__demoWalletRequest({ method: args.method, params: Array.isArray(args.params) ? args.params : [] });
      if (res && res.error) {
        const err = new Error(res.error.message);
        err.code = res.error.code;
        if (res.error.data !== undefined) err.data = res.error.data;
        throw err;
      }
      // events after the caller has its result, as an extension would deliver them
      for (const [event, payload] of res?.events ?? []) setTimeout(() => emit(event, payload), 0);
      return res ? res.result : null;
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return provider;
    },
    once(event, fn) {
      const wrap = (p) => {
        off(event, wrap);
        fn(p);
      };
      return provider.on(event, wrap);
    },
    removeListener: off,
    off,
  };
  Object.defineProperty(window, "__demoWalletProvider", { value: provider });

  const icon =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1f6feb"/>' +
        '<rect x="7" y="10" width="18" height="13" rx="3" fill="none" stroke="#fff" stroke-width="2"/>' +
        '<circle cx="21" cy="16.5" r="1.6" fill="#fff"/></svg>',
    );
  const info = Object.freeze({ uuid: "6f1c2a8e-3b5d-4e7f-9a10-d3e0b0c0de01", name: "Demo wallet", icon, rdns: "tech.bookrunner.demo" });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  if (!window.ethereum) {
    try {
      Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: true });
    } catch {
      // another script owns window.ethereum: EIP-6963 is enough for the app
    }
  }
})();
