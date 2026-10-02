// Connect Wallet dialog, opened from anywhere with useConnectModal().open(). Lists browser wallets
// discovered through EIP-6963 (name + icon), falls back to the generic injected wallet, offers
// WalletConnect only when VITE_WALLETCONNECT_PROJECT_ID is set, and keeps the devnet dev wallets.
import type { DevRole } from "@bookrunner/shared/devkeys";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { type Connector, useConnectors } from "wagmi";
import { cx } from "../components/cx";
import { IconChevronRight, IconWallet } from "../components/icons";
import { Badge, Callout, ExternalLink, Modal, Spinner } from "../components/ui";
import { DEV_GROUPS, DEV_WALLETS } from "../lib/devwallet";
import { shortHex } from "../lib/format";
import { appChain, walletConnectConnector } from "./chains";
import { useDevSigner } from "./devGate";
import { useWallet } from "./WalletContext";

interface ConnectModalCtx {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const Ctx = createContext<ConnectModalCtx | null>(null);

/** Opens / closes the Connect Wallet dialog from any component under ConnectModalProvider. */
export function useConnectModal(): ConnectModalCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useConnectModal outside ConnectModalProvider");
  return c;
}

export function ConnectModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const w = useWallet();
  const { clearConnectError } = w;
  // A fresh open starts without the last error; reopening after a failed WalletConnect keeps it.
  const value = useMemo<ConnectModalCtx>(
    () => ({
      isOpen,
      open: () => {
        clearConnectError();
        setOpen(true);
      },
      close: () => setOpen(false),
    }),
    [isOpen, clearConnectError],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <ConnectWalletModal open={isOpen} onClose={() => setOpen(false)} onReopen={() => setOpen(true)} />
    </Ctx.Provider>
  );
}

export const INSTALL_LINKS = [
  { name: "MetaMask", href: "https://metamask.io/download/" },
  { name: "Rabby", href: "https://rabby.io/" },
] as const;

function WalletGlyph({ icon, className }: { icon?: string | null; className?: string }) {
  return icon ? (
    <img src={icon} alt="" width={32} height={32} className={cx("size-8 shrink-0 rounded-[8px]", className)} />
  ) : (
    <span className={cx("inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-accent-soft text-accent-text", className)} aria-hidden>
      <IconWallet size={18} />
    </span>
  );
}

function OptionButton(props: { icon?: string | null; glyph?: ReactNode; title: ReactNode; sub: ReactNode; busy?: boolean; disabled?: boolean; onClick: () => void; badge?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-busy={props.busy || undefined}
      className="flex w-full items-center gap-3 rounded-control border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {props.glyph ?? <WalletGlyph icon={props.icon} />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
          <span className="truncate">{props.title}</span>
          {props.badge}
        </span>
        <span className="block text-[12px] text-muted">{props.sub}</span>
      </span>
      {props.busy ? <Spinner className="text-accent-text" /> : <IconChevronRight size={16} className="shrink-0 text-muted" />}
    </button>
  );
}

