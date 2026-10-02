// Wallet entry point. Disconnected: a "Connect wallet" button that opens the Connect Wallet dialog.
// Connected: an account menu with the address (copy + explorer), network, ETH / USDC / BKRN balances,
// test funds on test networks, and disconnect.
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { cx } from "../components/cx";
import { IconChevronDown, IconExternal, IconLogout, IconSwap, IconWallet } from "../components/icons";
import { Badge, CopyButton, Spinner } from "../components/ui";
import { BKRN_DECIMALS, ETH_DECIMALS, USDC_DECIMALS, formatAmountDisplay } from "../lib/amount";
import { gasStatus } from "../lib/chainConfig";
import { addressUrl, config } from "../lib/config";
import { shortHex } from "../lib/format";
import { useWalletBalances } from "./balances";
import { appChain, chainName } from "./chains";
import { useConnectModal } from "./ConnectModal";
import { DevnetTopUp, NetworkIssueLine, isTestChain } from "./network";
import { useMintTestUsdc } from "./useMintTestUsdc";
import { useWallet } from "./WalletContext";

function BalanceRow(props: { label: string; value: bigint | null | undefined; decimals: number; dp: number; symbol: string; dot: string; note?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="flex items-center gap-2 text-[13px] text-ink-2">
        <span className={cx("size-2 rounded-full", props.dot)} aria-hidden />
        {props.label}
      </span>
      <span className="flex items-center gap-2">
        {props.note}
        <span className="num text-[13px] font-medium">
          {props.value === undefined ? <span className="text-muted">…</span> : props.value === null ? <span className="text-muted">unavailable</span> : `${formatAmountDisplay(props.value, props.decimals, props.dp)} ${props.symbol}`}
        </span>
      </span>
    </div>
  );
}

