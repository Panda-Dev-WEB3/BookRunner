// Wallet menu: injected browser wallet, plus (devnet only) the dev wallet picker over anvil roles.
import type { DevRole } from "@bookrunner/shared/devkeys";
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { Hash, cx } from "../components/ui";
import { DEV_GROUPS, DEV_WALLETS, deriveAll } from "../lib/devwallet";
import { shortHex } from "../lib/format";
import { appChain, chainName } from "./chains";
import { NetworkNotice, WalletFunds } from "./network";
import { useWallet } from "./WalletContext";

export function WalletButton({ label, compact }: { label?: string; compact?: boolean }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [addrs, setAddrs] = useState<Partial<Record<DevRole, Address>>>({});

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !w.devAvailable) return;
    let alive = true;
    void deriveAll((role, address) => alive && setAddrs((a) => (a[role] ? a : { ...a, [role]: address })));
    return () => {
      alive = false;
    };
  }, [open, w.devAvailable]);

  const a = w.active;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={cx("btn", a ? "" : "btn-primary", compact && "h-8 min-h-8 px-2.5")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {a ? (
          <>
            <span className={cx("size-1.5 rounded-full", w.wrongNetwork ? "bg-critical" : a.kind === "dev" ? "bg-warn" : "bg-good")} aria-hidden />
            <span className="hidden sm:inline">{w.wrongNetwork ? "Wrong network" : a.label}</span>
            <span className="num text-[12px]">{shortHex(a.address, 6, 4)}</span>
          </>
        ) : w.deriving ? (
          "Loading wallet…"
        ) : (
          (label ?? "Connect wallet")
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Wallet"
          className="fixed inset-x-4 top-16 z-50 max-h-[75vh] overflow-y-auto rounded-[3px] border border-line-strong bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.12)] sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-1 sm:w-[340px]"
        >
          {a && (
            <div className="border-b border-line p-3">
              <div className="eyebrow">Active signer</div>
              <div className="mt-1 text-[13px] font-medium">{a.label}</div>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <Hash value={a.address} kind="address" head={10} tail={8} />
                <span className="num text-[11px] text-muted">{chainName(a.chainId)}</span>
              </div>
              {a.kind === "injected" && <NetworkNotice className="mt-2" />}
              <div className="mt-2 border-t border-line pt-2">
                <WalletFunds />
              </div>
              <button type="button" className="btn mt-2 h-7 min-h-7 w-full text-[12px]" onClick={() => (w.disconnect(), setOpen(false))}>
                Disconnect
              </button>
            </div>
          )}
          <div className="border-b border-line p-3">
            <div className="eyebrow">Browser wallet</div>
            {w.injectedAvailable ? (
              <button type="button" className="btn mt-2 w-full" disabled={w.connecting} onClick={() => void w.connectInjected().then(() => setOpen(false))}>
                {w.connecting ? "Connecting…" : a?.kind === "injected" ? "Reconnect browser wallet" : "Connect browser wallet"}
              </button>
            ) : (
              <p className="mt-1 text-[12px] text-ink-2">No injected wallet detected in this browser.</p>
            )}
            {w.injectedAvailable && !w.devAvailable && (
              <button type="button" className="btn btn-ghost mt-1 h-7 min-h-7 w-full text-[12px]" disabled={w.switching} onClick={() => void w.addAppChain()}>
                Add {appChain.name} (chain {appChain.id}) to the wallet
              </button>
            )}
            {w.connectError && <p className="mt-1 text-[11.5px] text-critical-ink">{w.connectError}</p>}
            {w.networkError && !w.wrongNetwork && <p className="mt-1 text-[11.5px] text-critical-ink">{w.networkError}</p>}
          </div>
          {w.devAvailable ? (
            <div className="p-3">
              <div className="flex items-center justify-between">
                <div className="eyebrow">Dev wallet · devnet 31337</div>
                <span className="text-[10.5px] text-muted">anvil test keys</span>
              </div>
              <p className="mt-1 text-[11.5px] text-ink-2">Signs locally with the anvil accounts behind each role, so every flow can be demoed without a browser wallet.</p>
              {DEV_GROUPS.map((g) => (
                <div key={g} className="mt-2">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted">{g}</div>
                  <ul className="mt-1 divide-y divide-line rounded-[2px] border border-line">
                    {DEV_WALLETS.filter((d) => d.group === g).map((d) => {
                      const on = a?.kind === "dev" && a.devRole === d.role;
                      return (
                        <li key={d.role}>
                          <button
                            type="button"
                            onClick={() => (w.selectDev(d.role), setOpen(false))}
                            className={cx("flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-surface-2", on && "bg-accent-soft")}
                            title={d.hint}
                          >
                            <span className="truncate text-[12.5px]">{d.label}</span>
                            <span className="num text-[11px] text-muted">{addrs[d.role] ? shortHex(addrs[d.role], 6, 4) : "…"}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="p-3 text-[11.5px] text-muted">
              This build runs on {appChain.name} (chain {appChain.id}): sign with a browser wallet. Dev wallets over the anvil test keys exist only on the local devnet build (chain
              31337).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