function DevWallets({ onPicked }: { onPicked: () => void }) {
  const w = useWallet();
  const [addrs, setAddrs] = useState<Partial<Record<DevRole, Address>>>({});
  const dev = useDevSigner(true);
  useEffect(() => {
    if (!dev) return;
    let alive = true;
    void dev.deriveAll((role, address) => alive && setAddrs((a) => (a[role] ? a : { ...a, [role]: address })));
    return () => {
      alive = false;
    };
  }, [dev]);
  const a = w.active;
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Dev wallets (local devnet only)</h3>
        <Badge size="sm" tone="warn">
          test keys
        </Badge>
      </div>
      <p className="mt-1 text-[12px] text-ink-2">Signs locally with the anvil accounts behind each role, so every flow can be tried without a browser wallet.</p>
      {DEV_GROUPS.map((g) => (
        <div key={g} className="mt-3">
          <div className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{g}</div>
          <ul className="mt-1 divide-y divide-line overflow-hidden rounded-control border border-line">
            {DEV_WALLETS.filter((d) => d.group === g).map((d) => {
              const on = a?.kind === "dev" && a.devRole === d.role;
              return (
                <li key={d.role}>
                  <button
                    type="button"
                    onClick={() => {
                      w.selectDev(d.role);
                      onPicked();
                    }}
                    className={cx("flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2", on && "bg-accent-soft")}
                    title={d.hint}
                    aria-current={on ? "true" : undefined}
                  >
                    <span className="truncate text-[13px]">{d.label}</span>
                    <span className="num text-[11.5px] text-muted">{addrs[d.role] ? shortHex(addrs[d.role], 6, 4) : "…"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function NewToWallets() {
  return (
    <div className="rounded-card bg-surface-2 p-4 text-[13px] text-ink-2">
      <h3 className="text-[14px] font-semibold text-ink">New to wallets?</h3>
      <p className="mt-2">A wallet is an app or browser extension that holds your keys and signs transactions. Bookrunner never sees your keys.</p>
      <ul className="mt-3 space-y-2">
        <li className="flex gap-2">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-good" aria-hidden />
          <span>
            <span className="font-medium text-ink">Connecting shares your address</span> so the app can show your balances and prepare transactions.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-good" aria-hidden />
          <span>
            <span className="font-medium text-ink">It cannot move funds on its own.</span> Every transaction opens in your wallet for you to review and approve.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
          <span>
            Bookrunner runs on <span className="font-medium text-ink">{appChain.name}</span>. Your wallet will ask to add or switch to it.
          </span>
        </li>
      </ul>
      <div className="mt-4 text-[12.5px]">
        <div className="font-medium text-ink">Get a wallet</div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          {INSTALL_LINKS.map((l) => (
            <ExternalLink key={l.name} href={l.href}>
              {l.name}
            </ExternalLink>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConnectWalletModal({ open, onClose, onReopen }: { open: boolean; onClose: () => void; onReopen: () => void }) {
  const w = useWallet();
  const connectors = useConnectors();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setPending(null);
  }, [open]);

  const discovered = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const generic = connectors.find((c) => c.id === "injected");
  const wc = w.walletConnectEnabled;
  const showGeneric = discovered.length === 0 && w.injectedAvailable && generic;
  const activeLabel = w.active?.kind === "injected" ? w.active.label : null;

  const go = async (c: Connector) => {
    setPending(c.uid);
    const ok = await w.connectWith(c);
    setPending(null);
    if (ok) onClose();
  };

  // WalletConnect shows its own QR dialog, which must not sit behind this one: close first, and
  // reopen with the error when the QR dialog is dismissed or the phone declines.
  const goWalletConnect = async () => {
    const c = walletConnectConnector();
    if (!c) return;
    setPending("walletConnect");
    onClose();
    const ok = await w.connectWith(c);
    setPending(null);
    if (!ok) onReopen();
  };

  const nothing = discovered.length === 0 && !showGeneric && !wc;

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Connect a wallet" description={`Choose the wallet you use. Bookrunner runs on ${appChain.name}.`}>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-5">
          {(discovered.length > 0 || showGeneric) && (
            <div>
              <h3 className="mb-2 text-[13px] font-semibold">Browser wallets</h3>
              <div className="space-y-2">
                {discovered.map((c) => (
                  <OptionButton
                    key={c.uid}
                    icon={c.icon}
                    title={c.name}
                    sub={activeLabel === c.name ? "Connected" : "Detected in this browser"}
                    badge={activeLabel === c.name ? <Badge size="sm" tone="good" dot>Active</Badge> : undefined}
                    busy={pending === c.uid}
                    disabled={pending !== null}
                    onClick={() => void go(c)}
                  />
                ))}
                {showGeneric && generic && (
                  <OptionButton title="Browser wallet" sub="The wallet extension in this browser" busy={pending === generic.uid} disabled={pending !== null} onClick={() => void go(generic)} />
                )}
              </div>
            </div>
          )}
          {wc && (
            <div>
              <h3 className="mb-2 text-[13px] font-semibold">Mobile wallet</h3>
              <OptionButton
                glyph={
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-senior/12 text-senior-ink" aria-hidden>
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="5" height="5" rx="1" />
                      <rect x="12" y="3" width="5" height="5" rx="1" />
                      <rect x="3" y="12" width="5" height="5" rx="1" />
                      <path d="M12 12h2v2M17 12v5h-5M14.5 16.5v.01" />
                    </svg>
                  </span>
                }
                title="WalletConnect"
                sub="Scan a QR code with a wallet app on your phone"
                busy={pending === "walletConnect"}
                disabled={pending !== null}
                onClick={() => void goWalletConnect()}
              />
            </div>
          )}
          {nothing && (
            <Callout tone="info" title="No browser wallet found">
              Install a wallet extension such as MetaMask or Rabby, then reload this page.
              {w.devAvailable ? " On the local devnet you can also use a dev wallet below." : ""}
            </Callout>
          )}
          {pending !== null && (
            <p className="text-[12.5px] text-ink-2" role="status">
              Open your wallet and approve the connection request.
            </p>
          )}
          {w.connectError && (
            <Callout tone="warn" compact title="The wallet did not connect">
              {w.connectError}
            </Callout>
          )}
          {w.devAvailable && <DevWallets onPicked={onClose} />}
        </div>
        <NewToWallets />
      </div>
    </Modal>
  );
}
