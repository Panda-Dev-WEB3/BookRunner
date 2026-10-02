import type { DevRole } from "@bookrunner/shared/devkeys";
import { useEffect, useState } from "react";
import { DEV_WALLETS, devAddress, devRoleOf } from "../lib/devwallet";

/** The dev role whose anvil account is `address` (derives the role list lazily, devnet only). */
export function useDevRoleFor(address: string | null | undefined, enabled: boolean): DevRole | null {
  const [role, setRole] = useState<DevRole | null>(() => devRoleOf(address));
  useEffect(() => {
    if (!enabled || !address) {
      setRole(null);
      return;
    }
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
  }, [address, enabled]);
  return role;
}
