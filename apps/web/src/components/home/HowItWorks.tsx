// "How it works" in five illustrated steps: charter -> committee -> funding -> agent -> waterfall + mark.
// Horizontal flow on wide screens (arrows between steps), a vertical list on phones.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { SPONSOR_SKIN_SHORT } from "../../lib/copy";
import { cx } from "../cx";
import { IconArrowRight } from "../icons";
import { Section, Term } from "../ui";
import { AgentArt, CharterArt, CommitteeArt, FundArt, WaterfallArt } from "./art";

interface Step {
  id: string;
  title: string;
  body: ReactNode;
  art: ReactNode;
}

const STEPS: Step[] = [
  {
    id: "charter",
    title: "A sponsor charters a market",
    art: <CharterArt />,
    body: (
      <>
        A <Term id="sponsor">sponsor</Term> files the market's terms on-chain: the asset it follows, the venue, the insurance-fund size, the agent's rules and the
        tranche terms. Filing pays a flat USDC fee and locks a <Term id="bkrn">BKRN</Term> bond.
      </>
    ),
  },
  {
    id: "committee",
    title: "The committee approves it",
    art: <CommitteeArt />,
    body: (
      <>
        A model jury reviews the <Term id="charter">charter</Term>, then three bonded members vote. Two approvals out of three create the book (three if the jury advised
        against).
      </>
    ),
  },
  {
    id: "fund",
    title: "Allocators fund Senior and Junior",
    art: <FundArt />,
    body: (
      <>
        Allocators deposit USDC into the <Term id="senior">Senior</Term> or <Term id="junior">Junior</Term> tranche. The book funds the market's insurance fund first, then the
        market-making inventory. The sponsor {SPONSOR_SKIN_SHORT}; later top-ups can dilute that share.
      </>
    ),
  },
  {
    id: "agent",
    title: "An agent quotes and hedges",
    art: <AgentArt />,
    body: (
      <>
        A <Term id="bookrunnerAgent">bookrunner agent</Term> quotes buy and sell prices on the venue and hedges with <Term id="stockToken">Stock Tokens</Term>. The{" "}
        <Term id="mandate">mandate</Term> sets a minimum spread, caps skew and inventory, keeps hedges in a band and stops new risk off-hours.
      </>
    ),
  },
  {
    id: "waterfall",
    title: "Fees flow, marks are signed",
    art: <WaterfallArt />,
    body: (
      <>
        Fee flow pays expenses, the 10% <Term id="carry">carry</Term>, Senior's share, then Junior: the <Term id="waterfall">waterfall</Term>. Each period a signed{" "}
        <Term id="mark">mark</Term> commits NAV on-chain with receipts anyone can verify.
      </>
    ),
  },
];

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      tone="muted"
      eyebrow="How it works"
      title="From a market idea to a signed mark"
      lead="Every book follows the same five steps, and each one leaves a record on-chain."
      actions={
        <Link to="/learn" className="btn">
          Read the full explainer
          <IconArrowRight size={14} />
        </Link>
      }
    >
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:gap-5">
        {STEPS.map((s, i) => (
          <li key={s.id} className={cx("relative min-w-0", i === STEPS.length - 1 && "sm:col-span-2 lg:col-span-1")}>
            <article className="flex h-full flex-col rounded-card border border-line bg-surface p-4 shadow-card sm:p-5" aria-labelledby={`how-${s.id}`}>
              <div className="rounded-[10px] bg-surface-2 px-3 py-2">
                <div className="mx-auto max-w-[200px] sm:max-w-none">{s.art}</div>
              </div>
              <div className="mt-4 flex items-center gap-2.5">
                <span className="tnum inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent-text" aria-hidden>
                  {i + 1}
                </span>
                <h3 id={`how-${s.id}`} className="text-[15px] leading-snug font-semibold tracking-[-0.01em] text-ink">
                  <span className="sr-only">{`Step ${i + 1}: `}</span>
                  {s.title}
                </h3>
              </div>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">{s.body}</p>
            </article>
            {i < STEPS.length - 1 && (
              <span
                className="absolute top-[64px] -right-[22px] z-[1] hidden size-6 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-card lg:inline-flex"
                aria-hidden
              >
                <IconArrowRight size={13} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
}
