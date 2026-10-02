// Compile-time gate for the devnet dev-wallet signer. Vite replaces import.meta.env.VITE_CHAIN_ID
// with the build's literal, so for a testnet or mainnet build DEV_BUILD is `false` and the bundler
// drops the dynamic import below, and with it the anvil mnemonic and the BIP-39 / BIP-32 code.
import { useEffect, useState } from "react";

export const DEV_BUILD: boolean = import.meta.env.VITE_CHAIN_ID === undefined || import.meta.env.VITE_CHAIN_ID === "" || import.meta.env.VITE_CHAIN_ID === "31337";

export type DevSigner = typeof import("../lib/devsigner");

let loading: Promise<DevSigner> | null = null;

/** The dev signer module (devnet builds only; null elsewhere). */
export function loadDevSigner(): Promise<DevSigner> | null {
  if (!DEV_BUILD) return null;
  loading ??= import("../lib/devsigner");
  return loading;
}

/** The dev signer once loaded, while `enabled` (null otherwise). */
export function useDevSigner(enabled: boolean): DevSigner | null {
  const [mod, setMod] = useState<DevSigner | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadDevSigner()?.then((m) => {
      if (alive) setMod(m);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return enabled ? mod : null;
}
