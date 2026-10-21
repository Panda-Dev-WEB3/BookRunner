// What sits in front of pool depositors when a book's insurance fund is drawn (the book's Junior and Senior, then
// the treasury's first-loss slice), the first-loss slice explained, and the risks in plain words. Facts follow
// InsurancePool.sol and docs/ARCHITECTURE.md §2.10 (the backstop never funds the pool: owner ruling N-1).
import type { ReactNode } from "react";
import type { PoolOverviewOut } from "../../lib/api-types";
import { bpsPct, fmtDuration, fmtUsd } from "../../lib/format";
import { SERIES } from "../../lib/palette";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { cx } from "../cx";
import { Card, ProgressBar, Term } from "../ui";
import { DEFAULT_COOLDOWN_SEC, DEFAULT_FIRST_LOSS_LEVEL_BPS, DEFAULT_MARKET_CAP_BPS, DEFAULT_PREMIUM_FLOOR_BPS, POOL_RISK_LINES, firstLossView } from "./poolLogic";

function Layer(props: { order: string; title: ReactNode; body: string; className: string; text: string }) {
  return (
    <li className={cx("flex min-w-0 items-start gap-3 rounded-control border p-3", props.className)}>
      <span className={cx("mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] border bg-surface text-[11px] font-semibold tnum", props.text)} aria-hidden>
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

/** Loss order for a drawn pool-funded insurance fund. */
export function PoolLossOrder() {
  return (
    <figure className="m-0">
      <div className="relative rounded-card border border-line bg-surface p-4 pl-11 shadow-card">
        <span className="absolute top-12 bottom-9 left-[19px] w-0.5 rounded-full bg-loss" aria-hidden />
        <svg className="absolute bottom-5 left-3" width="16" height="12" viewBox="0 0 16 12" aria-hidden>
          <path d="M2 2 L8 10 L14 2" fill="none" stroke={SERIES.loss} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="mb-3 text-[12px] font-semibold text-loss-ink">If a book's insurance fund is drawn, the loss lands here, in this order</div>
        <ol className="space-y-2">
          <Layer order="1" title={<Term id="junior">That book's Junior</Term>} body="Takes the book's losses first, insurance fund draws included." className="border-junior/45 bg-junior/14" text="text-junior-ink" />
          <Layer order="2" title={<Term id="senior">That book's Senior</Term>} body="Then Senior. The backstop pool never pays the book's debt to the insurance pool." className="border-senior/40 bg-senior/12" text="text-senior-ink" />
          <Layer
            order="3"
            title={<Term id="firstLossSlice">First-loss slice (treasury)</Term>}
            body="What the book cannot repay is the pool's loss. The treasury's slice takes it first."
            className="border-backstop/40 bg-backstop/[0.08]"
            text="text-backstop-ink"
          />
          <Layer order="4" title="Depositors' shares" body="Only then does the share price fall, for every share alike, queued withdrawals included." className="border-loss/40 bg-loss/[0.08]" text="text-loss-ink" />
        </ol>
      </div>
      <figcaption className="sr-only">A drawn insurance fund is first the book's loss: Junior, then Senior. What the book cannot repay lands on the first-loss slice, then on depositors' shares.</figcaption>
    </figure>
  );
}

export function FirstLossExplainer({ overview }: { overview: PoolOverviewOut | undefined }) {
  const sym = useSettlementSymbol();
  const level = overview?.params?.firstLossTargetBps ?? DEFAULT_FIRST_LOSS_LEVEL_BPS;
  const fl = overview ? firstLossView(overview.firstLossBps, level) : null;
  return (
    <Card title="The first-loss slice" padding="md">
      <div className="space-y-3 text-[13px] text-ink-2">
        <p>
          The treasury keeps its own money inside the pool, at least {bpsPct(level)} of the pool's value. It holds no shares: it is kept apart, receives premiums at the same rate as depositors, and takes any
          pool loss before depositors do. A recovery repays depositors first, then the slice.
        </p>
        <p>While the slice is below its required size, the pool lends to no new book. The treasury can take money out of it only through the timelock, never while withdrawals are due, and never below {bpsPct(level)}.</p>
        {overview && fl && (
          <div className="rounded-control border border-line bg-surface-2/70 p-3">
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span>Now</span>
              <span className="num font-medium text-ink">
                {fmtUsd(overview.firstLossUsd)} {sym} · {bpsPct(fl.bps, 1)}
              </span>
            </div>
            <ProgressBar className="mt-2" size="md" value={fl.fill} tone={fl.below ? "warn" : "backstop"} label="First-loss slice against its required size" />
            <div className="mt-1.5 text-[11.5px] text-muted">{fl.text}</div>
          </div>
        )}
      </div>
    </Card>
  );
}

export function PoolRiskBox() {
  return (
    <Card tone="muted" title="In plain words" padding="md">
      <ul className="list-disc space-y-1.5 pl-4 text-[13px] text-ink-2">
        {POOL_RISK_LINES.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </Card>
  );
}

export function PoolRisks({ overview }: { overview: PoolOverviewOut | undefined }) {
  const p = overview?.params;
  const floor = bpsPct(p?.premiumFloorBps ?? DEFAULT_PREMIUM_FLOOR_BPS);
  const cap = bpsPct(p?.marketCapBps ?? DEFAULT_MARKET_CAP_BPS);
  const cooldown = fmtDuration(p?.cooldownSeconds ?? DEFAULT_COOLDOWN_SEC);
  const risks: Array<{ title: string; body: ReactNode }> = [
    {
      title: "A book can be wiped out",
      body: "If a book's Junior and Senior are used up and its insurance fund was drawn, the pool cannot get that money back: the first-loss slice takes the loss, then the share price falls.",
    },
    {
      title: "Exits wait for the epoch",
      body: `Withdrawals are queued to the weekly epoch and priced when it is processed. Deposits start a cooldown of ${cooldown}. If free cash is short, a request fills partly and the rest stays queued, and exposed, until the next processing.`,
    },
    {
      title: "Most of the pool can be lent out",
      body: "Money lent to books comes back when books repay or retire. Withdrawals fill only from free cash, so a busy pool can take several epochs to pay a large exit.",
    },
    { title: "Concentration", body: `The books on one market can draw up to ${cap} of the pool between them.` },
    { title: "The premium varies", body: `The premium is a share of each pool-funded book's gross fee flow (the charter's rate, at least the ${floor} floor). It follows trading activity and can be zero.` },
    { title: "New contract", body: "The insurance pool is new code and gets a focused external review before mainnet. Upgrades and parameter changes go through the protocol timelock." },
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <PoolLossOrder />
        <PoolRiskBox />
      </div>
      <Card title="What can go wrong" padding="md">
        <ul className="space-y-3">
          {risks.map((r) => (
            <li key={r.title}>
              <div className="text-[13.5px] font-semibold text-ink">{r.title}</div>
              <div className="text-[12.5px] text-ink-2">{r.body}</div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
