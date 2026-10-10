// Where the BKRN that stakers claim comes from: book fee flow -> 10% protocol carry -> fee router,
// split 50/50 into the settlement-token backstop pool and a BKRN buyback shared across all stake. Drawn as
// HTML nodes with inline SVG connectors so it reflows from one column (phones) to one row (lg+).
// Live lifetime totals from BkrnFeeRouter and Backstop sit under each node.
import type { ReactNode } from "react";
import { buybackWhere } from "../../lib/copy";
import { fmtUsd } from "../../lib/format";
import { SERIES } from "../../lib/palette";
import { cx } from "../cx";
import { Term } from "../ui";
import { isTestChain } from "../../wallet/network";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { CarryPct } from "../ProtocolTerms";
import { bkrnNum } from "./stakeLogic";
import type { StakingProtocol } from "./useStaking";

type NodeTone = "fee" | "neutral" | "backstop" | "bkrn";

const NODE: Record<NodeTone, { bar: string; chip: string; label: string }> = {
  fee: { bar: "bg-fee", chip: "bg-fee/14 text-fee-ink", label: "Fee flow" },
  neutral: { bar: "bg-line-strong", chip: "bg-surface-2 text-ink-2", label: "Split" },
  // the backstop chip shows the settlement token's symbol (FlowNode)
  backstop: { bar: "hatch bg-backstop/30", chip: "bg-backstop/12 text-backstop-ink", label: "" },
  bkrn: { bar: "bg-bkrn", chip: "bg-bkrn/12 text-bkrn-ink", label: "BKRN" },
};

function FlowNode(props: { tone: NodeTone; step: string; title: ReactNode; body: ReactNode; figure?: ReactNode; figureLabel?: string; className?: string }) {
  const t = NODE[props.tone];
  const sym = useSettlementSymbol();
  const chipLabel = props.tone === "backstop" ? sym : t.label;
  return (
    <li className={cx("relative min-w-0 list-none overflow-hidden rounded-card border border-line bg-surface p-4 pl-5 shadow-card", props.className)}>
      <span className={cx("absolute inset-y-0 left-0 w-1.5", t.bar)} aria-hidden />
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">{props.step}</span>
        <span className={cx("rounded-full px-2 py-0.5 text-[10.5px] font-semibold", t.chip)}>{chipLabel}</span>
      </div>
      <h3 className="mt-1.5 text-[14.5px] font-semibold leading-snug text-ink">{props.title}</h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{props.body}</p>
      {props.figure !== undefined && (
        <div className="mt-3 border-t border-line pt-2.5">
          <div className="text-[11px] text-muted">{props.figureLabel}</div>
          <div className="num text-[15px] font-medium text-ink">{props.figure}</div>
        </div>
      )}
    </li>
  );
}

/** Down arrow on narrow screens, right arrow from lg. */
function Arrow({ color }: { color: string }) {
  return (
    <li className="flex list-none items-center justify-center py-0.5 lg:py-0" aria-hidden>
      <svg width="28" height="28" viewBox="0 0 28 28" className="rotate-90 lg:rotate-0">
        <path d="M3 14h19" stroke={color} strokeWidth="2" strokeLinecap="round" />
        <path d="M17 8.5 23 14l-6 5.5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </li>
  );
}

/** One input splitting into two outputs: a fork from lg, a plain down arrow below. */
function Fork() {
  // From lg the two outputs are stacked in the next column, so their centres sit near 25% and 75%
  // of this cell's height: the branches are drawn on a stretched 40x100 box.
  return (
    <li className="relative flex list-none items-center justify-center lg:self-stretch" aria-hidden>
      <svg width="28" height="28" viewBox="0 0 28 28" className="rotate-90 lg:hidden">
        <path d="M3 14h19" stroke="var(--line-strong)" strokeWidth="2" strokeLinecap="round" />
        <path d="M17 8.5 23 14l-6 5.5" fill="none" stroke="var(--line-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg viewBox="0 0 40 100" preserveAspectRatio="none" className="absolute inset-0 hidden h-full w-full lg:block">
        <path d="M0 50 H14 C20 50 20 25 26 25 H40" fill="none" stroke={SERIES.backstop} strokeWidth="2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <path d="M0 50 H14 C20 50 20 75 26 75 H40" fill="none" stroke={SERIES.bkrn} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </li>
  );
}

export function CarryFlow({ data }: { data: StakingProtocol | undefined }) {
  const sym = useSettlementSymbol();
  const usdc = (v: bigint | null | undefined) => (v == null ? "—" : `${fmtUsd(v)} ${sym}`);
  const noBuyback = data?.distributedBkrn === 0n;
  return (
    <figure className="m-0">
      <ol
        className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_28px_minmax(0,1fr)_40px_minmax(0,1.2fr)] lg:items-center lg:gap-2"
        aria-label="How protocol carry reaches the backstop pool and stakers"
      >
        <FlowNode
          tone="fee"
          step="1 · Books"
          title={
            <>
              Each book's <Term id="feeFlow">fee flow</Term>
            </>
          }
          body="What a book collects from its market, after venue and oracle costs."
        />
        <Arrow color={SERIES.fee} />
        <FlowNode
          tone="fee"
          step="2 · Carry"
          title={
            <>
              <CarryPct /> <Term id="carry">protocol carry</Term>
            </>
          }
          body="Taken in the waterfall before Senior. There is no fee on capital."
          figureLabel="Carry received, all time"
          figure={usdc(data?.carryReceivedUsd)}
        />
        <Arrow color={SERIES.fee} />
        <FlowNode tone="neutral" step="3 · Fee router" title="Split 50 / 50" body="Half goes to the backstop at once. Half waits for the next buyback." figureLabel="Waiting for a buyback" figure={usdc(data?.buybackPendingUsd)} />
        <Fork />
        <li className="grid list-none gap-2 sm:grid-cols-2 lg:grid-cols-1">
          <ol className="contents">
            <FlowNode
              tone="backstop"
              step="4a · Backstop"
              title={
                <>
                  <Term id="backstop">Backstop pool</Term>, in {sym}
                </>
              }
              body="Covers a Senior shortfall once that book's Junior is used up, up to what the pool holds. It never uses staked BKRN."
              figureLabel="Sent to the backstop, all time"
              figure={usdc(data?.toBackstopUsd)}
            />
            <FlowNode
              tone="bkrn"
              step="4b · Buyback"
              title="BKRN shared with stakers"
              body={`A keeper swaps the ${sym} for BKRN ${buybackWhere(isTestChain)}. The staking contract shares it in proportion to stake.`}
              figureLabel={noBuyback ? "Shared so far: none yet" : "Shared with stakers, all time"}
              figure={data?.distributedBkrn == null ? "—" : `${bkrnNum(data.distributedBkrn)} BKRN`}
            />
          </ol>
        </li>
      </ol>
      <figcaption className="mt-4 text-[12.5px] text-ink-2">
        Live totals from the fee router and backstop contracts. The buyback amount depends on fee flow, {isTestChain ? "the mock router's fixed price" : "the market price of BKRN"} and when a keeper runs the swap. It has no fixed rate and can be
        zero for long stretches.
        {noBuyback && data?.buybackPendingUsd != null && data.buybackPendingUsd > 0n && ` On this network no buyback has run yet, and ${fmtUsd(data.buybackPendingUsd)} ${sym} of carry is waiting for the first one.`}
      </figcaption>
    </figure>
  );
}
