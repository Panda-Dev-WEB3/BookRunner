// 2. A book, end to end: an interactive lifecycle (charter -> committee -> subscription window -> live ->
// marks -> top-ups and redemptions -> retire). Stages are tabs: click, or use the arrow keys.
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import type { GlossaryId } from "../../lib/glossary";
import { cx } from "../cx";
import { IconArrowRight } from "../icons";
import { Term } from "../Term";
import { Badge, Card } from "../ui";
import { LearnSection } from "./parts";

interface Stage {
  id: string;
  title: string;
  who: ReactNode;
  what: ReactNode;
  detail: ReactNode;
  when: ReactNode;
  /** Part of the cycle that repeats every mark period. */
  cycle?: boolean;
}

const STAGES: Stage[] = [
  {
    id: "charter",
    title: "Charter",
    who: <Term id="sponsor">Sponsor</Term>,
    what: (
      <>
        A sponsor files a <Term id="charter">charter</Term>: the market's underlying, venue, oracle plan, trading sessions, insurance-fund size, the agent's
        mandate and the tranche terms.
      </>
    ),
    detail: "Filing pays a flat USDC charter fee, refunded if the charter is rejected, and locks the sponsor's BKRN bond.",
    when: "Whenever new books are open.",
  },
  {
    id: "committee",
    title: "Committee review",
    who: <Term id="riskCommittee" />,
    what: "A model jury reviews the charter and publishes its verdict. Then three bonded committee members vote.",
    detail: "Two approvals pass it, or three if the jury advised against. Approval deploys the book's contracts; rejection refunds the fee and unlocks the bond.",
    when: "Decided within 48 hours.",
  },
  {
    id: "subscription",
    title: "Subscription window",
    who: <Term id="allocator">Allocators</Term>,
    what: "Allocators deposit USDC into Senior or Junior while the window is open.",
    detail:
      "At close, commitments are allocated pro-rata with a per-wallet cap. The sponsor is allocated first in Junior and always holds at least 10% of it; Senior is capped at a share of book capital. Anything over is refunded. If the window fails its checks, the book is cancelled and every deposit is refundable 1:1.",
    when: (
      <>
        Length set in the charter. See <Term id="subscriptionWindow" />.
      </>
    ),
  },
  {
    id: "live",
    title: "Live",
    who: <Term id="bookrunnerAgent">Bookrunner agent</Term>,
    what: "The book funds the market's insurance fund first, then the market-making inventory. The agent quotes both sides and hedges with Stock Tokens, inside the mandate.",
    detail: "On-chain actions are checked by the mandate contract. Quoting on the venue is watched by the risk service, which can cancel quotes and revoke keys.",
    when: "From window close until the book retires.",
    cycle: true,
  },
  {
    id: "marks",
    title: "Marks",
    who: "Mark service, then anyone can apply",
    what: (
      <>
        Each period, fee flow runs down the <Term id="waterfall">waterfall</Term> and a signed <Term id="mark">mark</Term> records the book's NAV on-chain.
      </>
    ),
    detail: "Applying the mark moves share prices, books any loss in order (Junior, then Senior, then the backstop) and settles queued redemptions.",
    when: "Hourly on testnet, daily on mainnet.",
    cycle: true,
  },
  {
    id: "flows",
    title: "Top-ups and redemptions",
    who: "Sponsor and allocators",
    what: (
      <>
        The sponsor can open a <Term id="topUpRound">top-up round</Term> with a capacity per tranche. Holders can ask to redeem at any time.
      </>
    ),
    detail:
      "Top-up deposits wait in escrow and are accepted at the next mark, at that mark's share price. Senior redemptions settle at the next mark; Junior ones at the first mark after the notice period. Notice is not a gate: a request is always accepted, and no pause or kill can block it.",
    when: "Settled at marks.",
    cycle: true,
  },
  {
    id: "retire",
    title: "Retire",
    who: "Sponsor or committee",
    what: "The book winds down. The agent stops adding risk and flattens its hedges, and the insurance fund and inventory come back from the venue.",
    detail: "A final mark with nothing left deployed closes the book. Every holder then redeems at the final NAV.",
    when: "When the sponsor or the committee decides.",
  },
];

const CAST: Array<{ id: GlossaryId; label: string; body: string }> = [
  { id: "sponsor", label: "Sponsor", body: "Charters the market, posts a BKRN bond and holds at least 10% of Junior." },
  { id: "riskCommittee", label: "Risk Committee", body: "A model jury plus three bonded members; approves books 2-of-3." },
  { id: "allocator", label: "Allocators", body: "Fund the book in Senior or Junior and hold shares valued at NAV." },
  { id: "bookrunnerAgent", label: "Bookrunner agent", body: "Quotes and hedges the book, and can only take actions its mandate allows." },
];

