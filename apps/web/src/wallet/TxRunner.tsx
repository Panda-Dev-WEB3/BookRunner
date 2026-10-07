// Review + send list for prepared transactions. Each tx is signed by the active wallet in order;
// the next starts after the previous confirms. Shows signing / pending / confirmed / failed states.
import { useEffect, useMemo, useRef, useState } from "react";
import { Chip, Hash, cx } from "../components/ui";
import type { PreparedTx } from "../lib/api-types";
import { devEntry } from "../lib/devwallet";
import type { Tone } from "../lib/limits";
import { type TxItem, type TxStatus, awaitsReceipt, callSummary, initialItems, runSequential, summarize } from "../lib/txflow";
import { appChain, chainName } from "./chains";
import { GasWarning, NetworkNotice } from "./network";
import { checkTxs, useFlowTargets } from "./txVerify";
import { useDevRoleFor } from "./useDevRoleFor";
import { WalletButton } from "./WalletButton";
import { sameAddress, useWallet } from "./WalletContext";

const STATUS: Record<TxStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  signing: { label: "Awaiting signature", tone: "accent" },
  pending: { label: "Pending", tone: "warn" },
  confirmed: { label: "Confirmed", tone: "good" },
  failed: { label: "Failed", tone: "critical" },
  skipped: { label: "Not sent", tone: "neutral" },
};

