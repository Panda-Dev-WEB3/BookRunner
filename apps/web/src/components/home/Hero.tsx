// Home hero: value proposition, the wallet call to action, the live strip (books, capital, latest mark)
// and a capital-stack picture of all books (Senior / Junior from the latest marks, plus the shared
// backstop pool read on-chain).
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { useNow, useQueryError } from "../../api/hooks";
import { POLL, trpc } from "../../api/trpc";
import { DASH, fmtUsd, shortHex } from "../../lib/format";
import { ageOf, nextMarkLabel } from "../../lib/lowgas";
import { SERIES_CLASS } from "../../lib/palette";
import { useBackstopBalance } from "../../wallet/backstop";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { appChain } from "../../wallet/chains";
import { useConnectModal } from "../../wallet/ConnectModal";
import { isTestChain } from "../../wallet/network";
import { useWallet } from "../../wallet/WalletContext";
import { cx } from "../cx";
import { IconArrowRight, IconWallet } from "../icons";
import { Badge, Card, Container, Skeleton, Stat, Term, ValueKind } from "../ui";
import { type BooksSummary, sharePct, summarizeBooks, trancheSplit } from "./model";

export function Hero() {
  const q = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.list });
  const error = useQueryError(q);
  const summary = q.data ? summarizeBooks(q.data) : null;
  return (
    <section className="hero-glow border-b border-line" aria-labelledby="home-title">
      <Container className="py-12 sm:py-16 lg:py-20">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14">
          <HeroCopy />
          <CapitalStack summary={summary} loading={q.data === undefined && !error} />
        </div>
        <LiveStrip summary={summary} loading={q.data === undefined && !error} failed={q.data === undefined && !!error} onRetry={() => void q.refetch()} />
      </Container>
    </section>
  );
}

function HeroCopy() {
  const w = useWallet();
  const modal = useConnectModal();
  return (
    <div className="min-w-0">
      <Badge tone="accent" dot>
        Stock perps on {appChain.name}
      </Badge>
      <h1 id="home-title" className="mt-5 text-[36px] leading-[1.06] font-semibold tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[56px]">
        Be the house for one perp market.
      </h1>
      <p className="mt-5 max-w-xl text-[16.5px] leading-relaxed text-ink-2 sm:text-[18px]">
        <Term id="allocator">Allocators</Term> fund a single market through a <Term id="senior">Senior</Term> or a <Term id="junior">Junior</Term> tranche. A software agent
        quotes and hedges that market under a <Term id="mandate">mandate</Term> enforced in code, and the market's <Term id="feeFlow">fee flow</Term> is shared out by fixed
        rules.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        {w.active ? (
          <Link to="/invest" className="btn btn-primary btn-lg">
            Invest
            <IconArrowRight size={16} />
          </Link>
        ) : (
          <button type="button" className="btn btn-primary btn-lg" onClick={modal.open}>
            <IconWallet size={17} />
            Connect wallet
          </button>
        )}
        <Link to="/learn" className="btn btn-lg">
          How it works
        </Link>
      </div>
      <p className="mt-4 text-[13px] text-ink-2">
        {w.active ? (
          <>
            Connected with {w.active.label} as <span className="num">{shortHex(w.active.address, 6, 4)}</span>.
          </>
        ) : (
          "Connecting shares your address only. Your wallet asks before every transaction."
        )}
        {isTestChain && " Testnet tokens have no value."}
      </p>
    </div>
  );
}

function LiveStrip(props: { summary: BooksSummary | null; loading: boolean; failed: boolean; onRetry: () => void }) {
  const now = useNow(5_000);
  const s = props.summary;
  return (
    <Card as="section" className="mt-10 sm:mt-14" padding="md" aria-label="Live protocol figures">
      {props.failed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-[13.5px]" role="status">
          <span className="text-ink-2">Live figures are unavailable right now: the API did not answer.</span>
          <button type="button" className="btn btn-sm" onClick={props.onRetry}>
            Retry now
          </button>
        </div>
      ) : (
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
          <LiveItem label="Live books" loading={props.loading} value={s ? String(s.live) : DASH} sub={s && s.liveTickers.length > 0 ? s.liveTickers.join(" · ") : "No live book yet"} />
          <LiveItem
            label={<Term id="nav">Capital in the books</Term>}
            kind="marked"
            loading={props.loading}
            value={s?.hasNav ? fmtUsd(s.navRaw, { symbol: true, compact: true }) : DASH}
            sub="Sum of the latest marked NAVs"
          />
          <LiveItem
            label={<Term id="mark">Latest mark</Term>}
            loading={props.loading}
            value={s?.latestMarkAt ? ageOf(s.latestMarkAt, now) : "No mark yet"}
            sub={s?.nextMark ? `Next ${nextMarkLabel(s.nextMark, now)} · ${s.nextMark.cadence} marks` : "Marks start once a book is live"}
          />
        </dl>
      )}
    </Card>
  );
}

