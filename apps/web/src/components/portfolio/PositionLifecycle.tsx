// How a position moves, in five steps: deposit -> accepted at a mark -> hold shares -> request a
// redemption -> claim. Explains the states the portfolio shows (pending, ready to claim, in redemption).
import type { ReactNode } from "react";
import { cx } from "../cx";
import { IconCheck, IconCoin, IconLayers, IconSwap } from "../icons";
import { Term } from "../Term";

interface Step {
  title: string;
  body: ReactNode;
  icon: ReactNode;
  /** What the portfolio calls this state. */
  shownAs: string;
}

const STEPS: Step[] = [
  {
    title: "Deposit USDC",
    body: (
      <>
        Into the Senior or Junior <Term id="tranche">tranche</Term> of a book, while a <Term id="topUpRound">top-up round</Term> or a subscription window is open. The USDC waits in escrow.
      </>
    ),
    icon: <IconCoin size={18} />,
    shownAs: "Pending deposit",
  },
  {
    title: "Accepted at a mark",
    body: (
      <>
        After a top-up round ends, the next <Term id="mark">mark</Term> accepts deposits up to its capacity, as shares at that mark's <Term id="sharePrice">share price</Term>. A new book's first window allocates when it closes. Any excess is refunded.
      </>
    ),
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="3.5" y="3.5" width="13" height="13" rx="3" stroke="currentColor" strokeWidth="1.6" />
        <path d="m6.8 10.2 2.2 2.2 4.3-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    shownAs: "Ready to claim",
  },
  {
    title: "Hold shares",
    body: (
      <>
        Each signed mark sets the share price. Fee flow lifts it; losses lower it, Junior first. Your value is shares times the latest marked price.
      </>
    ),
    icon: <IconLayers size={18} />,
    shownAs: "Position value",
  },
  {
    title: "Request a redemption",
    body: (
      <>
        At any time. Senior settles at the next mark; Junior waits out its <Term id="redemptionNotice">notice period</Term> first. Notice is not a gate: the request is always accepted.
      </>
    ),
    icon: <IconSwap size={18} />,
    shownAs: "In redemption",
  },
  {
    title: "Claim your USDC",
    body: <>Once a mark settles the request at its share price, the USDC is yours to claim. Claims are never blocked by a pause or a kill.</>,
    icon: <IconCheck size={18} />,
    shownAs: "Ready to claim",
  },
];

/** Five steps in a row on wide screens; `compact` keeps two columns (for narrow containers). */
export function PositionLifecycle({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <ol className={cx("grid gap-3 sm:grid-cols-2", !compact && "lg:grid-cols-5", className)} aria-label="How a position moves">
      {STEPS.map((s, i) => (
        <li key={s.title} className={cx("relative flex gap-3 rounded-card border border-line bg-surface p-4 shadow-card", !compact && "lg:flex-col")}>
          <div className={cx("flex shrink-0 items-center gap-2", !compact && "lg:justify-between")}>
            <span className="inline-flex size-9 items-center justify-center rounded-full bg-accent-soft text-accent-text" aria-hidden>
              {s.icon}
            </span>
            <span className={cx("num hidden text-[12px] text-muted", !compact && "lg:inline")} aria-hidden>
              {String(i + 1).padStart(2, "0")}
            </span>
          </div>
          <div className="min-w-0">
            <h3 className="text-[14.5px] font-semibold text-ink">
              <span className="sr-only">{`Step ${i + 1}: `}</span>
              {s.title}
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{s.body}</p>
            <p className="mt-2 text-[12px] text-muted">
              Shown as <span className="font-medium text-ink-2">{s.shownAs}</span>
            </p>
          </div>
          {!compact && i < STEPS.length - 1 && (
            <svg className="absolute top-1/2 -right-[11px] z-[1] hidden -translate-y-1/2 text-line-strong lg:block" width="10" height="16" viewBox="0 0 10 16" aria-hidden>
              <path d="M2 2l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </li>
      ))}
    </ol>
  );
}
