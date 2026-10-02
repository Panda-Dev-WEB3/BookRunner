// 5. The mark: what NAV is, how often it is set, how it is signed and receipt-rooted, and how anyone can
// check a receipt against it. Shows the showcase book's latest signed mark, live from the API.
import { Link } from "react-router";
import { useNow } from "../../api/hooks";
import { LIVE_VS_MARKED } from "../../lib/copy";
import { DASH, fmtDateTime, fmtUsd, tickerOf } from "../../lib/format";
import { cadenceTitle, nextMarkLabel } from "../../lib/lowgas";
import { cx } from "../cx";
import { IconArrowRight, IconCheck } from "../icons";
import { Term } from "../Term";
import { Card, ErrorState, Hash, KV, SkeletonRows, ValueKind } from "../ui";
import { MarkCadenceText } from "../ProtocolTerms";
import { Figure, LearnSection, Prose } from "./parts";
import { useShowcaseBook } from "./useLearnData";

const LEAVES = ["Quote", "Fill", "Hedge", "Risk check"];

/** Receipts (agent actions) hash up into hourly roots, then one receipts root signed into the mark. */
function MerkleDiagram() {
  const leafX = [12, 99, 186, 273];
  const box = (x: number, y: number, w: number, h: number, label: string, sub?: string, strong?: boolean) => (
    <g key={`${label}-${x}-${y}`}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="8"
        fill={strong ? "var(--accent-soft)" : "var(--surface-2)"}
        stroke={strong ? "var(--accent)" : "var(--line-strong)"}
        strokeWidth="1.25"
      />
      <text x={x + w / 2} y={sub ? y + h / 2 - 3 : y + h / 2 + 4.5} textAnchor="middle" fontSize="12.5" fontWeight="600" fill="var(--ink)">
        {label}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + h / 2 + 13} textAnchor="middle" fontSize="10.5" fill="var(--ink-2)">
          {sub}
        </text>
      )}
    </g>
  );
  const edge = (x1: number, y1: number, x2: number, y2: number) => (
    <path key={`${x1}-${y1}-${x2}`} d={`M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`} fill="none" stroke="var(--line-strong)" strokeWidth="1.5" />
  );
  return (
    <svg viewBox="0 0 360 336" className="mx-auto block h-auto w-full max-w-[440px]" role="img" aria-labelledby="merkle-title merkle-desc">
      <title id="merkle-title">From receipts to a signed mark</title>
      <desc id="merkle-desc">
        Each agent action, such as a quote, fill, hedge or risk check, is a receipt. Receipts are hashed into hourly roots, the hourly roots into one receipts
        root, and that root is signed into the period's mark, which is committed on-chain in one transaction.
      </desc>
      {/* edges first, so boxes sit on top */}
      {edge(51, 274, 98, 232)}
      {edge(138, 274, 98, 232)}
      {edge(225, 274, 262, 232)}
      {edge(312, 274, 262, 232)}
      {edge(98, 196, 180, 160)}
      {edge(262, 196, 180, 160)}
      {edge(180, 124, 180, 98)}
      {edge(180, 46, 180, 30)}

      {box(80, 2, 200, 28, "On-chain: one transaction", undefined, true)}
      {box(55, 46, 250, 52, "Signed mark", "NAV, inventory, P&L, receipts root")}
      {box(110, 124, 140, 36, "Receipts root")}
      {box(48, 196, 100, 36, "Hourly root")}
      {box(212, 196, 100, 36, "Hourly root")}
      {LEAVES.map((l, i) => box(leafX[i] ?? 0, 274, 78, 34, l))}
      <text x="180" y="330" textAnchor="middle" fontSize="11" fill="var(--muted)">
        Receipts: one per agent action
      </text>
    </svg>
  );
}

