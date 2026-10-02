// Reusable "get set up" checklist (Home, Invest, Portfolio, Stake): wallet connected -> on the app
// chain -> gas -> test USDC -> ready to invest. Live state from useOnboarding(); every step explains
// what it is for and offers the one action that completes it.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ETH_DECIMALS, USDC_DECIMALS, formatAmountDisplay } from "../lib/amount";
import { config } from "../lib/config";
import { shortHex } from "../lib/format";
import type { OnboardingStepId } from "../lib/onboarding";
import { appChain } from "../wallet/chains";
import { useConnectModal } from "../wallet/ConnectModal";
import { DevnetTopUp, NetworkIssueLine, isTestChain } from "../wallet/network";
import { useMintTestUsdc } from "../wallet/useMintTestUsdc";
import { useOnboarding } from "../wallet/useOnboarding";
import { useWallet } from "../wallet/WalletContext";
import { cx } from "./cx";
import { IconArrowRight, IconExternal } from "./icons";
import { Term } from "./Term";
import { Callout, CopyButton, ProgressBar, Spinner, Stepper, type StepperStep } from "./ui";

export interface SetupChecklistProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Where the last step points (default /invest). */
  investHref?: string;
  investLabel?: ReactNode;
  /** Replaces the last step's call to action (e.g. on the Invest page itself). */
  readyAction?: ReactNode;
  /** Once the wallet is ready: one-line summary (default), nothing, or the full list. */
  whenReady?: "collapse" | "hide" | "show";
  compact?: boolean;
  className?: string;
  id?: string;
}

const eth = (v: bigint | null | undefined) => (v == null ? null : `${formatAmountDisplay(v, ETH_DECIMALS, 4)} ETH`);
const usdc = (v: bigint | null | undefined) => (v == null ? null : `${formatAmountDisplay(v, USDC_DECIMALS, 2)} USDC`);

