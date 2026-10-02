// Portfolio without a connected wallet: what the page shows, why it needs a wallet, and the setup
// checklist to get one connected and funded.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { isTestChain } from "../../wallet/network";
import { WalletButton } from "../../wallet/WalletButton";
import { IconArrowRight, IconCoin, IconLayers, IconWallet } from "../icons";
import { SetupChecklist } from "../SetupChecklist";
import { Term } from "../Term";
import { Card, Section } from "../ui";
import { PositionLifecycle } from "./PositionLifecycle";
import { PORTFOLIO_LEAD } from "./display";

function Point(props: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-2" aria-hidden>
        {props.icon}
      </span>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold text-ink">{props.title}</div>
        <p className="mt-0.5 text-[13px] text-ink-2">{props.children}</p>
      </div>
    </li>
  );
}

export function ConnectPrompt() {
  return (
    <>
      <Section tone="hero" headingAs="h1" headerSize="md" eyebrow="Portfolio" title="Your portfolio" lead={PORTFOLIO_LEAD}>
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          <Card padding="lg" as="section" aria-label="Connect a wallet">
            <span className="inline-flex size-11 items-center justify-center rounded-card bg-accent-soft text-accent-text" aria-hidden>
              <IconWallet size={22} />
            </span>
            <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.01em] text-ink">Connect a wallet to see your positions</h2>
            <p className="mt-2 max-w-xl text-[14px] text-ink-2">
              Bookrunner has no accounts or sign-ups. Your portfolio is whatever the connected address holds on-chain, read live from the books' contracts. Connecting shares your address only: nothing moves without your approval in the{" "}
              <Term id="wallet">wallet</Term>.
            </p>
            <ul className="mt-6 space-y-4">
              <Point icon={<IconLayers size={16} />} title="Your shares, valued at the latest mark">
                Each book commits a signed <Term id="nav">NAV</Term> on-chain every period. Your Senior and Junior shares are valued at it, never at a live guess.
              </Point>
              <Point icon={<IconCoin size={16} />} title="Deposits and redemptions in flight">
                See deposits waiting for a mark to accept them, and redemption requests with the date each one settles.
              </Point>
              <Point
                icon={
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
                    <path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 15.5h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                }
                title="Claims in one place"
              >
                When shares, refunds or redeemed USDC are ready, claim them here. You review every transaction in your wallet first.
              </Point>
            </ul>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <WalletButton />
              <Link className="btn btn-ghost" to="/learn">
                How Bookrunner works
                <IconArrowRight size={14} />
              </Link>
            </div>
          </Card>
          <SetupChecklist
            whenReady="hide"
            description={isTestChain ? "New here? These steps get a wallet connected and funded with free test tokens." : "New here? These steps get a wallet connected and ready to invest."}
          />
        </div>
      </Section>
      <Section space="md" eyebrow="The life of a position" title="From deposit to claim" headerSize="md" lead="The portfolio follows each position through these five steps. Deposits are accepted and redemptions settle at a mark: the signed statement each book commits on-chain every period.">
        <PositionLifecycle />
      </Section>
    </>
  );
}
