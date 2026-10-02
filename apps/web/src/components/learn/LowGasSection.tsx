// 7. Low gas by design (docs/LOW_GAS.md): prices travel inside the transactions that need them, and one
// mark transaction per book per period carries everything else. Two timelines compare the approaches.
import type { ReactNode } from "react";
import { cx } from "../cx";
import { Term } from "../Term";
import { Card } from "../ui";
import { Figure, LearnSection } from "./parts";
import { useLiveBooks } from "./useLearnData";

const TIMER_TICKS = 40;
/** Where users happen to trade during the period (illustrative positions, 0..1). */
const TRADES = [0.13, 0.21, 0.46, 0.52, 0.58, 0.81];

const IDEAS = [
  {
    title: "Prices ride in your transaction",
    term: "pullOracle" as const,
    body: "The oracle signs prices off-chain. A transaction that needs a price, such as a trade, carries the signed price with it and the contract checks the signature first. Nobody pays to push prices nobody reads.",
  },
  {
    title: "One mark transaction per period",
    term: "mark" as const,
    body: "The signed prices, the venue's signed balance report and the mark itself go on-chain together, in a single transaction per book per period. It commits and applies the mark in one step.",
  },
  {
    title: "Skip empty work",
    term: "feeFlow" as const,
    body: "No fee sweep when the venue settled nothing, no recall unless a redemption is due, and the agent only re-quotes on-chain when its quote really moves.",
  },
];

/** Estimates from docs/LOW_GAS.md for 3 idle books on testnet at 0.01 gwei, daily marks. */
const ESTIMATE: Array<[string, string, string]> = [
  ["Oracle price updates", "about 47,000 a day", "0: prices ride in users' transactions"],
  ["Venue balance reports", "about 10,000 a day", "0: carried in the mark transaction"],
  ["Marks", "about 1,700 a day", "3 a day: one per book"],
  ["Fee distributions", "about 1,150 a day", "at most 3 a day, 0 without fees"],
  ["Total cost", "about 0.05 ETH a day", "about 0.00003 ETH a day"],
];

function Lane(props: { title: string; sub: string; children: ReactNode; accent?: boolean }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <div className={cx("text-[13.5px] font-semibold", props.accent ? "text-accent-text" : "text-ink")}>{props.title}</div>
        <div className="text-[12px] text-muted">{props.sub}</div>
      </div>
      <div className="relative mt-2 h-12 rounded-control border border-line bg-surface-2/60">
        <span className="absolute inset-x-3 top-1/2 h-px bg-line-strong" aria-hidden />
        {props.children}
      </div>
    </div>
  );
}

export function LowGasSection(props: { index: number }) {
  const list = useLiveBooks();
  const cadence = list.data?.[0]?.markSchedule.cadence ?? null;
  return (
    <LearnSection
      id="low-gas"
      index={props.index}
      eyebrow="Low gas"
      title="Pay only when something happens"
      lead={
        <>
          Every write to the chain costs <Term id="gas">gas</Term>. Bookrunner is built so an idle book costs close to nothing: on-chain writes are either part of
          a user's own transaction or one mark transaction per book per period.
        </>
      }
    >
      <ul className="grid gap-3 md:grid-cols-3">
        {IDEAS.map((i) => (
          <li key={i.title} className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h3 className="text-[14.5px] font-semibold text-ink">{i.title}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{i.body}</p>
            <p className="mt-2 text-[12px] text-muted">
              Term: <Term id={i.term} />
            </p>
          </li>
        ))}
      </ul>

      <Figure
        className="mt-6"
        label="Chain writes over one mark period"
        caption={`Chain writes over one mark period, drawn to show the shape, not to scale.${cadence ? ` Marks on this network: ${cadence}.` : ""}`}
      >
        <div className="space-y-5">
          <Lane title="Pushing prices on a timer" sub="a write every few seconds, used or not">
            {Array.from({ length: TIMER_TICKS }, (_, i) => (
              <span key={i} className="absolute top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-muted/60" style={{ left: `calc(12px + (100% - 24px) * ${i / (TIMER_TICKS - 1)})` }} aria-hidden />
            ))}
          </Lane>
          <Lane title="Bookrunner" sub="prices inside trades, one mark at the end" accent>
            {TRADES.map((t) => (
              <span key={t} className="absolute top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-ink-2/70" style={{ left: `calc(12px + (100% - 24px) * ${t})` }} aria-hidden />
            ))}
            <span className="absolute top-1/2 right-1.5 inline-flex h-7 -translate-y-1/2 items-center rounded-full bg-accent px-2 text-[11px] font-semibold text-accent-ink" aria-hidden>
              Mark
            </span>
          </Lane>
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12px] text-ink-2">
            <li className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-[2px] rounded-full bg-muted/60" aria-hidden />
              Timer price push (paid by the protocol)
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-[2px] rounded-full bg-ink-2/70" aria-hidden />A trade carrying its own price (paid by the trader)
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-5 rounded-full bg-accent" aria-hidden />
              The period's single mark transaction
            </li>
          </ul>
        </div>
      </Figure>

      <Card className="mt-6" title="What it saves" description="Design estimate for three idle books at 0.01 gwei with daily marks, from the protocol's low-gas design notes." padding="md">
        <div role="table" aria-label="Chain writes, pushing on a timer compared with Bookrunner" className="text-[13px]">
          <div role="row" className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-4 border-b border-line pb-2 text-[12px] font-medium text-muted sm:grid">
            <span role="columnheader">Chain writes</span>
            <span role="columnheader">Pushing on a timer</span>
            <span role="columnheader">Bookrunner</span>
          </div>
          {ESTIMATE.map(([what, before, after]) => (
            <div key={what} role="row" className="grid gap-x-4 gap-y-0.5 border-b border-line py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
              <span role="rowheader" className="font-medium text-ink">
                {what}
              </span>
              <span role="cell" className="text-ink-2">
                <span className="text-muted sm:hidden">On a timer: </span>
                {before}
              </span>
              <span role="cell" className="text-ink">
                <span className="text-muted sm:hidden">Bookrunner: </span>
                {after}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-muted">
          Estimates, not measurements. Testnet marks run hourly, which the same notes put at about 0.0002 ETH a day for three books. Activity such as trades is
          paid by whoever sends it.
        </p>
      </Card>
    </LearnSection>
  );
}