export function SetupChecklist(props: SetupChecklistProps) {
  const w = useWallet();
  const modal = useConnectModal();
  const mint = useMintTestUsdc();
  const ob = useOnboarding();
  const b = ob.balances;
  const status = (id: OnboardingStepId) => ob.steps.find((s) => s.id === id) ?? { id, status: "todo" as const, checking: false, unreadable: false };
  // a balance that could not be read is unknown, not missing: say so instead of asking to fund the wallet
  const checkingMeta = (id: OnboardingStepId) =>
    status(id).checking ? (
      <Spinner size={14} label="Checking" className="text-muted" />
    ) : status(id).unreadable ? (
      <span className="text-[12px] text-muted">Could not read the balance; retrying</span>
    ) : undefined;
  const investHref = props.investHref ?? "/invest";
  const net = config.chain.kind === "devnet" ? "devnet" : "testnet";

  if (ob.ready && props.whenReady === "hide") return null;
  if (ob.ready && (props.whenReady ?? "collapse") === "collapse") {
    return (
      <Callout
        tone="success"
        className={props.className}
        title="Your wallet is ready"
        action={
          props.readyAction ?? (
            <Link className="btn btn-primary btn-sm" to={investHref}>
              {props.investLabel ?? "Explore books"}
              <IconArrowRight size={14} />
            </Link>
          )
        }
      >
        <span className="num">
          {usdc(b.usdc)} · {eth(b.eth)}
        </span>{" "}
        on {appChain.name}.
      </Callout>
    );
  }

  const steps: StepperStep[] = [
    {
      id: "connect",
      status: status("connect").status,
      title: "Connect a wallet",
      description: (
        <>
          Your <Term id="wallet">wallet</Term> keeps your funds and signs each transaction. Connecting only shares your address.
        </>
      ),
      meta: w.active ? `${w.active.label} · ${shortHex(w.active.address, 6, 4)}` : undefined,
      action: (
        <button type="button" className="btn btn-primary" onClick={modal.open}>
          Connect wallet
        </button>
      ),
    },
    {
      id: "network",
      status: status("network").status,
      title: `Switch to ${appChain.name}`,
      description: `Bookrunner's contracts live on ${appChain.name} (chain ${appChain.id}). Your wallet asks before it adds or switches a network.`,
      meta: status("network").status === "done" ? appChain.name : undefined,
      action: w.active ? (
        <>
          <button type="button" className="btn btn-primary" disabled={w.switching} onClick={() => void w.switchToAppChain("checklist")}>
            {w.switching ? "Check your wallet…" : "Switch network"}
          </button>
          <button type="button" className="btn" disabled={w.switching} onClick={() => void w.addAppChain("checklist")}>
            Add network
          </button>
          <NetworkIssueLine places={["checklist"]} className="basis-full" />
        </>
      ) : undefined,
    },
    {
      id: "gas",
      status: status("gas").status,
      title: isTestChain ? `Get ${net} ETH for gas` : "Have ETH for gas",
      description: (
        <>
          Every transaction pays a small network fee, called <Term id="gas">gas</Term>, in ETH.{" "}
          {isTestChain ? `${net === "devnet" ? "Devnet" : "Testnet"} ETH is free: request some for your address. About 0.0005 ETH covers many transactions.` : "Keep a little ETH on Robinhood Chain in this wallet."}
        </>
      ),
      meta: checkingMeta("gas") ?? eth(b.eth) ?? undefined,
      action: w.active ? (
        <>
          {config.faucetUrl ? (
            <a className="btn btn-primary" href={config.faucetUrl} target="_blank" rel="noreferrer noopener">
              Open the faucet
              <IconExternal size={14} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <DevnetTopUp address={w.active.address} />
          )}
          <span className="inline-flex items-center gap-1.5 rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-[12px]">
            <span className="num">{shortHex(w.active.address, 8, 6)}</span>
            <CopyButton value={w.active.address} label="Copy your address" />
          </span>
          {config.faucetUrl && <span className="basis-full text-[12px] text-muted">Paste your address in the faucet. This step ticks itself once the ETH arrives.</span>}
        </>
      ) : undefined,
    },
    {
      id: "usdc",
      status: status("usdc").status,
      title: isTestChain ? "Mint test USDC" : "Add USDC",
      description: isTestChain ? (
        <>
          Books are funded in <Term id="usdc">USDC</Term>. On {net}, the token has an open mint: mint free test USDC to your own wallet. It has no value.
        </>
      ) : (
        <>
          Books are funded in <Term id="usdc">USDC</Term>. Send USDC on Robinhood Chain to this wallet.
        </>
      ),
      meta: checkingMeta("usdc") ?? usdc(b.usdc) ?? undefined,
      action: !isTestChain ? undefined : mint.available ? (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={mint.status === "signing" || mint.status === "pending" || b.eth === 0n}
            onClick={() => void mint.mint()}
          >
            {mint.status === "signing" ? (
              <>
                <Spinner size={14} /> Confirm in your wallet…
              </>
            ) : mint.status === "pending" ? (
              <>
                <Spinner size={14} /> Minting…
              </>
            ) : (
              "Mint 10,000 test USDC"
            )}
          </button>
          {b.eth === 0n && <span className="text-[12px] text-muted">Needs gas first (step 3).</span>}
          {mint.error && <span className="basis-full text-[12px] text-critical-ink">{mint.error}</span>}
        </>
      ) : mint.reason === "checking" ? (
        <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
          <Spinner size={14} /> Checking the test token…
        </span>
      ) : mint.reason === "not-mintable" ? (
        <span className="text-[12.5px] text-ink-2">This network's USDC has no open mint. Fund the wallet from another account.</span>
      ) : mint.reason === "no-token" ? (
        <span className="text-[12.5px] text-ink-2">The USDC address is not known yet (no book is listed by the API).</span>
      ) : undefined,
    },
    {
      id: "invest",
      status: status("invest").status,
      title: "Choose a book and invest",
      description: "Pick a market and a tranche. You review every transaction in your wallet before anything is sent.",
      action: props.readyAction ?? (
        <Link className="btn btn-primary" to={investHref}>
          {props.investLabel ?? "Explore books"}
          <IconArrowRight size={14} />
        </Link>
      ),
    },
  ];

  return (
    <section id={props.id} className={cx("rounded-card border border-line bg-surface shadow-card", props.className)} aria-label="Setup checklist">
      <div className="border-b border-line px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{props.title ?? "Get set up to invest"}</h2>
          <span className="num text-[12.5px] text-ink-2">
            {ob.doneCount} of {ob.total} done
          </span>
        </div>
        {props.description !== null && (
          <p className="mt-1 text-[13px] text-ink-2">{props.description ?? "Five short steps, a few minutes in total. Each one ticks itself as soon as it is done."}</p>
        )}
        <ProgressBar value={ob.progress} label="Setup progress" className="mt-3" tone="good" />
      </div>
      <div className="px-4 py-5 sm:px-5">
        <Stepper steps={steps} ariaLabel="Setup steps" compact={props.compact} />
      </div>
      {isTestChain && (
        <div className="rounded-b-card border-t border-line bg-surface-2/60 px-4 py-3 text-[12px] text-ink-2 sm:px-5">
          {appChain.name} is a <Term id="testnet">test network</Term>: test ETH and test USDC have no value, and nothing here is an offer.
        </div>
      )}
    </section>
  );
}