function AccountMenu({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const modal = useConnectModal();
  const bal = useWalletBalances();
  const mint = useMintTestUsdc();
  const a = w.active;
  if (!a) return null;
  const explorer = addressUrl(a.address);
  const gas = gasStatus(bal.eth ?? null);
  const lowGas = bal.eth !== undefined && (gas === "empty" || gas === "low");
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-3">
        {a.icon ? (
          <img src={a.icon} alt="" width={36} height={36} className="size-9 rounded-[9px]" />
        ) : (
          <span className="inline-flex size-9 items-center justify-center rounded-[9px] bg-accent-soft text-accent-text" aria-hidden>
            <IconWallet size={18} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{a.label}</div>
          <div className="flex items-center gap-1">
            <span className="num text-[12.5px] text-ink-2" title={a.address}>
              {shortHex(a.address, 6, 4)}
            </span>
            <CopyButton value={a.address} label="Copy address" />
            {explorer && (
              <a href={explorer} target="_blank" rel="noreferrer noopener" className="inline-flex rounded-[5px] p-0.5 text-muted hover:text-ink" aria-label="View address on the block explorer (opens in a new tab)" title="View on explorer">
                <IconExternal size={13} />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-3 py-2 text-[12.5px]">
        <span className="text-ink-2">Network</span>
        {w.wrongNetwork ? (
          <Badge tone="critical" dot>
            {chainName(a.chainId)}
          </Badge>
        ) : (
          <Badge tone="good" dot>
            {appChain.name}
          </Badge>
        )}
      </div>
      {w.wrongNetwork && (
        <div className="space-y-2 rounded-control border border-warn/40 bg-warn/10 p-3 text-[12.5px]">
          <p>Your wallet is on another network. Switch to {appChain.name} to sign transactions here.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={w.switching} onClick={() => void w.switchToAppChain("menu")}>
              {w.switching ? "Check your wallet…" : "Switch network"}
            </button>
            <button type="button" className="btn btn-sm" disabled={w.switching} onClick={() => void w.addAppChain("menu")}>
              Add network
            </button>
          </div>
          <NetworkIssueLine places={["menu"]} />
        </div>
      )}

      <div>
        <div className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Balances on {appChain.name}</div>
        <div className="divide-y divide-line">
          <BalanceRow
            label="ETH (gas)"
            value={bal.eth}
            decimals={ETH_DECIMALS}
            dp={4}
            symbol="ETH"
            dot="bg-muted"
            note={lowGas ? <Badge size="sm" tone="warn">{gas === "empty" ? "empty" : "low"}</Badge> : undefined}
          />
          <BalanceRow label={isTestChain ? "Test USDC" : "USDC"} value={bal.usdc} decimals={USDC_DECIMALS} dp={2} symbol="USDC" dot="bg-fee" />
          <BalanceRow label="BKRN" value={bal.bkrn} decimals={BKRN_DECIMALS} dp={2} symbol="BKRN" dot="bg-backstop" />
        </div>
      </div>

      {isTestChain && (
        <div className="space-y-2">
          {lowGas &&
            (config.faucetUrl ? (
              <a className="btn btn-sm w-full" href={config.faucetUrl} target="_blank" rel="noreferrer noopener">
                Get free testnet ETH from the faucet
                <IconExternal size={13} />
              </a>
            ) : (
              <DevnetTopUp address={a.address} />
            ))}
          {mint.available && (
            <button type="button" className="btn btn-secondary btn-sm w-full" disabled={mint.status === "signing" || mint.status === "pending" || gas === "empty"} onClick={() => void mint.mint()}>
              {mint.status === "signing" ? (
                <>
                  <Spinner size={14} /> Confirm in your wallet…
                </>
              ) : mint.status === "pending" ? (
                <>
                  <Spinner size={14} /> Minting…
                </>
              ) : mint.status === "confirmed" ? (
                "Minted. Mint 10,000 more test USDC"
              ) : (
                "Mint 10,000 test USDC"
              )}
            </button>
          )}
          {mint.error && <p className="text-[12px] text-critical-ink">{mint.error}</p>}
          <p className="text-[11.5px] text-muted">Testnet only: test ETH and test USDC have no value.</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 border-t border-line pt-3">
        <Link to="/portfolio" className="btn btn-sm" onClick={onClose}>
          Portfolio
        </Link>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            onClose();
            modal.open();
          }}
        >
          <IconSwap size={14} />
          Change
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm col-span-2 text-ink-2"
          onClick={() => {
            w.disconnect();
            onClose();
          }}
        >
          <IconLogout size={14} />
          Disconnect
        </button>
      </div>
    </div>
  );
}

/**
 * The wallet control. `label` customises the disconnected button (inline "connect to continue"
 * prompts); `compact` is the header variant (short address only on small screens).
 */
export function WalletButton({ label, compact, className }: { label?: string; compact?: boolean; className?: string }) {
  const w = useWallet();
  const modal = useConnectModal();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();

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

  const a = w.active;
  if (!a) {
    return (
      <button type="button" className={cx("btn btn-primary", compact && "px-3", className)} onClick={modal.open} disabled={w.deriving}>
        {w.deriving ? (
          <>
            <Spinner size={14} /> Loading wallet…
          </>
        ) : (
          <>
            <IconWallet size={16} className={cx(compact && "hidden sm:inline")} />
            {label ?? (compact ? "Connect" : "Connect wallet")}
          </>
        )}
      </button>
    );
  }
  return (
    <div className={cx("relative", className)} ref={ref}>
      <button
        type="button"
        className={cx("btn", compact && "px-2.5", w.wrongNetwork && "border-critical/50")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Wallet ${shortHex(a.address, 6, 4)}${w.wrongNetwork ? ", wrong network" : ""}. Open account menu`}
        onClick={() => setOpen((o) => !o)}
      >
        {a.icon ? (
          <img src={a.icon} alt="" width={18} height={18} className="size-[18px] rounded-[5px]" />
        ) : (
          <span className={cx("size-2 rounded-full", w.wrongNetwork ? "bg-critical" : a.kind === "dev" ? "bg-warn" : "bg-good")} aria-hidden />
        )}
        {w.wrongNetwork && <span className="hidden text-critical-ink md:inline">Wrong network</span>}
        <span className="num text-[12.5px]">{shortHex(a.address, compact ? 4 : 6, 4)}</span>
        <IconChevronDown size={14} className={cx("text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div
          id={menuId}
          role="dialog"
          aria-label="Account"
          className="pop-in fixed inset-x-4 top-[68px] z-50 max-h-[calc(100dvh-84px)] overflow-y-auto rounded-card border border-line bg-surface shadow-pop sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-2 sm:w-[340px]"
        >
          <AccountMenu onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
