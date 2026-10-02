// 3. The two tranches: Senior and Junior side by side, the tranche stack (fee flow enters at the top,
// losses rise from the bottom, the backstop sits beside Senior) and the live split of the testnet books.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { TRANCHE_COPY } from "../../lib/copy";
import { fmtUsd, tickerOf, usdRaw } from "../../lib/format";
import { SERIES, SERIES_INK } from "../../lib/palette";
import { cx } from "../cx";
import { Term } from "../Term";
import { Callout, Card, ErrorState, SkeletonRows, TrancheBadge, ValueKind } from "../ui";
import { Figure, LearnSection } from "./parts";
import { share } from "./sim";
import { markedBooks, useLiveBooks } from "./useLearnData";

interface Row {
  label: string;
  senior: ReactNode;
  junior: ReactNode;
}

const ROWS: Row[] = [
  {
    label: "Fee flow",
    senior: (
      <>
        Paid first: its <Term id="hurdle">hurdle share</Term> of what is left after expenses and carry.
      </>
    ),
    junior: "The residual: everything left after Senior's share. This is where the upside sits.",
  },
  {
    label: "Losses",
    senior: "Last. Senior only takes a loss once Junior is used up.",
    junior: "First. Junior absorbs losses before Senior is touched.",
  },
  {
    label: "Backstop",
    senior: (
      <>
        The <Term id="backstop">backstop</Term> may cover a Senior shortfall once Junior is used up, up to what the pool holds.
      </>
    ),
    junior: "No cover. Junior is the cushion the rest of the book stands on.",
  },
  {
    label: "Redemptions",
    senior: "Settle at NAV at the next mark, with no notice period.",
    junior: (
      <>
        Settle at NAV at the first mark after the <Term id="redemptionNotice">notice period</Term>. Notice is not a gate.
      </>
    ),
  },
  {
    label: "Size",
    senior: "Capped at a share of book capital set in the charter.",
    junior: "The rest of the book. The sponsor holds at least 10% of it.",
  },
  {
    label: "Who it suits",
    senior: "Allocators who would rather stand further back from losses, and accept a capped share of fee flow for it.",
    junior: "Allocators who accept taking losses first in exchange for the residual fee flow.",
  },
];