export function LifecycleSection(props: { index: number }) {
  const base = useId();
  const [sel, setSel] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const stage = STAGES[sel] ?? STAGES[0];
  const last = STAGES.length - 1;

  const go = (i: number, focus = false) => {
    const n = Math.max(0, Math.min(last, i));
    setSel(n);
    if (focus) tabs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const map: Record<string, number> = { ArrowRight: sel + 1, ArrowDown: sel + 1, ArrowLeft: sel - 1, ArrowUp: sel - 1, Home: 0, End: last };
    const next = map[e.key];
    if (next === undefined) return;
    e.preventDefault();
    go(next < 0 ? last : next > last ? 0 : next, true);
  };

  return (
    <LearnSection
      id="lifecycle"
      index={props.index}
      eyebrow="Lifecycle"
      title="A book, end to end"
      lead="Every book follows the same path, from a sponsor's application to its last redemption. The middle of it repeats once per mark period for as long as the book is live."
    >
      <ul className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {CAST.map((c) => (
          <li key={c.id} className="rounded-control border border-line bg-surface-2/60 p-3">
            <div className="text-[13.5px] font-semibold text-ink">
              <Term id={c.id}>{c.label}</Term>
            </div>
            <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{c.body}</p>
          </li>
        ))}
      </ul>

      <Card padding="lg">
        <div className="relative md:pt-10">
          {/* the cycle that repeats each period: stages 4 to 6 */}
          <div className="pointer-events-none absolute top-0 hidden h-7 md:block" style={{ left: `${(3.5 / 7) * 100}%`, width: `${(2 / 7) * 100}%` }} aria-hidden>
            <div className="absolute inset-x-0 bottom-0 h-3 rounded-t-[10px] border-x-2 border-t-2 border-dashed border-accent/50" />
            <div className="absolute inset-x-0 -top-1 text-center">
              <span className="rounded-full bg-surface px-2 text-[11.5px] font-medium text-accent-text">repeats every period</span>
            </div>
          </div>
          <span className="absolute top-6 bottom-6 left-[15.5px] w-px bg-line-strong md:hidden" aria-hidden />
          <span className="absolute top-[55.5px] hidden h-px bg-line-strong md:block" style={{ left: `${(0.5 / 7) * 100}%`, right: `${(0.5 / 7) * 100}%` }} aria-hidden />
          <div role="tablist" aria-label="Stages of a book" className="relative grid grid-cols-1 gap-1 md:grid-cols-7 md:gap-0">
            {STAGES.map((s, i) => {
              const on = i === sel;
              const done = i < sel;
              return (
                <button
                  key={s.id}
                  ref={(el) => {
                    tabs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${base}-tab-${s.id}`}
                  aria-selected={on}
                  aria-controls={`${base}-panel`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => go(i)}
                  onKeyDown={onKey}
                  className="group flex min-h-11 items-center gap-3 rounded-control py-1.5 pr-2 text-left md:flex-col md:gap-2 md:px-1 md:py-0 md:text-center"
                >
                  <span
                    className={cx(
                      "tnum relative z-[1] inline-flex size-8 shrink-0 items-center justify-center rounded-full border text-[12.5px] font-semibold transition-[background,border-color,color,box-shadow] duration-200",
                      on && "border-accent bg-accent text-accent-ink ring-4 ring-accent-soft",
                      !on && done && "border-accent/60 bg-surface text-accent-text",
                      !on && !done && "border-line-strong bg-surface text-ink-2 group-hover:border-accent/60",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className={cx("block text-[13.5px] leading-snug md:text-[12.5px]", on ? "font-semibold text-ink" : "font-medium text-ink-2 group-hover:text-ink")}>{s.title}</span>
                    {s.cycle && <span className="block text-[11.5px] text-accent-text md:hidden">Repeats every period</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          id={`${base}-panel`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${stage?.id}`}
          tabIndex={0}
          className="mt-6 rounded-control border border-line bg-surface-2/60 p-4 focus-visible:outline-offset-4 sm:p-5"
        >
          {stage && (
            <div key={stage.id} className="fade-in">
              <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow">
                  Stage {sel + 1} of {STAGES.length}
                </span>
                {stage.cycle && (
                  <Badge tone="accent" size="sm">
                    Every period
                  </Badge>
                )}
              </div>
              <h3 className="mt-1.5 text-[19px] font-semibold tracking-[-0.01em] text-ink">{stage.title}</h3>
              <dl className="mt-3 grid gap-x-6 gap-y-3 text-[14px] sm:grid-cols-[120px_minmax(0,1fr)]">
                <dt className="font-medium text-muted">Who</dt>
                <dd className="text-ink">{stage.who}</dd>
                <dt className="font-medium text-muted">What happens</dt>
                <dd className="text-ink-2">{stage.what}</dd>
                <dt className="font-medium text-muted">In detail</dt>
                <dd className="text-ink-2">{stage.detail}</dd>
                <dt className="font-medium text-muted">When</dt>
                <dd className="text-ink-2">{stage.when}</dd>
              </dl>
              <div className="mt-5 flex flex-wrap justify-between gap-2">
                <button type="button" className="btn btn-sm" onClick={() => go(sel - 1)} disabled={sel === 0}>
                  Previous stage
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => go(sel + 1)} disabled={sel === last}>
                  Next stage <IconArrowRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </Card>
    </LearnSection>
  );
}
