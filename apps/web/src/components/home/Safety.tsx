// Safety: how risk is kept in bounds (mandate limits, hedge band, off-hours rule, kill switch, loss
// order, signed marks), each book's live limit state, and the honest limits of those controls.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { POLL, trpc } from "../../api/trpc";
import { tickerOf } from "../../lib/format";
import { limitState } from "../../lib/limits";
import { IconArrowRight, IconLayers, IconShield, IconWarn } from "../icons";
import { Callout, Section, StateChip, Term, TrancheBadge } from "../ui";
import { IconGauge, IconMoon, IconReceipt } from "./art";

interface Control {
  id: string;
  title: ReactNode;
  icon: ReactNode;
  body: ReactNode;
  extra?: ReactNode;
}

const CONTROLS: Control[] = [
  {
    id: "mandate",
    title: <Term id="mandate">Mandate limits</Term>,
    icon: <IconGauge size={18} />,
    body: "Every charter fixes a minimum quote spread, a maximum skew and a maximum inventory. On-chain actions are checked by the mandate contract; quoting on the venue is monitored, and keys are revoked on a breach.",
  },
  {
    id: "hedge",
    title: <Term id="hedgeBand">Hedge band</Term>,
    icon: <IconLayers size={18} />,
    body: "Part of the book's exposure must be offset with Stock Tokens, for example 50% to 120%. A hedge trade has to stay in the band or move closer to it.",
  },
  {
    id: "offhours",
    title: "Reduce-only off-hours",
    icon: <IconMoon size={18} />,
    body: "When the stock market is closed and the price feed holds, the agent may only reduce risk. Quoting against a frozen price would invite one-sided trades.",
  },
  {
    id: "kill",
    title: <Term id="killSwitch">Kill switch</Term>,
    icon: <IconWarn size={18} />,
    body: "If the drawdown reaches the kill level in the charter, or a limit is breached, quoting stops, keys are revoked and positions are flattened. A kill never blocks redemptions.",
  },
  {
    id: "loss",
    title: "Loss order",
    icon: <IconShield size={18} />,
    body: "Losses hit Junior first, then Senior. The backstop may cover a Senior shortfall once that book's Junior is used up, and only up to what the pool holds.",
    extra: (
      <ol className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Order in which losses are absorbed">
        <li>
          <TrancheBadge tranche="junior" size="sm">
            1 Junior
          </TrancheBadge>
        </li>
        <li aria-hidden className="text-muted">
          <IconArrowRight size={13} />
        </li>
        <li>
          <TrancheBadge tranche="senior" size="sm">
            2 Senior
          </TrancheBadge>
        </li>
        <li aria-hidden className="text-muted">
          <IconArrowRight size={13} />
        </li>
        <li>
          <TrancheBadge tranche="backstop" size="sm">
            3 Backstop
          </TrancheBadge>
        </li>
      </ol>
    ),
  },
  {
    id: "marks",
    title: <Term id="mark">Signed marks</Term>,
    icon: <IconReceipt size={18} />,
    body: "Each period one transaction commits a signed statement of NAV, inventory and P&L with a receipts root. Anyone can check a quote, fill or hedge against it.",
    extra: (
      <Link to="/books" className="link mt-3 inline-flex items-center gap-1 text-[13px]">
        Verify on a book page
        <IconArrowRight size={13} />
      </Link>
    ),
  },
];

export function Safety() {
  return (
    <Section id="safety" eyebrow="Safety" title="How risk is kept in bounds" lead="Limits are set in the charter before a book takes a deposit, checked while it runs, and every result is signed.">
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CONTROLS.map((c) => (
          <li key={c.id} className="flex gap-3.5 rounded-card border border-line bg-surface p-5 shadow-card">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-text" aria-hidden>
              {c.icon}
            </span>
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{c.title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{c.body}</p>
              {c.extra}
            </div>
          </li>
        ))}
      </ul>
      <LiveLimits />
      <Callout tone="neutral" className="mt-6" title="What these controls do not do">
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Senior is last loss, not no loss. The backstop pays only up to its balance.</li>
          <li>On Orderly books the venue holds margin and runs liquidations: the book's exposure is bounded by its deposits, not removed.</li>
          <li>Venue quoting is enforced by monitoring and key revocation; the venue's own position caps are the hard stop for a compromised key.</li>
          <li>Prices come from an attested, multi-source oracle. It is still an oracle, and it can be wrong.</li>
        </ul>
      </Callout>
    </Section>
  );
}

/** Each listed book's limit state right now (from the risk service, via the API). */
function LiveLimits() {
  const q = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.list });
  const books = [...(q.data ?? [])].sort((a, b) => a.bookId - b.bookId);
  if (books.length === 0) return null;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line bg-surface-2/60 px-4 py-3 text-[13px]" role="group" aria-label="Limit state of each book right now">
      <span className="flex items-center gap-2 font-medium text-ink">
        <span className="live-dot" aria-hidden />
        Right now
      </span>
      {books.map((b) => (
        <span key={b.bookId} className="inline-flex items-center gap-2">
          <span className="font-semibold text-ink">{tickerOf(b.symbol)}</span>
          <StateChip meta={limitState(b.limits?.state)} />
        </span>
      ))}
      <Link to="/risk" className="link ml-auto text-[12.5px]">
        Risk view
      </Link>
    </div>
  );
}