function TrancheColumn(props: { kind: "senior" | "junior" }) {
  const k = props.kind;
  return (
    <Card as="article" padding="none" className={cx("overflow-hidden border-t-4", k === "senior" ? "border-t-senior" : "border-t-junior")} aria-label={`${TRANCHE_COPY[k].name} tranche`}>
      <div className="p-4 sm:p-5">
        <TrancheBadge tranche={k} term />
        <p className="mt-3 text-[14px] leading-relaxed text-ink">{TRANCHE_COPY[k].line}</p>
      </div>
      <dl className="divide-y divide-line border-t border-line">
        {ROWS.map((r) => (
          <div key={r.label} className="grid gap-1 px-4 py-3 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-4 sm:px-5">
            <dt className="text-[12.5px] font-medium text-muted">{r.label}</dt>
            <dd className="text-[13.5px] leading-relaxed text-ink-2">{k === "senior" ? r.senior : r.junior}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Tranche stack: Senior on top of Junior, losses rising from below, backstop beside Senior. */
export function TrancheStack() {
  return (
    <svg viewBox="0 0 360 420" className="mx-auto block h-auto w-full max-w-[400px]" role="img" aria-labelledby="stack-title stack-desc">
      <title id="stack-title">The tranche stack</title>
      <desc id="stack-desc">
        Fee flow enters at the top and pays Senior first, then Junior. Losses rise from the bottom and hit Junior first, then Senior. The backstop sits beside
        Senior and covers a Senior shortfall once Junior is used up, up to what the pool holds.
      </desc>
      <defs>
        <marker id="stack-arrow-fee" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" fill={SERIES.fee} />
        </marker>
        <marker id="stack-arrow-loss" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" fill={SERIES.loss} />
        </marker>
        <marker id="stack-arrow-bk" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" fill={SERIES.backstop} />
        </marker>
        <pattern id="stack-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" stroke={SERIES.backstop} strokeWidth="2" strokeOpacity="0.35" />
        </pattern>
      </defs>

      {/* fee flow in at the top */}
      <text x="130" y="18" textAnchor="middle" fontSize="13" fontWeight="600" fill={SERIES_INK.fee}>
        Fee flow in
      </text>
      <line x1="130" y1="26" x2="130" y2="62" stroke={SERIES.fee} strokeWidth="3" markerEnd="url(#stack-arrow-fee)" />

      {/* Senior */}
      <rect x="30" y="70" width="200" height="150" rx="10" fill={SERIES.senior} fillOpacity="0.14" stroke={SERIES.senior} strokeWidth="1.5" />
      <text x="48" y="100" fontSize="16" fontWeight="700" fill={SERIES_INK.senior}>
        Senior
      </text>
      <text x="48" y="124" fontSize="12.5" fill="var(--ink-2)">
        Paid first, up to its
      </text>
      <text x="48" y="141" fontSize="12.5" fill="var(--ink-2)">
        hurdle share
      </text>
      <text x="48" y="200" fontSize="12.5" fontWeight="600" fill="var(--ink-2)">
        Loses last
      </text>

      {/* Junior */}
      <rect x="30" y="226" width="200" height="120" rx="10" fill={SERIES.junior} fillOpacity="0.16" stroke={SERIES.junior} strokeWidth="1.5" />
      <text x="48" y="256" fontSize="16" fontWeight="700" fill={SERIES_INK.junior}>
        Junior
      </text>
      <text x="48" y="280" fontSize="12.5" fill="var(--ink-2)">
        Gets the residual
      </text>
      <text x="48" y="328" fontSize="12.5" fontWeight="600" fill="var(--ink-2)">
        Loses first
      </text>

      {/* losses rise from below */}
      <line x1="130" y1="404" x2="130" y2="356" stroke={SERIES.loss} strokeWidth="3" markerEnd="url(#stack-arrow-loss)" />
      <text x="146" y="396" fontSize="13" fontWeight="600" fill={SERIES_INK.loss}>
        Losses in
      </text>

      {/* backstop beside Senior */}
      <rect x="258" y="88" width="88" height="116" rx="10" fill="url(#stack-hatch)" stroke={SERIES.backstop} strokeWidth="1.5" strokeDasharray="4 3" />
      <rect x="258" y="88" width="88" height="116" rx="10" fill={SERIES.backstop} fillOpacity="0.06" />
      <text x="302" y="116" textAnchor="middle" fontSize="13.5" fontWeight="700" fill={SERIES_INK.backstop}>
        Backstop
      </text>
      <text x="302" y="138" textAnchor="middle" fontSize="11.5" fill="var(--ink-2)">
        shared pool
      </text>
      <text x="302" y="166" textAnchor="middle" fontSize="11.5" fill="var(--ink-2)">
        covers Senior
      </text>
      <text x="302" y="182" textAnchor="middle" fontSize="11.5" fill="var(--ink-2)">
        up to the pool
      </text>
      <line x1="256" y1="146" x2="238" y2="146" stroke={SERIES.backstop} strokeWidth="2.5" markerEnd="url(#stack-arrow-bk)" />
      <text x="302" y="228" textAnchor="middle" fontSize="11" fill="var(--muted)">
        only once Junior
      </text>
      <text x="302" y="243" textAnchor="middle" fontSize="11" fill="var(--muted)">
        is used up
      </text>
    </svg>
  );
}

function LiveSplit() {
  const q = useLiveBooks();
  const books = markedBooks(q.data);
  if (q.isLoading) return <SkeletonRows rows={3} />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />;
  if (books.length === 0) return <p className="text-[13px] text-muted">No book has a mark yet.</p>;
  return (
    <ul className="space-y-4">
      {books.map((b) => {
        const s = usdRaw(b.seniorNavUsd) ?? 0n;
        const j = usdRaw(b.juniorNavUsd) ?? 0n;
        const total = s + j;
        const sw = share(s, total) * 100;
        return (
          <li key={b.bookId}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <Link to={`/books/${b.bookId}`} className="link text-[13.5px] font-semibold">
                {tickerOf(b.symbol)}
              </Link>
              <span className="num text-[12px] text-ink-2">{fmtUsd(total, { compact: true, symbol: true })} marked NAV</span>
            </div>
            <div className="mt-1.5 flex h-3 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label={`${tickerOf(b.symbol)}: Senior ${fmtUsd(s, { dp: 0 })} USDC, Junior ${fmtUsd(j, { dp: 0 })} USDC`}>
              <span className="h-full bg-senior" style={{ width: `${sw}%` }} />
              <span className="h-full flex-1 bg-junior" />
            </div>
            <div className="num mt-1 flex justify-between text-[11.5px] text-ink-2">
              <span>Senior {fmtUsd(s, { compact: true })}</span>
              <span>Junior {fmtUsd(j, { compact: true })}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function TranchesSection(props: { index: number }) {
  return (
    <LearnSection
      id="tranches"
      index={props.index}
      eyebrow="Tranches"
      title="Two tranches, one clear order"
      lead={
        <>
          Every book is split into <Term id="senior">Senior</Term> and <Term id="junior">Junior</Term>. They hold the same book. What differs is who is paid first
          and who takes losses first.
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <TrancheColumn kind="senior" />
        <TrancheColumn kind="junior" />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Figure label="Tranche stack" caption="Money moves down the stack, losses move up it. Senior is last loss, not no loss.">
          <TrancheStack />
        </Figure>
        <Card
          title="Live split on testnet"
          description="Marked Senior and Junior NAV of each book, from its latest signed mark."
          actions={<ValueKind kind="marked" />}
        >
          <LiveSplit />
          <p className="mt-5 text-[12.5px] text-muted">
            Senior is capped at a share of each book, so there is always Junior in front of it. The bigger the Junior slice, the larger the loss it can absorb
            before Senior is touched.
          </p>
        </Card>
      </div>
      <Callout tone="neutral" className="mt-6" title="A description, not a recommendation">
        Which tranche fits depends on how much loss you can take. Neither tranche promises an amount of fee flow, and Senior can still lose money if losses use up
        Junior and the backstop.
      </Callout>
    </LearnSection>
  );
}
