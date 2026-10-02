import type { DevRole } from "@bookrunner/shared/devkeys";
import { useEffect, useState } from "react";
import { DEV_WALLETS } from "../lib/devwallet";
import { useDevSigner } from "./devGate";

/** The dev role whose anvil account is `address` (derives the role list lazily, devnet only). */
export function useDevRoleFor(address: string | null | undefined, enabled: boolean): DevRole | null {
  const dev = useDevSigner(enabled);
  const [role, setRole] = useState<DevRole | null>(null);
  useEffect(() => {
    if (!enabled || !address || !dev) {
      setRole(null);
      return;
    }
    const { devAddress, devRoleOf } = dev;
    const known = devRoleOf(address);
    if (known) {
      setRole(known);
      return;
    }
    let cancelled = false;
    (async () => {
      for (const w of DEV_WALLETS) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 0));
        if (devAddress(w.role).toLowerCase() === address.toLowerCase()) {
          if (!cancelled) setRole(w.role);
          return;
        }
      }
      if (!cancelled) setRole(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [address, enabled, dev]);
  return role;
}
