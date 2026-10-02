// Risks of staking, in plain words, plus a diagram of where staked BKRN sits relative to the loss
// order (Junior -> Senior -> backstop pool): outside it. Only locked bonds can be slashed
// (MarketCharter.slashSponsor via the committee, RiskCommittee.slashMember via the timelock).
import type { ReactNode } from "react";
import { SERIES } from "../../lib/palette";
import { cx } from "../cx";
import { IconShield } from "../icons";
import { Card, Term } from "../ui";

function LossLayer(props: { order: string; title: ReactNode; body: string; className: string; text: string; swatch: string }) {
  return (
    <li className={cx("flex min-w-0 items-start gap-3 rounded-control border p-3", props.className)}>
      <span className={cx("mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] border text-[11px] font-semibold tnum", props.swatch, props.text)} aria-hidden>
        {props.order}
      </span>
      <span className="min-w-0">
        <span className={cx("block text-[13.5px] font-semibold", props.text)}>
          <span className="sr-only">{`${props.order}. `}</span>
          {props.title}
        </span>
        <span className="block text-[12.5px] text-ink-2">{props.body}</span>
      </span>
    </li>
  );
}

/** Loss order on the left, staked BKRN set apart on the right. */
export function LossOrderDiagram() {
  return (
    <figure className="m-0 grid gap-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] md:items-stretch lg:grid-cols-1">
      <div className="relative rounded-card border border-line bg-surface p-4 pl-11 shadow-card">
        <span className="absolute top-12 bottom-9 left-[19px] w-0.5 rounded-full bg-loss" aria-hidden />
        <svg className="absolute bottom-5 left-3" width="16" height="12" viewBox="0 0 16 12" aria-hidden>
          <path d="M2 2 L8 10 L14 2" fill="none" stroke={SERIES.loss} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="mb-3 text-[12px] font-semibold text-loss-ink">If a book loses money, the loss lands here, in this order</div>
        <ol className="space-y-2">
          <LossLayer order="1" title={<Term id="junior">Junior</Term>} body="Absorbs losses first." className="border-junior/45 bg-junior/14" swatch="border-junior/50 bg-surface" text="text-junior-ink" />
          <LossLayer
            order="2"
            title={<Term id="senior">Senior</Term>}
            body="Takes losses only once Junior is used up."
            className="border-senior/40 bg-senior/12"
            swatch="border-senior/45 bg-surface"
            text="text-senior-ink"
          />
          <LossLayer
            order="3"
            title={<Term id="backstop">Backstop pool (USDC)</Term>}
            body="Then covers Senior's shortfall, up to what the pool holds."
            className="border-backstop/40 bg-backstop/[0.08]"
            swatch="border-backstop/45 bg-surface"
            text="text-backstop-ink"
          />
        </ol>
      </div>
      <div className="flex flex-col justify-center rounded-card border-2 border-dashed border-bkrn/40 bg-bkrn/[0.06] p-4">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-[3px] bg-bkrn" aria-hidden />
          <span className="text-[13.5px] font-semibold text-bkrn-ink">Staked BKRN</span>
        </div>
        <p className="mt-1.5 text-[13px] text-ink-2">Not part of the loss order. Book losses never draw on staked BKRN. Only the part locked as a bond can be slashed, and only for the role holder's own conduct.</p>
      </div>
      <figcaption className="sr-only">
        Losses hit Junior first, then Senior, then the USDC backstop pool up to what it holds. Staked BKRN is outside this order.
      </figcaption>
    </figure>
  );
}

const RISKS: Array<{ title: string; body: ReactNode }> = [
  {
    title: "Bonds can be slashed",
    body: (
      <>
        A <Term id="sponsor">sponsor</Term>'s bond can be slashed by the Risk Committee if the sponsor abandons a live book. A committee member's bond can be slashed by protocol governance. Agent
        operator bonds are locked and released by each book's mandate. Slashed BKRN goes to the protocol's slash address. Stake that is not locked cannot be slashed.
      </>
    ),
  },
  {
    title: "The price of BKRN moves",
    body: "Staking does not fix what BKRN is worth. Its market price can fall while it is staked or cooling down, and the cooldown means you cannot sell it at once.",
  },
  {
    title: "Nothing is promised",
    body: "BKRN shared with stakers depends on how much fee flow books collect and on when a keeper runs a buyback. It has no fixed rate, can be zero, and past amounts say nothing about the next ones.",
  },
  {
    title: "Contracts can have bugs",
    body: "The contracts are public and every figure here is read from them, but software can fail. Only stake what you can afford to have locked or lost.",
  },
];

export function StakeRisks() {
  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <LossOrderDiagram />
      <Card padding="lg" className="space-y-0">
        <div className="mb-4 flex items-center gap-2 text-critical-ink">
          <IconShield size={18} />
          <h3 className="text-[15.5px] font-semibold text-ink">Before you stake</h3>
        </div>
        <ul className="space-y-4">
          {RISKS.map((r) => (
            <li key={r.title}>
              <div className="text-[13.5px] font-semibold text-ink">{r.title}</div>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{r.body}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