export function TxRunner(props: {
  txs: PreparedTx[];
  /** Expected sender (API `signer`); null when any of several roles may sign. */
  signer?: string | null;
  signerHint?: string;
  /** The amount the user entered (raw units): deposit / redeem / stake steps (and approvals) must match. */
  amount?: bigint | null;
  onConfirmed?: () => void;
  className?: string;
}) {
  const w = useWallet();
  // verified against chain-derived contracts before any prompt (txVerify.ts); nothing is sent otherwise
  const flowTargets = useFlowTargets();
  const account = props.signer ?? w.active?.address ?? null;
  const verified = useMemo(() => checkTxs(props.txs, flowTargets.data, { account, amount: props.amount }), [props.txs, flowTargets.data, account, props.amount]);
  const blocked = verified.status !== "ok";
  const [items, setItems] = useState<TxItem<PreparedTx>[]>(() => initialItems(props.txs));
  const key = useMemo(() => props.txs.map((t) => `${t.to}:${t.data}`).join("|"), [props.txs]);
  const doneRef = useRef(false);
  useEffect(() => {
    setItems(initialItems(props.txs));
    doneRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const s = summarize(items);
  // A failed step that was broadcast but lost its receipt wait: retrying waits for that hash again.
  const lostReceipt = items.find((i) => i.status === "failed" && awaitsReceipt(i)) ?? null;
  const mismatch = !!props.signer && !!w.active && !sameAddress(props.signer, w.active.address);
  const suggested = useDevRoleFor(props.signer ?? null, w.devAvailable && mismatch);
  const chainIds = [...new Set(props.txs.map((t) => t.chainId))];
  const wrongChainForDev = w.active?.kind === "dev" && chainIds.some((c) => c !== 31337);
  const foreignChain = chainIds.find((c) => c !== appChain.id) ?? null;

  const run = async () => {
    if (!w.executor || verified.status !== "ok") return;
    const r = await runSequential(items, w.executor, setItems);
    if (r.ok && !doneRef.current) {
      doneRef.current = true;
      props.onConfirmed?.();
    }
  };

  // Only when the explorer does not show the transaction at all (dropped): forget the hash and sign it again.
  const sendAgain = () => setItems((cur) => cur.map((i) => (i === lostReceipt ? { ...i, hash: undefined, reverted: undefined } : i)));

  if (props.txs.length === 0) return null;

  return (
    <div className={cx("rounded-card border border-line", props.className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-3 py-2">
        <div className="eyebrow !text-ink">
          Prepared transaction{props.txs.length > 1 ? "s" : ""} · {s.done}/{s.total} confirmed
        </div>
        <div className="num text-[11px] text-muted">{chainIds.map(chainName).join(", ")}</div>
      </div>
      <ol className="divide-y divide-line">
        {items.map((it, i) => {
          const st = STATUS[it.status];
          const call = callSummary(it.tx.data);
          const decoded = verified.status === "ok" ? verified.steps[i]?.summary : undefined;
          return (
            <li key={i} className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <div className="flex items-start gap-2 text-[12.5px]">
                  <span className="num mt-px text-muted">{i + 1}.</span>
                  <span className="min-w-0">{it.tx.description}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-[11px] text-muted">
                  <span className="inline-flex items-center gap-1">
                    to <Hash value={it.tx.to} kind="address" />
                  </span>
                  <span className="num">{decoded ?? `${call.selector} · ${call.bytes} bytes`}</span>
                  {it.hash && (
                    <span className="inline-flex items-center gap-1">
                      tx <Hash value={it.hash} kind="tx" />
                    </span>
                  )}
                  {it.blockNumber !== undefined && <span className="num">block {it.blockNumber.toString()}</span>}
                </div>
                {it.error && <div className={cx("mt-1 pl-5 text-[11.5px]", it.status === "skipped" ? "text-ink-2" : "text-critical-ink")}>{it.error}</div>}
              </div>
              <div className="pl-5 sm:pl-0">
                <Chip tone={st.tone}>{st.label}</Chip>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
        {props.signer && (
          <div className="text-[11.5px] text-ink-2">
            Expected signer <Hash value={props.signer} kind="address" />
            {props.signerHint ? ` (${props.signerHint})` : ""}
          </div>
        )}
        {mismatch && (
          <div className="flex flex-wrap items-center gap-2 rounded-control bg-warn/15 px-2 py-1.5 text-[11.5px]">
            <span>
              The active wallet is not the account these transactions were prepared for: they would revert or act for another account. Switch back to that account, or prepare them again from
              this one.
            </span>
            {suggested && (
              <button type="button" className="btn h-6 min-h-6 text-[11.5px]" onClick={() => w.selectDev(suggested)}>
                Switch to {devEntry(suggested)?.label ?? suggested}
              </button>
            )}
          </div>
        )}
        {foreignChain !== null ? (
          <div className="text-[11.5px] text-critical-ink">
            Prepared for {chainName(foreignChain)}, but this build runs on {appChain.name}. Point the app (VITE_CHAIN_ID) and the API at the same chain.
          </div>
        ) : wrongChainForDev ? (
          <div className="text-[11.5px] text-critical-ink">These transactions are for another chain; connect a browser wallet.</div>
        ) : null}
        {verified.status === "refused" ? (
          <div className="text-[11.5px] text-critical-ink">{verified.error}</div>
        ) : verified.status === "pending" ? (
          <div className="text-[11.5px] text-muted">
            {flowTargets.error ? "Could not read the contract addresses from the chain to verify these transactions; retry shortly." : "Verifying the transactions against the contracts on chain…"}
          </div>
        ) : null}
        {w.active?.kind === "injected" && <NetworkNotice />}
        {w.active && <GasWarning address={w.active.address} />}
        <div className="flex flex-wrap items-center gap-2">
          {w.active ? (
            <button type="button" className="btn btn-primary" disabled={s.running || s.allConfirmed || mismatch || wrongChainForDev || foreignChain !== null || !w.executor || blocked} onClick={run}>
              {s.running ? "Sending…" : s.allConfirmed ? "All confirmed" : lostReceipt ? "Check the transaction again" : s.failed ? "Retry from the failed step" : `Sign and send ${props.txs.length > 1 ? `${props.txs.length} transactions` : "transaction"}`}
            </button>
          ) : (
            <WalletButton label="Connect a wallet to send" />
          )}
          {w.active && (
            <span className="text-[11.5px] text-muted">
              as {w.active.label} <Hash value={w.active.address} kind="address" />
            </span>
          )}
        </div>
        {lostReceipt && !s.running && (
          <div className="text-[11.5px] text-ink-2">
            The transaction was sent, but its confirmation could not be read yet; it may still confirm. Check it again rather than sending it twice.{" "}
            <button type="button" className="link" onClick={sendAgain}>
              The explorer does not show it: send it again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