function LiveItem(props: { label: ReactNode; value: string; sub: string; loading: boolean; kind?: "marked" }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-2 text-[12.5px] font-medium text-ink-2">
        {props.label}
        {props.kind && <ValueKind kind={props.kind} compact />}
      </dt>
      <dd className="mt-1.5">
        {props.loading ? (
          <>
            <Skeleton className="h-8 w-24" />
            <Skeleton className="mt-2 h-3.5 w-36" />
          </>
        ) : (
          <>
            <div className="tnum text-[28px] leading-9 font-semibold tracking-[-0.02em] text-ink">{props.value}</div>
            <div className="mt-0.5 text-[12.5px] text-ink-2">{props.sub}</div>
          </>
        )}
      </dd>
    </div>
  );
}

/** Senior over Junior (all books, latest marks), with the shared backstop on top: fee flow is paid top-down, losses absorbed bottom-up. */
function CapitalStack({ summary, loading }: { summary: BooksSummary | null; loading: boolean }) {
  const pool = useBackstopBalance();
  const sym = useSettlementSymbol();
  const split = summary ? trancheSplit(summary.seniorRaw, summary.juniorRaw) : null;
  const seniorGrow = split ? Math.max(split.senior, 0.18) : 0.6;
  const juniorGrow = split ? Math.max(split.junior, 0.18) : 0.4;
  return (
    <Card as="section" padding="lg" aria-label="Capital stack across all books">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow">Across all books</div>
          <div className="mt-1 text-[15.5px] font-semibold text-ink">How the capital is stacked</div>
        </div>
        <ValueKind kind="marked" />
      </div>
      <div className="mt-5 grid grid-cols-[18px_minmax(0,1fr)_18px] gap-x-3">
        <FlowArrow direction="down" />
        <div className="flex h-[264px] flex-col gap-1.5" aria-busy={loading || undefined}>
          <StackRow
            className={cx("border border-dashed", SERIES_CLASS.backstop.border, SERIES_CLASS.backstop.soft)}
            style={{ flexGrow: 0, flexBasis: 58 }}
            swatch={cx("hatch border", SERIES_CLASS.backstop.border)}
            title={<Term id="backstop">Backstop pool</Term>}
            note="Covers Senior only after Junior is used up"
            value={pool.data !== undefined ? `${fmtUsd(pool.data, { compact: true })} ${sym}` : pool.isError ? DASH : null}
          />
          <StackRow
            className={cx(SERIES_CLASS.senior.soft, "border", SERIES_CLASS.senior.border)}
            style={{ flexGrow: seniorGrow }}
            swatch={SERIES_CLASS.senior.bg}
            title="Senior"
            note="Fixed share of fee flow · last loss"
            value={loading ? null : summary ? `${fmtUsd(summary.seniorRaw, { symbol: true, compact: true })}${split ? ` · ${sharePct(split.senior)}` : ""}` : DASH}
          />
          <StackRow
            className={cx(SERIES_CLASS.junior.soft, "border", SERIES_CLASS.junior.border)}
            style={{ flexGrow: juniorGrow }}
            swatch={SERIES_CLASS.junior.bg}
            title="Junior"
            note="Residual fee flow · first loss"
            value={loading ? null : summary ? `${fmtUsd(summary.juniorRaw, { symbol: true, compact: true })}${split ? ` · ${sharePct(split.junior)}` : ""}` : DASH}
          />
        </div>
        <FlowArrow direction="up" />
      </div>
      <ul className="mt-4 grid gap-1.5 text-[12.5px] text-ink-2 sm:grid-cols-2">
        <li className="flex items-center gap-2">
          <span className={cx("inline-block h-2.5 w-2.5 rounded-full", SERIES_CLASS.fee.bg)} aria-hidden />
          <span>
            <span className="font-medium text-ink">Fee flow</span> is split in fixed shares
          </span>
        </li>
        <li className="flex items-center gap-2">
          <span className={cx("inline-block h-2.5 w-2.5 rounded-full", SERIES_CLASS.loss.bg)} aria-hidden />
          <span>
            <span className="font-medium text-ink">Losses</span> are absorbed bottom-up
          </span>
        </li>
      </ul>
    </Card>
  );
}

function StackRow(props: { className: string; style: CSSProperties; swatch?: string; title: ReactNode; note: string; value: string | null }) {
  return (
    <div className={cx("flex min-h-[58px] flex-col justify-center rounded-[10px] px-3.5 py-2", props.className)} style={props.style}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold text-ink">
          {props.swatch && <span className={cx("size-2.5 shrink-0 rounded-[3px]", props.swatch)} aria-hidden />}
          {props.title}
        </span>
        {props.value === null ? <Skeleton className="h-4 w-20" /> : <span className="num shrink-0 text-[13px] font-medium text-ink">{props.value}</span>}
      </div>
      <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{props.note}</div>
    </div>
  );
}

function FlowArrow({ direction }: { direction: "down" | "up" }) {
  const down = direction === "down";
  return (
    <svg viewBox="0 0 18 264" preserveAspectRatio="none" className="h-[264px] w-[18px]" aria-hidden focusable="false">
      <line x1="9" y1={down ? 6 : 258} x2="9" y2={down ? 246 : 18} stroke={down ? "var(--fee)" : "var(--loss)"} strokeWidth="2.5" strokeLinecap="round" />
      <path
        d={down ? "M3 240l6 12 6-12" : "M3 24l6-12 6 12"}
        fill={down ? "var(--fee)" : "var(--loss)"}
        stroke={down ? "var(--fee)" : "var(--loss)"}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
