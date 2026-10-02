// "Start in 3 steps": the short version (connect, get test funds, pick a book) next to the live
// SetupChecklist, which ticks each step as the wallet completes it.
import type { ReactNode } from "react";
import { formatAmountDisplay } from "../../lib/amount";
import { TEST_USDC_AMOUNT } from "../../lib/funds";
import { appChain } from "../../wallet/chains";
import { isTestChain } from "../../wallet/network";
import { IconCoin, IconLayers, IconWallet } from "../icons";
import { SetupChecklist } from "../SetupChecklist";
import { Section, Term } from "../ui";

export function StartSteps() {
  const mintAmount = formatAmountDisplay(TEST_USDC_AMOUNT, 6, 0);
  const steps: Array<{ id: string; title: string; icon: ReactNode; body: ReactNode }> = [
    {
      id: "connect",
      title: "Connect a wallet",
      icon: <IconWallet size={18} />,
      body: (
        <>
          MetaMask, Rabby or any browser <Term id="wallet">wallet</Term> works. Connecting shares your address only, and the app helps you switch to {appChain.name}.
        </>
      ),
    },
    {
      id: "fund",
      title: isTestChain ? "Get free test funds" : "Fund your wallet",
      icon: <IconCoin size={18} />,
      body: isTestChain ? (
        <>
          Take a little ETH for <Term id="gas">gas</Term> from the faucet, then mint {mintAmount} test USDC to your wallet in one click. Neither has any value.
        </>
      ) : (
        <>
          Keep a little ETH for <Term id="gas">gas</Term> and the USDC you plan to deposit in this wallet, on {appChain.name}.
        </>
      ),
    },
    {
      id: "invest",
      title: "Pick a book and a tranche",
      icon: <IconLayers size={18} />,
      body: (
        <>
          Choose a market, then <Term id="senior">Senior</Term> or <Term id="junior">Junior</Term>. Your wallet shows each transaction, an approval and a deposit, before
          you sign.
        </>
      ),
    },
  ];

  return (
    <Section
      id="start"
      tone="muted"
      eyebrow="Get started"
      title="Start in 3 steps"
      lead={isTestChain ? "A few minutes on testnet, at no cost: test ETH and test USDC are free." : "A few minutes, from your own wallet."}
      bodyClassName="grid items-start gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-12"
    >
      <ol className="space-y-6">
        {steps.map((s, i) => (
          <li key={s.id} className="flex gap-4">
            <span className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-[12px] border border-line bg-surface text-accent-text shadow-card" aria-hidden>
              {s.icon}
              <span className="tnum absolute -top-2 -right-2 inline-flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-ink">{i + 1}</span>
            </span>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
                <span className="sr-only">{`Step ${i + 1}: `}</span>
                {s.title}
              </h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <SetupChecklist id="setup" />
    </Section>
  );
}