function LatestMark() {
  const { list, book, detail } = useShowcaseBook();
  const now = useNow(1_000);
  if (list.isLoading || (book && detail.isLoading)) return <SkeletonRows rows={6} />;
  if (list.error && !list.data) return <ErrorState error={list.error} onRetry={() => void list.refetch()} compact />;
  if (!book) return <p className="text-[13px] text-muted">No book has a signed mark yet.</p>;
  const d = detail.data;
  const m = d?.latestMark ?? null;
  const ticker = tickerOf(book.symbol);
  return (
    <>
      <KV
        rows={[
          ["Book", `${ticker} (book #${book.bookId})`],
          ["Mark", m ? `#${m.markId}` : DASH],
          ["Period ended", m ? fmtDateTime(m.periodEndAt) : DASH],
          [
            <span key="nav">
              <Term id="nav">NAV</Term>
            </span>,
            m ? `${fmtUsd(m.navUsd)} USDC` : DASH,
          ],
          ["Senior NAV", m ? `${fmtUsd(m.seniorNavUsd)} USDC` : DASH],
          ["Junior NAV", m ? `${fmtUsd(m.juniorNavUsd)} USDC` : DASH],
          ["P&L over the period", m?.pnlUsd ? `${fmtUsd(m.pnlUsd, { signed: true })} USDC` : DASH],
          [
            <span key="root">
              <Term id="merkleReceipt">Receipts</Term> root
            </span>,
            <Hash key="r" value={m?.receiptsRoot ?? null} kind="hash" />,
          ],
          ["Signed by", <Hash key="s" value={m?.signer ?? null} kind="address" />],
          ["Committed in", <Hash key="t" value={m?.txHash ?? null} kind="tx" />],
          ["Next mark", d ? `${nextMarkLabel(d.markSchedule, now)} (${cadenceTitle(d.markSchedule.cadence).toLowerCase()})` : DASH],
        ]}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Link to={`/books/${book.bookId}#verify`} className="btn btn-primary btn-sm">
          Verify a receipt yourself <IconArrowRight size={14} />
        </Link>
        <Link to={`/books/${book.bookId}`} className="btn btn-sm">
          Open the {ticker} book
        </Link>
      </div>
    </>
  );
}

const VERIFY_STEPS = [
  "Open a book and go to its Verify panel.",
  "Pick a receipt. The app fetches its Merkle proof: the few hashes that link it to the root.",
  "Your browser rebuilds the root from the receipt and the proof, and compares it with the root inside the signed mark on-chain. If they match, the receipt is part of that statement.",
];

export function MarkSection(props: { index: number }) {
  const { list } = useShowcaseBook();
  const cadence = list.data?.[0]?.markSchedule.cadence ?? null;
  return (
    <LearnSection
      id="mark"
      index={props.index}
      eyebrow="The mark"
      title="One signed statement per period"
      lead={
        <>
          A book's <Term id="nav">NAV</Term> (net asset value) is what it is worth: cash in the vault plus what is deployed on the venue, minus what it owes. The{" "}
          <Term id="mark">mark</Term> is the moment that number becomes official.
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Prose>
            <p>
              Once per period (<MarkCadenceText />), the mark service values the book, writes a statement of its NAV, inventory and P&L, and
              signs it. One transaction commits the statement on-chain and applies it: share prices move, any loss is booked in order and queued redemptions
              settle.
            </p>
            <p>
              Every action the agent takes in between is a receipt: each quote, fill, hedge and risk check. Receipts are hashed into a Merkle tree, and its root
              goes inside the signed mark. Anyone can then check that a given receipt belongs to that statement.
            </p>
          </Prose>
          <ol className="space-y-3">
            {VERIFY_STEPS.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="tnum mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-text">{i + 1}</span>
                <span className="text-[14px] leading-relaxed text-ink-2">{s}</span>
              </li>
            ))}
          </ol>
          <div className={cx("flex items-start gap-2 rounded-control border border-line bg-surface-2/60 p-3 text-[12.5px] text-ink-2")}>
            <IconCheck size={16} className="mt-0.5 shrink-0 text-good-ink" />
            <span>
              <span className="font-semibold text-ink">Live or marked?</span> {LIVE_VS_MARKED}
            </span>
          </div>
        </div>
        <Figure caption={cadence ? `${cadenceTitle(cadence)} on this network.` : "Each network sets its mark interval."} label="Receipts and the mark">
          <MerkleDiagram />
        </Figure>
      </div>
      <Card className="mt-6" title="The latest mark, live" description="Straight from the first live book on this network." actions={<ValueKind kind="marked" />}>
        <LatestMark />
      </Card>
    </LearnSection>
  );
}
